import { createLibp2p } from "libp2p";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { Identify, identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { bootstrap } from "@libp2p/bootstrap";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { mdns } from "@libp2p/mdns";

import { Libp2p, PeerId, PeerInfo, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { keys } from "@libp2p/crypto";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import inquirer from "inquirer";

import MessageProto, { MessageEvents } from "./protocols/message-proto.js";
import { toBuffer, encodePeerId, isAddress } from "./tools/typing.js";
import { genericHash } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

const bootstrapNodes: string[] = [
  "/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
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

async function getPrivateKeyFromSeed(password: string): Promise<PrivateKey> {
  const passwordBuffer: Uint8Array = toBuffer(password);
  const seed: Uint8Array = genericHash(passwordBuffer);
  return await keys.generateKeyPairFromSeed("Ed25519", seed);
}

type ClientNode = Libp2p<{ proto: MessageProto<MessageEvents>; identify: Identify }>;

async function bootstrapClient(client: ClientNode, peerId: PeerId): Promise<void> {
  assert(!client.peerId.equals(peerId), "Cannot bootstrap to self");
  assert(isAddress(encodePeerId(peerId)), "Invalid peer ID format");

  console.log("Bootstrapping with peer:", peerId.toString());

  // Set up inquirer to listen for a key press
  const abortController = new AbortController();
  const keyPressListener = inquirer.prompt({
    type: "input",
    name: "abort",
    message: 'Press "q" to abort bootstrapping...',
    filter: (input) => input.trim().toLowerCase(),
  });

  try {
    keyPressListener.then((answers) => {
      if (answers.abort === "q") {
        console.log("Aborting bootstrapping...");
        abortController.abort();
      }
    });

    const bootstrapPeer: PeerInfo = await client.peerRouting.findPeer(peerId, { signal: abortController.signal });
    console.log("Found bootstrap peer:", bootstrapPeer.id);

    await client.dial(bootstrapPeer.multiaddrs, { signal: abortController.signal });
    console.log("Connected to bootstrap peer:", bootstrapPeer.id);
  } catch (err) {
    if (abortController.signal.aborted) {
      console.log("Bootstrapping was aborted.");
    } else {
      console.error("Error during bootstrapping:", err);
    }
  }
}

async function sendMessage(client: ClientNode, recipient: PeerId, messages: string[]): Promise<void> {
  assert(client.services.proto, "Message service not initialized");
  assert(isAddress(encodePeerId(recipient)), "Invalid recipient address");

  console.log("Sending message to:", recipient);
  await client.services.proto.sendMessages(recipient, messages);
  console.log("Message sent successfully!");
}

var client: ClientNode;
async function main(): Promise<void> {
  console.log("Starting application...");

  // Prompt the user for a seed password
  const { seedPassword } = await inquirer.prompt({
    type: "input",
    name: "seedPassword",
    message: "Enter a secret password:",
  });

  // Generate the private key from the seed password
  const privateKey: PrivateKey = await getPrivateKeyFromSeed(seedPassword);
  client = await getNewClient(["/ip4/0.0.0.0/udp/0/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"], privateKey);

  await client.start();
  console.log("Client started with ID:", client.peerId.toString(), "Please wait for connections...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("Client is ready. You can now interact with the network.");
  console.log("Your Peer ID:", encodePeerId(client.peerId));
  console.log("Your Bootstrap Addresses:");

  let running: boolean = true;
  while (running) {
    try {
      const { action } = await inquirer.prompt({
        type: "list",
        name: "action",
        message: `${client.peerId}: Select an action:`,
        choices: [
          { name: "Bootstrap to Peer ID", value: "bootstrap" },
          { name: "View Neighbors", value: "pool" },
          { name: "Send a message", value: "send" },
          { name: "View inbox", value: "inbox" },
          { name: "Exit", value: "exit" },
        ],
      });

      switch (action) {
        case "bootstrap":
          const { bootstrapAddress } = await inquirer.prompt({
            type: "input",
            name: "bootstrapAddress",
            message: "Enter bootstrap peer ID:",
          });
          const bootstrapPeerId: PeerId = peerIdFromString(bootstrapAddress);
          await bootstrapClient(client, bootstrapPeerId);
          break;
        case "pool":
          const pool: Address[] = await client.services.proto.getNeighbors();
          console.log("Connected peers:", pool);
          break;
        case "send":
          const { recipient, message } = await inquirer.prompt([
            { type: "input", name: "recipient", message: "Enter recipient peer ID:" },
            { type: "input", name: "message", message: "Enter your message:" },
          ]);
          await sendMessage(client, recipient, [message]);
          break;
        case "inbox":
          const inbox: string[] = await client.services.proto.getInbox(client.peerId);
          console.log("Inbox messages:", inbox);
          break;
        case "exit":
          running = false;
          console.log("Exiting...");
          break;
        default:
          console.log("Invalid action. Please try again.");
          break;
      }
    } catch (err: unknown) {
      console.warn("An error occurred on main:", err);
    }
  }

  process.exit(0);
}

main()
  .catch((err) => {
    console.error("An irrecoverable error occurred:", err);
    process.exit(1);
  })
  .finally(async () => {
    await client?.stop();
    console.log("Cleanup complete.");
  });
