import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import { bytesToBase64, encodePeerId } from "./tools/typing.js";
import { blake2b, totp } from "./tools/cryptography.js";
import BaseProto from "./base-proto.js";
import { assert } from "./tools/utils.js";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
  [HandshakeTypes.RequestPulse]: CustomEvent<Parcel<RequestPulse>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
  RequestPulse = "handshake:request-pulse",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private readonly initiationToken: Uint8Array;

  private static readonly PEER_AUDIT_INTERVAL: number = 60_000; // 1 minute
  private static readonly PEER_FRESHNESS_THRESHOLD: number = 120_000; // 2 minutes
  private peerAuditTimer: NodeJS.Timeout | null = null;

  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<Address, PeerData> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE) {
    super(components);
    this.events = components.events;
    this.initiationToken = blake2b(passphrase);
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  /**
   * Generates a stamped request object by signing the payload with a time-based one-time password (TOTP)
   * and a Blake2b hash, then encoding the signature as a Base64 string.
   *
   * @template T - The type of the request data, which must include a `stamp` property.
   * @param payload - The request payload without the `stamp` property.
   * @returns The payload object with an added `stamp` property containing the Base64-encoded signature.
   */
  protected stampRequest<T extends ReqData>(payload: Omit<T, "stamp">): T {
    const data: string = JSON.stringify(payload);

    const otp: Uint8Array = totp(this.initiationToken);
    const sig: Uint8Array = blake2b(data, otp);
    const stamp: Base64 = bytesToBase64(sig);

    return { ...payload, stamp } as T;
  }

  /**
   * Verifies the integrity and authenticity of a payload using a time-based one-time password (TOTP) and a Blake2b signature.
   *
   * The method checks if the payload contains a `stamp` property. It then generates a signature by:
   * - Serializing the payload (excluding the `stamp` property).
   * - Generating a TOTP value using the `initiationToken`.
   * - Hashing the serialized data with the TOTP value using Blake2b.
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
    const otp: Uint8Array = totp(this.initiationToken);
    const expectedSig: Uint8Array = blake2b(data, otp);
    return bytesToBase64(expectedSig) === payload.stamp;
  }

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

  protected async sendRequest<T extends ReqData, U extends ResData>(peerId: PeerId, payload: T): Promise<Return<U>> {
    const address: Address = encodePeerId(peerId);

    if (!this.peers.has(address) || this.peerIsStale(peerId)) {
      await this.requestPulse(peerId);
    }

    return this.sendRequest(peerId, payload);
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
    this.addEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.addEventListener(HandshakeTypes.RequestPulse, this.onRequestPulse.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.peerAuditTimer = setInterval(this.auditPeers.bind(this), HandshakeProto.PEER_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();
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
