import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";

import { x25519 } from "@noble/curves/ed25519.js";
import { Uint8ArrayList } from "uint8arraylist";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import {
  isParcel,
  isReturn,
  isRequest,
  decodeAddress,
  encodePeerId,
  stringify,
  toBuffer,
  Formats,
} from "../tools/typing.js";
import { getLogger, Logger } from "../helpers/logger.js";
import { sodium } from "../tools/cryptography.js";
import { assert } from "../tools/utils.js";

export enum BaseTypes {
  Return = "base:return",
  EmptyResponse = "base:empty-response",
}

export default class BaseProto<T extends ProtocolEvents> extends TypedEventEmitter<T> {
  public static readonly PROTOCOL: string = "/secret-handshake/proto/0.7.1";

  private static readonly BATCH_TIMEOUT: number = 250; // send batch if no new parcels arrive within a quarter of a second
  private static readonly CALLBACK_TIMEOUT: number = 10_000; // 10 seconds until callback request expires
  protected static readonly HEAVY_CALLBACK_TIMEOUT: number = 5_000; // 5 second timeout for heavy operations

  private connectionManager: Components["connectionManager"];
  private registrar: Components["registrar"];

  protected readonly sk: Uint8Array;
  protected get pk(): Uint8Array {
    return x25519.getPublicKey(this.sk);
  }
  protected readonly peerId: PeerId;
  protected get address(): Address {
    return encodePeerId(this.peerId);
  }
  protected readonly logger: Logger;

  private batches = new Map<Address, Set<Parcel<Payload>>>();
  private batchTimers = new Map<Address, NodeJS.Timeout>();
  private callbackMap = new Map<Uuid, Callback>();

  private connectionCache = new LRUCache<PeerId, Connection>({ max: 256 });
  private requestCache = new LRUCache<Base64, Promise<Acceptance<ResData>>>({ max: 256 });

  constructor(components: Components) {
    super();
    this.peerId = components.peerId;
    this.sk = components.privateKey.raw.subarray(0, 32);
    this.logger = getLogger(this.address);
    this.connectionManager = components.connectionManager;
    this.registrar = components.registrar;
  }

  public handleLog(level: "error" | "warn" | "info", message: unknown, context: string): void {
    switch (level) {
      case "error":
        this.logger.error(`Error ${context}:`, message);
        break;
      case "warn":
        this.logger.warn(`Warning ${context}:`, message);
        break;
      case "info":
        this.logger.info(`Info ${context}:`, message);
        break;
    }
  }

