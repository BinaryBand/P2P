import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import { bytesToBase64, decodeAddress, encode, encodePeerId } from "../tools/typing.js";
import { blake2b, blake3, totp } from "../tools/cryptography.js";
import { orderPeers } from "../tools/routing.js";
import { assert } from "../tools/utils.js";
import BaseProto from "./base-proto.js";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
  [HandshakeTypes.PingRequest]: CustomEvent<Parcel<PingRequest>>;
  [HandshakeTypes.GetNeighborsRequest]: CustomEvent<Parcel<GetNeighborsRequest>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
  PingRequest = "handshake:ping-request",
  PingResponse = "handshake:ping-response",
  GetNeighborsRequest = "handshake:get-neighbors-request",
  GetNeighborsResponse = "handshake:get-neighbors-response",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private readonly initiationToken: Uint8Array;
  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private static readonly MAX_RECURSION_DEPTH: number = 5; // Maximum depth for recursive nearest peer search
  private static readonly PEER_AUDIT_INTERVAL: number = 20_000; // 20 seconds
  private static readonly PEER_FRESHNESS_THRESHOLD: number = 60_000; // 1 minute
  private static readonly AUDIT_NET_SIZE: number = 10;

  private events: TypedEventTarget<Libp2pEvents>;
  private peerAuditTimer?: NodeJS.Timeout;
  private peersCache: LRUCache<Address, PeerInfo> = new LRUCache({ max: 256 });

  constructor(
    components: Components,
    passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE,
    private readonly role: Role = "phone"
  ) {
    super(components);
    this.events = components.events;
    this.initiationToken = blake3(passphrase);
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  public static hashFromData(data: string): Base64 {
    const key: Uint8Array = blake3(data);
    return bytesToBase64(key);
  }

  public async getNeighbors(n: number = 10, role?: Role): Promise<Address[]> {
    const addressHash: Base64 = bytesToBase64(blake3(this.address));
    return this.getNearestPeers(addressHash, n, role ?? this.role);
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
      const request: PingRequest = this.stampRequest({ type: HandshakeTypes.PingRequest });
      const response: Return<PingResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to verify pulse request from ${peerId}`);

      this.addPeer(peerId, response.data.role);
    } catch (err: unknown) {
      BaseProto.handleError(err, "requestPulse");
      this.peersCache.delete(encodePeerId(peerId));
    }
  }

  private getNearestLocalPairs(hash: Base64, n: number): PeerDistancePair[] {
    const candidates: Address[] = [this.address, ...this.peersCache.keys()];
    const distances: PeerDistancePair[] = orderPeers(hash, candidates);
    return distances.slice(0, n);
  }

  protected getNearestLocalPeers(hash: Base64, n: number): Address[] {
    return this.getNearestLocalPairs(hash, n).map(({ peer }) => peer);
  }

  private async getNearestRemotePeers(address: Address, hash: Base64, n: number, role: Role): Promise<Address[]> {
    if (this.address === address) {
      return this.getNearestLocalPeers(hash, n);
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: GetNeighborsRequest = this.stampRequest({
        n,
        role,
        hash,
        type: HandshakeTypes.GetNeighborsRequest,
      });
      const response: Return<GetNeighborsResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.peers;
    } catch (err: unknown) {
      BaseProto.handleError(err, "getNearestRemotePeers");
      return [];
    }
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
  protected async getNearestPeers(query: Base64, n: number, role: Role): Promise<Address[]> {
    const hash: Base64 = HandshakeProto.hashFromData(query);
    let peers: PeerDistancePair[] = this.getNearestLocalPairs(hash, n);

    let prevMinDistance: number = peers[0]?.distance ?? Infinity;
    for (let i: number = 0; i < HandshakeProto.MAX_RECURSION_DEPTH; i++) {
      // Query the wide network for more peers
      const wideNetPromises: Promise<Address[]>[] = peers
        .map(({ peer }: PeerDistancePair) => this.getNearestRemotePeers(peer, hash, n, role))
        .map((promise: Promise<Address[]>) => this.getWithTimeout(promise, HandshakeProto.HEAVY_CALLBACK_TIMEOUT));

      // Wait for all wide network queries to settle
      const wideNetResults: PromiseSettledResult<Address[]>[] = await Promise.allSettled(wideNetPromises);
      const validResults: Address[] = wideNetResults
        .filter((res): res is PromiseFulfilledResult<Address[]> => res.status === "fulfilled")
        .flatMap(({ value }: PromiseFulfilledResult<Address[]>) => value);

      peers = orderPeers(hash, validResults);

      const currMinDistance: number = peers[0]?.distance ?? prevMinDistance;
      if (currMinDistance >= prevMinDistance || peers.length === 0) {
        break;
      }

      prevMinDistance = currMinDistance;
    }

    return peers.map((pair: PeerDistancePair) => pair.peer).slice(0, n);
  }

  private addPeer(peerId: PeerId, role: Role): void {
    const address: Address = encodePeerId(peerId);
    const timestamp: number = Date.now();
    this.peersCache.set(address, { peerId, role, timestamp });
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    if (this.peersCache.has(encodePeerId(detail))) {
      this.peersCache.delete(encodePeerId(detail));
    }
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    if (!detail.protocols.includes(HandshakeProto.PROTOCOL)) {
      return;
    }

    try {
      const request: InitiationRequest = this.stampRequest({ role: this.role, type: HandshakeTypes.InitiationRequest });
      const response: Return<PingResponse> = await this.sendRequest(detail.peerId, request);
      assert(response.success, `Failed to initiate handshake with ${detail.peerId}`);

      this.addPeer(detail.peerId, response.data.role);
    } catch (err: unknown) {
      BaseProto.handleError(err, "initiateHandshake");
    }
  }

  private onInitiationRequest({ detail }: CustomEvent<Parcel<InitiationRequest>>): void {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp in initiation request");
  }

  private onPingRequest({ detail }: CustomEvent<Parcel<PingRequest>>): PingResponse {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp in ping request");
    return { role: this.role, type: HandshakeTypes.PingResponse };
  }

  private onPeersRequest({ detail }: CustomEvent<Parcel<GetNeighborsRequest>>): GetNeighborsResponse {
    assert(this.verifyStamp(detail.batch.payload), "Invalid stamp");
    const peers: Address[] = this.getNearestLocalPeers(detail.batch.payload.hash, detail.batch.payload.n);
    return { peers, type: HandshakeTypes.GetNeighborsResponse };
  }

  private peerIsStale(peerId: PeerId, now: number = Date.now()): boolean {
    const address: Address = encodePeerId(peerId);
    const peerData: PeerInfo | undefined = this.peersCache.get(address);
    if (!peerData) {
      return true;
    }

    const age: number = now - peerData.timestamp;
    return age > HandshakeProto.PEER_FRESHNESS_THRESHOLD;
  }

  private async auditPeers(): Promise<void> {
    const now: number = Date.now();

    Array.from(this.peersCache.entries())
      .filter(([_addr, { peerId }]) => this.peerIsStale(peerId, now))
      .map(([addr]) => decodeAddress(addr))
      .forEach(this.requestPulse.bind(this));

    this.getNeighbors(HandshakeProto.AUDIT_NET_SIZE, "tower").then((neighbors: Address[]) => {
      neighbors.forEach((neighbor: Address) => {
        const peerId: PeerId = decodeAddress(neighbor);
        this.addPeer(peerId, "tower");
      });
    });
  }

  public async start(): Promise<void> {
    await super.start();

    this.addEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.addEventListener(HandshakeTypes.PingRequest, this.onPingRequest.bind(this));
    this.addEventListener(HandshakeTypes.GetNeighborsRequest, this.onPeersRequest.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.peerAuditTimer = setInterval(this.auditPeers.bind(this), HandshakeProto.PEER_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();

    this.removeEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.removeEventListener(HandshakeTypes.PingRequest, this.onPingRequest.bind(this));
    this.removeEventListener(HandshakeTypes.GetNeighborsRequest, this.onPeersRequest.bind(this));
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));

    this.peersCache.clear();

    if (this.peerAuditTimer !== undefined) {
      clearInterval(this.peerAuditTimer);
      this.peerAuditTimer = undefined;
    }
  }
}
