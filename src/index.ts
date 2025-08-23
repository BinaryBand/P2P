// import { peerIdFromString } from "@libp2p/peer-id";
// import { PeerId } from "@libp2p/interface";
// import inquirer from "inquirer";

// import { bootstrapNode, getClient } from "./tools/node.js";
import { sodium } from "./tools/cryptography.js";
import { startRpcServers } from "./server.js";

var client: GatewayNode;
async function main(): Promise<void> {
  await sodium.ready;
  console.log("Starting application...");

  // Parse command line arguments for bootstrap addresses
  const args = process.argv.slice(2);
  const bootstrapAddresses: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bootstrap" && i + 1 < args.length) {
      bootstrapAddresses.push(args[i + 1]);
      i++; // Skip the next argument as it's the address
    }
  }

  if (bootstrapAddresses.length > 0) {
    console.log("Bootstrap addresses provided:", bootstrapAddresses);
  }

  const server = await startRpcServers(bootstrapAddresses);

  try {
    const res = await fetch("http://localhost:3000/gateway/peer-id");
    const data = await res.text();
    console.log("Gateway Peer ID:", data);
  } catch (error) {
    console.error("Error fetching Gateway Peer ID:", error);
  }

  // const address = server.address();
  // console.log("Server is listening on:", address);

  server.close();
  return;

  // // Prompt the user for a seed password
  // // Generate the private key from the seed password
  // const { seedPassword } = await inquirer.prompt({
  //   type: "input",
  //   name: "seedPassword",
  //   message: "Enter a secret password:",
  // });
  // client = await getClient(seedPassword);

  // await client.start();
  // console.log("Client started with ID:", client.peerId.toString());

  // let running: boolean = true;
  // while (running) {
  //   client.services.proto.logger.info("Client is running");

  //   try {
  //     const { action } = await inquirer.prompt({
  //       type: "list",
  //       name: "action",
  //       message: `${client.peerId}: Select an action:`,
  //       choices: [
  //         { name: "Bootstrap to Peer ID", value: "bootstrap" },
  //         { name: "View Neighbors", value: "pool" },
  //         // { name: "Send a message", value: "send" },
  //         // { name: "View inbox", value: "inbox" },
  //         { name: "Exit", value: "exit" },
  //       ],
  //     });

  //     switch (action) {
  //       case "bootstrap":
  //         const { bootstrapAddress } = await inquirer.prompt({
  //           type: "input",
  //           name: "bootstrapAddress",
  //           message: "Enter bootstrap peer ID:",
  //         });
  //         const bootstrapPeerId: PeerId = peerIdFromString(bootstrapAddress);
  //         await bootstrapNode(client, bootstrapPeerId);
  //         break;
  //       case "pool":
  //         const pool: Address[] = client.services.proto.getNeighbors();
  //         console.log("Connected peers:", pool);
  //         break;
  //       // case "send":
  //       //   const { recipient, message } = await inquirer.prompt([
  //       //     { type: "input", name: "recipient", message: "Enter recipient peer ID:" },
  //       //     { type: "input", name: "message", message: "Enter your message:" },
  //       //   ]);
  //       //   await sendMessage(client, recipient, [message]);
  //       //   break;
  //       // case "inbox":
  //       //   const inbox: string[] = await client.services.proto.getInbox(client.peerId);
  //       //   console.log("Inbox messages:", inbox);
  //       //   break;
  //       case "exit":
  //         running = false;
  //         console.log("Exiting...");
  //         break;
  //       default:
  //         console.log("Invalid action. Please try again.");
  //         break;
  //     }
  //   } catch (err: unknown) {
  //     console.error(err, "main");
  //   }
  // }
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
