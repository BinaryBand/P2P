import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import { Components } from "libp2p/dist/src/components";

import { Uint8ArrayList } from "uint8arraylist";
import { blake2b } from "@noble/hashes/blake2";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import { decoder, isValidParcel, encodedFromBuffer } from "./tools/utils.js";

export enum BaseTypes {
  EmptyPayload = "base:empty",
}

function newRejection(callbackId: Uuid, message: string = ""): Rejection {
  return { callbackId, message, success: false };
}

function newSuccess(callbackId: Uuid, from: Base58): Parcel<EmptyPayload> {
  const payload: EmptyPayload = { type: BaseTypes.EmptyPayload };
  return { callbackId, from, payload, success: true };
}

export default class BaseProto<T extends {}> extends TypedEventEmitter<T> {
  public static readonly PROTOCOL: string = "/secret-handshake/proto/0.4.0";
  private static readonly LIMIT: number = 32;
  private static readonly TIMEOUT: number = 30_000;

  private connectionManager: ConnectionManager;
  protected peerId: PeerId;
  private registrar: Registrar;

  private callbackQueue = new LRUCache<Uuid, Callback>({ max: BaseProto.LIMIT, ttl: BaseProto.TIMEOUT });
  private limiterCache = new LRUCache<string, number>({ max: 2048, ttl: BaseProto.TIMEOUT });

  constructor(components: Components) {
    super();
    this.connectionManager = components.connectionManager;
    this.peerId = components.peerId;
    this.registrar = components.registrar;
  }

  private async getConnection(peerId: PeerId): Promise<Connection> {
    const connections: Connection[] = this.connectionManager
      .getConnections(peerId)
      .filter(({ direction }) => direction === "outbound");
    const connection: Connection = connections[0] ?? (await this.connectionManager.openConnection(peerId));
    return connection;
  }

  private static byteArrayToString(byteArray: Uint8Array[]): string {
    const combined: Uint8Array = new Uint8Array(byteArray.reduce((acc, val) => acc + val.length, 0));
    let offset: number = 0;
    for (const chunk of byteArray) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(combined);
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    const chunks: Uint8Array[] = [];
    await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      for await (const data of source) {
        chunks.push(...Array.from(data));
      }
    });
    return BaseProto.byteArrayToString(chunks);
  }

  private async sendParcel<T extends Payload>(peerId: PeerId, parcel: Parcel<T>): Promise<void> {
    const connection: Connection = await this.getConnection(peerId);
    const outgoing: Stream = await connection.newStream(BaseProto.PROTOCOL);
    try {
      const parcelString: string = JSON.stringify(parcel);
      await pipe([Buffer.from(parcelString, "utf-8")], outgoing);
    } finally {
      outgoing.close();
    }
  }

  private async sendParcelWithCallback<T extends Payload>(peerId: PeerId, parcel: Parcel): Promise<Parcel<T>> {
    await this.sendParcel(peerId, parcel);

    return new Promise<Parcel<T>>((res): void => {
      const timeOut: NodeJS.Timeout = setTimeout((): void => {
        const timeoutMessage: string = `Timeout while waiting for response from: ${peerId}`;
        res(newRejection(parcel.callbackId, timeoutMessage));
      }, BaseProto.TIMEOUT);

      // Open a callback for the response
      this.callbackQueue.set(parcel.callbackId, (val: Parcel): void => {
        timeOut.close();
        this.callbackQueue.delete(parcel.callbackId);
        res(!val.success ? newRejection(val.callbackId, val.message) : (val as Parcel<T>));
      });
    });
  }

  protected async sendPayload<T extends Payload>(peerId: PeerId, payload: Payload, callbackId: Uuid): Promise<T> {
    const parcel: Parcel = { callbackId, from: this.peerId.toString(), payload, success: true };
    const result: Parcel<T> = await this.sendParcelWithCallback<T>(peerId, parcel);

    if (!result.success) {
      throw new Error(result.message);
    }

    return result.payload as T;
  }

  protected async sendConfirmation(peerId: PeerId, callbackId: Uuid): Promise<void> {
    try {
      await this.sendParcel(peerId, newSuccess(callbackId, this.peerId.toString()));
    } catch {
      console.warn(`Failed to send confirmation to peer ${peerId}`);
    }
  }

  protected async sendRejection(peerId: PeerId, callbackId: Uuid, message: string): Promise<void> {
    try {
      await this.sendParcel(peerId, newRejection(callbackId, message));
    } catch {
      console.warn(`Failed to send rejection to peer ${peerId}`);
    }
  }

  private exceedsRateLimit(peerId: PeerId): boolean {
    const peerAddress: string = peerId.toString();
    const rateCount: number = (this.limiterCache.get(peerAddress) ?? 0) + 1;
    this.limiterCache.set(peerAddress, rateCount);
    return BaseProto.LIMIT < rateCount;
  }

  private countDuplicateMessages(rawMessage: string): number {
    const fingerprint: Encoded = encodedFromBuffer(blake2b(rawMessage));
    const messageCount: number = (this.limiterCache.get(fingerprint) ?? 0) + 1;
    this.limiterCache.set(fingerprint, messageCount);
    return messageCount;
  }

  private static parsePackagedPayload<T extends Payload>(rawMessage: string): PackagedPayload<T> | undefined {
    try {
      const packaged: PackagedPayload<T> = JSON.parse(rawMessage);
      if (isValidParcel(packaged)) {
        return packaged;
      }
    } catch {}
  }

  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await BaseProto.decodeStream(stream);
    stream.close();

    // Check if the message is a valid payload
    if (this.exceedsRateLimit(connection.remotePeer)) {
      console.warn("Rate limit exceeded, dropping message:", rawMessage);
      return;
    }

    // Check for excessive duplicate messages
    const messageCount: number = this.countDuplicateMessages(rawMessage);
    if (1 < messageCount) {
      if (8 < messageCount) {
        console.warn(`Excessive duplicates detected: ${rawMessage}`);
      }
      return;
    }

    let detail: PackagedPayload<Payload> | undefined = BaseProto.parsePackagedPayload(rawMessage);
    if (detail === undefined) {
      console.warn("Failed to parse payload:", rawMessage);
      return;
    }

    // If this is a callback response, invoke the callback instead of treating it like a new event
    if (this.callbackQueue.has(detail.callbackId)) {
      this.callbackQueue.get(detail.callbackId)!(detail);
      return;
    }

    // Pass the event to the appropriate handler
    if (detail.success) {
      this.dispatchEvent(new CustomEvent(detail.payload.type, { detail }));
    }
  }

  public async start(): Promise<void> {
    await this.registrar.handle(BaseProto.PROTOCOL, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    await this.registrar.unhandle(BaseProto.PROTOCOL);
    this.callbackQueue.clear();
    this.limiterCache.clear();
  }
}
