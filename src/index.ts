import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";
import inquirer from "inquirer";

import { bootstrapClient, getClient } from "./client.js";
import { sodium } from "./tools/cryptography.js";

var client: ClientNode;
async function main(): Promise<void> {
  await sodium.ready;
  console.log("Starting application...");

  // Prompt the user for a seed password
  // Generate the private key from the seed password
  const { seedPassword } = await inquirer.prompt({
    type: "input",
    name: "seedPassword",
    message: "Enter a secret password:",
  });
  client = await getClient(seedPassword);

  await client.start();
  console.log("Client started with ID:", client.peerId.toString());

  let running: boolean = true;
  while (running) {
    client.services.proto.logger.info("Client is running");

    try {
      const { action } = await inquirer.prompt({
        type: "list",
        name: "action",
        message: `${client.peerId}: Select an action:`,
        choices: [
          { name: "Bootstrap to Peer ID", value: "bootstrap" },
          { name: "View Neighbors", value: "pool" },
          // { name: "Send a message", value: "send" },
          // { name: "View inbox", value: "inbox" },
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
          const pool: Address[] = client.services.proto.getNeighbors();
          console.log("Connected peers:", pool);
          break;
        // case "send":
        //   const { recipient, message } = await inquirer.prompt([
        //     { type: "input", name: "recipient", message: "Enter recipient peer ID:" },
        //     { type: "input", name: "message", message: "Enter your message:" },
        //   ]);
        //   await sendMessage(client, recipient, [message]);
        //   break;
        // case "inbox":
        //   const inbox: string[] = await client.services.proto.getInbox(client.peerId);
        //   console.log("Inbox messages:", inbox);
        //   break;
        case "exit":
          running = false;
          console.log("Exiting...");
          break;
        default:
          console.log("Invalid action. Please try again.");
          break;
      }
    } catch (err: unknown) {
      console.error(err, "main");
    }
  }
}

main()
  .catch((err) => {
    console.error(err, "main");
  })
  .finally(async () => {
    await client?.stop();
    console.log("Cleanup complete.");
    process.exit(1);
  });
