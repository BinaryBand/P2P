import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";

import { blake2b } from "@noble/hashes/blake2";
import { ed25519 } from "@noble/curves/ed25519";
import { LRUCache } from "lru-cache";

import BaseProto from "./base-proto.js";
import { assert, bufferFromEncoded, encodedFromBuffer, generateUuid } from "./tools/utils.js";

export interface HandshakeEvents extends Record<keyof HandshakeTypes, CustomEvent> {
  [HandshakeTypes.ChallengeRequest]: CustomEvent<PackagedPayload<ChallengeRequest>>;
  [HandshakeTypes.ChallengeResponse]: CustomEvent<PackagedPayload<ChallengeResponse>>;
}

export enum HandshakeTypes {
  ChallengeRequest = "handshake:challenge",
  ChallengeResponse = "handshake:submit-proof",
}

const PASSPHRASE: string = "reconcile-stranger-clash";

export default class HandshakeProto<T extends HandshakeEvents> extends BaseProto<T> {
  private readonly initiationToken: Uint8Array;

  protected readonly privateKey: Uint8Array;
  protected events: TypedEventTarget<Libp2pEvents>;
  protected peers: LRUCache<Base58, PeerId> = new LRUCache({ max: 256 });

  constructor(components: Components, passphrase: string = PASSPHRASE) {
    super(components);
    this.privateKey = components.privateKey.raw.subarray(0, 32);
    this.events = components.events;
    this.initiationToken = blake2b(passphrase, { dkLen: 32 });
    components.connectionGater.denyDialPeer = this.filterPeers.bind(this);
  }

  public static Handshake<T extends {}>(
    passphrase?: string
  ): (params: Components) => HandshakeProto<T & HandshakeEvents> {
    return (params: Components) => new HandshakeProto(params, passphrase);
  }

  private filterPeers(peerId: PeerId): boolean {
    return this.peers.has(peerId.toString());
  }

  private async dropPeer({ detail }: CustomEvent<PeerId>): Promise<void> {
    this.peers.delete(detail.toString());
    console.info(`Peer ${detail} disconnected`);
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    console.info(`${this.peerId}: Initiating handshake with peer: ${detail.peerId.toString()}`);

    // Check if the peer supports the handshake protocol
    if (!detail.protocols.includes(HandshakeProto.PROTOCOL)) {
      console.warn(`${this.peerId}: Peer ${detail.peerId} does not support handshake protocol`);
      return;
    }

    // Package the challenge request
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const challengePayload: ChallengeRequest = {
      challenge: encodedFromBuffer(challengeBuffer),
      type: HandshakeTypes.ChallengeRequest,
    };

    const callbackId: Uuid = generateUuid();
    try {
      // Send the challenge request to the peer and wait for a response
      const result: ChallengeResponse = await this.sendPayload(detail.peerId, challengePayload, callbackId);
      const proofBuffer: Uint8Array = bufferFromEncoded(result.proof);
      const dueGuard: Uint8Array = ed25519.getPublicKey(this.initiationToken);
      assert(ed25519.verify(proofBuffer, challengeBuffer, dueGuard), "Invalid proof provided");

      // Wrap up by sending a confirmation message
      this.sendConfirmation(detail.peerId, callbackId);
    } catch (err) {
      this.sendRejection(detail.peerId, callbackId, "Handshake failed");
      console.warn(`${this.peerId}: Handshake with peer ${detail.peerId} failed`, err);
    }
  }

  private async onChallengeRequest({ detail }: CustomEvent<PackagedPayload<ChallengeRequest>>): Promise<void> {
    const peerId: PeerId = peerIdFromString(detail.from);
    try {
      // Prove the challenge by signing it with the initiation token
      const challengeBuffer: Uint8Array = bufferFromEncoded(detail.payload.challenge);
      const proofBuffer: Uint8Array = ed25519.sign(challengeBuffer, this.initiationToken);
      const dueGuard: Uint8Array = ed25519.getPublicKey(this.initiationToken);
      assert(ed25519.verify(proofBuffer, challengeBuffer, dueGuard), "Failed to sign challenge");

      // Send the challenge response back to the peer
      const proofPayload: ChallengeResponse = {
        proof: encodedFromBuffer(proofBuffer),
        type: HandshakeTypes.ChallengeResponse,
      };
      await this.sendPayload(peerId, proofPayload, detail.callbackId);

      // Add the peer to the known peers list when the challenge is confirmed
      this.peers.set(detail.from, peerId);
    } catch (err) {
      this.sendRejection(peerId, detail.callbackId, "Failed to confirm challenge");
      console.warn(`${this.peerId}: Failed to confirm challenge with peer ${peerId}`, err);
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
