import { AbortOptions, Multiaddr } from "@multiformats/multiaddr";

import { fromString, toString } from "uint8arrays";
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

import { assert } from "./utils.js";
import { GossipSub } from "@chainsafe/libp2p-gossipsub";

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
  response: string;
  type: PayloadType.ChallengeResponse;
}

interface HandshakeComponents extends Components {
  connectionManager: ConnectionManager;
  registrar: Registrar;
}

const PREFERRED_ENCODING: string = "utf-8";

export interface HandshakeEvents extends Libp2pEvents {
  "handshake:challenge": CustomEvent<ChallengeRequest>;
  "handshake:response": CustomEvent<ChallengeResponse>;
}

export default class HandshakeProto extends TypedEventEmitter<HandshakeEvents> implements Startable {
  public static readonly protocol: string = "/secret-handshake/proto/0.1.3";
  private static readonly initiation: string = "Attractor-Impolite-Oversold";
  private static readonly grip: Uint8Array = blake2b(HandshakeProto.initiation, { dkLen: 32 });

  private connectionManager: ConnectionManager;
  private events: TypedEventTarget<Libp2pEvents>;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();

  constructor(components: Components) {
    super();
    this.connectionManager = components.connectionManager;
    this.events = components.events;
    this.registrar = components.registrar;
  }

  public static Handshake(): (params: HandshakeComponents) => HandshakeProto {
    return (params: HandshakeComponents) => new HandshakeProto(params);
  }

  private static isHandshakePayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch (payload.type) {
      case PayloadType.ChallengeRequest:
        return "callbackId" in payload && "challenge" in payload;
      case PayloadType.ChallengeResponse:
        return "callbackId" in payload && "response" in payload;
      default:
        return false;
    }
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    return await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      let message: string = "";
      for await (const data of source) {
        const partials: string[] = [...data].map((bit: Uint8Array) => toString(bit, "utf-8"));
        message += partials.join("");
      }
      return message;
    });
  }

  private static async sendPayload(connection: Connection, payload: Payload, options?: AbortOptions): Promise<void> {
    try {
      const outgoing: Stream = await connection.newStream(HandshakeProto.protocol, options);
      const payloadString: string = JSON.stringify(payload);
      await pipe([fromString(payloadString, PREFERRED_ENCODING)], outgoing);
      outgoing.close();
    } catch {
      console.warn("Failed to send payload:", payload);
      connection.close();
    }
  }

  private solveChallenge({ detail }: CustomEvent<ChallengeRequest>): ChallengeResponse {
    const { callbackId, challenge } = detail;
    const challengeBuffer: Uint8Array = fromString(challenge, PREFERRED_ENCODING);
    const response: Uint8Array = ed25519.sign(challengeBuffer, HandshakeProto.grip);
    const responseBuffer: string = toString(response, PREFERRED_ENCODING);
    return { callbackId, response: responseBuffer, type: PayloadType.ChallengeResponse };
  }

  private verifyChallengeResponse({ detail }: CustomEvent<ChallengeResponse>): void {
    this.callbackQueue.get(detail.callbackId)?.(detail);
  }

  private initiateHandshake({ detail }: CustomEvent<IdentifyResult>): void {
    if (!detail.protocols.includes(HandshakeProto.protocol)) {
      console.warn(`Peer ${detail.peerId} does not support the handshake protocol`);
      detail.connection.close();
      return;
    }

    this.sendChallenge(detail.peerId);
  }

  private async sendChallenge(peerId: PeerId | Multiaddr | Multiaddr[], options?: AbortOptions): Promise<void> {
    const callbackId: string = crypto.randomUUID();
    const challenge: string = crypto.randomUUID();
    const payload: ChallengeRequest = { callbackId, challenge, type: PayloadType.ChallengeRequest };

    const connection: Connection = await this.connectionManager.openConnection(peerId, options);
    await HandshakeProto.sendPayload(connection, payload, options);

    const callback = async (pl: Payload) => {
      assert(HandshakeProto.isHandshakePayload(pl), "Invalid payload received");
      assert(pl.type === PayloadType.ChallengeResponse, "Expected open_sesame response");

      const dueGuard: Uint8Array = ed25519.getPublicKey(HandshakeProto.grip);
      const challengeBuffer: Uint8Array = fromString(challenge, PREFERRED_ENCODING);
      const responseBuffer: Uint8Array = fromString(pl.response, PREFERRED_ENCODING);

      if (!ed25519.verify(responseBuffer, challengeBuffer, dueGuard)) {
        console.warn(`Invalid response for callback ID: ${callbackId}`);
        await connection.close();
      } else {
        this.callbackQueue.delete(callbackId);
      }
    };

    this.callbackQueue.set(callbackId, callback);
  }

  private async onIncomingStream({ stream }: IncomingStreamData): Promise<void> {
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
        this.dispatchEvent(new CustomEvent("handshake:challenge", { detail: payload }));
        break;
      case PayloadType.ChallengeResponse:
        this.dispatchEvent(new CustomEvent("handshake:response", { detail: payload }));
        break;
    }
  }

  public async start(): Promise<void> {
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.addEventListener("handshake:challenge", this.solveChallenge.bind(this));
    this.addEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    await this.registrar.handle(HandshakeProto.protocol, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.removeEventListener("handshake:challenge", this.solveChallenge.bind(this));
    this.removeEventListener("handshake:response", this.verifyChallengeResponse.bind(this));
    await this.registrar.unhandle(HandshakeProto.protocol);
    this.callbackQueue.clear();
  }
}
