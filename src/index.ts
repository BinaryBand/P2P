import { PeerId, PeerInfo, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";

import inquirer from "inquirer";

import { getNewClient, getPrivateKeyFromSeed } from "./tools/client.js";
import { encodePeerId, isAddress } from "./tools/typing.js";
import { sodium } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";
import BaseProto from "./protocols/base-proto.js";

async function bootstrapClient(client: ClientNode, peerId: PeerId): Promise<void> {
  assert(!client.peerId.equals(peerId), "Cannot bootstrap to self");
  assert(isAddress(encodePeerId(peerId)), "Invalid peer ID format");

  console.log("Started bootstrapping with peer:", peerId.toString());

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

    await client.dialProtocol(bootstrapPeer.multiaddrs, BaseProto.PROTOCOL, { signal: abortController.signal });
    console.log("Connected to bootstrap peer:", bootstrapPeer.id);
  } catch (err: unknown) {
    client.services.proto.handleLog("error", err, "bootstrapping");
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
  await sodium.ready;
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
          console.log("Getting connected peers...");
          const pool: Address[] = client.services.proto.getNeighbors();
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
      client.services.proto.handleLog("error", err, "main");
    }
  }
}

main()
  .catch((err) => {
    client.services.proto.handleLog("error", err, "main");
  })
  .finally(async () => {
    await client?.stop();
    console.log("Cleanup complete.");
    process.exit(1);
  });
