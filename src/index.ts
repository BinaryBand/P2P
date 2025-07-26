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
import { gossipsub, GossipSub } from "@chainsafe/libp2p-gossipsub";
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

// Known peers addresses
const bootstrapList = [
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

interface Envelope {
  sender: string;
  recipient: string;
  message: string;
  timestamp: number;
}

type Payload = ChallengeRequest | ChallengeResponse | SendMessage | CheckMessageBox | PackageDelivery;

interface ChallengeRequest {
  type: "whats_the_password";
  callbackId: string;
  challenge: string;
}

interface ChallengeResponse {
  type: "open_sesame";
  callbackId: string;
  response: string;
}

interface SendMessage {
  type: "deliver_this_message_and_make_it_snappy";
  messages: Envelope[];
}

interface CheckMessageBox {
  type: "hey_mailman_got_anything_for_me";
  callbackId: string;
  recipient: string;
}

interface PackageDelivery {
  type: "just_the_usual_tell_the_misses_i_said_hi";
  callbackId: string;
  messages: Envelope[];
}

class HandshakeProto extends GossipSub {
  public static readonly protocol: string = "/secret-handshake/proto/0.1.1";
  private static readonly grip: Uint8Array = blake2b("Attractor-Impolite-Oversold", { dkLen: 32 });
  private static readonly dueGuard: Uint8Array = ed25519.getPublicKey(HandshakeProto.grip);

  private peerId: PeerId;
  private connectionManager: ConnectionManager;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();

  constructor(components: Components) {
    super(components);
    this.peerId = components.peerId;
    this.connectionManager = components.connectionManager;
    this.registrar = components.registrar;
  }

  public static Handshake(): (components: Components) => HandshakeProto {
    return (components: Components) => new HandshakeProto(components);
  }

  private static isPayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch ((payload as Payload).type) {
      case "whats_the_password":
        return "callbackId" in payload && "challenge" in payload;
      case "open_sesame":
        return "callbackId" in payload && "challenge" in payload && "response" in payload;
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
      const outgoing: Stream = await connection.newStream(HandshakeProto.protocol, options);
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
    const response: Uint8Array = ed25519.sign(challengeBuffer, HandshakeProto.grip);
    return { type: "open_sesame", callbackId, response: Buffer.from(response).toString("hex") };
  }

  private handleMessageEvent(event: CustomEvent<Message>): void {
    console.log("You've got mail:", event);
  }

  async start(): Promise<void> {
    await this.registrar.handle(HandshakeProto.protocol, async ({ connection, stream }: any) => {
      const rawMessage: string = await HandshakeProto.decodeStream(stream);
      stream.close();

      let payload: Payload;
      try {
        payload = JSON.parse(rawMessage);
        if (!HandshakeProto.isPayload(payload)) {
          console.warn("Invalid payload received:", payload);
          return;
        }
      } catch {
        console.warn("Invalid payload.", rawMessage);
        return;
      }

      switch (payload.type) {
        case "whats_the_password": {
          const response: ChallengeResponse = this.solveChallenge(payload);
          await HandshakeProto.sendPayload(connection, response);
          break;
        }
        case "open_sesame": {
          this.callbackQueue.get(payload.callbackId)?.(payload);
          break;
        }
      }
    });

    this.addEventListener("message", this.handleMessageEvent.bind(this));
  }

  async stop(): Promise<void> {
    this.removeEventListener("message", this.handleMessageEvent.bind(this));

    this.callbackQueue.clear();
    await this.registrar.unhandle(HandshakeProto.protocol);
  }

  public async sendChallenge(peerId: PeerId | Multiaddr | Multiaddr[], options?: AbortOptions): Promise<void> {
    const callbackId: string = crypto.randomUUID();
    const challenge: string = crypto.randomUUID();
    const payload: ChallengeRequest = { type: "whats_the_password", callbackId, challenge };

    const connection: Connection = await this.connectionManager.openConnection(peerId, options);
    await HandshakeProto.sendPayload(connection, payload, options);

    this.callbackQueue.set(callbackId, async (pl: Payload) => {
      assert(HandshakeProto.isPayload(pl), "Invalid payload received");
      assert(pl.type === "open_sesame", "Expected open_sesame response");
      assert(pl.callbackId === callbackId, "Callback ID mismatch");

      const responseBuffer: Uint8Array = fromString(pl.response, "hex");
      const challengeBuffer: Uint8Array = fromString(challenge, "utf-8");

      const isValidResponse: boolean = ed25519.verify(responseBuffer, challengeBuffer, HandshakeProto.dueGuard);
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
    const envelope: Envelope = { sender, recipient, message, timestamp: Date.now() };

    const payload: SendMessage = {
      type: "deliver_this_message_and_make_it_snappy",
      messages: [envelope],
    };
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
      dht: kadDHT(),
      identify: identify(),
      ping: ping(),
      handshake: HandshakeProto.Handshake(),
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
  const client = await getNewClient(listeners);
  await client.start();

  // const magicWord: string = "DiscoMagic";
  // client.services.pubsub.subscribe(magicWord);

  // client.services.pubsub.addEventListener("gossipsub:message", ({ detail }) => {
  //   console.log(detail);
  // });

  client.addEventListener("peer:identify", async ({ detail }) => {
    if (!detail.protocols.includes(HandshakeProto.protocol)) {
      console.warn(`Peer ${detail.peerId} does not support the handshake protocol`);
      detail.connection.close();
      return;
    }

    await client.services.handshake.sendChallenge(detail.peerId);
  });

  while (client.getPeers().length < 10) {
    console.log(client.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.getPeers().length);

  // while (client.services.pubsub.getSubscribers(magicWord).length < 1) {
  //   console.log(client.getPeers().length, "peers connected");
  //   console.log(client.services.pubsub.getSubscribers(magicWord).length, "subscribers");
  //   await new Promise((resolve) => setTimeout(resolve, 10000));
  // }

  // await client.services.pubsub.publish(magicWord, Buffer.from("Hello, Disco!", "utf-8"));

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Stopping application...");
  await client.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
