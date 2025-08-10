import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { calculateDistance } from "./tools/routing.js";
import { decodeAddress } from "./tools/typing.js";
import { blake3 } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

export interface SwarmEvents extends HandshakeEvents {
  [SwarmTypes.SetDataFragmentRequest]: CustomEvent<Parcel<SetDataFragmentRequest>>;
  [SwarmTypes.GetDataFragmentRequest]: CustomEvent<Parcel<GetDataFragmentRequest>>;
}

export enum SwarmTypes {
  SetDataFragmentRequest = "swarm:set-data-fragment-request",
  GetDataFragmentRequest = "swarm:get-data-fragment-request",
  GetDataFragmentResponse = "swarm:get-data-fragment-response",
}

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
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

  private static verifyDataFragment(hash: Base64, fragment: string | null): boolean {
    if (!fragment) return false;
    const expectedHash: Base64 = HandshakeProto.hashFromData(fragment);
    return expectedHash === hash;
  }

  private async storeRemotely(address: Address, data: string): Promise<boolean> {
    if (this.address === address) {
      this.saveDataLocally(data);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: SetDataFragmentRequest = this.stampRequest({ data, type: SwarmTypes.SetDataFragmentRequest });
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
      const request: GetDataFragmentRequest = this.stampRequest({ hash, type: SwarmTypes.GetDataFragmentRequest });
      const response: Return<GetDataFragmentResponse> = await this.sendRequest(peerId, request);
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
    const nearestPeers: Address[] = this.getNearestLocalPeers(hash, SwarmProto.SWARM_SIZE);
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

  /**
   * Audits the swarm for the given data by verifying its presence across the nearest peers.
   *
   * This method computes the hash of the provided data, identifies the nearest local peers,
   * retrieves the corresponding storage values from those peers, and then attempts to repair
   * the swarm if any discrepancies are found.
   *
   * @param data - The data to audit within the swarm.
   * @returns A promise that resolves when the audit and any necessary repairs are complete.
   */
  public async auditSwarm(data: string): Promise<void> {
    const hash: Base64 = SwarmProto.hashFromData(data);
    const nearestPeers: Address[] = this.getNearestLocalPeers(hash, SwarmProto.SWARM_SIZE);

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
    const selfCode: Uint8Array = blake3(selfKey);

    // Calculate the distance from self and if the item is stale
    const scanStorageFragment = ({ hash, timestamp }: StorageItem): StorageContainer => {
      const distance: number = calculateDistance(selfCode, blake3(hash));
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

  private onSetDataFragmentRequest({ detail }: CustomEvent<Parcel<SetDataFragmentRequest>>): void {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    this.saveDataLocally(detail.payload.data);
  }

  private onGetDataFragmentRequest({ detail }: CustomEvent<Parcel<GetDataFragmentRequest>>): GetDataFragmentResponse {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    const fragment: string | null = this.getLocalData(detail.payload.hash) ?? null;
    return { fragment, type: SwarmTypes.GetDataFragmentResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.SetDataFragmentRequest, this.onSetDataFragmentRequest.bind(this));
    this.addEventListener(SwarmTypes.GetDataFragmentRequest, this.onGetDataFragmentRequest.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.storageAuditTimer = setInterval(this.auditStorage.bind(this), SwarmProto.STORAGE_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.SetDataFragmentRequest, this.onSetDataFragmentRequest.bind(this));
    this.removeEventListener(SwarmTypes.GetDataFragmentRequest, this.onGetDataFragmentRequest.bind(this));
    this.storage.clear();

    if (this.storageAuditTimer) {
      clearInterval(this.storageAuditTimer);
      this.storageAuditTimer = null;
    }
  }
}
