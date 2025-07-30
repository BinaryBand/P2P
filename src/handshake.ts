import { AbortOptions } from "@multiformats/multiaddr";
import { peerIdFromString } from "@libp2p/peer-id";

import { Uint8ArrayList } from "uint8arraylist";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import {
  Connection,
  IdentifyResult,
  IncomingStreamData,
  Libp2pEvents,
  PeerId,
  Startable,
  Stream,
  TypedEventEmitter,
  TypedEventTarget,
} from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import { Components } from "libp2p/dist/src/components";

import { assert } from "./utils.js";

const PREFERRED_ENCODING: BufferEncoding = "base64";

enum PayloadType {
  ChallengeRequest = "whats_the_password",
  ChallengeResponse = "open_sesame",
  HoldRequest = "hold_this_will_ya",
  DownloadMessages = "please_mr_postman",
  InboxDropoff = "here_are_your_messages",
}

type Payload = ChallengeRequest | ChallengeResponse | HoldRequest | DownloadMessages | InboxDropoff;

interface ChallengeRequest {
  callbackId: string;
  challenge: string;
  type: PayloadType.ChallengeRequest;
}

interface ChallengeResponse {
  callbackId: string;
  challengeResponse: string;
  type: PayloadType.ChallengeResponse;
}

interface HoldRequest {
  content: string;
  neighbors: [string, string];
  recipient: string;
  sender: string;
  timestamp: number;
  type: PayloadType.HoldRequest;
}

interface DownloadMessages {
  destination: string;
  type: PayloadType.DownloadMessages;
}

interface Envelope {
  content: string;
  sender: string;
  timestamp: number;
}

interface InboxDropoff {
  inbox: Envelope[];
  retrievedFrom: string;
  type: PayloadType.InboxDropoff;
}

export interface HandshakeEvents extends Libp2pEvents {
  "handshake:challenge": CustomEvent<ChallengeRequest>;
  "handshake:response": CustomEvent<ChallengeResponse>;
  "handshake:hold": CustomEvent<HoldRequest>;
  "handshake:download": CustomEvent<DownloadMessages>;
  "handshake:dropoff": CustomEvent<InboxDropoff>;
}

export default class HandshakeProto extends TypedEventEmitter<HandshakeEvents> implements Startable {
  public static readonly protocol: string = "/secret-handshake/proto/0.1.4";
  private static readonly initiation: string = "Attractor-Impolite-Oversold";
  private static readonly grip: Uint8Array = blake2b(HandshakeProto.initiation, { dkLen: 32 });

  private connectionManager: ConnectionManager;
  private events: TypedEventTarget<Libp2pEvents>;
  private peerId: PeerId;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();
  private limiterCache: LRUCache<string, number> = new LRUCache<string, number>({ ttl: 60000, max: 1024 });
  private peers: LRUCache<string, PeerId> = new LRUCache<string, PeerId>({ max: 128 });
  private storage: LRUCache<string, LRUCache<number, HoldRequest>> = new LRUCache<
    string,
    LRUCache<number, HoldRequest>
  >({ max: 2048, ttl: 60000 * 60 * 24 * 2 }); // 2 days

  constructor(components: Components) {
    super();
    this.connectionManager = components.connectionManager;
    this.events = components.events;
    this.peerId = components.peerId;
    this.registrar = components.registrar;
  }

  public static Handshake(): (params: Components) => HandshakeProto {
    return (params: Components) => new HandshakeProto(params);
  }

