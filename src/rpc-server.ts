import express, { Request, Response } from "express";
import cors from "cors";
import { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";

import { getNewClient, getPrivateKeyFromSeed, ClientNode } from "./tools/client.js";
import { encodePeerId, isAddress } from "./tools/typing.js";
import { sodium } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

interface RPCRequest {
  method: string;
  params: any;
  id?: string | number;
}

interface RPCResponse {
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id?: string | number;
}

export class P2PRPCServer {
  private app: express.Application;
  private client: ClientNode | null = null;
  private server: any;
  private port: number;

  constructor(port: number = 8080) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        client_connected: !!this.client,
        peer_id: this.client?.peerId?.toString() || null,
      });
    });

    // Main RPC endpoint
    this.app.post("/rpc", async (req: Request, res: Response) => {
      try {
        const rpcRequest: RPCRequest = req.body;
        const response = await this.handleRPCRequest(rpcRequest);
        res.json(response);
      } catch (error) {
        console.error("RPC Error:", error);
        res.status(500).json({
          error: {
            code: -32603,
            message: "Internal error",
            data: error instanceof Error ? error.message : "Unknown error",
          },
          id: req.body?.id || null,
        });
      }
    });

    // RESTful endpoints for easier testing
    this.app.post("/api/initialize", async (req: Request, res: Response) => {
      try {
        const { seedPassword } = req.body;
        const result = await this.initializeClient(seedPassword);
        res.json({ success: true, peerId: result });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.post("/api/bootstrap", async (req: Request, res: Response) => {
      try {
        const { peerId } = req.body;
        await this.bootstrapToPeer(peerId);
        res.json({ success: true, message: "Bootstrap completed" });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.get("/api/neighbors", async (_req: Request, res: Response) => {
      try {
        const neighbors = await this.getNeighbors();
        res.json({ success: true, neighbors });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.post("/api/send", async (req: Request, res: Response) => {
      try {
        const { recipient, messages } = req.body;
        await this.sendMessage(recipient, messages);
        res.json({ success: true, message: "Messages sent successfully" });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.get("/api/inbox/:peerId", async (req: Request, res: Response) => {
      try {
        const peerId = req.params.peerId;
        const messages = await this.getInbox(peerId);
        res.json({ success: true, messages });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.get("/api/inbox", async (_req: Request, res: Response) => {
      try {
        if (!this.client?.peerId) {
          throw new Error("Client not initialized");
        }
        const messages = await this.getInbox();
        res.json({ success: true, messages });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  }

  private async handleRPCRequest(request: RPCRequest): Promise<RPCResponse> {
    const { method, params, id } = request;

    try {
      let result: any;

      switch (method) {
        case "initialize":
          result = await this.initializeClient(params.seedPassword);
          break;

        case "bootstrap":
          await this.bootstrapToPeer(params.peerId);
          result = { success: true };
          break;

        case "getNeighbors":
          result = await this.getNeighbors();
          break;

        case "sendMessage":
          await this.sendMessage(params.recipient, params.messages);
          result = { success: true };
          break;

        case "getInbox":
          result = await this.getInbox(params.peerId || this.client?.peerId?.toString());
          break;

        case "getStatus":
          result = {
            connected: !!this.client,
            peerId: this.client?.peerId?.toString() || null,
            timestamp: new Date().toISOString(),
          };
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      return { result, id };
    } catch (error) {
      return {
        error: {
          code: -32602,
          message: error instanceof Error ? error.message : "Unknown error",
          data: { method, params },
        },
        id,
      };
    }
  }

  private async initializeClient(seedPassword: string): Promise<string> {
    if (this.client) {
      await this.client.stop();
    }

    await sodium.ready;
    console.log("Initializing P2P client...");

    const privateKey = await getPrivateKeyFromSeed(seedPassword);
    this.client = await getNewClient(["/ip4/0.0.0.0/udp/0/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"], privateKey);

    await this.client.start();
    const peerId = this.client.peerId.toString();
    console.log("Client initialized with ID:", peerId);

    return peerId;
  }

  private async bootstrapToPeer(peerIdString: string): Promise<void> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize first.");
    }

    const peerId: PeerId = peerIdFromString(peerIdString);
    assert(!this.client.peerId.equals(peerId), "Cannot bootstrap to self");
    assert(isAddress(encodePeerId(peerId)), "Invalid peer ID format");

    console.log("Started bootstrapping with peer:", peerId.toString());

    const abortController = new AbortController();

    try {
      await this.client.peerRouting.findPeer(peerId, { signal: abortController.signal });
      console.log("Found peer:", peerId.toString());

      await this.client.dial(peerId, { signal: abortController.signal });
      console.log("Connected to peer:", peerId.toString());
    } catch (err: unknown) {
      console.warn("Error during bootstrapping:", err);
      abortController.abort();
      throw err;
    }
  }

  private async getNeighbors(): Promise<string[]> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize first.");
    }

    const neighbors = this.client.services.proto.getNeighbors();
    return neighbors;
  }

  private async sendMessage(recipientString: string, messages: string[]): Promise<void> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize first.");
    }

    assert(this.client.services.proto, "Message service not initialized");

    const recipient: PeerId = peerIdFromString(recipientString);
    assert(isAddress(encodePeerId(recipient)), "Invalid recipient address");

    console.log("Sending message to:", recipient.toString());
    await this.client.services.proto.sendMessages(recipient, messages);
    console.log("Message sent successfully!");
  }

  private async getInbox(peerIdString?: string): Promise<string[]> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize first.");
    }

    const peerId = peerIdString ? peerIdFromString(peerIdString) : this.client.peerId;
    const messages = await this.client.services.proto.getInbox(peerId);
    return messages;
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, "0.0.0.0", () => {
        console.log(`P2P RPC Server running on port ${this.port}`);
        console.log(`Health check: http://localhost:${this.port}/health`);
        console.log(`RPC endpoint: http://localhost:${this.port}/rpc`);
        console.log(`REST API: http://localhost:${this.port}/api/*`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log("RPC Server stopped");
          resolve();
        });
      });
    }
  }
}
