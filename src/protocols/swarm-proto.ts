import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";

import { setMetadataDb, getMetadataDb, setFragmentsDb, getDataFragmentsDb } from "../helpers/database.js";
import { calculateDistance, orderPeers } from "../tools/routing.js";
import { bytesToBase64, isFragment, Role } from "../tools/typing.js";
import { genericHash, hashFromData } from "../tools/cryptography.js";
import { assert } from "../tools/utils.js";
import BaseProto from "./base-proto.js";

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

export default class SwarmProto<T extends SwarmEvents = SwarmEvents> extends HandshakeProto<T> {
  private static readonly SWARM_SIZE: number = 3;
  private static readonly MAX_STORAGE_CACHE_SIZE: number = 2048;
  private static readonly LIGHT_AUDIT_INTERVAL: number = 60_000; // 1 minute

  private lightAuditTimer?: NodeJS.Timeout;
  private metadataCache = new LRUCache<Base64, Set<Base64>>({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });
  private storageCache = new LRUCache<Base64, DataFragment>({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });
  private requestCache = new LRUCache<Base64, Acceptance<ResData>>({ max: 64, ttl: 5_000 });

  constructor(components: Components, passphrase?: string, role: Role = Role.Tower) {
    super(components, passphrase, role);
  }

  public static init<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  public static verifyDataFragment(hash: Base64, fragment?: unknown): fragment is Fragment {
    return isFragment(fragment) && hashFromData(fragment) === hash;
  }

