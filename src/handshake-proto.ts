import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";
import speakeasy from "speakeasy";

import { bytesToBase64, encodePeerId } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import BaseProto from "./base-proto.js";
import assert from "assert";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private readonly initiationToken: string;

  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";

  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<Address, PeerData> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE) {
    super(components);
    this.events = components.events;

    const token: Uint8Array = blake2b(passphrase);
    this.initiationToken = bytesToBase64(token);
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  protected stampRequest<T extends RequestData>(payload: Omit<T, "stamp">): T {
    const data: string = JSON.stringify(payload);

    const otp: string = speakeasy.totp({ secret: this.initiationToken });
    const signature: Uint8Array = blake2b(data, otp);
    const stamp: Base64 = bytesToBase64(signature);

    return { ...payload, stamp } as T;
  }

  protected verifyStamp(payload: Partial<RequestData>): boolean {
    if (!payload.stamp) {
      console.warn("Missing stamp");
      return false;
    }

    const data: string = JSON.stringify({ ...payload, stamp: undefined });
    const otp: string = speakeasy.totp({ secret: this.initiationToken });
    const expectedSignature: Uint8Array = blake2b(data, otp);

    return bytesToBase64(expectedSignature) === payload.stamp;
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
