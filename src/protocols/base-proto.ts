import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";

import { x25519 } from "@noble/curves/ed25519.js";
import { Uint8ArrayList } from "uint8arraylist";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import { isParcel, isReturn, isRequest, decodeAddress, encodePeerId, stringify, toBuffer } from "../tools/typing.js";
import {
  Address,
  Role,
  Uuid,
  PeerInfo,
  ProtocolEvents,
  Payload,
  Parcel,
  ReqData,
  ResData,
  Acceptance,
  Rejection,
  Return,
  Callback,
  AsyncIsh,
} from "../types/index.js";
import DistanceCache from "../helpers/distance-cache.js";
import { getLogger, Logger } from "../helpers/logger.js";
import { assert } from "../tools/utils.js";

export enum BaseTypes {
  Return = "base:return",
  EmptyResponse = "base:empty-response",
}

export default class BaseProto<T extends ProtocolEvents = ProtocolEvents> extends TypedEventEmitter<T> {
  public readonly PROTOCOL: string = "/secret-handshake/proto/0.7.1";

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
  public readonly logger: Logger;

  protected peersCache = new DistanceCache<Address, PeerInfo>(this.address, 128);

  private batchMap = new Map<Address, Set<Parcel<Payload>>>();
  private batchTimers = new Map<Address, NodeJS.Timeout>();
  private callbackMap = new Map<Uuid, Callback>();

  private connectionCache = new LRUCache<PeerId, Connection>({ max: 512 });
  private streamCache = new LRUCache<PeerId, Stream>({ max: 512 });

  constructor(components: Components) {
    super();
    this.peerId = components.peerId;
    this.sk = components.privateKey.raw.subarray(0, 32);

    this.logger = getLogger(this.address);

    this.connectionManager = components.connectionManager;
    this.registrar = components.registrar;
  }

  protected addPeer(peerId: PeerId, role: Role): void {
    const address: Address = encodePeerId(peerId);
    this.peersCache.add(address, { peerId, role, timestamp: Date.now() });
  }

  protected dropPeer(peerId: PeerId): void {
    const address: Address = encodePeerId(peerId);
    this.peersCache.delete(address);
    this.connectionCache.delete(peerId);
    this.streamCache.delete(peerId);
  }

  private async getConnection(peerId: PeerId): Promise<Connection> {
    let connection: Connection | undefined = this.connectionCache.get(peerId);

    if (connection?.status !== "open" || connection.direction !== "outbound") {
      await connection?.close();
      connection = await this.connectionManager.openConnection(peerId);
      this.connectionCache.set(peerId, connection);
    }

    return connection;
  }

  private async getStream(connection: Connection, peerId: PeerId): Promise<Stream> {
    let stream: Stream | undefined = this.streamCache.get(peerId);

    if (stream?.status !== "open" || stream.direction !== "outbound") {
      await stream?.close();
      stream = await connection.newStream(this.PROTOCOL);
      this.streamCache.set(peerId, stream);
    }

    return stream;
  }

  private async decodeStream(stream: Stream): Promise<string> {
    const chunks: string[] = [];

    try {
      await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
        for await (const data of source) {
          chunks.push(stringify(data.subarray(), { stream: true }));
        }
      });

