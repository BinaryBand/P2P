import express, { Express } from "express";
import { Server } from "http";
import { PeerId } from "@libp2p/interface";

import { getNewGatewayNode, GatewayNode } from "./tools/node.js";

const PORT = process.env.PORT || 3000;
const app: Express = express();

var gateway: GatewayNode;
var server: Server;

app.get("/gateway/peer-id", (_req, res) => {
  const peerId: PeerId = gateway.peerId;
  res.send(peerId.toString());
});

export async function startRpcServers(bootstrapAddresses?: string[]): Promise<Server> {
  gateway = await getNewGatewayNode(
    ["/ip4/0.0.0.0/udp/0/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"],
    undefined,
    undefined,
    bootstrapAddresses
  );
  await gateway.start();

  server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

  return server;
}

app.addListener("stop", async () => {
  await gateway.stop();
  console.log("Gateway node stopped.");
});

process.on("SIGTERM", async () => {
  if (gateway) {
    await gateway.stop();
    console.log("Gateway node stopped");
  }
  if (server) {
    server.close(() => {
      console.log("Server closed");
    });
  }
});
