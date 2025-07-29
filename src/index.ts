import { createLibp2p } from "libp2p";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { mdns } from "@libp2p/mdns";
import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { PeerId, PrivateKey } from "@libp2p/interface";

import { keys } from "@libp2p/crypto";

import HandshakeProto from "./handshake.js";

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
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    peerDiscovery: [mdns()],
    privateKey,
    services: { handshake: HandshakeProto.Handshake(), identify: identify() },
  });
}

async function main() {
  console.log("Starting application...");

  const seed: Uint8Array = new Uint8Array(32);
  seed.set(Buffer.from("AppleMango"));
  const privateKey: PrivateKey = await keys.generateKeyPairFromSeed("Ed25519", seed);
  const peerId: PeerId = peerIdFromPrivateKey(privateKey);
  console.log("Peer ID:", peerId.toString());

  const client = await getNewClient(["/ip4/0.0.0.0/udp/4999/webrtc-direct"], privateKey);
  const nodes = await Promise.all([
    getNewClient(["/ip4/0.0.0.0/udp/5000/webrtc-direct"]),
    getNewClient(["/ip4/0.0.0.0/udp/5001/webrtc-direct"]),
    getNewClient(["/ip4/0.0.0.0/udp/5002/webrtc-direct"]),
  ]);

  await client.start();
  await Promise.all(nodes.map((node) => node.start()));

  while (client.getPeers().length < 1) {
    console.log(client.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.getPeers().length);

  await new Promise((resolve) => setTimeout(resolve, 2500));

  await new Promise((resolve) => setTimeout(resolve, 7500));

  console.log("Stopping application...");
  await client.stop();
  await Promise.all(nodes.map((node) => node.stop()));
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
