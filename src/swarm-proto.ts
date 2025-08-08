import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { calculateDistance, orderPeers } from "./tools/routing.js";
import { bytesToBase64, decodeAddress } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

export interface SwarmEvents extends HandshakeEvents {
  [SwarmTypes.NearestPeersRequest]: CustomEvent<Parcel<NearestPeersRequest>>;
  [SwarmTypes.StoreRequest]: CustomEvent<Parcel<StoreRequest>>;
  [SwarmTypes.FetchRequest]: CustomEvent<Parcel<FetchRequest>>;
}

export enum SwarmTypes {
  NearestPeersRequest = "swarm:nearest-peers-request",
  NearestPeersResponse = "swarm:nearest-peers-response",
  StoreRequest = "swarm:store-request",
  StoreResponse = "swarm:store-response",
  FetchRequest = "swarm:fetch-request",
  FetchResponse = "swarm:fetch-response",
}

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
  private static readonly MAX_RECURSION_DEPTH: number = 5;
  private static readonly MAX_STORAGE_SIZE: number = 4096;
  private static readonly STORAGE_AUDIT_INTERVAL: number = 60_000; // 1 minute
  private static readonly STORAGE_FRESHNESS_THRESHOLD: number = 180_000; // 3 minutes
  private static readonly REDUNDANCY_MARGIN: number = 10; // Audit `n` healthy fragments per audit cycle
  private static readonly SWARM_SIZE: number = 3;

  private storageAuditTimer: NodeJS.Timeout | null = null;
  protected storage: LRUCache<Base64, StorageItem> = new LRUCache({ max: SwarmProto.MAX_STORAGE_SIZE });

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Swarm<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  private getNearestLocalPairs(hash: Base64, n: number): PeerDistancePair[] {
    const candidates: Address[] = [this.address, ...this.peers.keys()];
    const distances: PeerDistancePair[] = orderPeers(hash, candidates);
    return distances.slice(0, n);
  }

  private getNearestLocals(hash: Base64, n: number): Address[] {
    return this.getNearestLocalPairs(hash, n).map(({ peer }) => peer);
  }

  private async getNearestRemotes(address: Address, hash: Base64, n: number): Promise<Address[]> {
    if (this.address === address) {
      return this.getNearestLocals(hash, n);
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: NearestPeersRequest = this.stampRequest({ n, hash, type: SwarmTypes.NearestPeersRequest });
      const response: Return<NearestPeersResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.peers;
    } catch (err) {
      console.warn(`Error getting nearest peers from ${address}:`, err);
      return [];
    }
  }

  private static hashFromData(data: string): Base64 {
    const key: Uint8Array = blake2b(data);
    return bytesToBase64(key);
  }

  private static verifyDataFragment(hash: Base64, fragment: string | null): boolean {
    if (!fragment) return false;
    const expectedHash: Base64 = SwarmProto.hashFromData(fragment);
    return expectedHash === hash;
  }

  /**
   * Finds and returns the addresses of the nearest peers to a given query.
   *
   * This method first retrieves the nearest local peers, then iteratively queries those peers
   * for their nearest peers, up to a maximum recursion depth defined by `SwarmProto.MAX_RECURSION_DEPTH`.
   * The process stops early if no closer peers are found in an iteration.
   *
   * @param query - The identifier or key to search nearest peers for.
   * @param n - The maximum number of nearest peers to return. Defaults to 3.
   * @returns A promise that resolves to an array of the nearest peer addresses.
   */
  public async getNearestPeers(query: string, n: number = SwarmProto.SWARM_SIZE): Promise<Address[]> {
    const hash: Base64 = SwarmProto.hashFromData(query);
    let peers: PeerDistancePair[] = this.getNearestLocalPairs(hash, n);

    let prevMinDistance: number = peers[0]?.distance ?? Infinity;
    for (let i: number = 0; i < SwarmProto.MAX_RECURSION_DEPTH; i++) {
      const wideNet = await Promise.all(peers.map(({ peer }) => this.getNearestRemotes(peer, hash, n)));
      peers = orderPeers(hash, wideNet.flat());

      const currMinDistance: number = peers[0]?.distance ?? prevMinDistance;
      if (currMinDistance >= prevMinDistance || peers.length === 0) {
        break;
      }

      prevMinDistance = currMinDistance;
    }

    return peers.map((pair: PeerDistancePair) => pair.peer).slice(0, n);
  }

  private async storeRemotely(address: Address, data: string): Promise<boolean> {
    if (this.address === address) {
      this.saveDataLocally(data);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: StoreRequest = this.stampRequest({ data, type: SwarmTypes.StoreRequest });
      await this.sendRequest(peerId, request);
      return true;
    } catch (err) {
      console.warn(`Error storing data to ${address}:`, err);
      return false;
    }
  }

  private async getRemoteStorage(address: Address, hash: Base64): Promise<string | null> {
    if (this.address === address) {
      return this.getLocalData(hash) ?? null;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: FetchRequest = this.stampRequest({ hash, type: SwarmTypes.FetchRequest });
      const response: Return<FetchResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.fragment ?? null;
    } catch (err) {
      console.warn(`Error getting remote storage from ${address}:`, err);
      return null;
    }
  }

  /**
   * Saves the provided data string locally in the storage using a base64-encoded hash as the key.
   *
   * @param data - The string data to be saved locally.
   * @returns The base64-encoded hash generated from the input data, used as the storage key.
   */
  public saveDataLocally(data: string): Base64 {
    const hash: Base64 = SwarmProto.hashFromData(data);
    const timestamp: number = Date.now();
    const storageItem: StorageItem = { data, hash, timestamp };

    this.storage.set(hash, storageItem);
    return hash;
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
  public async storeData(data: string): Promise<Base64> {
    const query: Base64 = SwarmProto.hashFromData(data);
    const nearestPeers: Address[] = await this.getNearestPeers(query, SwarmProto.SWARM_SIZE);
    await Promise.all(nearestPeers.map((addr: Address) => this.storeRemotely(addr, data)));
    return query;
  }

  /**
   * Retrieves local data associated with the specified hash from storage.
   *
   * @param hash - The base64-encoded key used to look up data in storage.
   * @returns The data as a string if found; otherwise, `null`.
   */
  public getLocalData(hash: Base64): string | null {
    const storageItem: StorageItem | undefined = this.storage.get(hash);
    return storageItem?.data ?? null;
  }

  /**
   * Fetches data associated with the given hash from the nearest peers in the swarm.
   *
   * This method locates the nearest peers using the provided hash, requests the data fragment from each peer,
   * verifies the integrity of each received fragment, and returns the last valid fragment found.
   *
   * @param hash - The base64-encoded hash identifying the data to fetch.
   * @returns A promise that resolves to the valid data fragment as a string, or `null` if no valid fragment is found.
   */
  public async fetchData(hash: Base64): Promise<string | null> {
    const nearestPeers: Address[] = this.getNearestLocals(hash, SwarmProto.SWARM_SIZE);
    const responses = await Promise.all(nearestPeers.map((peer: Address) => this.getRemoteStorage(peer, hash)));

    const filteredResponses: string[] = responses
      .filter((data: string | null) => SwarmProto.verifyDataFragment(hash, data))
      .filter((data: string | null): data is string => typeof data === "string");

    return filteredResponses.pop() ?? null;
  }

  private async repairSwarm(data: string, storagePairs: [Address, string | null][]): Promise<void> {
    await Promise.all(
      storagePairs
        .filter((pair: [Address, string | null]): pair is [Address, null] => pair[1] === null)
        .map(([addr]: [Address, null]) => addr)
        .map(async (addr: Address) => this.storeRemotely(addr, data))
    );
  }

  public async auditSwarm(data: string): Promise<void> {
    const hash: Base64 = SwarmProto.hashFromData(data);
    const nearestPeers: Address[] = this.getNearestLocals(hash, SwarmProto.SWARM_SIZE);

    const storagePairs: [Address, string | null][] = await Promise.all(
      nearestPeers.map(async (peer: Address) => [peer, await this.getRemoteStorage(peer, hash)])
    );

    await this.repairSwarm(data, storagePairs);
  }

  private async auditStorage(): Promise<void> {
    type StorageContainer = {
      distance: number;
      hash: Base64;
      isStale: boolean;
    };

    const selfKey: Base64 = SwarmProto.hashFromData(this.address);
    const selfCode: Uint8Array = blake2b(selfKey);

    // Calculate the distance from self and if the item is stale
    const scanStorageFragment = ({ hash, timestamp }: StorageItem): StorageContainer => {
      const distance: number = calculateDistance(selfCode, blake2b(hash));
      const isStale: boolean = timestamp + SwarmProto.STORAGE_FRESHNESS_THRESHOLD < Date.now();
      return { distance, hash, isStale };
    };

    // Only audit stale storage items near self
    const storageData: StorageContainer[] = Array.from(this.storage.values()).map(scanStorageFragment);
    const staleData: Base64[] = storageData.filter(({ isStale }) => isStale).map(({ hash }): Base64 => hash);

    // Select fresh data for auditing
    const freshDataToAudit: Base64[] = storageData
      .filter(({ isStale }) => !isStale)
      .sort((a, b): number => a.distance - b.distance)
      .slice(0, SwarmProto.REDUNDANCY_MARGIN)
      .map(({ hash }): Base64 => hash);

    await Promise.all([...staleData, ...freshDataToAudit].map(this.auditSwarm.bind(this)));
  }

  private onPeersRequest({ detail }: CustomEvent<Parcel<NearestPeersRequest>>): NearestPeersResponse {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    const peers: Address[] = this.getNearestLocals(detail.payload.hash, detail.payload.n);
    return { peers, type: SwarmTypes.NearestPeersResponse };
  }

  private onStoreRequest({ detail }: CustomEvent<Parcel<StoreRequest>>): void {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    this.saveDataLocally(detail.payload.data);
  }

  private onFetchRequest({ detail }: CustomEvent<Parcel<FetchRequest>>): FetchResponse {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    const fragment: string | null = this.getLocalData(detail.payload.hash) ?? null;
    return { fragment, type: SwarmTypes.FetchResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.addEventListener(SwarmTypes.StoreRequest, this.onStoreRequest.bind(this));
    this.addEventListener(SwarmTypes.FetchRequest, this.onFetchRequest.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.storageAuditTimer = setInterval(this.auditStorage.bind(this), SwarmProto.STORAGE_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.removeEventListener(SwarmTypes.StoreRequest, this.onStoreRequest.bind(this));
    this.removeEventListener(SwarmTypes.FetchRequest, this.onFetchRequest.bind(this));
    this.storage.clear();

    if (this.storageAuditTimer) {
      clearInterval(this.storageAuditTimer);
      this.storageAuditTimer = null;
    }
  }
}
