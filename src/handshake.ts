import { createLibp2p, Libp2p } from "libp2p";

import { bootstrap } from "@libp2p/bootstrap";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { AbortOptions, multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";

import { peerIdFromPrivateKey, peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import { PeerId, PrivateKey, Startable, Stream } from "@libp2p/interface";
import { convertPeerId } from "@libp2p/kad-dht/dist/src/utils";
import { keys } from "@libp2p/crypto";

import { pipe } from "it-pipe";
import { fromString, toString } from "uint8arrays";
import { Uint8ArrayList } from "uint8arraylist";

type Payload = HandshakeRequest;

interface HandshakeRequest {
  type: "handshake_request";
  peerId: string;
}

function isPayload(payload: unknown): payload is Payload {
  return typeof payload === "object" && payload !== null && "type" in payload;
}

class CustomProto implements Startable {
  public static readonly protocol = "/custom/proto/1.0.0";

  public static customProto(): (components: CustomComponents) => CustomProto {
    return (components: CustomComponents) => new CustomProto(components);
  }

  constructor(private readonly components: CustomComponents) {}

  private async parseIncomingStream(stream: Stream): Promise<string> {
    return await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      let message: string = "";
      for await (const data of source) {
        const partials: string[] = [...data].map((arr) => toString(arr, "utf-8"));
        message += partials.join("");
      }
      return message;
    });
  }

  public async start(): Promise<void> {
    await this.components.registrar.handle(CustomProto.protocol, async ({ stream }) => {
      const rawMessage: string = await this.parseIncomingStream(stream);

      const payload: Payload = JSON.parse(rawMessage);
      if (!isPayload(payload)) {
        return stream.close();
      }

      switch (payload.type) {
        case "handshake_request":
          console.log("Introducing:", payload.peerId);
          break;
        default:
          console.error(payload);
          throw new Error(`Unknown payload type: ${payload.type}`);
      }
    });

    console.log("Custom protocol started");
  }

  public async stop(): Promise<void> {
    await this.components.registrar.unhandle(CustomProto.protocol);
    console.log("Custom protocol stopped");
  }
}

const stockOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

const clientOptions = {
  ...stockOptions,
  services: { customProto: CustomProto.customProto() },
  transports: [webRTCDirect()],
};

async function main() {
  console.log("Starting application...");

  const seed: Uint8Array = new Uint8Array(32);
  seed.set(Buffer.from("AppleMango"));
  const privateKey: PrivateKey = await keys.generateKeyPairFromSeed("Ed25519", seed);

  const client1 = await createLibp2p({
    ...clientOptions,
    addresses: { listen: ["/ip4/0.0.0.0/udp/1/webrtc-direct"] },
    privateKey,
  });
  const client2 = await createLibp2p({ ...clientOptions, addresses: { listen: ["/ip4/0.0.0.0/udp/2/webrtc-direct"] } });
  console.log("Client1 ID:", client1.peerId.toString());
  console.log("Client2 ID:", client2.peerId.toString());

  // Send a message using the custom protocol
  const introduction: HandshakeRequest = { type: "handshake_request", peerId: client1.peerId.toString() };
  const stream: Stream = await client1.dialProtocol(client2.getMultiaddrs(), CustomProto.protocol);
  await pipe([fromString(JSON.stringify(introduction))], stream);

  // Stop the client nodes
  await client1.stop();
  await client2.stop();
  console.log("Stop both nodes.");

  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
