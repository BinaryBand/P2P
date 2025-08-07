import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import { bytesToBase64, encodePeerId } from "./tools/typing.js";
import { blake2b, totp } from "./tools/cryptography.js";
import BaseProto from "./base-proto.js";
import assert from "assert";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private readonly initiationToken: Uint8Array;

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
   * Stamps a request payload with a cryptographic signature.
   *
   * This method takes a payload object (excluding the `stamp` property), serializes it,
   * generates a one-time password (OTP) using the initiation token, and creates a signature
   * using the Blake2b hash algorithm. The resulting signature is encoded in Base64 and added
   * to the payload as the `stamp` property.
   *
   * @typeParam T - The type of the request data, which must include a `stamp` property.
   * @param payload - The request payload object without the `stamp` property.
   * @returns The payload object with the generated `stamp` property included.
   */
  protected stampRequest<T extends ReqData>(payload: Omit<T, "stamp">): T {
    const data: string = JSON.stringify(payload);

    const otp: Uint8Array = totp(this.initiationToken);
    const sig: Uint8Array = blake2b(data, otp);
    const stamp: Base64 = bytesToBase64(sig);

    return { ...payload, stamp } as T;
  }

  /**
   * Verifies the integrity and authenticity of a payload using a time-based one-time password (TOTP) and a Blake2b hash.
   *
   * This method checks if the payload contains a valid `stamp` property. It then generates a hash signature
   * from the payload (excluding the `stamp`), using a TOTP derived from the `initiationToken`. The method
   * compares the base64-encoded expected signature with the provided `stamp` to determine validity.
   *
   * @param payload - A partial request data object that may contain a `stamp` property.
   * @returns `true` if the `stamp` is present and matches the expected signature; otherwise, `false`.
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

  private addPeer(peerId: PeerId): void {
    this.peers.set(encodePeerId(peerId), { peerId });
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    console.info(`Peer ${detail} disconnected`);
    this.peers.delete(encodePeerId(detail));
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

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));
    this.peers.clear();
  }
}
