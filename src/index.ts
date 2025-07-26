import { createLibp2p } from "libp2p";

import { bootstrap } from "@libp2p/bootstrap";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

import { persistentPeerStore } from "@libp2p/peer-store";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { AbortOptions, multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { mdns } from "@libp2p/mdns";

import { peerIdFromPrivateKey, peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import {
  Connection,
  EventHandler,
  Libp2pEvents,
  Peer,
  PeerId,
  PeerInfo,
  PrivateKey,
  ServiceMap,
  Startable,
  Stream,
  StreamHandler,
} from "@libp2p/interface";
// import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
// import { convertPeerId } from "@libp2p/kad-dht/dist/src/utils";

import { fromString, toString } from "uint8arrays";
import { Uint8ArrayList } from "uint8arraylist";
import { pipe } from "it-pipe";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { keys } from "@libp2p/crypto";

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

type Payload = ChallengeRequest | ChallengeResponse;

interface ChallengeRequest {
  callbackId: string;
  type: "whats_the_password";
  challenge: string;
}

interface ChallengeResponse {
  callbackId: string;
  type: "open_sesame";
  challenge: string;
  response: string;
}

class HandshakeProto implements Startable {
  public static readonly protocol: string = "/handshake/proto/0.1.0";

  private privateKey: Uint8Array = new Uint8Array(32);
  private publicKey: Uint8Array;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();

  constructor(private readonly components: CustomComponents) {
    this.privateKey.set(Buffer.from("AppleMango", "utf-8"));
    this.publicKey = ed25519.getPublicKey(this.privateKey);
  }

  public static Handshake(): (components: CustomComponents) => HandshakeProto {
    return (components: CustomComponents) => new HandshakeProto(components);
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
    const outgoing: Stream = await connection.newStream(HandshakeProto.protocol, options);
    const payloadString: string = JSON.stringify(payload);
    await pipe([Buffer.from(payloadString)], outgoing);
    outgoing.close();
  }

  private solveChallenge(challenge: ChallengeRequest): ChallengeResponse {
    const challengeBuffer: Uint8Array = Buffer.from(challenge.challenge, "utf-8");
    const response: Uint8Array = ed25519.sign(challengeBuffer, this.privateKey);
    return { ...challenge, type: "open_sesame", response: Buffer.from(response).toString("hex") };
  }

  async start(): Promise<void> {
    await this.components.registrar.handle(HandshakeProto.protocol, async ({ connection, stream }) => {
      const rawMessage: string = await HandshakeProto.decodeStream(stream);
      stream.close();

      const payload: Payload = JSON.parse(rawMessage);
      if (!HandshakeProto.isPayload(payload)) {
        console.warn("Invalid payload received:", payload);
        return;
      }

      switch (payload.type) {
        case "whats_the_password": {
          const response = this.solveChallenge(payload);
          await HandshakeProto.sendPayload(connection, response);
          break;
        }
        case "open_sesame": {
          const callback = this.callbackQueue.get(payload.callbackId);
          callback?.(payload);
          break;
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.callbackQueue.clear();
    await this.components.registrar.unhandle(HandshakeProto.protocol);
  }

  public async sendChallenge(peerId: PeerId | Multiaddr | Multiaddr[], options?: AbortOptions): Promise<void> {
    const callbackId: string = crypto.randomUUID();
    const challenge: string = crypto.randomUUID();
    const payload: ChallengeRequest = { callbackId, type: "whats_the_password", challenge };

    const connection: Connection = await this.components.connectionManager.openConnection(peerId, options);
    await HandshakeProto.sendPayload(connection, payload, options);

    this.callbackQueue.set(callbackId, async (pl: Payload) => {
      assert(HandshakeProto.isPayload(pl), "Invalid payload received");
      assert(pl.type === "open_sesame", "Expected open_sesame response");
      assert(pl.callbackId === callbackId, "Callback ID mismatch");
      assert(pl.challenge === challenge, "Challenge mismatch");

      const responseBuffer: Uint8Array = fromString(pl.response, "hex");
      const challengeBuffer: Uint8Array = fromString(pl.challenge, "utf-8");
      const isValidResponse: boolean = ed25519.verify(responseBuffer, challengeBuffer, this.publicKey);
      if (!isValidResponse) {
        console.error(`Invalid response for callback ID: ${callbackId}`);
        await connection.close();
      }

      this.callbackQueue.delete(callbackId);
    });
  }
}

const stockOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

const clientOptions = {
  ...stockOptions,
  transports: [circuitRelayTransport(), webRTCDirect(), webSockets()],
};

async function getNewClient(addresses: string[], privateKey?: PrivateKey) {
  return createLibp2p({
    ...clientOptions,
    addresses: { listen: [...addresses, "/p2p-circuit"] },
    peerDiscovery: [mdns()],
    privateKey,
    services: {
      dht: kadDHT(),
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub(),
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

  const client = await getNewClient(["/ip4/0.0.0.0/udp/1/webrtc-direct"], privateKey);
  await client.start();

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

  console.log("Stopping application...");
  await client.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
