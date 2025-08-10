import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import { bytesToBase64, decodeAddress, encode, encodePeerId } from "./tools/typing.js";
import { blake2b, blake3, totp } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";
import BaseProto from "./base-proto.js";
import { orderPeers } from "./tools/routing.js";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
  [HandshakeTypes.RequestPulse]: CustomEvent<Parcel<RequestPulse>>;
  [HandshakeTypes.NearestPeersRequest]: CustomEvent<Parcel<NearestPeersRequest>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
  RequestPulse = "handshake:request-pulse",
  NearestPeersRequest = "handshake:nearest-peers-request",
  NearestPeersResponse = "handshake:nearest-peers-response",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private readonly initiationToken: Uint8Array;

  private static readonly MAX_RECURSION_DEPTH: number = 5;
  private static readonly NET_SIZE: number = 3;
  private static readonly PEER_AUDIT_INTERVAL: number = 20_000; // 20 seconds
  private static readonly PEER_FRESHNESS_THRESHOLD: number = 60_000; // 1 minute
  private peerAuditTimer: NodeJS.Timeout | null = null;

  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<Address, PeerData> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE) {
    super(components);
    this.events = components.events;
    this.initiationToken = blake3(passphrase);
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  public getPeers(): PeerData[] {
    return Array.from(this.peers.values()).filter((peerData: PeerData) => !this.peerIsStale(peerData.peerId));
  }

  /**
   * Generates a stamped request object by signing the payload with a time-based one-time password (TOTP)
   * and a blake2b hash, then encoding the signature as a Base64 string.
   *
   * @template T - The type of the request data, which must include a `stamp` property.
   * @param payload - The request payload without the `stamp` property.
   * @returns The payload object with an added `stamp` property containing the Base64-encoded signature.
   */
  protected stampRequest<T extends ReqData>(payload: Omit<T, "stamp">): T {
    const data: string = JSON.stringify({ ...payload, stamp: undefined });
    const buffer: Uint8Array = encode(data);

    const otp: Uint8Array = totp(this.initiationToken);
    const sig: Uint8Array = blake2b(buffer, otp);
    const stamp: Base64 = bytesToBase64(sig);

    return { ...payload, stamp } as T;
  }

  /**
   * Verifies the integrity and authenticity of a payload using a time-based one-time password (TOTP) and a blake2b signature.
   *
   * The method checks if the payload contains a `stamp` property. It then generates a signature by:
   * - Serializing the payload (excluding the `stamp` property).
   * - Generating a TOTP value using the `initiationToken`.
   * - Hashing the serialized data with the TOTP value using blake2b.
   * - Comparing the base64-encoded hash to the provided `stamp`.
   *
   * @param payload - A partial request data object that may contain a `stamp` property.
   * @returns `true` if the signature matches the provided stamp, otherwise `false`.
   */
  protected verifyStamp(payload: Partial<ReqData>): boolean {
    if (!payload.stamp) {
      console.warn("Missing stamp");
      return false;
    }

    const data: string = JSON.stringify({ ...payload, stamp: undefined });
    const buffer: Uint8Array = encode(data);

    let otp: Uint8Array = totp(this.initiationToken, Date.now());
    let expectedSig: Uint8Array = blake2b(buffer, otp);
    if (bytesToBase64(expectedSig) === payload.stamp) {
      return true;
    }

    otp = totp(this.initiationToken, Date.now() - 30_000); // Check for a 30-second window
    expectedSig = blake2b(buffer, otp);
    return bytesToBase64(expectedSig) === payload.stamp;
  }

  /**
   * Sends a pulse request to the specified peer and adds the peer to the internal list upon success.
   * If the request fails, logs a warning and removes the peer from the internal list.
   *
   * @param peerId - The identifier of the peer to send the pulse request to.
   * @returns A promise that resolves when the pulse request has been processed.
   */
  protected async requestPulse(peerId: PeerId): Promise<void> {
    try {
      const request: RequestPulse = this.stampRequest({ type: HandshakeTypes.RequestPulse });
      await this.sendRequest(peerId, request);
      this.addPeer(peerId);
    } catch {
      console.warn(`Failed to verify pulse request from ${peerId}`);
      this.peers.delete(encodePeerId(peerId));
    }
  }

  private getNearestLocalPairs(hash: Base64, n: number): PeerDistancePair[] {
    const candidates: Address[] = [this.address, ...this.peers.keys()];
    const distances: PeerDistancePair[] = orderPeers(hash, candidates);
    return distances.slice(0, n);
  }

  protected getNearestLocalPeers(hash: Base64, n: number): Address[] {
    return this.getNearestLocalPairs(hash, n).map(({ peer }) => peer);
  }

  private async getNearestRemotes(address: Address, hash: Base64, n: number): Promise<Address[]> {
    if (this.address === address) {
      return this.getNearestLocalPeers(hash, n);
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: NearestPeersRequest = this.stampRequest({ n, hash, type: HandshakeTypes.NearestPeersRequest });
      const response: Return<NearestPeersResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.peers;
    } catch (err) {
      console.warn(`Error getting nearest peers from ${address}:`, err);
      return [];
    }
  }

  protected static hashFromData(data: string): Base64 {
    const key: Uint8Array = blake3(data);
    return bytesToBase64(key);
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
  protected async getNearestPeers(query: string, n: number = HandshakeProto.NET_SIZE): Promise<Address[]> {
    const hash: Base64 = HandshakeProto.hashFromData(query);
    let peers: PeerDistancePair[] = this.getNearestLocalPairs(hash, n);

    let prevMinDistance: number = peers[0]?.distance ?? Infinity;
    for (let i: number = 0; i < HandshakeProto.MAX_RECURSION_DEPTH; i++) {
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

  private addPeer(peerId: PeerId): void {
    const address: Address = encodePeerId(peerId);
    const timestamp: number = Date.now();
    this.peers.set(address, { peerId, timestamp });
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    if (this.peers.has(encodePeerId(detail))) {
      console.info(`Peer ${detail} disconnected`);
      this.peers.delete(encodePeerId(detail));
    }
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    assert(detail.protocols.includes(BaseProto.PROTOCOL), "Invalid protocol");
    console.info(`${this.peerId}: Initiating handshake with peer: ${detail.peerId.toString()}`);

    try {
      const request: InitiationRequest = this.stampRequest({ type: HandshakeTypes.InitiationRequest });
      await this.sendRequest(detail.peerId, request);
      this.addPeer(detail.peerId);
      console.info(`${this.peerId} successfully initiated handshake with peer ${detail.peerId}`);
    } catch {
      console.warn(`${this.peerId} Failed to initiate handshake with peer ${detail.peerId}`);
    }
  }

  private onInitiationRequest({ detail }: CustomEvent<Parcel<InitiationRequest>>): void {
    console.info(`${this.peerId}: Received token request from peer: ${detail.sender}`);
    assert(this.verifyStamp(detail.payload), "Invalid stamp in initiation request");
  }

  private onRequestPulse({ detail }: CustomEvent<Parcel<RequestPulse>>): void {
    console.info(`${this.peerId}: Received pulse request from peer: ${detail.sender}`);
    assert(this.verifyStamp(detail.payload), "Invalid stamp in pulse request");
  }

  private onPeersRequest({ detail }: CustomEvent<Parcel<NearestPeersRequest>>): NearestPeersResponse {
    assert(this.verifyStamp(detail.payload), "Invalid stamp");
    const peers: Address[] = this.getNearestLocalPeers(detail.payload.hash, detail.payload.n);
    return { peers, type: HandshakeTypes.NearestPeersResponse };
  }

  private peerIsStale(peerId: PeerId): boolean {
    const address: Address = encodePeerId(peerId);
    const peerData: PeerData | undefined = this.peers.get(address);
    if (!peerData) return true;

    const age: number = Date.now() - peerData.timestamp;
    return age > HandshakeProto.PEER_FRESHNESS_THRESHOLD;
  }

  private auditPeers(): void {
    Array.from(this.peers.entries()).forEach(([_addr, { peerId }]) => {
      if (this.peerIsStale(peerId)) {
        this.requestPulse(peerId);
      }
    });
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(HandshakeTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.addEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.addEventListener(HandshakeTypes.RequestPulse, this.onRequestPulse.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.peerAuditTimer = setInterval(this.auditPeers.bind(this), HandshakeProto.PEER_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(HandshakeTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
    this.removeEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.removeEventListener(HandshakeTypes.RequestPulse, this.onRequestPulse.bind(this));
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));
    this.peers.clear();

    if (this.peerAuditTimer) {
      clearInterval(this.peerAuditTimer);
      this.peerAuditTimer = null;
    }
  }
}
