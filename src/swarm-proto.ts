import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { bytesToBase64, decodeAddress, isAddress, isBase64 } from "./tools/typing.js";
import { blake3 } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

interface DataFragment {
  data: string;
  hash: Base64;
  timestamp: number;
}

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

  private lightAuditTimer: NodeJS.Timeout | null = null;

  protected metadataCache: LRUCache<Base64, Set<Base64>> = new LRUCache({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });
  protected storageCache: LRUCache<Base64, DataFragment> = new LRUCache({ max: SwarmProto.MAX_STORAGE_CACHE_SIZE });

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase, "tower");
  }

  public static Swarm<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  private static verifyDataFragment(hash: Base64, fragment?: string): boolean {
    return fragment !== undefined && HandshakeProto.hashFromData(fragment) === hash;
  }

  private storeMetadataLocally(key: Base64, metadata: Base64[]): void {
    if (this.metadataCache.has(key)) {
      const existingHashes: Set<Base64> = this.metadataCache.get(key)!;
      metadata.forEach((hash: Base64) => existingHashes.add(hash));
    } else {
      this.metadataCache.set(key, new Set(metadata));
    }
  }

  private async storeMetadataRemotely(holder: Address, hashKey: Base64, metadata: Base64[]): Promise<boolean> {
    if (this.address === holder) {
      this.storeMetadataLocally(hashKey, metadata);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const request: SetMetadataRequest = this.stampRequest({ hashKey, metadata, type: SwarmTypes.SetMetadataRequest });
      await this.sendRequest(peerId, request);
      return true;
    } catch (err) {
      console.warn(`Error storing data to ${holder}:`, err);
      return false;
    }
  }

  private getLocalMetadata(hashKey: Base64): Base64[] {
    return Array.from(this.metadataCache.get(hashKey) ?? []);
  }

  private async getRemoteMetadata(holder: Address, hashKey: Base64): Promise<Base64[]> {
    if (this.address === holder) {
      return this.getLocalMetadata(hashKey);
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const request: GetMetadataRequest = this.stampRequest({ hashKey, type: SwarmTypes.GetMetadataRequest });
      const response: Return<GetMetadataResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to get metadata from ${peerId}`);

      return response.data.metadata;
    } catch (err) {
      console.warn(`Error getting metadata from ${holder}:`, err);
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
    return fragments.map((fragment) => {
      const hash: Base64 = SwarmProto.hashFromData(fragment);
      const timestamp: number = Date.now();
      const dataFragment: DataFragment = { data: fragment, hash, timestamp };
      this.storageCache.set(hash, dataFragment);
      return hash;
    });
  }

  private async storeFragmentsRemotely(address: Address, fragments: string[]): Promise<boolean> {
    if (this.address === address) {
      this.storeFragmentsLocally(fragments);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: SetFragmentsRequest = this.stampRequest({ fragments, type: SwarmTypes.SetFragmentsRequest });
      await this.sendRequest(peerId, request);
      return true;
    } catch (err) {
      console.warn(`Error storing data to ${address}:`, err);
      return false;
    }
  }

  private getLocalFragments(hashes: Base64[]): string[] {
    return hashes
      .map((hash: Base64): [Base64, string | undefined] => [hash, this.storageCache.get(hash)?.data])
      .filter(([hash, fragment]) => SwarmProto.verifyDataFragment(hash, fragment))
      .map(([, fragment]: [Base64, string | undefined]) => fragment!);
  }

  private async getRemoteFragments(holder: Address, hashes: Base64[]): Promise<string[]> {
    if (this.address === holder) {
      return this.getLocalFragments(hashes);
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const request: GetFragmentsRequest = this.stampRequest({ hashes, type: SwarmTypes.GetFragmentsRequest });
      const response: Return<GetFragmentsResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.fragments;
    } catch (err) {
      console.warn(`Error getting remote storage from ${holder}:`, err);
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
      .map((prom: Promise<string[]>) => this.getWithTimeout(prom, HandshakeProto.LIGHTER_TIMEOUT));

    // Flatten the results and filter out any undefined values
    return Promise.all(wideNetPromises).then((res: string[][]) => {
      const fragments: string[] = res.flat().filter((frag): frag is string => typeof frag === "string");
      return fragments;
    });
  }

  private async onSetMetadataRequest({ detail }: CustomEvent<Parcel<SetMetadataRequest>>): Promise<void> {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");

    this.storeMetadataLocally(detail.payload.hashKey, detail.payload.metadata);
  }

  private async onGetMetadataRequest({
    detail,
  }: CustomEvent<Parcel<GetMetadataRequest>>): Promise<GetMetadataResponse> {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");

    const address: Set<Base64> | null = this.metadataCache.get(detail.payload.hashKey) ?? null;
    return { metadata: [...(address || [])], type: SwarmTypes.GetMetadataResponse };
  }

  private onSetFragmentsRequest({ detail }: CustomEvent<Parcel<SetFragmentsRequest>>): void {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    this.storeFragmentsLocally(detail.payload.fragments);
  }

  private onGetFragmentsRequest({ detail }: CustomEvent<Parcel<GetFragmentsRequest>>): GetFragmentsResponse {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    const fragments: string[] = this.getLocalFragments(detail.payload.hashes);
    return { fragments, type: SwarmTypes.GetFragmentsResponse };
  }

  // Ensure your peers' metadata stays up-to-date
  private hydrateMetadata(): void {
    const keys: Base64[] = Array.from(this.metadataCache.keys());
    const randomKeys: Base64[] = keys.sort(() => Math.random() - 0.5).slice(0, SwarmProto.AUDITING_NET_SIZE);

    randomKeys.forEach((randomKey: Base64): void => {
      const values: Base64[] = Array.from(this.metadataCache.get(randomKey) || []);
      const nearestPeers: Address[] = this.getNearestLocalPeers(randomKey, SwarmProto.SWARM_SIZE);
      nearestPeers.forEach((holder: Address): void => {
        this.storeMetadataRemotely(holder, randomKey, values);
      });
    });
  }

  private hydrateStorage(): void {
    // Only update stale fragments that are in the cache
    const now: number = Date.now();
    const staleFragments = Array.from(this.storageCache.values())
      .filter(({ timestamp }) => timestamp + SwarmProto.LIGHT_FRESHNESS_THRESHOLD < now)
      .sort(() => Math.random() - 0.5)
      .slice(0, SwarmProto.AUDITING_NET_SIZE);

    // Map each stale fragment to its nearest local peers
    const storageHydrationMap: Map<Address, Set<string>> = new Map();
    staleFragments.forEach(({ data, hash }: DataFragment) => {
      const localSwarm: Address[] = this.getNearestLocalPeers(hash, SwarmProto.SWARM_SIZE);
      localSwarm.forEach((addr: Address): void => {
        if (!storageHydrationMap.has(addr)) {
          storageHydrationMap.set(addr, new Set());
        }

        storageHydrationMap.get(addr)!.add(data);
      });
    });

    // Hydrate stale fragments from local peers
    for (const [addr, dataSet] of storageHydrationMap.entries()) {
      const dataArray: string[] = Array.from(dataSet);
      this.storeFragmentsRemotely(addr, dataArray);
    }
  }

  private async lightAudit(): Promise<void> {
    this.hydrateMetadata();
    this.hydrateStorage();
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

    if (this.lightAuditTimer !== null) {
      clearInterval(this.lightAuditTimer);
      this.lightAuditTimer = null;
    }
  }
}
