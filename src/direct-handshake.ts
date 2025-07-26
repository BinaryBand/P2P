import { createLibp2p } from "libp2p";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

// import { identify } from "@libp2p/identify";
// import { ping } from "@libp2p/ping";

// import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTCDirect } from "@libp2p/webrtc";
// import { webSockets } from "@libp2p/websockets";

import { AbortOptions, multiaddr, Multiaddr } from "@multiformats/multiaddr";
// import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

// import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
// import { gossipsub } from "@chainsafe/libp2p-gossipsub";

import { peerIdFromPrivateKey, peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import {
  Connection,
  EventHandler,
  Libp2pEvents,
  PeerId,
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

type Payload = HandshakeRequest;

interface HandshakeRequest {
  id: string;
  type: "handshake_request" | "accept_handshake";
  publicKey: string;
}

class HandshakeProto implements Startable {
  public static readonly protocol = "/handshake/proto/1.0.0";

  private requestQueue: Map<string, (payload: Payload) => void> = new Map();

  constructor(private readonly components: CustomComponents, private pk: Uint8Array) {}

  private get publicKey(): string {
    return Buffer.from(this.pk).toString("hex");
  }

  public static Handshake(pk: Uint8Array): (components: CustomComponents) => HandshakeProto {
    return (components: CustomComponents) => new HandshakeProto(components, pk);
  }

  private static isPayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch ((payload as Payload).type) {
      case "handshake_request":
      case "accept_handshake":
        return "publicKey" in payload && typeof payload.publicKey === "string";
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

  private async addEventListener(requestId: string, event: EventHandler<Payload>): Promise<void> {
    this.requestQueue.set(requestId, (pl: Payload) => {
      return "handleEvent" in event ? event.handleEvent(pl) : event(pl);
    });
  }

  private async removeEventListener(requestId: string): Promise<void> {
    this.requestQueue.delete(requestId);
  }

  async start(): Promise<void> {
    await this.components.registrar.handle(HandshakeProto.protocol, async ({ connection, stream }) => {
      const rawMessage: string = await HandshakeProto.decodeStream(stream);
      stream.close();

      const payload: Payload = JSON.parse(rawMessage);
      if (!HandshakeProto.isPayload(payload)) {
        console.error("Invalid payload received:", payload);
        return;
      }

      if (this.requestQueue.has(payload.id)) {
        this.requestQueue.get(payload.id)?.(payload);
        this.requestQueue.delete(payload.id);
      }

      let response: Payload | undefined;
      switch (payload.type) {
        case "handshake_request":
          response = { id: payload.id, type: "accept_handshake", publicKey: this.publicKey };
          break;
      }

      // Respond to the stream
      if (HandshakeProto.isPayload(response)) {
        await HandshakeProto.sendPayload(connection, response);
      }

      connection.close();
    });
  }

  async stop(): Promise<void> {
    this.requestQueue.clear();
    await this.components.registrar.unhandle(HandshakeProto.protocol);
  }

  async handshake(peerId: PeerId | Multiaddr | Multiaddr[], options?: AbortOptions): Promise<Payload> {
    const requestId: string = crypto.randomUUID();
    const payload: HandshakeRequest = { id: requestId, type: "handshake_request", publicKey: this.publicKey };

    const conn: Connection = await this.components.connectionManager.openConnection(peerId, options);
    await HandshakeProto.sendPayload(conn, payload, options);

    return new Promise<Payload>((resolve) => {
      this.addEventListener(requestId, (pl: Payload) => {
        this.removeEventListener(requestId);
        resolve(pl);
      });
    });
  }
}

const stockOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

const clientOptions = {
  ...stockOptions,
  transports: [webRTCDirect()],
};

function privKeyToPublicKey(privateKey: PrivateKey): string {
  const publicKey: Uint8Array = x25519.getPublicKey(privateKey.raw.slice(0, 32));
  return Buffer.from(publicKey).toString("hex");
}

async function getNewClient(addr: string, privateKey: PrivateKey) {
  const pk: Uint8Array = x25519.getPublicKey(privateKey.raw.slice(0, 32));
  return createLibp2p({
    ...clientOptions,
    addresses: { listen: [addr] },
    services: { handshake: HandshakeProto.Handshake(pk) },
    privateKey,
  });
}

async function main() {
  console.log("Starting application...");

  const seed: Uint8Array = new Uint8Array(32);
  seed.set(Buffer.from("AppleMango"));
  const privKey: PrivateKey = await keys.generateKeyPairFromSeed("Ed25519", seed);

  const pubKey: Uint8Array = privKey.publicKey.raw;
  const sk: Uint8Array = privKey.raw;
  const pk: Uint8Array = ed25519.getPublicKey(sk.slice(0, 32));
  for (let i: number = 0; i < pk.length; i++) {
    if (pk[i] !== pubKey[i]) {
      throw new Error("Public key does not match the expected value");
    }
  }

  const listener = await getNewClient("/ip4/0.0.0.0/udp/1/webrtc-direct", privKey);
  const testPeerId: PeerId = peerIdFromPrivateKey(privKey);
  const controlPeerId: PeerId = listener.peerId;
  if (!controlPeerId.equals(testPeerId)) {
    throw new Error("Control peer ID does not match the expected test peer ID");
  }

  const privKey2: PrivateKey = await keys.generateKeyPair("Ed25519");
  const dialer = await getNewClient("/ip4/0.0.0.0/udp/2/webrtc-direct", privKey2);

  const listenerControlPublicKey = privKeyToPublicKey(privKey);
  const dialerControlPublicKey = privKeyToPublicKey(privKey2);
  console.log("Listener control public key:", listenerControlPublicKey);
  console.log("Dialer control public key:", dialerControlPublicKey);

  const { publicKey } = await dialer.services.handshake.handshake(listener.getMultiaddrs(), {
    signal: AbortSignal.timeout(5000),
  });
  console.log("listener callback:", { publicKey });

  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log("Stopping application...");
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
