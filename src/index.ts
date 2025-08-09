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

// import { encodePeerId } from "./tools/typing.js";
// import { assert } from "./tools/utils.js";
import MessageProto from "./message-proto.js";

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

function getNewClient(addresses: string[], privateKey?: PrivateKey, passphrase?: string) {
  const options = getClientOptions(addresses, privateKey);
  return createLibp2p({ ...options, services: { ...options.services, proto: MessageProto.Message(passphrase) } });
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
    getNewClient(["/ip4/0.0.0.0/udp/5003/webrtc-direct"]),
  ]);

  await client.start();
  await Promise.all(nodes.map((node) => node.start()));
  await new Promise((resolve) => setTimeout(resolve, 5000));

  while (client.getPeers().length < 2) {
    console.log(client.getPeers().length, "peers connected");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Bootstrapped with peers:", client.getPeers().length);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  /*****************
   * Test Local Data Storage
   *****************/
  const mockData: string = "This is test data to be stored locally.";
  const mockHash: Base64 = client.services.proto.saveDataLocally(mockData);
  console.log("Data stored with hash:", mockHash);

  let clientData: string | null = client.services.proto.getLocalData(mockHash);
  let nodeData: (string | null)[] = nodes.map((node) => node.services.proto.getLocalData(mockHash));
  console.log("Data retrieved from client:", { clientData, ...nodeData });

  /*****************
   * Test Remote Data Storage
   *****************/
  const remoteData: string = "This is remote data stored by another peer.";
  const remoteHash: Base64 = await client.services.proto.storeData(remoteData);
  console.log("Data stored with hash:", remoteHash);

  clientData = client.services.proto.getLocalData(remoteHash);
  nodeData = nodes.map((node) => node.services.proto.getLocalData(remoteHash));
  console.log("Data retrieved from client & Nodes:", { ...nodeData, clientData });

  const networkData: string | null = await client.services.proto.fetchData(remoteHash);
  console.log("Data fetched from network:", [networkData]);

  /*****************
   * Test Audit Remote Data Storage
   *****************/
  await client.services.proto.auditSwarm(remoteData);
  console.log(
    "Data from nodes:",
    nodes.map((n) => n.services.proto.getLocalData(remoteHash))
  );

  /*****************
   * Test Message Sending
   *****************/
  const first: string = "Hello, this is a test message!";
  const second: string = "This is another message to be sent.";
  await client.services.proto.sendMessages(nodes[0].peerId, [first, second]);

  const fragments = await nodes[0].services.proto.getInbox(nodes[0].peerId);
  console.log("Inbox fragments from node 0:", fragments);

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
