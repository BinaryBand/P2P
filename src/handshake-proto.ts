import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";

import { blake2b } from "@noble/hashes/blake2";
import { ed25519 } from "@noble/curves/ed25519.js";
import { LRUCache } from "lru-cache";

import BaseProto from "./base-proto.js";
import { bufferFromString, stringFromBuffer } from "./utils.js";

export interface HandshakeEvents extends Record<keyof HandshakeTypes, CustomEvent> {
  [HandshakeTypes.ChallengeRequest]: CustomEvent<PackagedPayload<ChallengeRequest>>;
  [HandshakeTypes.ChallengeResponse]: CustomEvent<PackagedPayload<ChallengeResponse>>;
}

export enum HandshakeTypes {
  ChallengeRequest = "handshake:challenge",
  ChallengeResponse = "handshake:submit-proof",
}

const PASSPHRASE: string = "paralysis-stadium-dioxide-absentee-repeated-panoramic";

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private readonly initiationToken: Uint8Array;

  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<string, PeerId> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = PASSPHRASE) {
    super(components);
    this.events = components.events;
    this.initiationToken = blake2b(passphrase, { dkLen: 32 });
    components.connectionGater.denyDialPeer = this.filterPeers.bind(this);
  }

  public static Handshake<T extends {}>(): (
    params: Components,
    passphrase?: string
  ) => HandshakeProto<T & HandshakeEvents> {
    return (params: Components, passphrase?: string) => new HandshakeProto(params, passphrase);
  }

  private filterPeers(peerId: PeerId): boolean {
    return this.peers.has(peerId.toString());
  }

  private async dropPeer({ detail }: CustomEvent<PeerId>): Promise<void> {
    this.peers.delete(detail.toString());
    console.info(`Peer ${detail} disconnected`);
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    console.info(`${this.address}: Initiating handshake with peer: ${detail.peerId.toString()}`);

    const callbackId: string = crypto.randomUUID();
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));

    const challengePayload: ChallengeRequest = {
      challenge: stringFromBuffer(challengeBuffer),
      type: HandshakeTypes.ChallengeRequest,
    };

    try {
      const result: ChallengeResponse = await this.sendPayload(detail.peerId, challengePayload, callbackId);
      const proofBuffer: Uint8Array = bufferFromString(result.proof);

      const dueGuard: Uint8Array = ed25519.getPublicKey(this.initiationToken);
      if (ed25519.verify(proofBuffer, challengeBuffer, dueGuard)) {
        this.sendConfirmation(detail.peerId, callbackId);
        console.info(`${this.address}: Handshake with peer ${detail.peerId.toString()} completed successfully.`);
      } else {
        this.sendRejection(detail.peerId, callbackId, "Invalid proof provided");
        console.info(`${this.address}: Handshake with peer ${detail.peerId.toString()} failed due to invalid proof.`);
      }
    } catch {
      console.error(`${this.address}: Handshake with peer ${detail.peerId.toString()} failed`);
    }
  }

  private async onChallengeRequest({ detail }: CustomEvent<PackagedPayload<ChallengeRequest>>): Promise<void> {
    const challengeBuffer: Uint8Array = bufferFromString(detail.payload.challenge);
    const proofBuffer: Uint8Array = ed25519.sign(challengeBuffer, this.initiationToken);

    const proofPayload: ChallengeResponse = {
      proof: stringFromBuffer(proofBuffer),
      type: HandshakeTypes.ChallengeResponse,
    };

    const peerId: PeerId = peerIdFromString(detail.from);
    try {
      this.peers.set(detail.from, peerId);
      this.sendPayload(peerId, proofPayload, detail.callbackId);
      console.info(`${this.peerId}: Successfully connected to: ${detail.from}`);
    } catch (err) {
      this.sendRejection(peerId, detail.callbackId, "Failed to send challenge response");
      console.warn(`${this.address}: Failed to send challenge response to peer: ${detail.from}`, err);
    }
  }

  public async start(): Promise<void> {
    await super.start();
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.addEventListener(HandshakeTypes.ChallengeRequest, this.onChallengeRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.removeEventListener(HandshakeTypes.ChallengeRequest, this.onChallengeRequest.bind(this));
    this.peers.clear();
  }
}
