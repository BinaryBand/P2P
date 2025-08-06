import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";

import { ed25519 } from "@noble/curves/ed25519";
import { LRUCache } from "lru-cache";

import { base64ToBytes, bytesToBase64, encodePeerId } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";
import BaseProto from "./base-proto.js";

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
  protected peers: LRUCache<Address, PeerData> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE) {
    super(components);
    this.events = components.events;

    const token: Uint8Array = blake2b(passphrase);
    this.initiationToken = token;
  }

  public static Handshake<T extends HandshakeEvents>(passphrase?: string): (params: Components) => HandshakeProto<T> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  /**
   * Retrieves the token associated with a given peer.
   *
   * If the token is already cached in the local peer data, it is returned immediately.
   * Otherwise, a token request is sent to the remote peer to obtain the token.
   *
   * @param peerId - The identifier of the peer whose token is to be retrieved.
   * @returns A promise that resolves to the peer's token, or `undefined` if not available.
   */
  protected async getPeerToken(peerId: PeerId): Promise<Token | undefined> {
    const peerData: PeerData | undefined = this.peers.get(encodePeerId(peerId));

    const remoteTokenCallback = async () => {
      const tokenRequest: TokenRequest = { type: HandshakeTypes.TokenRequest };
      const response: Return<TokenResponse> = await this.sendRequest(peerId, tokenRequest);
      assert(response.success, `Failed to get token from peer ${peerId}`);
      return response.data.token;
    };

    return peerData?.token ?? remoteTokenCallback();
  }

  private createToken(peerId: Address): Token {
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const challenge: Base64 = bytesToBase64(challengeBuffer);
    const initiationToken: Base64 = bytesToBase64(this.initiationToken);

    const signedAt: number = Date.now();
    const validFor: number = HandshakeProto.TOKEN_TIMEOUT;

    const signHere: Uint8Array = blake2b(`${challenge} ${signedAt} ${validFor} ${initiationToken} ${peerId}`);
    const sig: Uint8Array = ed25519.sign(signHere, this.sk);
    const signature: Base64 = bytesToBase64(sig);
    return { challenge, peerId, signature, signedAt, validFor };
  }

  /**
   * Verifies the validity of a token by checking its expiration and signature.
   *
   * @param token - The token object containing challenge, peerId, signature, signedAt, and validFor.
   * @returns `true` if the token is valid and the signature is verified; otherwise, `false`.
   *
   * @remarks
   * - The token is considered expired if the current time exceeds `signedAt + validFor`.
   * - The signature is verified using Ed25519 and a hash of the token's contents.
   * - Logs a warning if the token has expired.
   */
  protected verifyToken({ challenge, peerId, signature, signedAt, validFor }: Token): boolean {
    const initiationToken: Base64 = bytesToBase64(this.initiationToken);

    const expiration: number = signedAt + validFor;
    if (Date.now() > expiration) {
      console.warn(`Token for peer ${peerId} has expired`);
      return false;
    }

    const signHere: Uint8Array = blake2b(`${challenge} ${signedAt} ${validFor} ${initiationToken} ${peerId}`);
    const sig: Uint8Array = base64ToBytes(signature);
    return ed25519.verify(sig, signHere, this.pk);
  }

  private addPeer(peerId: PeerId, token: Token): void {
    this.peers.set(encodePeerId(peerId), { peerId, token });
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    console.info(`Peer ${detail} disconnected`);
    this.peers.delete(encodePeerId(detail));
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    console.info(`${this.peerId}: Initiating handshake with peer: ${detail.peerId.toString()}`);

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

    const token: Token = this.createToken(encodePeerId(this.peerId));
    assert(this.verifyToken(token), "Invalid token signature");

    const publicKey: Base64 = bytesToBase64(this.pk);
    return { publicKey, token, type: HandshakeTypes.TokenResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(HandshakeTypes.TokenRequest, this.onTokenRequest.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(HandshakeTypes.TokenRequest, this.onTokenRequest.bind(this));
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));
    this.peers.clear();
  }
}
