import { AbortOptions } from "@multiformats/multiaddr";

import { Uint8ArrayList } from "uint8arraylist";
import { pipe } from "it-pipe";

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2";

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

import { LRUCache } from "lru-cache";

import { assert } from "./utils.js";

const PREFERRED_ENCODING: BufferEncoding = "base64";

enum PayloadType {
  ChallengeRequest = "whats_the_password",
  ChallengeResponse = "open_sesame",
}

type Payload = ChallengeRequest | ChallengeResponse;

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

export interface HandshakeEvents extends Libp2pEvents {
  "handshake:challenge": CustomEvent<ChallengeRequest>;
  "handshake:response": CustomEvent<ChallengeResponse>;
}

export default class HandshakeProto extends TypedEventEmitter<HandshakeEvents> implements Startable {
  public static readonly protocol: string = "/secret-handshake/proto/0.1.4";
  private static readonly initiation: string = "Attractor-Impolite-Oversold";
  private static readonly grip: Uint8Array = blake2b(HandshakeProto.initiation, { dkLen: 32 });

  private connectionManager: ConnectionManager;
  private events: TypedEventTarget<Libp2pEvents>;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();
  private peers: LRUCache<string, PeerId> = new LRUCache<string, PeerId>({ max: 100 });

  constructor(components: Components) {
    super();
    this.connectionManager = components.connectionManager;
    this.events = components.events;
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
      default:
        return false;
    }
  }

  private async getConnection(peerId: PeerId, options?: AbortOptions): Promise<Connection> {
    const connections: Connection[] = this.connectionManager
      .getConnections(peerId)
      .filter((conn) => conn.direction === "outbound");
    const connection: Connection = connections[0] ?? (await this.connectionManager.openConnection(peerId, options));
    return connection;
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
    const callbackIdBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const challengeBuffer: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
    const payload: ChallengeRequest = {
      callbackId: Buffer.from(callbackIdBuffer).toString(PREFERRED_ENCODING),
      challenge: Buffer.from(challengeBuffer).toString(PREFERRED_ENCODING),
      type: PayloadType.ChallengeRequest,
    };

    await this.sendPayload(peerId, payload, options);

    this.callbackQueue.set(payload.callbackId, async (pl: Payload) => {
      assert(HandshakeProto.isHandshakePayload(pl), "Invalid payload received");
      assert(pl.type === PayloadType.ChallengeResponse, "Expected open_sesame response");

      const dueGuard: Uint8Array = ed25519.getPublicKey(HandshakeProto.grip);
      const responseBuffer: Uint8Array = Buffer.from(pl.challengeResponse, PREFERRED_ENCODING);

      if (!ed25519.verify(responseBuffer, challengeBuffer, dueGuard)) {
        console.warn(`Invalid response for callback ID: ${payload.callbackId}`);
        await this.connectionManager.closeConnections(peerId, options);
      } else {
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

  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await HandshakeProto.decodeStream(stream);
    stream.close();

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
    }
  }

  public async start(): Promise<void> {
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.addEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    await this.registrar.handle(HandshakeProto.protocol, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.dropPeer.bind(this));
    this.removeEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    await this.registrar.unhandle(HandshakeProto.protocol);
    this.callbackQueue.clear();
  }
}