  private storeMetadataLocally(hashKey: Base64, metadata: Base64[]): void {
    setMetadataDb(hashKey, metadata).catch((err: unknown) => this.logger.error("storeMetadataLocally", err));

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
      const request: SetMetadataRequest = { hashKey, metadata, type: SwarmTypes.SetMetadataRequest };
      await this.sendRequest(holder, request);
      return true;
    } catch (err: unknown) {
      this.logger.warn("storeMetadataRemotely", err);
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

    const holderBuffer: Uint8Array = genericHash(holder);
    const requestId: Uint8Array = genericHash(hashKey, holderBuffer);
    const requestKey: Base64 = bytesToBase64(requestId);

    try {
      let response: Acceptance<ResData> | undefined = this.requestCache.get(requestKey);
      if (response === undefined) {
        const request: GetMetadataRequest = { hashKey, type: SwarmTypes.GetMetadataRequest };
        response = await this.sendRequest<GetMetadataResponse>(holder, request);
      }

      assert(response.success, `Failed to get metadata from ${holder}`);
      assert(response.data.type === SwarmTypes.GetMetadataResponse, "Invalid response type for metadata request");

      this.requestCache.set(requestKey, response);
      return response.data.metadata;
    } catch (err: unknown) {
      this.logger.warn("getRemoteMetadata", err);
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
    const ownerBuffer: Uint8Array = genericHash(owner);
    const ownerHash: Base64 = bytesToBase64(ownerBuffer);

    const candidates: Address[] = await this.getNearestPeers(ownerHash, SwarmProto.SWARM_SIZE, Role.Tower);
    const promises: Promise<Base64[]>[] = candidates.flatMap((addr) => this.getRemoteMetadata(addr, ownerHash));
    const results: Base64[][] = await Promise.all(promises);
    const metadata: Base64[] = Array.from(new Set(results.flat()));

    return metadata;
  }

  private storeFragmentsLocally(fragments: Fragment[]): Base64[] {
    setFragmentsDb(fragments).catch((err: unknown) => this.logger.error("storeFragmentsLocally", err));

    return fragments.map((frag) => {
      const hashKey: Base64 = hashFromData(frag);
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
      const request: SetFragmentsRequest = { fragments, type: SwarmTypes.SetFragmentsRequest };
      await this.sendRequest(holder, request);
      return true;
    } catch (err: unknown) {
      this.logger.warn("storeFragmentsRemotely", err);
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

    const addressHash: Uint8Array = genericHash(holder);
    const requestId: Uint8Array = genericHash(addressHash);
    const requestKey: Base64 = bytesToBase64(requestId);

    try {
      let response: Acceptance<ResData> | undefined = this.requestCache.get(requestKey);
      if (response === undefined) {
        const request: GetFragmentsRequest = { hashes, type: SwarmTypes.GetFragmentsRequest };
        response = await this.sendRequest<GetFragmentsResponse>(holder, request);
      }

      assert(response.success, `Failed to find nearest peers for ${holder}`);
      assert(response.data.type === SwarmTypes.GetFragmentsResponse, "Invalid response type for fragments request");

      this.requestCache.set(requestKey, response);
      return response.data.fragments;
    } catch (err: unknown) {
      this.logger.warn("getRemoteFragments", err);
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
    const hashes: Base64[] = fragments.map(hashFromData);

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
      .map((prom: Promise<Fragment[]>) => this.getWithTimeout(prom, BaseProto.HEAVY_CALLBACK_TIMEOUT));

    // Flatten the results and filter out any undefined values
    return Promise.all(wideNetPromises).then((res: Fragment[][]) => {
      const fragments: Fragment[] = res.flat().filter(isFragment);
      return fragments;
    });
  }

  private async onSetMetadataRequest({ detail }: CustomEvent<Parcel<SetMetadataRequest>>): Promise<void> {
    this.storeMetadataLocally(detail.batch.payload.hashKey, detail.batch.payload.metadata);
  }

  private async onGetMetadataRequest({
    detail,
  }: CustomEvent<Parcel<GetMetadataRequest>>): Promise<GetMetadataResponse> {
    const addresses: Base64[] = (await this.getLocalMetadata(detail.batch.payload.hashKey)) ?? null;
    return { metadata: [...(addresses || [])], type: SwarmTypes.GetMetadataResponse };
  }

  private onSetFragmentsRequest({ detail }: CustomEvent<Parcel<SetFragmentsRequest>>): void {
    this.storeFragmentsLocally(detail.batch.payload.fragments);
  }

  private async onGetFragmentsRequest({
    detail,
  }: CustomEvent<Parcel<GetFragmentsRequest>>): Promise<GetFragmentsResponse> {
    const fragments: Fragment[] = await this.getLocalFragments(detail.batch.payload.hashes);
    return { fragments, type: SwarmTypes.GetFragmentsResponse };
  }

  // Periodically ensure neighbors' data stays up-to-date with random distribution
  private async lightAudit(): Promise<void> {
    const allNeighbors: Address[] = this.getNeighbors();
    if (allNeighbors.length === 0) {
      this.logger.debug("lightAudit", "No neighbors available for audit");
      return;
    }

    const addrHash: Uint8Array = genericHash(this.address);
    const maxDistance: number = allNeighbors
      .map((addr: Address) => calculateDistance(addrHash, genericHash(addr)))
      .reduce((a: number, b: number) => Math.max(a, b), 0);

    // Randomly select a subset of neighbors for this audit cycle
    const auditSubsetSize: number = Math.min(Math.ceil(allNeighbors.length * 0.6), allNeighbors.length);
    const selectedNeighbors: Address[] = this.shuffleArray([...allNeighbors]).slice(0, auditSubsetSize);

    this.logger.debug("lightAudit", `Auditing ${selectedNeighbors.length} of ${allNeighbors.length} neighbors`);

    // Audit metadata cache
    await this.auditMetadataCache(selectedNeighbors, addrHash, maxDistance);

    // Audit storage cache (data fragments)
    await this.auditStorageCache(selectedNeighbors, addrHash, maxDistance);
  }

  // Helper method to shuffle an array using Fisher-Yates algorithm
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Audit metadata and ensure proper distribution
  private async auditMetadataCache(neighbors: Address[], addrHash: Uint8Array, maxDistance: number): Promise<void> {
    for (const [key, metadataSet] of this.metadataCache.entries()) {
      // Only consider metadata that is nearby
      const distance: number = calculateDistance(addrHash, genericHash(key));
      if (maxDistance < distance) continue;

      // Find the ideal candidates for this metadata
      const idealCandidates: Address[] = orderPeers(key, neighbors, SwarmProto.SWARM_SIZE).map(({ value }) => value);

      // Randomly select a subset of ideal candidates to send metadata to
      const candidateSubsetSize: number = Math.min(
        Math.max(2, Math.ceil(idealCandidates.length * 0.7)),
        idealCandidates.length
      );
      const selectedCandidates: Address[] = this.shuffleArray(idealCandidates).slice(0, candidateSubsetSize);

      // Send a subset of metadata to each selected candidate
      const metadataArray: Base64[] = Array.from(metadataSet.values());
      const metadataSubsetSize: number = Math.min(
        Math.max(1, Math.ceil(metadataArray.length * 0.8)),
        metadataArray.length
      );

      for (const candidate of selectedCandidates) {
        const metadataSubset: Base64[] = this.shuffleArray(metadataArray).slice(0, metadataSubsetSize);
        const metadataRequest: SetMetadataRequest = {
          hashKey: key,
          metadata: metadataSubset,
          type: SwarmTypes.SetMetadataRequest,
        };

        this.sendRequest(candidate, metadataRequest).catch((err: unknown) => {
          this.logger.warn("auditMetadataCache", `Failed to send metadata to ${candidate}`, err);
        });
      }
    }
  }

  // Audit data fragments and ensure proper distribution
  private async auditStorageCache(neighbors: Address[], addrHash: Uint8Array, maxDistance: number): Promise<void> {
    const fragmentEntries: [Base64, DataFragment][] = Array.from(this.storageCache.entries());

    if (fragmentEntries.length === 0) {
      return;
    }

    // Group fragments by their ideal storage locations to optimize network requests
    const fragmentsByCandidate = new Map<Address, Fragment[]>();

    for (const [hashKey, dataFragment] of fragmentEntries) {
      // Only consider fragments that are nearby
      const distance: number = calculateDistance(addrHash, genericHash(hashKey));
      if (maxDistance < distance) continue;

      // Find ideal candidates for this fragment
      const idealCandidates: Address[] = orderPeers(hashKey, neighbors, SwarmProto.SWARM_SIZE).map(
        ({ value }) => value
      );

      // Ensure at least 3 nodes will have this fragment (minimum replication requirement)
      const minReplicationCandidates: number = Math.min(3, idealCandidates.length);
      const replicationCandidates: Address[] = idealCandidates.slice(0, minReplicationCandidates);

      // Add some randomness by potentially including additional candidates
      const extraCandidates: Address[] = idealCandidates.slice(minReplicationCandidates);
      if (extraCandidates.length > 0 && Math.random() < 0.4) {
        const randomExtra: Address = extraCandidates[Math.floor(Math.random() * extraCandidates.length)];
        replicationCandidates.push(randomExtra);
      }

      // Group fragments by candidate to batch requests
      for (const candidate of replicationCandidates) {
        if (!fragmentsByCandidate.has(candidate)) {
          fragmentsByCandidate.set(candidate, []);
        }
        fragmentsByCandidate.get(candidate)!.push(dataFragment.data);
      }
    }

    // Send batched fragment requests to each candidate
    for (const [candidate, fragments] of fragmentsByCandidate.entries()) {
      // Send fragments in smaller batches to avoid overwhelming peers
      const batchSize: number = Math.min(10, fragments.length);
      for (let i = 0; i < fragments.length; i += batchSize) {
        const fragmentBatch: Fragment[] = fragments.slice(i, i + batchSize);
        const fragmentRequest: SetFragmentsRequest = {
          fragments: fragmentBatch,
          type: SwarmTypes.SetFragmentsRequest,
        };

        this.sendRequest(candidate, fragmentRequest).catch((err: unknown) => {
          this.logger.warn("auditStorageCache", `Failed to send fragments to ${candidate}`, err);
        });
      }
    }

    this.logger.debug(
      "auditStorageCache",
      `Distributed ${fragmentEntries.length} fragments to ${fragmentsByCandidate.size} candidates`
    );
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
