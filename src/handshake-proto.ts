import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";

import { ed25519 } from "@noble/curves/ed25519";
import { LRUCache } from "lru-cache";

import BaseProto from "./base-proto.js";
import { quickHash } from "./tools/messenger.js";
import { assert, bufferFromEncoded, encodedFromBuffer } from "./tools/utils.js";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.TokenRequest]: CustomEvent<Parcel<TokenRequest>>;
}

export enum HandshakeTypes {
  TokenRequest = "handshake:token-request",
  TokenResponse = "handshake:token-response",
}

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private readonly initiationToken: Uint8Array;

  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private static readonly TOKEN_TIMEOUT: number = 60 * 60 * 1000; // 1 hour

  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<Base58, PeerData> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE) {
    super(components);
    this.events = components.events;

    const token: Uint8Array = quickHash(passphrase);
    this.initiationToken = token;
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  private addPeer(peerId: PeerId, token: Token): void {
    this.peers.set(peerId.toString(), { peerId, token });
  }

  protected async getPeerToken(peerId: PeerId): Promise<Token | undefined> {
    const peerData: PeerData | undefined = this.peers.get(peerId.toString());

    const remoteTokenCallback = async () => {
      const tokenRequest: TokenRequest = { type: HandshakeTypes.TokenRequest };
      const response: Return<TokenResponse> = await this.sendRequest(peerId, tokenRequest);
      assert(response.success, `Failed to get token from peer ${peerId}`);
      return response.data.token;
    };

    return peerData?.token ?? remoteTokenCallback();
  }

  private createToken(peerId: Base58): Token {
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const challenge: Encoded = encodedFromBuffer(challengeBuffer);
    const initiationToken: Encoded = encodedFromBuffer(this.initiationToken);

    const signedAt: number = Date.now();
    const validFor: number = HandshakeProto.TOKEN_TIMEOUT;

    const signHere: Uint8Array = quickHash(`${challenge} ${signedAt} ${validFor} ${initiationToken} ${peerId}`);
    const sig: Uint8Array = ed25519.sign(signHere, this.sk);
    const signature: Encoded = encodedFromBuffer(sig);
    return { challenge, peerId, signature, signedAt, validFor };
  }

  private verifyToken({ challenge, peerId, signature, signedAt, validFor }: Token, publicKey: Uint8Array): boolean {
    const initiationToken: Encoded = encodedFromBuffer(this.initiationToken);

    const expiration: number = signedAt + validFor;
    if (Date.now() > expiration) {
      console.warn(`Token for peer ${peerId} has expired`);
      return false;
    }

    const signHere: Uint8Array = quickHash(`${challenge} ${signedAt} ${validFor} ${initiationToken} ${peerId}`);
    const sig: Uint8Array = bufferFromEncoded(signature);
    return ed25519.verify(sig, signHere, publicKey);
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    console.info(`Peer ${detail} disconnected`);
    this.peers.delete(detail.toString());
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    console.info(`${this.peerId}: Initiating handshake with peer: ${detail.peerId}`);

    try {
      const token: Token | undefined = await this.getPeerToken(detail.peerId);
      assert(token !== undefined, `No token found for peer ${detail.peerId}`);
      this.addPeer(detail.peerId, token);
    } catch (err) {
      console.warn(`Failed to initiate handshake with peer ${detail.peerId}:`, err);
    }
  }

  private onTokenRequest({ detail }: CustomEvent<Parcel<TokenRequest>>): TokenResponse {
    console.info(`${this.peerId}: Received token request from peer: ${detail.sender}`);

    const token: Token = this.createToken(this.peerId.toString());
    assert(this.verifyToken(token, this.pk), "Invalid token signature");
    const publicKey: Encoded = encodedFromBuffer(this.pk);
    return { publicKey, token, type: HandshakeTypes.TokenResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));
    super.addEventListener(HandshakeTypes.TokenRequest, this.onTokenRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));
    super.removeEventListener(HandshakeTypes.TokenRequest, this.onTokenRequest.bind(this));
    this.peers.clear();
  }

  public addEventListener<K extends keyof T, U extends ResponseData>(
    type: K,
    args: (evt: T[K]) => U | Promise<U>,
    opts?: AddEventListenerOptions
  ): void {
    const authWrapper = async (evt: T[K]): Promise<U> => {
      assert("token" in evt.detail.payload, "Token is required for this event");
      assert(this.verifyToken(evt.detail.payload.token, this.pk), "Invalid token format");
      return args(evt);
    };

    super.addEventListener(type, authWrapper, opts);
  }
}