  private static isHandshakePayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch (payload.type) {
      case PayloadType.ChallengeRequest:
        return "callbackId" in payload && "challenge" in payload;
      case PayloadType.ChallengeResponse:
        return "callbackId" in payload && "challengeResponse" in payload;
      case PayloadType.HoldRequest:
        return (
          "content" in payload &&
          typeof payload.content === "string" &&
          "neighbors" in payload &&
          Array.isArray(payload.neighbors) &&
          payload.neighbors.length === 2 &&
          payload.neighbors.every((n) => typeof n === "string") &&
          "recipient" in payload &&
          typeof payload.recipient === "string"
        );
      case PayloadType.DownloadMessages:
        return "destination" in payload && typeof payload.destination === "string";
      case PayloadType.InboxDropoff:
        return "inbox" in payload && Array.isArray(payload.inbox);
      default:
        return false;
    }
  }

  private async getConnection(peerId: PeerId, options?: AbortOptions): Promise<Connection> {
    const connections: Connection[] = this.connectionManager
      .getConnections(peerId)
      .filter(({ direction }) => direction === "outbound");
    const connection: Connection = connections[0] ?? (await this.connectionManager.openConnection(peerId, options));
    return connection;
  }

  private async getRandomPeerIds(count: number): Promise<PeerId[]> {
    const peerIds: PeerId[] = Array.from(this.peers.values());
    if (peerIds.length === 0) {
      return [];
    }
    const shuffled: PeerId[] = peerIds.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  private static byteToString(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf-8");
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    return await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      let message: string = "";
      for await (const data of source) {
        const partials: string[] = [...data].map(HandshakeProto.byteToString);
        message += partials.join("");
      }
      return message;
    });
  }

  private async sendPayload(peerId: PeerId, payload: Payload, options?: AbortOptions): Promise<void> {
    const connection: Connection = await this.getConnection(peerId, options);
    try {
      const outgoing: Stream = await connection.newStream(HandshakeProto.protocol, options);
      const payloadString: string = JSON.stringify(payload);
      await pipe([Buffer.from(payloadString, "utf-8")], outgoing);
      outgoing.close();
    } catch {
      console.warn("Failed to send payload:", payload);
      connection.close();
    }
  }

  private initiateHandshake({ detail }: CustomEvent<IdentifyResult>): void {
    if (!detail.protocols.includes(HandshakeProto.protocol)) {
      console.warn(`Peer ${detail.peerId} does not support the handshake protocol`);
      detail.connection.close();
      return;
    }

    this.sendChallenge(detail.peerId);
  }

  private dropPeer({ detail }: CustomEvent<PeerId>): void {
    console.info(`Peer ${detail} disconnected`);
    this.peers.delete(detail.toString());
  }

  private async sendChallenge(peerId: PeerId, options?: AbortOptions): Promise<void> {
    const callbackId: string = crypto.randomUUID();
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const payload: ChallengeRequest = {
      callbackId,
      challenge: Buffer.from(challengeBuffer).toString(PREFERRED_ENCODING),
      type: PayloadType.ChallengeRequest,
    };

    await this.sendPayload(peerId, payload, options);

    this.callbackQueue.set(payload.callbackId, async (pl: Payload) => {
      assert(HandshakeProto.isHandshakePayload(pl), "Invalid payload received");
      assert(pl.type === PayloadType.ChallengeResponse, "Expected open_sesame response");

      const dueGuard: Uint8Array = ed25519.getPublicKey(HandshakeProto.grip);
      const responseBuffer: Uint8Array = Buffer.from(pl.challengeResponse, PREFERRED_ENCODING);
      if (ed25519.verify(responseBuffer, challengeBuffer, dueGuard)) {
        this.peers.set(peerId.toString(), peerId);
        this.callbackQueue.delete(payload.callbackId);
      }
    });
  }

  private static solveChallenge({ callbackId, challenge }: ChallengeRequest): ChallengeResponse {
    const challengeBuffer: Uint8Array = Buffer.from(challenge, PREFERRED_ENCODING);
    const response: Uint8Array = ed25519.sign(challengeBuffer, HandshakeProto.grip);
    const responseBuffer: string = Buffer.from(response).toString(PREFERRED_ENCODING);
    return { callbackId, challengeResponse: responseBuffer, type: PayloadType.ChallengeResponse };
  }

  private verifyChallengeResponse({ detail }: CustomEvent<ChallengeResponse>): void {
    this.callbackQueue.get(detail.callbackId)?.(detail);
  }

  private async handleHoldRequest({ detail }: CustomEvent<HoldRequest>): Promise<void> {
    const { recipient, timestamp } = detail;

    let recipientCache: LRUCache<number, HoldRequest> | undefined = this.storage.get(recipient);
    if (recipientCache === undefined) {
      recipientCache = new LRUCache<number, HoldRequest>({ max: 32 });
      this.storage.set(recipient, recipientCache);
    }

    recipientCache.set(timestamp, detail);
  }

  private async handleDownloadRequest({ detail }: CustomEvent<DownloadMessages>): Promise<void> {
    const { destination } = detail;

    const recipientCache: LRUCache<number, HoldRequest> | undefined = this.storage.get(destination);
    if (recipientCache !== undefined) {
      const peerId: PeerId = peerIdFromString(destination);

      const inbox: Envelope[] = [];
      for (const [timestamp, { content, sender }] of recipientCache.entries()) {
        inbox.push({ content, timestamp, sender });
      }

      const retrievedFrom: string = this.peerId.toString();
      const deliveryBag: InboxDropoff = { retrievedFrom, inbox, type: PayloadType.InboxDropoff };
      await this.sendPayload(peerId, deliveryBag);
    }

    const spreaders: PeerId[] = await this.getRandomPeerIds(3);
    for (const spreader of spreaders) {
      if (!spreader.equals(detail.destination)) {
        await this.sendPayload(spreader, detail);
      }
    }
  }

  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await HandshakeProto.decodeStream(stream);
    stream.close();

    const address: string = connection.remoteAddr.nodeAddress().address;
    const rateCount: number = this.limiterCache.get(address) ?? 0;
    if (128 < rateCount) {
      console.warn(`Rate limit exceeded for ${address}`);
      return;
    }
    this.limiterCache.set(address, rateCount + 1);

    const messageFingerprint: string = Buffer.from(blake2b(rawMessage)).toString(PREFERRED_ENCODING);
    const messageCount: number = this.limiterCache.get(messageFingerprint) ?? 0;
    if (0 < messageCount) {
      if (8 < messageCount) {
        console.warn(`Excessive duplicates: ${rawMessage}`);
      }
      return;
    }
    this.limiterCache.set(messageFingerprint, messageCount + 1);

    let payload: Payload;
    try {
      payload = JSON.parse(rawMessage);
      if (!HandshakeProto.isHandshakePayload(payload)) {
        console.warn("Invalid payload received:", payload);
        return;
      }
    } catch {
      console.warn("Invalid payload.", rawMessage);
      return;
    }

    switch (payload.type) {
      case PayloadType.ChallengeRequest:
        this.dispatchEvent(new CustomEvent("handshake:request", { detail: payload }));
        const res: ChallengeResponse = HandshakeProto.solveChallenge(payload);
        await this.sendPayload(connection.remotePeer, res);
        break;
      case PayloadType.ChallengeResponse:
        this.dispatchEvent(new CustomEvent("handshake:response", { detail: payload }));
        break;
      case PayloadType.HoldRequest:
        this.dispatchEvent(new CustomEvent("handshake:hold", { detail: payload }));
        break;
      case PayloadType.DownloadMessages:
        this.dispatchEvent(new CustomEvent("handshake:download", { detail: payload }));
        break;
      case PayloadType.InboxDropoff:
        this.dispatchEvent(new CustomEvent("handshake:dropoff", { detail: payload }));
    }
  }

  public async start(): Promise<void> {
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.addEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    this.addEventListener("handshake:hold", this.handleHoldRequest.bind(this));
    this.addEventListener("handshake:download", this.handleDownloadRequest.bind(this));
    await this.registrar.handle(HandshakeProto.protocol, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.removeEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    this.removeEventListener("handshake:hold", this.handleHoldRequest.bind(this));
    this.removeEventListener("handshake:download", this.handleDownloadRequest.bind(this));
    await this.registrar.unhandle(HandshakeProto.protocol);
    this.callbackQueue.clear();
  }

  public async sendMessage(destination: PeerId, content: string, options?: AbortOptions): Promise<void> {
    const sender: string = this.peerId.toString();
    const swarm: PeerId[] = await this.getRandomPeerIds(3);

    const partialPayload: Omit<HoldRequest, "neighbors" | "recipient"> = {
      content,
      sender,
      timestamp: Date.now(),
      type: PayloadType.HoldRequest,
    };

    const mailingList: Promise<void>[] = swarm.map((peerId: PeerId) => {
      const recipient: string = destination.toString();
      const neighbors: [string, string] = swarm.filter((n) => !n.equals(peerId)).map((n) => `${n}`) as [string, string];
      return this.sendPayload(peerId, { ...partialPayload, neighbors, recipient }, options);
    });

    await Promise.all(mailingList);
  }

  public async requestInbox(options?: AbortOptions): Promise<void> {
    const destination: string = this.peerId.toString();
    const payload: DownloadMessages = { destination, type: PayloadType.DownloadMessages };
    await Promise.all([...this.peers.values()].map((peerId: PeerId) => this.sendPayload(peerId, payload, options)));
  }
}
