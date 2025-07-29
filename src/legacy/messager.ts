import { createLibp2p } from "libp2p";

import { bootstrap } from "@libp2p/bootstrap";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

import { persistentPeerStore } from "@libp2p/peer-store";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { AbortOptions, multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
import { gossipsub, GossipSub, GossipsubMessage } from "@chainsafe/libp2p-gossipsub";
import { mdns } from "@libp2p/mdns";

import { peerIdFromPrivateKey, peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import {
  Connection,
  EventHandler,
  Libp2pEvents,
  Message,
  Peer,
  PeerId,
  PeerInfo,
  PrivateKey,
  ServiceMap,
  Startable,
  Stream,
  StreamHandler,
} from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
// import { convertPeerId } from "@libp2p/kad-dht/dist/src/utils";

import { fromString, toString } from "uint8arrays";
import { Uint8ArrayList } from "uint8arraylist";
import { pipe } from "it-pipe";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2";

import { keys } from "@libp2p/crypto";
import { Components } from "libp2p/dist/src/components";

import { assert } from "../utils.js";

interface Letter {
  sender: string;
  recipient: string;
  message: string;
  timestamp: number;
}

type Payload = ChallengeRequest | ChallengeResponse | PackageDropOff | CheckMessageBox | PackageDelivery;

interface ChallengeRequest {
  type: PayloadType.ChallengeRequest;
  callbackId: string;
  challenge: string;
}

interface ChallengeResponse {
  type: PayloadType.ChallengeResponse;
  callbackId: string;
  response: string;
}

interface PackageDropOff {
  type: PayloadType.PackageDropOff;
  envelope: Letter[];
}

interface CheckMessageBox {
  type: PayloadType.CheckMessageBox;
  callbackId: string;
  recipient: string;
}

interface PackageDelivery {
  type: PayloadType.PackageDelivery;
  callbackId: string;
  envelope: Letter[];
}

enum PayloadType {
  ChallengeRequest = "whats_the_password",
  ChallengeResponse = "open_sesame",
  PackageDropOff = "deliver_this_and_make_it_snappy",
  CheckMessageBox = "hey_mailman_got_anything_for_me",
  PackageDelivery = "just_the_usual_tell_the_misses_i_said_hi",
}

class MessagingProto extends GossipSub {
  public static readonly protocol: string = "/secret-handshake/proto/0.1.1";
  private static readonly password: string = "Attractor-Impolite-Oversold";
  private static readonly grip: Uint8Array = blake2b(MessagingProto.password, { dkLen: 32 });

  private peerId: PeerId;
  private connectionManager: ConnectionManager;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();
  private messageCache: Map<string, Letter[]> = new Map();

  constructor(components: Components) {
    super(components);

    this.peerId = components.peerId;
    this.connectionManager = components.connectionManager;
    this.registrar = components.registrar;
  }

  public static Handshake(): (components: Components) => MessagingProto {
    return (components: Components) => new MessagingProto(components);
  }

  private static isLetter(item: unknown): item is Letter {
    if (!item || typeof item !== "object") {
      return false;
    }
    const { sender, recipient, message, timestamp } = item as Letter;
    return (
      typeof sender === "string" &&
      typeof recipient === "string" &&
      typeof message === "string" &&
      typeof timestamp === "number"
    );
  }

  private static isEnvelope(envelope: unknown): envelope is Letter[] {
    if (!envelope || !Array.isArray(envelope)) {
      return false;
    }
    return envelope.every(MessagingProto.isLetter);
  }

  private static isPayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch ((payload as Payload).type) {
      case PayloadType.ChallengeRequest:
        return "callbackId" in payload && "challenge" in payload;
      case PayloadType.ChallengeResponse:
        return "callbackId" in payload && "response" in payload;
      case PayloadType.PackageDropOff:
        return "envelope" in payload && MessagingProto.isEnvelope(payload.envelope);
      case PayloadType.CheckMessageBox:
        return "callbackId" in payload && "recipient" in payload;
      case PayloadType.PackageDelivery:
        return "callbackId" in payload && "envelope" in payload && MessagingProto.isEnvelope(payload.envelope);
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
    if (connection.status !== "open") {
      console.warn("Connection is not open");
      return;
    }

    try {
      const outgoing: Stream = await connection.newStream(MessagingProto.protocol, options);
      const payloadString: string = JSON.stringify(payload);
      await pipe([Buffer.from(payloadString)], outgoing);
      outgoing.close();
    } catch {
      console.warn("Failed to send payload:", payload);
      connection.close();
    }
  }

  private solveChallenge({ callbackId, challenge }: ChallengeRequest): ChallengeResponse {
    const challengeBuffer: Uint8Array = Buffer.from(challenge, "utf-8");
    const response: Uint8Array = ed25519.sign(challengeBuffer, MessagingProto.grip);
    return { type: PayloadType.ChallengeResponse, callbackId, response: Buffer.from(response).toString("hex") };
  }

  private async handleMessageEvent(event: CustomEvent<GossipsubMessage>): Promise<void> {
    const { data } = event.detail.msg;
    const rawMessage: string = toString(data, "utf-8");

    let payload: Payload;
    try {
      payload = JSON.parse(rawMessage);
      if (!MessagingProto.isPayload(payload)) {
        console.warn("Invalid payload received:", payload);
        return;
      }
    } catch {
      console.warn("Invalid payload.", rawMessage);
      return;
    }

    switch (payload.type) {
      case PayloadType.PackageDropOff: {
        for (const letter of payload.envelope) {
          const { sender, recipient, message, timestamp } = letter;
          const stockpile: Letter[] = this.messageCache.get(recipient) || [];
          stockpile.push({ sender, recipient, message, timestamp });
          this.messageCache.set(recipient, stockpile);
        }
        console.log(
          `You've got mail from ${payload.envelope[0].sender} to ${payload.envelope[0].recipient} at ${payload.envelope[0].timestamp}: ${payload.envelope[0].message}`
        );
        break;
      }
    }
  }

  async start(): Promise<void> {
    await super.start();

    await this.registrar.handle(MessagingProto.protocol, async ({ connection, stream }: any) => {
      const rawMessage: string = await MessagingProto.decodeStream(stream);
      stream.close();

      let payload: Payload;
      try {
        payload = JSON.parse(rawMessage);
        if (!MessagingProto.isPayload(payload)) {
          console.warn("Invalid payload received:", payload);
          return;
        }
      } catch {
        console.warn("Invalid payload.", rawMessage);
        return;
      }

      switch (payload.type) {
        case PayloadType.ChallengeRequest: {
          const response: ChallengeResponse = this.solveChallenge(payload);
          await MessagingProto.sendPayload(connection, response);
          break;
        }
        case PayloadType.ChallengeResponse: {
          this.callbackQueue.get(payload.callbackId)?.(payload);
          break;
        }
      }
    });
  }
  async afterStart(): Promise<void> {
    this.addEventListener("gossipsub:message", this.handleMessageEvent.bind(this));
    this.subscribe(MessagingProto.password);
  }

  async stop(): Promise<void> {
    this.removeEventListener("gossipsub:message", this.handleMessageEvent.bind(this));
    this.unsubscribe(MessagingProto.password);

    this.callbackQueue.clear();
    await this.registrar.unhandle(MessagingProto.protocol);
  }

  public async sendChallenge(peerId: PeerId | Multiaddr | Multiaddr[], options?: AbortOptions): Promise<void> {
    const callbackId: string = crypto.randomUUID();
    const challenge: string = crypto.randomUUID();
    const payload: ChallengeRequest = { type: PayloadType.ChallengeRequest, callbackId, challenge };

    const connection: Connection = await this.connectionManager.openConnection(peerId, options);
    await MessagingProto.sendPayload(connection, payload, options);

    this.callbackQueue.set(callbackId, async (pl: Payload) => {
      assert(MessagingProto.isPayload(pl), "Invalid payload received");
      assert(pl.type === PayloadType.ChallengeResponse, "Expected open_sesame response");
      assert(pl.callbackId === callbackId, "Callback ID mismatch");

      const responseBuffer: Uint8Array = fromString(pl.response, "hex");
      const challengeBuffer: Uint8Array = fromString(challenge, "utf-8");

      const dueGuard: Uint8Array = ed25519.getPublicKey(MessagingProto.grip);
      const isValidResponse: boolean = ed25519.verify(responseBuffer, challengeBuffer, dueGuard);
      if (!isValidResponse) {
        console.error(`Invalid response for callback ID: ${callbackId}`);
        await connection.close();
      }

      this.callbackQueue.delete(callbackId);
    });
  }

  public async sendMessage(destination: PeerId | Multiaddr | Multiaddr[], message: string, options?: AbortOptions) {
    const connection: Connection = await this.connectionManager.openConnection(destination, options);
    const recipient: string = connection.remotePeer.toString();

    const sender: string = this.peerId.toString();
    const letter: Letter = { sender, recipient, message, timestamp: Date.now() };

    const payload: PackageDropOff = { type: PayloadType.PackageDropOff, envelope: [letter] };

    while (this.getSubscribers(MessagingProto.password).length < 1) {
      console.log("Waiting for subscribers to the handshake protocol...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const messageBuffer: Uint8Array = Buffer.from(JSON.stringify(payload), "utf-8");
    return this.publish(MessagingProto.password, messageBuffer);
  }
}

const stockOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

const clientOptions = {
  ...stockOptions,
  transports: [circuitRelayTransport(), webRTC(), webRTCDirect(), webSockets()],
};

async function getNewClient(addresses: string[], privateKey?: PrivateKey) {
  return createLibp2p({
    ...clientOptions,
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    peerDiscovery: [mdns()],
    privateKey,
    services: {
      pubsub: gossipsub(),
      dht: kadDHT(),
      identify: identify(),
      ping: ping(),
      handshake: MessagingProto.Handshake(),
    },
  });
}

async function main() {
  console.log("Starting application...");

  const seed: Uint8Array = new Uint8Array(32);
  seed.set(Buffer.from("AppleMango"));
  const privateKey: PrivateKey = await keys.generateKeyPairFromSeed("Ed25519", seed);
  const peerId: PeerId = peerIdFromPrivateKey(privateKey);
  console.log("Peer ID:", peerId.toString());

  const listeners: string[] = ["/ip4/0.0.0.0/udp/4998/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"];
  const client = await getNewClient(listeners, privateKey);

  const neighbor = await getNewClient(["/ip4/0.0.0.0/udp/4999/webrtc-direct"]);

  await client.start();
  await neighbor.start();

  client.addEventListener("peer:identify", async ({ detail }) => {
    console.log(detail.peerId.toString(), "identified");

    if (!detail.protocols.includes(MessagingProto.protocol)) {
      console.warn(`Peer ${detail.peerId} does not support the handshake protocol`);
      detail.connection.close();
      return;
    }

    await client.services.handshake.sendChallenge(detail.peerId);
  });

  while (client.getPeers().length < 1) {
    console.log(client.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.getPeers().length);

  await client.services.handshake.sendMessage(neighbor.peerId, "Howdy, neighbor!");

  // while (client.getPeers().length !== 0) {
  //   console.log(client.services.handshake.getSubscribers(MessagingProto.password).length, "peers connected");
  //   await new Promise((resolve) => setTimeout(resolve, 10000));
  // }

  // while (client.services.pubsub.getSubscribers(magicWord).length < 1) {
  //   console.log(client.getPeers().length, "peers connected");
  //   console.log(client.services.pubsub.getSubscribers(magicWord).length, "subscribers");
  //   await new Promise((resolve) => setTimeout(resolve, 10000));
  // }

  // await client.services.pubsub.publish(magicWord, Buffer.from("Hello, Disco!", "utf-8"));

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Stopping application...");
  await client.stop();
  await neighbor.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
