import { createLibp2p } from "libp2p";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTCDirect } from "@libp2p/webrtc";
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
  transports: [circuitRelayTransport(), webRTCDirect(), webSockets()],
};

function getClientOptions(addresses: string[], privateKey?: PrivateKey) {
  return {
    ...stockOptions,
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    privateKey,
    services: { dht: kadDHT(), identify: identify(), ping: ping() },
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
    ["/ip4/0.0.0.0/udp/0/webrtc-direct"],
    privateKey
  );
  // const nodes: Libp2p<{ proto: MessageProto<MessageEvents>; identify: Identify }>[] = await Promise.all([
  //   // getNewClient(["/ip4/0.0.0.0/udp/5000/webrtc-direct"]),
  //   // getNewClient(["/ip4/0.0.0.0/udp/5001/webrtc-direct"]),
  //   // getNewClient(["/ip4/0.0.0.0/udp/5002/webrtc-direct"]),
  //   // getNewClient(["/ip4/0.0.0.0/udp/5003/webrtc-direct"]),
  // ]);

  await client.start();
  // await Promise.all(nodes.map((node) => node.start()));
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Client started with ID:", client.peerId.toString());

  const bootstrapPeer = peerIdFromString("12D3KooWNUG46aTGP9aKo5kJF8KQtjah74qSkH4YQqaqEHVWVktz");
  if (!bootstrapPeer.equals(client.peerId)) {
    await client.dialProtocol(bootstrapPeer, MessageProto.PROTOCOL);
  }

  while (client.services.proto.getPeers().length < 2) {
    console.log(client.services.proto.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.services.proto.getPeers().length);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const neighbor: string = await getTextInput("Who do you want to connect to? (Enter peer ID): ");
  const neighborPeerId: PeerId = peerIdFromString(neighbor);
  console.log("Connecting to neighbor:", neighborPeerId.toString());

  const message: string = await getTextInput("Enter a message to send: ");
  console.log("Sending message:", message);
  await client.services.proto.sendMessages(neighborPeerId, [message]);
  console.log("Message sent successfully!");

  // /*****************
  //  * Test Local Data Storage
  //  *****************/
  // const mockData: string = "This is test data to be stored locally.";
  // const mockHash: Base64 = client.services.proto.saveDataLocally(mockData);
  // console.log("Data stored with hash:", mockHash);

  // let clientData: string | null = client.services.proto.getLocalData(mockHash);
  // let nodeData: (string | null)[] = nodes.map((node) => node.services.proto.getLocalData(mockHash));
  // console.log("Data retrieved from client:", { clientData, ...nodeData });

  // /*****************
  //  * Test Remote Data Storage
  //  *****************/
  // const remoteData: string = "This is remote data stored by another peer.";
  // const remoteHash: Base64 = await client.services.proto.storeData(remoteData);
  // console.log("Data stored with hash:", remoteHash);

  // clientData = client.services.proto.getLocalData(remoteHash);
  // nodeData = nodes.map((node) => node.services.proto.getLocalData(remoteHash));
  // console.log("Data retrieved from client & Nodes:", { ...nodeData, clientData });

  // const networkData: string | null = await client.services.proto.fetchData(remoteHash);
  // console.log("Data fetched from network:", [networkData]);

  // /*****************
  //  * Test Audit Remote Data Storage
  //  *****************/
  // await client.services.proto.auditSwarm(remoteData);
  // console.log(
  //   "Data from nodes:",
  //   nodes.map((n) => n.services.proto.getLocalData(remoteHash))
  // );

  // /*****************
  //  * Test Message Sending
  //  *****************/
  // const first: string = "Hello, this is a test message!";
  // const second: string = "This is another message to be sent.";
  // await client.services.proto.sendMessages(nodes[0].peerId, [first, second]);

  // const fragments: Message[] = await nodes[0].services.proto.getInbox(nodes[0].peerId);
  // console.log("Inbox fragments from node 0:", fragments);

  // /*************/
  // await new Promise((resolve) => setTimeout(resolve, 2500));
  // console.log("Stopping application...");
  // await client.stop();
  // await Promise.all(nodes.map((node) => node.stop()));
  // process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