      chunks.push(stringify()); // Flush any remaining data
    } catch (err: unknown) {
      this.logger.warn("Failed to decode stream", err);
      throw new Error("Failed to decode stream");
    }

    return chunks.join("");
  }

  protected async getWithTimeout<T>(promise: Promise<T>, delay: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const message: string = "Timeout while waiting for response";
        reject({ success: false, message });
      }, delay);
    });

    return Promise.race([promise, timeoutPromise]).then((t: T) => {
      clearTimeout(timer);
      return t;
    });
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
    const receivers: Set<Address> = new Set(parcels.map((p) => p.receiver));
    assert(receivers.size === 1, "All parcels must have the same receiver");

    try {
      const peerId: PeerId = decodeAddress(receivers.values().next().value!);
      const connection: Connection = await this.getConnection(peerId);
      const outgoing: Stream = await this.getStream(connection, peerId);

      const parcelsString: string = JSON.stringify(parcels);
      const parcelsBuffer: Uint8Array = toBuffer(parcelsString);
      await pipe([parcelsBuffer], outgoing);
    } catch (err: unknown) {
      this.logger.error("sendBatch", err);
    }
  }

  private async addToBatch(parcel: Parcel<Payload>): Promise<void> {
    const userAddress: Address = parcel.receiver;
    let batch: Set<Parcel<Payload>> | undefined = this.batchMap.get(userAddress);
    if (batch === undefined) {
      batch = new Set<Parcel<Payload>>();
      this.batchMap.set(userAddress, batch);
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
      this.batchMap.delete(userAddress);
      this.batchTimers.delete(userAddress);
    }, BaseProto.BATCH_TIMEOUT);
    this.batchTimers.set(userAddress, launchTimer);
  }

  private async sendParcel<U extends ResData, T extends ReqData = ReqData>(parcel: Parcel<T>): Promise<Return<U>> {
    this.addToBatch(parcel);
    return this.registerCallback(parcel, BaseProto.CALLBACK_TIMEOUT);
  }

  protected async sendRequest<U extends ResData, T extends ReqData = ReqData>(
    receiver: Address,
    payload: T
  ): Promise<Acceptance<U>> {
    this.logger.debug("sendRequest", payload);

    const callbackId: Uuid = crypto.randomUUID();
    const parcel: Parcel<T> = { batch: { callbackId, payload }, receiver, sender: this.address };
    const result: Return<U> = await this.sendParcel<U, T>(parcel);
    assert(result.success, (result as Rejection).message);

    return result;
  }

  private parseIncoming(rawMessage: string): Parcel<Payload>[] {
    try {
      const parcel: unknown = JSON.parse(rawMessage);
      if (Array.isArray(parcel) && parcel.every(isParcel)) {
        return parcel;
      }
      throw new Error("Invalid parcel format");
    } catch (err: unknown) {
      this.logger.error("Failed to parse incoming message", err);
    }
    return [];
  }

  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    this.logger.debug("onIncomingStream", connection.remotePeer.toString());
    const rawMessage: string = await this.decodeStream(stream);
    stream.close();

    const sender: Address = encodePeerId(connection.remotePeer);
    try {
      const parcels: Parcel<Payload>[] = this.parseIncoming(rawMessage);

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
      this.logger.error("onIncomingStream", err);
    }
  }

  // Override the addEventListener method to handle returns from network requests
  public addEventListener<K extends keyof T>(type: K, args: AsyncIsh<T[K], ResData>): void {
    const eventWrapper = async (event: T[K]): Promise<void> => {
      const senderPeerId: PeerId = decodeAddress(event.detail.sender); // Who sent the request
      const receiver: Address = encodePeerId(senderPeerId); // Who will receive the response
      const sender: Address = this.address;

      let payload: Return;
      try {
        const data: ResData = (await args(event)) ?? { type: BaseTypes.EmptyResponse };
        payload = { success: true, data };
        this.logger.info("eventWrapper", payload);
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);
        payload = { success: false, message: errorMessage };
        this.logger.warn("eventWrapper", payload);
      }

      const callbackId: Uuid = event.detail.batch.callbackId;
      const returnParcel: Parcel<Return> = { batch: { callbackId, payload }, receiver, sender };

      this.addToBatch(returnParcel).catch((err: unknown) => {
        const message: string = err instanceof Error ? err.message : String(err);
        this.logger.error("Error sending parcel", message);
      });
    };

    super.addEventListener(type, eventWrapper);
  }

  public async start(): Promise<void> {
    await this.registrar.handle(this.PROTOCOL, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    await this.registrar.unhandle(this.PROTOCOL);
    this.streamCache.clear();
  }
}
