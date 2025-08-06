import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";

import { Uint8ArrayList } from "uint8arraylist";
import { blake2b } from "@noble/hashes/blake2";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import {
  decoder,
  isValidParcel,
  encodedFromBuffer,
  generateUuid,
  isValidReturn,
  isValidRequest,
  assert,
} from "./tools/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";

export enum BaseTypes {
  Return = "base:return",
  EmptyResponse = "base:empty-response",
}

function newAcceptance<T extends ResponseData = EmptyResponse>(data: T): Acceptance<T> {
  return { data, success: true, type: BaseTypes.Return };
}

function newRejection(message: string): Rejection {
  return { type: BaseTypes.Return, success: false, message };
}

export default class BaseProto<T extends ProtocolEvents> extends TypedEventEmitter<T> {
  public static readonly PROTOCOL: string = "/secret-handshake/proto/0.5.0";
  private static readonly CALLBACK_LIMIT: number = 32;
  private static readonly TIMEOUT: number = 30_000;

  protected readonly sk: Uint8Array;
  protected get pk(): Uint8Array {
    return ed25519.getPublicKey(this.sk);
  }

  private connectionManager: ConnectionManager;
  protected peerId: PeerId;
  private registrar: Registrar;

  private callbackQueue = new LRUCache<Uuid, Callback>({ max: BaseProto.CALLBACK_LIMIT, ttl: BaseProto.TIMEOUT });
  private limiterCache = new LRUCache<string, number>({ max: 2048, ttl: BaseProto.TIMEOUT });

  constructor(components: Components) {
    super();
    this.sk = components.privateKey.raw.subarray(0, 32);
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

  private async sendParcelNoCallback<T extends RequestData | Return>(peerId: PeerId, parcel: Parcel<T>): Promise<void> {
    const connection: Connection = await this.getConnection(peerId);
    const outgoing: Stream = await connection.newStream(BaseProto.PROTOCOL);
    try {
      const parcelString: string = JSON.stringify(parcel);
      await pipe([Buffer.from(parcelString, "utf-8")], outgoing);
    } finally {
      outgoing.close();
    }
  }

  private async sendParcel<T extends RequestData, U extends ResponseData>(
    peerId: PeerId,
    parcel: Parcel<T>
  ): Promise<Return<U>> {
    await this.sendParcelNoCallback(peerId, parcel);

    return new Promise<Return<U>>((res: Callback<U>): void => {
      const timeOut: NodeJS.Timeout = setTimeout((): void => {
        res(newRejection(`Timeout while waiting for response from: ${peerId}`) as Return<U>);
      }, BaseProto.TIMEOUT);

      // Open a callback for the response
      this.callbackQueue.set(parcel.callbackId, (val: Return): void => {
        timeOut.close();
        this.callbackQueue.delete(parcel.callbackId);
        res(val as Return<U>);
      });
    });
  }

  /**
   * Sends a request to a specified peer and awaits a response.
   *
   * @template T - The type of the request payload.
   * @template U - The type of the expected response data.
   * @param peerId - The identifier of the peer to send the request to.
   * @param payload - The payload data to send with the request.
   * @returns A promise that resolves to the response data wrapped in a `Return<U>` object.
   * @throws {Error} If the response indicates failure (`result.success` is false).
   */
  protected async sendRequest<T extends RequestData, U extends ResponseData>(
    peerId: PeerId,
    payload: T
  ): Promise<Return<U>> {
    const sender: Base58 = this.peerId.toString();

    const callbackId: Uuid = generateUuid();
    const parcel: Parcel<T> = { callbackId, payload, sender };
    const result: Return<U> = await this.sendParcel<T, U>(peerId, parcel);

    if (!result.success) {
      throw new Error(result.message);
    }

    return result;
  }

  private exceedsRateLimit(peerId: PeerId): boolean {
    const peerAddress: string = peerId.toString();
    const rateCount: number = (this.limiterCache.get(peerAddress) ?? 0) + 1;
    this.limiterCache.set(peerAddress, rateCount);
    return BaseProto.CALLBACK_LIMIT < rateCount;
  }

  private countDuplicateMessages(rawMessage: string): number {
    const fingerprint: Encoded = encodedFromBuffer(blake2b(rawMessage));
    const messageCount: number = (this.limiterCache.get(fingerprint) ?? 0) + 1;
    this.limiterCache.set(fingerprint, messageCount);
    return messageCount;
  }

  private static parseParcel<T extends RequestData>(rawMessage: string): Parcel<T> | undefined {
    try {
      const parcel: Parcel<T> = JSON.parse(rawMessage);
      if (isValidParcel(parcel)) {
        return parcel;
      }
    } catch {}
  }

  /**
   * Handles an incoming stream from a peer connection.
   *
   * This method decodes the incoming stream, checks for rate limits and duplicate messages,
   * parses the message into a parcel, and dispatches the appropriate event or callback.
   * If the message is a callback response, it invokes the corresponding callback.
   * If the message is a new payload, it dispatches a custom event with the payload details.
   * Logs warnings for rate limit violations and excessive duplicate messages.
   * Catches and logs errors encountered during processing.
   *
   * @param {IncomingStreamData} param0 - The incoming stream data containing the connection and stream.
   * @returns {Promise<void>} A promise that resolves when the stream has been processed.
   */
  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await BaseProto.decodeStream(stream);
    stream.close();

    try {
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

      const detail: Parcel<RequestData | Return> | undefined = BaseProto.parseParcel(rawMessage);
      assert(detail !== undefined, `Invalid parcel received: ${rawMessage}`);
      assert(connection.remotePeer.equals(detail.sender), `${connection.remotePeer} !== ${detail.sender}`);

      // If this is a callback response, invoke the callback instead of treating it like a new event
      if (this.callbackQueue.has(detail.callbackId) && isValidReturn(detail.payload)) {
        this.callbackQueue.get(detail.callbackId)!(detail.payload);
      }

      // If this is a new payload, pass it to the event handler
      else if (isValidRequest(detail.payload)) {
        this.dispatchEvent(new CustomEvent(detail.payload.type, { detail }));
      }
    } catch {
      console.error("Error processing incoming stream:", rawMessage);
    }
  }

