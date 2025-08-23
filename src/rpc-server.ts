import express, { Request, Response } from "express";
import cors from "cors";
import { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";

import { encodePeerId, isAddress } from "./tools/typing.js";
import { assert } from "./tools/utils.js";

interface RPCRequest {
  method: string;
  params: any;
  id?: string | number;
  clientId?: string; // Optional client identifier
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

// Interfaces for client-provided data in requests
interface ValidateBootstrapParams {
  peerId: string;
  clientPeerId: string;
}

interface ValidateSendMessageParams {
  recipient: string;
  messages: string[];
}

interface ValidatePeerIdParams {
  peerId: string;
}

export class P2PRPCServer {
  private app: express.Application;
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
        message: "P2P RPC Server is running",
        version: "2.0.0-client-agnostic",
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

    // RESTful endpoints for validation and processing
    this.app.post("/api/validate/bootstrap", async (req: Request, res: Response) => {
      try {
        const result = await this.validateBootstrap(req.body);
        res.json({ success: true, validation: result });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.post("/api/validate/send", async (req: Request, res: Response) => {
      try {
        const result = await this.validateSendMessage(req.body);
        res.json({ success: true, validation: result });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.post("/api/validate/peer", async (req: Request, res: Response) => {
      try {
        const result = await this.validatePeerId(req.body);
        res.json({ success: true, validation: result });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    // Process client data endpoints
    this.app.post("/api/process/neighbors", async (req: Request, res: Response) => {
      try {
        const { neighbors } = req.body;
        const result = await this.processNeighbors(neighbors);
        res.json({ success: true, processed: result });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    this.app.post("/api/process/inbox", async (req: Request, res: Response) => {
      try {
        const { messages, peerId } = req.body;
        const result = await this.processInbox(messages, peerId);
        res.json({ success: true, processed: result });
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
        case "validateBootstrap":
          result = await this.validateBootstrap(params);
          break;

        case "validateSendMessage":
          result = await this.validateSendMessage(params);
          break;

        case "validatePeerId":
          result = await this.validatePeerId(params);
          break;

        case "processNeighbors":
          result = await this.processNeighbors(params.neighbors);
          break;

        case "processInbox":
          result = await this.processInbox(params.messages, params.peerId);
          break;

        case "getServerStatus":
          result = {
            status: "ok",
            timestamp: new Date().toISOString(),
            version: "2.0.0-client-agnostic",
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

  private async validateBootstrap(params: ValidateBootstrapParams): Promise<any> {
    const { peerId, clientPeerId } = params;

    if (!peerId || !clientPeerId) {
      throw new Error("Both peerId and clientPeerId are required");
    }

    // Validate peer ID formats
    try {
      const targetPeer = peerIdFromString(peerId);
      const clientPeer = peerIdFromString(clientPeerId);

      // Check if trying to bootstrap to self
      if (targetPeer.equals(clientPeer)) {
        throw new Error("Cannot bootstrap to self");
      }

      // Validate peer ID format
      if (!isAddress(encodePeerId(targetPeer))) {
        throw new Error("Invalid target peer ID format");
      }

      if (!isAddress(encodePeerId(clientPeer))) {
        throw new Error("Invalid client peer ID format");
      }

      console.log(`Validated bootstrap request: ${clientPeerId} -> ${peerId}`);

      return {
        valid: true,
        targetPeer: peerId,
        clientPeer: clientPeerId,
        message: "Bootstrap validation successful",
      };
    } catch (error) {
      throw new Error(`Bootstrap validation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async validateSendMessage(params: ValidateSendMessageParams): Promise<any> {
    const { recipient, messages } = params;

    if (!recipient) {
      throw new Error("Recipient peer ID is required");
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error("Messages array is required and must not be empty");
    }

    try {
      const recipientPeer = peerIdFromString(recipient);

      if (!isAddress(encodePeerId(recipientPeer))) {
        throw new Error("Invalid recipient peer ID format");
      }

      console.log(`Validated send message request to: ${recipient} (${messages.length} messages)`);

      return {
        valid: true,
        recipient,
        messageCount: messages.length,
        messages: messages.map((msg, index) => ({ index, length: msg.length })),
        message: "Send message validation successful",
      };
    } catch (error) {
      throw new Error(`Send message validation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async validatePeerId(params: ValidatePeerIdParams): Promise<any> {
    const { peerId } = params;

    if (!peerId) {
      throw new Error("Peer ID is required");
    }

    try {
      const peer = peerIdFromString(peerId);

      if (!isAddress(encodePeerId(peer))) {
        throw new Error("Invalid peer ID format");
      }

      console.log(`Validated peer ID: ${peerId}`);

      return {
        valid: true,
        peerId,
        encodedPeerId: encodePeerId(peer),
        message: "Peer ID validation successful",
      };
    } catch (error) {
      throw new Error(`Peer ID validation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async processNeighbors(neighbors: string[]): Promise<any> {
    if (!neighbors || !Array.isArray(neighbors)) {
      throw new Error("Neighbors must be an array");
    }

    const processed = neighbors.map((neighbor, index) => {
      try {
        const peer = peerIdFromString(neighbor);
        return {
          index,
          peerId: neighbor,
          valid: isAddress(encodePeerId(peer)),
          encoded: encodePeerId(peer),
        };
      } catch (error) {
        return {
          index,
          peerId: neighbor,
          valid: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    const validCount = processed.filter((p) => p.valid).length;
    const invalidCount = processed.length - validCount;

    console.log(`Processed neighbors: ${validCount} valid, ${invalidCount} invalid`);

    return {
      total: processed.length,
      valid: validCount,
      invalid: invalidCount,
      neighbors: processed,
      message: "Neighbors processing completed",
    };
  }

  private async processInbox(messages: string[], peerId?: string): Promise<any> {
    if (!messages || !Array.isArray(messages)) {
      throw new Error("Messages must be an array");
    }

    // Validate peer ID if provided
    if (peerId) {
      try {
        const peer = peerIdFromString(peerId);
        if (!isAddress(encodePeerId(peer))) {
          throw new Error("Invalid peer ID format");
        }
      } catch (error) {
        throw new Error(`Invalid peer ID: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    const processed = messages.map((message, index) => ({
      index,
      length: message.length,
      preview: message.substring(0, 50) + (message.length > 50 ? "..." : ""),
      timestamp: new Date().toISOString(),
    }));

    console.log(`Processed inbox: ${messages.length} messages${peerId ? ` for peer ${peerId}` : ""}`);

    return {
      messageCount: messages.length,
      peerId: peerId || null,
      messages: processed,
      totalBytes: messages.reduce((sum, msg) => sum + msg.length, 0),
      message: "Inbox processing completed",
    };
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, "0.0.0.0", () => {
        console.log(`P2P RPC Server (Client-Agnostic) running on port ${this.port}`);
        console.log(`Health check: http://localhost:${this.port}/health`);
        console.log(`RPC endpoint: http://localhost:${this.port}/rpc`);
        console.log(`Validation APIs: http://localhost:${this.port}/api/validate/*`);
        console.log(`Processing APIs: http://localhost:${this.port}/api/process/*`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
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
