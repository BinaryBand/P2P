import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { bytesToBase64, decodeAddress, encodePeerId } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import { orderPeers } from "./tools/routing.js";
import { assert } from "./tools/utils.js";
import { LRUCache } from "lru-cache";

export type SwarmEvents = (ProtocolEvents & HandshakeEvents) & {
  [SwarmTypes.NearestPeersRequest]: CustomEvent<Parcel<NearestPeersRequest>>;
  [SwarmTypes.StoreRequest]: CustomEvent<Parcel<StoreRequest>>;
  [SwarmTypes.FetchRequest]: CustomEvent<Parcel<FetchRequest>>;
};

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
  private static readonly MAX_STORAGE_SIZE: number = 2048;
  private static readonly SWARM_SIZE: number = 3;

  protected storage: LRUCache<Base64, string> = new LRUCache({ max: SwarmProto.MAX_STORAGE_SIZE });

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Swarm<T extends SwarmEvents>(passphrase?: string): (params: Components) => SwarmProto<T> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  private getNearestLocalPairs(hash: Base64, n: number): PeerDistancePair[] {
    const candidates: Address[] = Array.from(this.peers.keys());
    const distances: PeerDistancePair[] = orderPeers(hash, candidates);
    return distances.slice(0, n);
  }

  private getNearestLocals(hash: Base64, n: number): Address[] {
    return this.getNearestLocalPairs(hash, n).map(({ peer }) => peer);
  }

  protected async getNearestRemote(address: Address, hash: Base64, n: number): Promise<Address[]> {
    if (encodePeerId(this.peerId) === address) {
      return this.getNearestLocals(hash, n);
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const token: Token | undefined = await this.getPeerToken(peerId);
      assert(token !== undefined, `No token found for peer ${peerId}`);

      const request: NearestPeersRequest = { n, hash, token, type: SwarmTypes.NearestPeersRequest };
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

  private static verifyDataFragment(hash: Base64, fragment?: string): boolean {
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
      const wideNet = await Promise.all(peers.map(({ peer }) => this.getNearestRemote(peer, hash, n)));
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
    if (encodePeerId(this.peerId) === address) {
      this.saveDataLocally(data);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const token: Token | undefined = await this.getPeerToken(peerId);
      assert(token !== undefined, `No token found for peer ${peerId}`);

      const request: StoreRequest = { data, token, type: SwarmTypes.StoreRequest };
      await this.sendRequest(peerId, request);
      return true;
    } catch (err) {
      console.warn(`Error storing data to ${address}:`, err);
      return false;
    }
  }

  protected async getRemoteStorage(address: Address, hash: Base64): Promise<string | undefined> {
    if (encodePeerId(this.peerId) === address) {
      return this.getLocalData(hash);
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const token: Token | undefined = await this.getPeerToken(peerId);
      assert(token !== undefined, `No token found for peer ${peerId}`);

      const request: FetchRequest = { hash, token, type: SwarmTypes.FetchRequest };
      const response: Return<FetchResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.fragment;
    } catch (err) {
      console.warn(`Error getting remote storage from ${address}:`, err);
      return undefined;
    }
  }

  public saveDataLocally(data: string): Base64 {
    const query: Base64 = SwarmProto.hashFromData(data);
    this.storage.set(query, data);
    return query;
  }

  public async storeData(data: string): Promise<Base64> {
    const query: Base64 = SwarmProto.hashFromData(data);
    const nearestPeers: Address[] = await this.getNearestPeers(query, SwarmProto.SWARM_SIZE);
    await Promise.all(nearestPeers.map((addr: Address) => this.storeRemotely(addr, data)));
    return query;
  }

  public getLocalData(query: Base64): string | undefined {
    return this.storage.get(query);
  }

  public async fetchData(hash: Base64): Promise<string | undefined> {
    const nearestPeers: Address[] = this.getNearestLocals(hash, SwarmProto.SWARM_SIZE);
    const responses = await Promise.all(nearestPeers.map((peer: Address) => this.getRemoteStorage(peer, hash)));

    const filteredResponses: string[] = responses
      .filter((data) => SwarmProto.verifyDataFragment(hash, data))
      .filter((data?: string): data is string => typeof data === "string");

    return filteredResponses.pop();
  }

  private onPeersRequest({ detail }: CustomEvent<Parcel<NearestPeersRequest>>): NearestPeersResponse {
    assert(this.verifyToken(detail.payload.token), "Invalid token in nearest peers request");
    const peers: Address[] = this.getNearestLocals(detail.payload.hash, detail.payload.n);
    return { peers, type: SwarmTypes.NearestPeersResponse };
  }

  private onStoreRequest({ detail }: CustomEvent<Parcel<StoreRequest>>): void {
    assert(this.verifyToken(detail.payload.token), "Invalid token in storage request");
    this.saveDataLocally(detail.payload.data);
  }

  private onFetchRequest({ detail }: CustomEvent<Parcel<FetchRequest>>): FetchResponse {
    assert(this.verifyToken(detail.payload.token), "Invalid token in fetch request");
    const fragment: string | undefined = this.getLocalData(detail.payload.hash);
    return { fragment, type: SwarmTypes.FetchResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.addEventListener(SwarmTypes.StoreRequest, this.onStoreRequest.bind(this));
    this.addEventListener(SwarmTypes.FetchRequest, this.onFetchRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.removeEventListener(SwarmTypes.StoreRequest, this.onStoreRequest.bind(this));
    this.removeEventListener(SwarmTypes.FetchRequest, this.onFetchRequest.bind(this));
    this.storage.clear();
  }
}
