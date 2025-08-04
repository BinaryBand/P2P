import { createLibp2p } from "libp2p";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { identify } from "@libp2p/identify";
import { mdns } from "@libp2p/mdns";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { PeerId, PrivateKey } from "@libp2p/interface";
import { keys } from "@libp2p/crypto";

import SwarmProto from "./swarm-proto.js";

const stockOptions = {
  connectionEncrypters: [noise()],
  peerDiscovery: [mdns()],
  streamMuxers: [yamux()],
  transports: [circuitRelayTransport(), webRTCDirect(), webSockets()],
};

function getClientOptions(addresses: string[], privateKey?: PrivateKey) {
  return {
    ...stockOptions,
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    privateKey,
    services: { identify: identify() },
  };
}

function getNewClient(addresses: string[], privateKey?: PrivateKey) {
  const options = getClientOptions(addresses, privateKey);
  return createLibp2p({ ...options, services: { ...options.services, proto: SwarmProto.Swarm() } });
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
    createLibp2p(getClientOptions(["/ip4/0.0.0.0/udp/5002/webrtc-direct"])),
    getNewClient(["/ip4/0.0.0.0/udp/5003/webrtc-direct"]),
    getNewClient(["/ip4/0.0.0.0/udp/5004/webrtc-direct"]),
    getNewClient(["/ip4/0.0.0.0/udp/5005/webrtc-direct"]),
  ]);

  await client.start();
  await Promise.all(nodes.map((node) => node.start()));

  while (client.getPeers().length < 3) {
    console.log(client.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.getPeers().length);

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const targetAddress: string = nodes[4].peerId.toString();
  const nearestPeers = await client.services.proto.findNearestPeers(targetAddress);
  console.log("Nearest peers found:", nearestPeers);

  await client.services.proto.sendMessages(targetAddress, [
    "Hello from the client!",
    "This is a test message.",
    "P2P communication is fun!",
  ]);
  console.log(`Message sent to nearest peer`);

  await new Promise((resolve) => setTimeout(resolve, 2500));

  const messages = await nodes[4].services.proto.getMessages(targetAddress);
  console.log(`Messages retrieved from ${targetAddress}:`, messages);

  await new Promise((resolve) => setTimeout(resolve, 2500));

  console.log("Stopping application...");
  await client.stop();
  await Promise.all(nodes.map((node) => node.stop()));
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
