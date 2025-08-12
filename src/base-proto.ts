import { Connection, IncomingStreamData, PeerId, Stream, TypedEventEmitter } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";

import { x25519 } from "@noble/curves/ed25519.js";
import { Uint8ArrayList } from "uint8arraylist";
import { LRUCache } from "lru-cache";
import { pipe } from "it-pipe";

import { bytesToBase64, isParcel, isReturn, isRequest, encodePeerId, decodeAddress } from "./tools/typing.js";
import { totp } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

export enum BaseTypes {
  Return = "base:return",
  EmptyResponse = "base:empty-response",
}

export default class BaseProto<T extends ProtocolEvents> extends TypedEventEmitter<T> {
  public static readonly PROTOCOL: string = "/secret-handshake/proto/0.6.0";
  private static readonly CALLBACK_TIMEOUT: number = 30_000; // 30 seconds until callback request expires
  private static readonly RATE_LIMIT: number = 300; // max requests per 30 seconds

  private connectionManager: Components["connectionManager"];
  private registrar: Components["registrar"];

  protected readonly sk: Uint8Array;
  protected get pk(): Uint8Array {
    return x25519.getPublicKey(this.sk);
  }
  protected peerId: PeerId;
  protected get address(): Address {
    return encodePeerId(this.peerId);
  }

  private callbackMap = new Map<Uuid, Callback>();

  private connectionCache = new LRUCache<PeerId, Connection>({ max: 256 });
  private rateLimitCache = new LRUCache<Base64, number>({ max: 2048, ttl: BaseProto.CALLBACK_TIMEOUT });

  constructor(components: Components) {
    super();
    this.sk = components.privateKey.raw.subarray(0, 32);
    this.connectionManager = components.connectionManager;
    this.peerId = components.peerId;
    this.registrar = components.registrar;
  }

  private async getConnection(peerId: PeerId): Promise<Connection> {
    const existingConnection: Connection | undefined = this.connectionCache.get(peerId);
    if (existingConnection !== undefined) {
      if (existingConnection.status === "open" && existingConnection.direction === "outbound") {
        return Promise.resolve(existingConnection);
      } else {
        this.connectionCache.delete(peerId);
      }
    }

    const newConnection: Connection = await this.connectionManager.openConnection(peerId);
    this.connectionCache.set(peerId, newConnection);
    return newConnection;
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    const decoder = new TextDecoder("utf-8");
    let result: string = "";

    await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      for await (const data of source) {
        result += decoder.decode(data.subarray(), { stream: true });
      }
    });

    result += decoder.decode(); // Flush any remaining data
    return result;
  }

  private async sendParcelNoCallback<T extends ReqData | Return>(parcel: Parcel<T>): Promise<void> {
    const peerId: PeerId = decodeAddress(parcel.receiver);

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

  private async registerCallback<T extends ReqData, U extends ResData>(
    parcel: Parcel<T>,
    delay: number = BaseProto.CALLBACK_TIMEOUT
  ): Promise<Return<U>> {
    // Create a promise that resolves when the response is received
    const responsePromise = new Promise<Return<U>>((resolve) => {
      this.callbackMap.set(parcel.callbackId, (val: Return) => {
        this.callbackMap.delete(parcel.callbackId);
        resolve(val as Return<U>);
      });
    });

    return this.getWithTimeout(responsePromise, delay);
  }

  private async sendParcel<T extends ReqData, U extends ResData>(parcel: Parcel<T>): Promise<Return<U>> {
    return this.sendParcelNoCallback(parcel).then(() => {
      return this.registerCallback(parcel, BaseProto.CALLBACK_TIMEOUT);
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
    const callbackId: Uuid = crypto.randomUUID();
    const receiver: Address = encodePeerId(peerId);
    const parcel: Parcel<T> = { callbackId, payload, receiver, sender: this.address };
    const result: Return<U> = await this.sendParcel<T, U>(parcel);
    assert(result.success, (result as Rejection).message);

    return result;
  }

  private exceedsRateLimit(peerId: PeerId): boolean {
    const timedFingerprint: Uint8Array = totp(peerId.toCID().bytes);
    const key: Base64 = bytesToBase64(timedFingerprint);
    const rateCount: number = (this.rateLimitCache.get(key) ?? 0) + 1;

    // Early exit if limit exceeded
    if (rateCount > BaseProto.RATE_LIMIT) {
      return true;
    }

    this.rateLimitCache.set(key, rateCount);
    return false;
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
   * @param {IncomingStreamData} params - The incoming stream data containing the connection and stream.
   * @returns {Promise<void>} A promise that resolves when the stream has been processed.
   */
  private async onIncomingStream({ connection, stream }: IncomingStreamData): Promise<void> {
    const rawMessage: string = await BaseProto.decodeStream(stream);
    stream.close();

    try {
      // Check for rate limit violations
      const errorMessage: string = `Rate limit exceeded for peer: ${connection.remotePeer}`;
      assert(!this.exceedsRateLimit(connection.remotePeer), errorMessage);

      const detail: Parcel<ReqData | Return> | null = BaseProto.parseParcel(rawMessage);
      assert(detail !== null, `Invalid parcel received: ${rawMessage}`);
      assert(encodePeerId(connection.remotePeer) === detail.sender, `${connection.remotePeer} !== ${detail.sender}`);

      // If this is a callback response, invoke the callback instead of treating it like a new event
      if (this.callbackMap.has(detail.callbackId) && isReturn(detail.payload)) {
        this.callbackMap.get(detail.callbackId)!(detail.payload);
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
      const senderPeerId: PeerId = decodeAddress(event.detail.sender); // Who sent the request
      const receiver: Address = encodePeerId(senderPeerId); // Who will receive the response
      const sender: Address = this.address;

      let returnParcel: Parcel<Return>;
      try {
        const res: ResData = (await args(event)) ?? { type: BaseTypes.EmptyResponse };
        returnParcel = { callbackId: event.detail.callbackId, payload: { data: res, success: true }, receiver, sender };
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);
        const payload: Rejection = { success: false, message: errorMessage };
        returnParcel = { callbackId: event.detail.callbackId, payload, receiver, sender };
      }

      this.sendParcelNoCallback(returnParcel).catch((err) => {
        console.error("Error sending parcel:", err);
      });
    };

    super.addEventListener(type, eventWrapper);
  }

  public async start(): Promise<void> {
    await this.registrar.handle(BaseProto.PROTOCOL, this.onIncomingStream.bind(this));
  }

  public async stop(): Promise<void> {
    await this.registrar.unhandle(BaseProto.PROTOCOL);
    this.callbackMap.clear();
    this.connectionCache.clear();
    this.rateLimitCache.clear();
  }
}