  /**
   * Registers an asynchronous event listener for a specific event type.
   *
   * @typeParam K - The event type key, constrained to the keys of `T`.
   * @typeParam U - The response data type, extending `ResponseData`.
   * @param type - The event type to listen for.
   * @param args - An asynchronous callback function that handles the event and returns a response or a promise of a response.
   *
   * The listener wraps the callback to handle both successful and error responses,
   * packaging the result into a `Parcel` and sending it back to the sender.
   * Errors thrown by the callback are caught and sent as rejection payloads.
   *
   * @remarks
   * This method overrides the base `addEventListener` to provide additional logic for
   * handling peer-to-peer event responses, including error handling and response packaging.
   */
  public addEventListener<K extends keyof T, U extends ResponseData>(
    type: K,
    args: (evt: T[K]) => U | Promise<U>,
    opts?: AddEventListenerOptions
  ): void {
    const eventWrapper = async (event: T[K]): Promise<void> => {
      const senderPeerId = peerIdFromString(event.detail.sender);
      const sender: Base58 = this.peerId.toString();

      let returnParcel: Parcel<Return<U>>;
      try {
        const res: U = await args(event);
        const payload: Return<U> = newAcceptance(res);
        returnParcel = { callbackId: event.detail.callbackId, payload, sender };
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);
        returnParcel = { callbackId: event.detail.callbackId, payload: newRejection(errorMessage), sender };
      }

      try {
        this.sendParcelNoCallback(senderPeerId, returnParcel);
      } catch (error) {
        console.error("Error sending parcel:", error);
      }
    };

    super.addEventListener(type, eventWrapper, opts);
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
