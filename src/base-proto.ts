import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import { Components } from "libp2p/dist/src/components";

import { ed25519 } from "@noble/curves/ed25519.js";
import { Uint8ArrayList } from "uint8arraylist";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import { decode, bytesToBase64, isParcel, isReturn, isRequest, encodePeerId, decodeAddress } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

export enum BaseTypes {
  Return = "base:return",
  EmptyResponse = "base:empty-response",
}

export default class BaseProto<T extends ProtocolEvents> extends TypedEventEmitter<T> {
  public static readonly PROTOCOL: string = "/secret-handshake/proto/0.5.2";
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
    return connections[0] ?? (await this.connectionManager.openConnection(peerId));
  }

  private static byteArrayToString(byteArray: Uint8Array[]): string {
    const combined: Uint8Array = new Uint8Array(byteArray.reduce((acc, val) => acc + val.length, 0));
    let offset: number = 0;
    for (const chunk of byteArray) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return decode(combined);
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

  private async sendParcelNoCallback<T extends ReqData | Return>(peerId: PeerId, parcel: Parcel<T>): Promise<void> {
    const connection: Connection = await this.getConnection(peerId);
    const outgoing: Stream = await connection.newStream(BaseProto.PROTOCOL);
    try {
      const parcelString: string = JSON.stringify(parcel);
      await pipe([Buffer.from(parcelString, "utf-8")], outgoing);
    } catch {
    } finally {
      outgoing.close();
    }
  }

  private async sendParcel<T extends ReqData, U extends ResData>(
    peerId: PeerId,
    parcel: Parcel<T>
  ): Promise<Return<U>> {
    await this.sendParcelNoCallback(peerId, parcel);

    // Wait for the response
    return new Promise<Return<U>>((res: Callback<U>): void => {
      const timeOut: NodeJS.Timeout = setTimeout((): void => {
        const message: string = `Timeout while waiting for response from: ${peerId}`;
        res({ success: false, message });
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
  protected async sendRequest<T extends ReqData, U extends ResData>(peerId: PeerId, payload: T): Promise<Return<U>> {
    const sender: Address = encodePeerId(this.peerId);

    const callbackId: Uuid = crypto.randomUUID();
    const parcel: Parcel<T> = { callbackId, payload, sender };
    const result: Return<U> = await this.sendParcel<T, U>(peerId, parcel);
    assert(result.success, (result as Rejection).message);

    return result;
  }

  private exceedsRateLimit(peerId: PeerId): boolean {
    const peerAddress: Address = encodePeerId(peerId);
    const rateCount: number = (this.limiterCache.get(peerAddress) ?? 0) + 1;
    this.limiterCache.set(peerAddress, rateCount);
    return BaseProto.CALLBACK_LIMIT < rateCount;
  }

  private countDuplicateMessages(rawMessage: string): number {
    const fingerprint: Base64 = bytesToBase64(blake2b(rawMessage));
    const messageCount: number = (this.limiterCache.get(fingerprint) ?? 0) + 1;
    this.limiterCache.set(fingerprint, messageCount);
    return messageCount;
  }

  private static parseParcel<T extends ReqData>(rawMessage: string): Parcel<T> | null {
    try {
      const parcel: Parcel<T> = JSON.parse(rawMessage);
      if (isParcel(parcel)) return parcel;
    } catch {}
    return null;
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
      // Check for rate limit violations
      const errorMessage: string = `Rate limit exceeded for peer: ${connection.remotePeer}`;
      assert(!this.exceedsRateLimit(connection.remotePeer), errorMessage);

      // Check for excessive duplicate messages
      const messageCount: number = this.countDuplicateMessages(rawMessage);
      assert(messageCount < 8, `Excessive duplicates detected: ${rawMessage}`);

      const detail: Parcel<ReqData | Return> | null = BaseProto.parseParcel(rawMessage);
      assert(detail !== null, `Invalid parcel received: ${rawMessage}`);
      assert(encodePeerId(connection.remotePeer) === detail.sender, `${connection.remotePeer} !== ${detail.sender}`);

      // If this is a callback response, invoke the callback instead of treating it like a new event
      if (this.callbackQueue.has(detail.callbackId) && isReturn(detail.payload)) {
        this.callbackQueue.get(detail.callbackId)!(detail.payload);
      }

      // If this is a new payload, pass it to the event handler
      else if (isRequest(detail.payload)) {
        this.dispatchEvent(new CustomEvent(detail.payload.type, { detail }));
      }
    } catch (err) {
      console.error("Error processing incoming stream:", { rawMessage }, err);
    }
  }

  /**
   * Registers an asynchronous event listener for a specific event type.
   *
   * @typeParam K - The event type key, constrained to the keys of `T`.
   * @typeParam U - The response data type, extending `ResData`.
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
  public addEventListener<K extends keyof T>(type: K, args: AsyncIsh<T[K], ResData>): void {
    const eventWrapper = async (event: T[K]): Promise<void> => {
      const peerId: PeerId = decodeAddress(event.detail.sender);
      const sender: Address = encodePeerId(this.peerId);

      let returnParcel: Parcel<Return>;
      try {
        const res: ResData = (await args(event)) ?? { type: BaseTypes.EmptyResponse };
        returnParcel = { callbackId: event.detail.callbackId, payload: { data: res, success: true }, sender };
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);
        const payload: Rejection = { success: false, message: errorMessage };
        returnParcel = { callbackId: event.detail.callbackId, payload, sender };
      }

      try {
        this.sendParcelNoCallback(peerId, returnParcel);
      } catch (err) {
        console.error("Error sending parcel:", err);
      }
    };

    super.addEventListener(type, eventWrapper);
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