  protected async getWithTimeout<T>(promise: Promise<T>, delay: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, rej) => {
      timer = setTimeout(() => {
        const message: string = "Timeout while waiting for response";
        rej({ success: false, message });
      }, delay);
    });

    return Promise.race([promise, timeoutPromise]).then((t: T) => {
      clearTimeout(timer);
      return t;
    });
  }

  private async getConnection(peerId: PeerId): Promise<Connection> {
    const existingConnection: Connection | undefined = this.connectionCache.get(peerId);
    if (existingConnection?.status === "open" && existingConnection?.direction === "outbound") {
      this.connectionCache.set(peerId, existingConnection);
      return existingConnection;
    }

    const newConnection: Connection = await this.connectionManager.openConnection(peerId);
    this.connectionCache.set(peerId, newConnection);
    return newConnection;
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    const chunks: string[] = [];

    await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      for await (const data of source) {
        chunks.push(stringify(data.subarray(), { stream: true }));
      }
    });

    chunks.push(stringify()); // Flush any remaining data
    return chunks.join("");
  }

  // Create a promise that resolves when the response is received
  private async registerCallback<T extends ReqData, U extends ResData = ResData>(
    parcel: Parcel<T>,
    delay: number
  ): Promise<Return<U>> {
    const responsePromise: Promise<Return<U>> = new Promise<Return<U>>((res) => {
      this.callbackMap.set(parcel.batch.callbackId, (val: Return) => {
        this.callbackMap.delete(parcel.batch.callbackId);
        res(val as Return<U>);
      });
    });

    return this.getWithTimeout(responsePromise, delay);
  }

  private async sendBatch<T extends Payload>(parcels: Parcel<T>[]): Promise<void> {
    const peerId: PeerId = decodeAddress(parcels[0].receiver);
    const connection: Connection = await this.getConnection(peerId);
    const outgoing: Stream = await connection.newStream(BaseProto.PROTOCOL);

    try {
      const parcelsString: string = JSON.stringify(parcels);
      const parcelsBuffer: Uint8Array = toBuffer(parcelsString);
      await pipe([parcelsBuffer], outgoing);
    } catch (err: unknown) {
      const message: string = err instanceof Error ? err.message : String(err);
      this.handleLog("error", message, "sendBatch");
    } finally {
      outgoing.close();
    }
  }

  private async addToBatch(parcel: Parcel<Payload>): Promise<void> {
    const userAddress: Address = parcel.receiver;
    let batch: Set<Parcel<Payload>> | undefined = this.batches.get(userAddress);
    if (batch === undefined) {
      batch = new Set();
      this.batches.set(userAddress, batch);
    }
    batch.add(parcel);

    // Clear existing timer
    const existingTimer: NodeJS.Timeout | undefined = this.batchTimers.get(userAddress);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    // Dispatch batch if a new parcel hasn't arrived within the timeout
    const launchTimer: NodeJS.Timeout = setTimeout(() => {
      this.sendBatch(Array.from(batch));
      this.batches.delete(userAddress);
      this.batchTimers.delete(userAddress);
    }, BaseProto.BATCH_TIMEOUT);
    this.batchTimers.set(userAddress, launchTimer);
  }

  private async sendParcel<T extends ReqData, U extends ResData>(parcel: Parcel<T>): Promise<Return<U>> {
    this.addToBatch(parcel);
    return this.registerCallback(parcel, BaseProto.CALLBACK_TIMEOUT);
  }

  protected async sendRequest<T extends ReqData, U extends ResData>(
    receiver: Address,
    payload: T
  ): Promise<Acceptance<U>> {
    payload.stamp;
    const fingerprint: Base64 = `${Formats.Base64},${sodium.crypto_generichash(32, payload.stamp, receiver, "base64")}`;
    if (this.requestCache.has(fingerprint)) {
      return this.requestCache.get(fingerprint)! as Promise<Acceptance<U>>;
    }

    const callbackId: Uuid = crypto.randomUUID();
    const parcel: Parcel<T> = { batch: { callbackId, payload }, receiver, sender: this.address };
    const result: Return<U> = await this.sendParcel<T, U>(parcel);
    assert(result.success, (result as Rejection).message);

    this.requestCache.set(fingerprint, Promise.resolve(result));
    return result;
  }

  private static parseIncoming(rawMessage: string): Parcel<Payload>[] {
    try {
      const parcel: unknown = JSON.parse(rawMessage);
      if (Array.isArray(parcel) && parcel.every(isParcel)) {
        return parcel;
      }
    } catch {}
    return [];
  }

  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await BaseProto.decodeStream(stream);
    stream.close();

    const sender: Address = encodePeerId(connection.remotePeer);
    try {
      const parcels: Parcel<Payload>[] = BaseProto.parseIncoming(rawMessage);
      this.logger.info("onIncomingStream", parcels);

      for (const detail of parcels) {
        assert(sender === detail.sender, `${sender} !== ${detail.sender}`);

        // If this is a callback response, invoke the callback instead of treating it like a new event
        if (this.callbackMap.has(detail.batch.callbackId) && isReturn(detail.batch.payload)) {
          this.callbackMap.get(detail.batch.callbackId)!(detail.batch.payload);
        }

        // If this is a new payload, pass it to the event handler
        else if (isRequest(detail.batch.payload)) {
          this.dispatchEvent(new CustomEvent(detail.batch.payload.type, { detail }));
        }
      }
    } catch (err: unknown) {
      this.handleLog("error", err, "onIncomingStream");
    }
  }

  public addEventListener<K extends keyof T>(type: K, args: AsyncIsh<T[K], ResData>): void {
    const eventWrapper = async (event: T[K]): Promise<void> => {
      const senderPeerId: PeerId = decodeAddress(event.detail.sender); // Who sent the request
      const receiver: Address = encodePeerId(senderPeerId); // Who will receive the response
      const sender: Address = this.address;

      let payload: Return;
      try {
        const data: ResData = (await args(event)) ?? { type: BaseTypes.EmptyResponse };
        payload = { success: true, data };
        this.logger.info("callback (eventWrapper)", payload);
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);
        payload = { success: false, message: errorMessage };
      }

      const callbackId: Uuid = event.detail.batch.callbackId;
      const returnParcel: Parcel<Return> = { batch: { callbackId, payload }, receiver, sender };

      this.addToBatch(returnParcel).catch((err: unknown) => {
        const message: string = err instanceof Error ? err.message : String(err);
        console.error("Error sending parcel", message);
      });
    };

    super.addEventListener(type, eventWrapper);
  }

  public async start(): Promise<void> {
    await this.registrar.handle(BaseProto.PROTOCOL, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    await this.registrar.unhandle(BaseProto.PROTOCOL);
    this.connectionCache.clear();
  }
}
