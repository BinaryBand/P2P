import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";

import { setMetadataDb, getMetadataDb, setFragmentsDb, getDataFragmentsDb } from "../helpers/database.js";
import { bytesToBase64, isFragment, Role } from "../tools/typing.js";
import { calculateDistance, orderPeers } from "../tools/routing.js";
import { genericHash } from "../tools/cryptography.js";
import { assert } from "../tools/utils.js";

export interface SwarmEvents extends HandshakeEvents {
  [SwarmTypes.SetMetadataRequest]: CustomEvent<Parcel<SetMetadataRequest>>;
  [SwarmTypes.GetMetadataRequest]: CustomEvent<Parcel<GetMetadataRequest>>;

  [SwarmTypes.SetFragmentsRequest]: CustomEvent<Parcel<SetFragmentsRequest>>;
  [SwarmTypes.GetFragmentsRequest]: CustomEvent<Parcel<GetFragmentsRequest>>;
}

export enum SwarmTypes {
  SetMetadataRequest = "swarm:set-metadata-request",
  GetMetadataRequest = "swarm:get-metadata-request",
  GetMetadataResponse = "swarm:get-metadata-response",

  SetFragmentsRequest = "swarm:set-fragments-request",
  GetFragmentsRequest = "swarm:get-fragments-request",
  GetFragmentsResponse = "swarm:get-fragments-response",
}

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
  private static readonly SWARM_SIZE: number = 3;
  private static readonly MAX_STORAGE_CACHE_SIZE: number = 2048;
  private static readonly LIGHT_AUDIT_INTERVAL: number = 60_000; // 1 minute

  private lightAuditTimer?: NodeJS.Timeout;
  private metadataCache = new LRUCache<Base64, Set<Base64>>({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });
  private storageCache = new LRUCache<Base64, DataFragment>({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });

  constructor(components: Components, passphrase?: string, role: Role = Role.Tower) {
    super(components, passphrase, role);
  }

  public static Swarm<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  public static verifyDataFragment(hash: Base64, fragment?: unknown): fragment is Fragment {
    return isFragment(fragment) && HandshakeProto.hashFromData(fragment) === hash;
  }

  private storeMetadataLocally(hashKey: Base64, metadata: Base64[]): void {
    setMetadataDb(hashKey, metadata).catch((err: unknown) => this.handleLog("error", err, "storeMetadataLocally"));

    // Update cache
    let cacheSet: Set<Base64> | undefined = this.metadataCache.get(hashKey);
    if (cacheSet === undefined) {
      cacheSet = new Set<Base64>();
      this.metadataCache.set(hashKey, cacheSet);
    }
    metadata.forEach((hash: Base64) => cacheSet.add(hash));
  }

  private async storeMetadataRemotely(holder: Address, hashKey: Base64, metadata: Base64[]): Promise<boolean> {
    if (this.address === holder) {
      this.storeMetadataLocally(hashKey, metadata);
      return true;
    }

    try {
      const prepped: Unstamped<SetMetadataRequest> = { hashKey, metadata, type: SwarmTypes.SetMetadataRequest };
      const request: SetMetadataRequest = this.stampRequest(prepped);
      await this.sendRequest(holder, request);
      return true;
    } catch (err: unknown) {
      this.handleLog("warn", err, "storeMetadataRemotely");
      return false;
    }
  }

  private async getLocalMetadata(hashKey: Base64): Promise<Base64[]> {
    let cacheSet: Set<Base64> | undefined = this.metadataCache.get(hashKey);
    if (cacheSet === undefined) {
      cacheSet = new Set<Base64>();
      this.metadataCache.set(hashKey, cacheSet);
    }

    // Populate cache from local db
    const rows: Base64[] = await getMetadataDb(hashKey);
    rows.forEach((row: Base64) => cacheSet.add(row));

    this.metadataCache.set(hashKey, cacheSet);
    return Array.from(cacheSet);
  }

  private async getRemoteMetadata(holder: Address, hashKey: Base64): Promise<Base64[]> {
    if (this.address === holder) {
      return this.getLocalMetadata(hashKey);
    }

    try {
      const prepped: Unstamped<GetMetadataRequest> = { hashKey, type: SwarmTypes.GetMetadataRequest };
      const request: GetMetadataRequest = this.stampRequest(prepped);
      const response: Return<GetMetadataResponse> = await this.sendRequest(holder, request);
      assert(response.success, `Failed to get metadata from ${holder}`);

      return response.data.metadata;
    } catch (err: unknown) {
      this.handleLog("warn", err, "getRemoteMetadata");
      return [];
    }
  }

  /**
   * Stores metadata associated with a recipient peer by distributing it to the nearest peers in the swarm.
   *
   * @param owner - The peer ID of the recipient whose metadata is being stored.
   * @param contentHashes - An array of base64-encoded content hashes to associate with the recipient.
   * @returns A promise that resolves when the metadata has been stored on all nearest peers.
   */
  protected async storeMetadata(owner: Address, hashes: Base64[]): Promise<void> {
    this.logger.info("storeMetadata", { owner, hashes });
    const ownerHash: Base64 = bytesToBase64(genericHash(owner));
    const candidates: Address[] = await this.getNearestPeers(ownerHash, SwarmProto.SWARM_SIZE, Role.Tower);
    candidates.map((addr: Address) => this.storeMetadataRemotely(addr, ownerHash, hashes));
  }

  /**
   * Fetches metadata associated with the specified owner from the swarm.
   *
   * This method computes a hash of the owner's address, finds the nearest peers in the swarm,
   * and queries each peer for metadata related to the owner. The results are flattened and deduplicated.
   *
   * @param owner - The address of the owner whose metadata is to be fetched.
   * @returns A promise that resolves to an array of unique Base64-encoded metadata entries.
   */
  protected async fetchMetadata(owner: Address): Promise<Base64[]> {
    this.logger.info("fetchMetadata", { owner });
    const ownerHash: Base64 = bytesToBase64(genericHash(owner));

    const candidates: Address[] = await this.getNearestPeers(ownerHash, SwarmProto.SWARM_SIZE, Role.Tower);
    const promises: Promise<Base64[]>[] = candidates.flatMap((addr) => this.getRemoteMetadata(addr, ownerHash));
    const results: Base64[][] = await Promise.all(promises);
    const metadata: Base64[] = Array.from(new Set(results.flat()));

    return metadata;
  }

  private storeFragmentsLocally(fragments: Fragment[]): Base64[] {
    setFragmentsDb(fragments).catch((err: unknown) => this.handleLog("error", err, "storeFragmentsLocally"));

    return fragments.map((frag) => {
      const hashKey: Base64 = SwarmProto.hashFromData(frag);
      const timestamp: number = Date.now();
      const dataFragment: DataFragment = { data: frag, hashKey, timestamp };
      this.storageCache.set(hashKey, dataFragment);
      return hashKey;
    });
  }

  private async storeFragmentsRemotely(holder: Address, fragments: Fragment[]): Promise<boolean> {
    if (this.address === holder) {
      this.storeFragmentsLocally(fragments);
      return true;
    }

    try {
      const prepped: Unstamped<SetFragmentsRequest> = { fragments, type: SwarmTypes.SetFragmentsRequest };
      const request: SetFragmentsRequest = this.stampRequest(prepped);
      await this.sendRequest(holder, request);
      return true;
    } catch (err: unknown) {
      this.handleLog("warn", err, "storeFragmentsRemotely");
      return false;
    }
  }

  private async getLocalFragments(hashes: Base64[]): Promise<Fragment[]> {
    const cachedHashes: [Base64, Fragment?][] = hashes.map((hash: Base64) => [hash, this.storageCache.get(hash)?.data]);

    const fromCache = new Set<Fragment>(
      cachedHashes
        .filter((args): args is [Base64, Fragment] => SwarmProto.verifyDataFragment(...args))
        .map(([, frag]) => frag)
    );

    const missingHashes: Base64[] = cachedHashes
      .filter(([, frag]) => !fromCache.has(frag as Fragment))
      .map(([hash]) => hash);

    const fromDb: Fragment[] = await getDataFragmentsDb(missingHashes);
    fromDb.forEach(fromCache.add.bind(fromCache));

    const fragments: Fragment[] = Array.from(fromCache);
    this.storeFragmentsLocally(fragments);

    return fragments;
  }

  private async getRemoteFragments(holder: Address, hashes: Base64[]): Promise<Fragment[]> {
    if (this.address === holder) {
      return this.getLocalFragments(hashes);
    }

    try {
      const prepped: Unstamped<GetFragmentsRequest> = { hashes, type: SwarmTypes.GetFragmentsRequest };
      const request: GetFragmentsRequest = this.stampRequest(prepped);
      const response: Return<GetFragmentsResponse> = await this.sendRequest(holder, request);
      assert(response.success, `Failed to find nearest peers for ${holder}`);

      return response.data.fragments;
    } catch (err: unknown) {
      this.handleLog("warn", err, "getRemoteFragments");
      return [];
    }
  }

  /**
   * Stores the provided data across the nearest peers in the swarm.
   *
   * @param fragments - The Fragment data to be stored.
   * @returns A promise that resolves to the Base64-encoded hash of the data.
   *
   * The method computes a hash from the input data, finds the nearest peers in the swarm,
   * and stores the data remotely on each of those peers. The hash is returned as a unique identifier.
   */
  protected async storeFragments(fragments: Fragment[], n: number = SwarmProto.SWARM_SIZE): Promise<Base64[]> {
    this.logger.info("storeFragments", { fragments, n });
    const hashes: Base64[] = fragments.map(SwarmProto.hashFromData);

    const promises: Promise<Address[]>[] = hashes.map((hash) => this.getNearestPeers(hash, n, Role.Tower));
    const results: Address[][] = await Promise.all(promises);
    const candidates: Address[] = Array.from(new Set(results.flat()));
    candidates.forEach((addr: Address) => this.storeFragmentsRemotely(addr, fragments));

    return hashes;
  }

  /**
   * Fetches data fragments from the nearest peers in the swarm network.
   *
   * Given an array of fragment hashes, this method locates the nearest peers for each hash,
   * aggregates a unique set of candidate peers, and requests the fragments from them.
   * Each remote data request is performed with a timeout to avoid hanging.
   *
   * @param hashes - An array of base64-encoded fragment hashes to fetch.
   * @param n - The number of nearest peers to query for each hash. Defaults to `SWARM_SIZE`.
   * @returns A promise that resolves to an array of fetched fragment Fragment.
   */
  protected async fetchFragments(hashes: Base64[], n: number = SwarmProto.SWARM_SIZE): Promise<Fragment[]> {
    this.logger.info("fetchFragments", { hashes, n });

    // Find the nearest peers for each hash
    const promises: Promise<Address[]>[] = hashes.map((hash) => this.getNearestPeers(hash, n, Role.Tower));
    const results: Address[][] = await Promise.all(promises);
    const candidates: Address[] = Array.from(new Set(results.flat()));

    // Map each peer to the hashes they need to fetch
    const wideNetPromises: Promise<Fragment[]>[] = candidates
      .map((addr: Address) => this.getRemoteFragments(addr, hashes))
      .map((prom: Promise<Fragment[]>) => this.getWithTimeout(prom, HandshakeProto.HEAVY_CALLBACK_TIMEOUT));

    // Flatten the results and filter out any undefined values
    return Promise.all(wideNetPromises).then((res: Fragment[][]) => {
      const fragments: Fragment[] = res.flat().filter(isFragment);
      return fragments;
    });
  }

  private async onSetMetadataRequest({ detail }: CustomEvent<Parcel<SetMetadataRequest>>): Promise<void> {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");
    this.storeMetadataLocally(detail.batch.payload.hashKey, detail.batch.payload.metadata);
  }

  private async onGetMetadataRequest({
    detail,
  }: CustomEvent<Parcel<GetMetadataRequest>>): Promise<GetMetadataResponse> {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");

    const addresses: Base64[] = (await this.getLocalMetadata(detail.batch.payload.hashKey)) ?? null;
    return { metadata: [...(addresses || [])], type: SwarmTypes.GetMetadataResponse };
  }

  private onSetFragmentsRequest({ detail }: CustomEvent<Parcel<SetFragmentsRequest>>): void {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");
    this.storeFragmentsLocally(detail.batch.payload.fragments);
  }

  private async onGetFragmentsRequest({
    detail,
  }: CustomEvent<Parcel<GetFragmentsRequest>>): Promise<GetFragmentsResponse> {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");

    const fragments: Fragment[] = await this.getLocalFragments(detail.batch.payload.hashes);
    return { fragments, type: SwarmTypes.GetFragmentsResponse };
  }

  // Periodically ensure neighbors' data stays up-to-date
  private async lightAudit(): Promise<void> {
    const neighbors: Address[] = this.getNeighbors();
    const addrHash: Uint8Array = genericHash(this.address);
    const maxDistance: number = neighbors
      .map((addr: Address) => calculateDistance(addrHash, genericHash(addr)))
      .reduce((a: number, b: number) => Math.max(a, b), 0);

    // Map each metadata to its nearest candidate peers
    for (const [key, metadataSet] of this.metadataCache.entries()) {
      // Only consider metadata that is nearby
      const distance: number = calculateDistance(addrHash, genericHash(key));
      if (maxDistance < distance) continue;

      const topCandidates: Address[] = orderPeers(key, neighbors, SwarmProto.SWARM_SIZE).map(({ value }) => value);

      topCandidates.forEach((neighbor: Address) => {
        const metadata: Base64[] = [...metadataSet];
        const prepped: Unstamped<SetMetadataRequest> = { hashKey: key, metadata, type: SwarmTypes.SetMetadataRequest };
        const metadataRequest: SetMetadataRequest = this.stampRequest(prepped);
        this.sendRequest(neighbor, metadataRequest);
      });
    }

    // const nearbyFragmentKeys: Base64[] = [...this.storageCache.keys()].filter(
    //   (key: Base64) => calculateDistance(addrHash, blake3(key)) < maxDistance
    // );

    // for (const key of nearbyFragmentKeys) {
    //   const x = this.getLocalFragments([key]);

    //   // const topCandidates: Address[] = orderPeers(key, neighbors)
    //   //   .map(({ peer }) => peer)
    //   //   .slice(0, SwarmProto.SWARM_SIZE);

    //   // topCandidates.forEach((neighbor: Address) => {
    //   //   const fragment: string | undefined = this.storageCache.get(key)?.data;

    //   //   if (fragment !== undefined) {
    //   //     const prep: Unstamped<SetFragmentsRequest> = { fragments: [fragment], type: SwarmTypes.SetFragmentsRequest };
    //   //     const fragmentRequest: SetFragmentsRequest = this.stampRequest(prep);
    //   //     requestMap.get(neighbor)!.push(fragmentRequest);
    //   //   }
    //   // });
    // }
  }

  public async start(): Promise<void> {
    await super.start();

    this.addEventListener(SwarmTypes.SetMetadataRequest, this.onSetMetadataRequest.bind(this));
    this.addEventListener(SwarmTypes.GetMetadataRequest, this.onGetMetadataRequest.bind(this));
    this.addEventListener(SwarmTypes.SetFragmentsRequest, this.onSetFragmentsRequest.bind(this));
    this.addEventListener(SwarmTypes.GetFragmentsRequest, this.onGetFragmentsRequest.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.lightAuditTimer = setInterval(this.lightAudit.bind(this), SwarmProto.LIGHT_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();

    this.removeEventListener(SwarmTypes.SetMetadataRequest, this.onSetMetadataRequest.bind(this));
    this.removeEventListener(SwarmTypes.GetMetadataRequest, this.onGetMetadataRequest.bind(this));
    this.removeEventListener(SwarmTypes.SetFragmentsRequest, this.onSetFragmentsRequest.bind(this));
    this.removeEventListener(SwarmTypes.GetFragmentsRequest, this.onGetFragmentsRequest.bind(this));

    this.metadataCache.clear();
    this.storageCache.clear();

    if (this.lightAuditTimer !== undefined) {
      clearInterval(this.lightAuditTimer);
      this.lightAuditTimer = undefined;
    }
  }
}
