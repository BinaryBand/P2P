import { createLibp2p } from "libp2p";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { Identify, identify } from "@libp2p/identify";
import { bootstrap } from "@libp2p/bootstrap";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { mdns } from "@libp2p/mdns";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { Libp2p, PeerId, PrivateKey } from "@libp2p/interface";
import { keys } from "@libp2p/crypto";

import readline from "readline";

import MessageProto, { MessageEvents } from "./message-proto.js";
import { blake3 } from "./tools/cryptography.js";

const bootstrapNodes: string[] = [
  "/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
];

const stockOptions = {
  connectionEncrypters: [noise()],
  peerDiscovery: [mdns(), bootstrap({ list: bootstrapNodes })],
  streamMuxers: [yamux()],
  transports: [circuitRelayTransport(), webRTC(), webRTCDirect(), webSockets()],
};

function getClientOptions(addresses: string[], privateKey?: PrivateKey) {
  return {
    ...stockOptions,
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    privateKey,
    services: { dht: kadDHT(), identify: identify(), ping: ping(), relay: circuitRelayServer() },
  };
}

function getNewClient(addresses: string[], privateKey?: PrivateKey, passphrase?: string) {
  const options = getClientOptions(addresses, privateKey);
  return createLibp2p({ ...options, services: { ...options.services, proto: MessageProto.Message(passphrase) } });
}

const rl: readline.Interface = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getTextInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function getPrivateKeyFromSeed(password: string): Promise<PrivateKey> {
  const seed: Uint8Array = blake3(password);
  return await keys.generateKeyPairFromSeed("Ed25519", seed);
}

async function main() {
  console.log("Starting application...");

  // Prompt the user for input
  const seedPassword: string = await getTextInput("Enter your name: ");
  const privateKey: PrivateKey = await getPrivateKeyFromSeed(seedPassword);
  const peerId: PeerId = peerIdFromPrivateKey(privateKey);
  console.log("Peer ID:", peerId.toString());
  await getTextInput("Press Enter to continue...");

  const client: Libp2p<{ proto: MessageProto<MessageEvents>; identify: Identify }> = await getNewClient(
    ["/ip4/0.0.0.0/udp/0/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"],
    privateKey
  );

  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Client started with ID:", client.peerId.toString());

  const bootstrapPeer = peerIdFromString("12D3KooWNUG46aTGP9aKo5kJF8KQtjah74qSkH4YQqaqEHVWVktz");
  if (!bootstrapPeer.equals(client.peerId)) {
    await client.dialProtocol(bootstrapPeer, MessageProto.PROTOCOL, { signal: AbortSignal.timeout(500_000) });
  }

  while (client.services.proto.getPeers().length < 2) {
    console.log(client.services.proto.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.services.proto.getPeers().length);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  while (true) {
    const neighbor: string = await getTextInput("Who do you want to connect to? (Enter peer ID): ");
    const neighborPeerId: PeerId = peerIdFromString(neighbor);
    console.log("Connecting to neighbor:", neighborPeerId.toString());

    const message: string = await getTextInput("Enter a message to send: ");
    console.log("Sending message:", message);
    await client.services.proto.sendMessages(neighborPeerId, [message]);
    console.log("Message sent successfully!");
  }
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
