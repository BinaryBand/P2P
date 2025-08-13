import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import BaseProto from "./base-proto.js";

import { setMetadataDb, getMetadataDb, setFragmentsDb, getDataFragmentsDb } from "../helpers/database.js";
import { bytesToBase64, decodeAddress } from "../tools/typing.js";
import { calculateDistance, orderPeers } from "../tools/routing.js";
import { blake3 } from "../tools/cryptography.js";
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
  private static readonly LIGHT_FRESHNESS_THRESHOLD: number = 180_000; // 3 minutes

  private lightAuditTimer?: NodeJS.Timeout;
  private metadataCache: LRUCache<Base64, Set<Base64>> = new LRUCache({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });
  private storageCache: LRUCache<Base64, DataFragment> = new LRUCache({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });

  constructor(components: Components, passphrase?: string, role: Role = "tower") {
    super(components, passphrase, role);
  }

  public static Swarm<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  public static verifyDataFragment(hash: Base64, fragment?: string): boolean {
    return fragment !== undefined && HandshakeProto.hashFromData(fragment) === hash;
  }

  private storeMetadataLocally(hashKey: Base64, metadata: Base64[]): void {
    // Save to local db
    setMetadataDb(hashKey, metadata);

    // Update cache
    let cacheSet: Set<Base64> | undefined = this.metadataCache.get(hashKey);
    if (cacheSet === undefined) {
      cacheSet = new Set();
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
      const peerId: PeerId = decodeAddress(holder);
      const prepped: Unstamped<SetMetadataRequest> = { hashKey, metadata, type: SwarmTypes.SetMetadataRequest };
      const request: SetMetadataRequest = this.stampRequest(prepped);
      await this.sendRequest(peerId, request);
      return true;
    } catch (err: unknown) {
      BaseProto.handleError(err, "storeMetadataRemotely");
      return false;
    }
  }

  private getLocalMetadata(hashKey: Base64): Base64[] {
    let cacheSet: Set<Base64> | undefined = this.metadataCache.get(hashKey);
    if (cacheSet === undefined) {
      cacheSet = new Set();
      this.metadataCache.set(hashKey, cacheSet);
    }

    // Populate cache from local db
    getMetadataDb(hashKey).then((rows: Base64[]) => {
      rows.forEach((row: Base64) => cacheSet.add(row));
    });

    return Array.from(cacheSet);
  }

  private async getRemoteMetadata(holder: Address, hashKey: Base64): Promise<Base64[]> {
    if (this.address === holder) {
      return this.getLocalMetadata(hashKey);
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const prepped: Unstamped<GetMetadataRequest> = { hashKey, type: SwarmTypes.GetMetadataRequest };
      const request: GetMetadataRequest = this.stampRequest(prepped);
      const response: Return<GetMetadataResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to get metadata from ${peerId}`);

      return response.data.metadata;
    } catch (err: unknown) {
      BaseProto.handleError(err, "getRemoteMetadata");
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
    const ownerHash: Base64 = bytesToBase64(blake3(owner));
    const candidates: Address[] = await this.getNearestPeers(ownerHash, SwarmProto.SWARM_SIZE, "tower");
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
    const ownerHash: Base64 = bytesToBase64(blake3(owner));

    const candidates: Address[] = await this.getNearestPeers(ownerHash, SwarmProto.SWARM_SIZE, "tower");
    const promises: Promise<Base64[]>[] = candidates.flatMap((addr: Address) =>
      this.getRemoteMetadata(addr, ownerHash)
    );
    const results: Base64[][] = await Promise.all(promises);
    const metadata: Base64[] = Array.from(new Set(results.flat()));

    return metadata;
  }

  private storeFragmentsLocally(fragments: string[]): Base64[] {
    setFragmentsDb(fragments);

    return fragments.map((frag) => {
      const hashKey: Base64 = SwarmProto.hashFromData(frag);
      const timestamp: number = Date.now();
      const dataFragment: DataFragment = { data: frag, hashKey, timestamp };
      this.storageCache.set(hashKey, dataFragment);
      return hashKey;
    });
  }

  private async storeFragmentsRemotely(address: Address, fragments: string[]): Promise<boolean> {
    if (this.address === address) {
      this.storeFragmentsLocally(fragments);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const prepped: Unstamped<SetFragmentsRequest> = { fragments, type: SwarmTypes.SetFragmentsRequest };
      const request: SetFragmentsRequest = this.stampRequest(prepped);
      await this.sendRequest(peerId, request);
      return true;
    } catch (err: unknown) {
      BaseProto.handleError(err, "storeFragmentsRemotely");
      return false;
    }
  }

  private async getLocalFragments(hashes: Base64[]): Promise<string[]> {
    const cachedHashes: [Base64, string?][] = hashes.map((hash: Base64) => [hash, this.storageCache.get(hash)?.data]);
    const fromCache = new Set<string>(
      cachedHashes
        .filter((args): args is [Base64, string] => SwarmProto.verifyDataFragment(...args))
        .map(([, frag]) => frag)
    );

    const missingHashes: Base64[] = cachedHashes.filter(([, frag]) => !fromCache.has(frag ?? "")).map(([hash]) => hash);
    const fromDb: string[] = await getDataFragmentsDb(missingHashes);
    fromDb.forEach(fromCache.add.bind(fromCache));

    return Array.from(fromDb);
  }

  private async getRemoteFragments(holder: Address, hashes: Base64[]): Promise<string[]> {
    if (this.address === holder) {
      return this.getLocalFragments(hashes);
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const prepped: Unstamped<GetFragmentsRequest> = { hashes, type: SwarmTypes.GetFragmentsRequest };
      const request: GetFragmentsRequest = this.stampRequest(prepped);
      const response: Return<GetFragmentsResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.fragments;
    } catch (err: unknown) {
      BaseProto.handleError(err, "getRemoteFragments");
      return [];
    }
  }

  /**
   * Stores the provided data across the nearest peers in the swarm.
   *
   * @param data - The string data to be stored.
   * @returns A promise that resolves to the Base64-encoded hash of the data.
   *
   * The method computes a hash from the input data, finds the nearest peers in the swarm,
   * and stores the data remotely on each of those peers. The hash is returned as a unique identifier.
   */
  public async storeFragments(fragments: string[], n: number = SwarmProto.SWARM_SIZE): Promise<Base64[]> {
    const hashes: Base64[] = fragments.map(SwarmProto.hashFromData);

    const promises: Promise<Address[]>[] = hashes.map((hash) => this.getNearestPeers(hash, n, "tower"));
    const results: Address[][] = await Promise.all(promises);
    const candidates: Address[] = Array.from(new Set(results.flat()));
    candidates.map((addr: Address) => this.storeFragmentsRemotely(addr, fragments));

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
   * @returns A promise that resolves to an array of fetched fragment strings.
   */
  public async fetchFragments(hashes: Base64[], n: number = SwarmProto.SWARM_SIZE): Promise<string[]> {
    const promises: Promise<Address[]>[] = hashes.map((hash) => this.getNearestPeers(hash, n, "tower"));
    const results: Address[][] = await Promise.all(promises);
    const candidates: Address[] = Array.from(new Set(results.flat()));

    // Map each peer to the hashes they need to fetch
    const wideNetPromises: Promise<string[]>[] = candidates
      .map((addr: Address) => this.getRemoteFragments(addr, hashes))
      .map((prom: Promise<string[]>) => this.getWithTimeout(prom, HandshakeProto.HEAVY_CALLBACK_TIMEOUT));

    // Flatten the results and filter out any undefined values
    return Promise.all(wideNetPromises).then((res: string[][]) => {
      const fragments: string[] = res.flat().filter((frag): frag is string => typeof frag === "string");
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
    const address: Set<Base64> | null = this.metadataCache.get(detail.batch.payload.hashKey) ?? null;
    return { metadata: [...(address || [])], type: SwarmTypes.GetMetadataResponse };
  }

  private onSetFragmentsRequest({ detail }: CustomEvent<Parcel<SetFragmentsRequest>>): void {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");
    this.storeFragmentsLocally(detail.batch.payload.fragments);
  }

  private async onGetFragmentsRequest({
    detail,
  }: CustomEvent<Parcel<GetFragmentsRequest>>): Promise<GetFragmentsResponse> {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");
    const fragments: string[] = await this.getLocalFragments(detail.batch.payload.hashes);
    return { fragments, type: SwarmTypes.GetFragmentsResponse };
  }

  // Periodically ensure neighbors' data stays up-to-date
  private async lightAudit(): Promise<void> {
    const neighbors: Address[] = this.getNeighbors();
    const addrHash: Uint8Array = blake3(this.address);
    const maxDistance: number = neighbors
      .map((addr: Address) => calculateDistance(addrHash, blake3(addr)))
      .reduce((a: number, b: number) => Math.max(a, b), 0);

    // Map each metadata to its nearest candidate peers
    for (const [key, metadataSet] of this.metadataCache.entries()) {
      // Only consider metadata that is nearby
      const distance: number = calculateDistance(addrHash, blake3(key));
      if (maxDistance < distance) continue;

      const topCandidates: Address[] = orderPeers(key, neighbors, SwarmProto.SWARM_SIZE).map(({ address }) => address);

      topCandidates.forEach((neighbor: Address) => {
        const metadata: Base64[] = [...metadataSet];
        const prepped: Unstamped<SetMetadataRequest> = { hashKey: key, metadata, type: SwarmTypes.SetMetadataRequest };
        const metadataRequest: SetMetadataRequest = this.stampRequest(prepped);

        const peerId: PeerId = decodeAddress(neighbor);
        this.sendRequest(peerId, metadataRequest);
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
