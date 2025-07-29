import { AbortOptions, Multiaddr } from "@multiformats/multiaddr";

import { Connection, PeerId, PrivateKey, Startable, Stream } from "@libp2p/interface";
import { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import { Components } from "libp2p/dist/src/components";

import { toString } from "uint8arrays";
import { Uint8ArrayList } from "uint8arraylist";
import { pipe } from "it-pipe";

interface Letter {
  sender: string;
  recipient: string;
  message: string;
  timestamp: number;
}

type Payload = PackageDropOff | CheckMessageBox | PackageDelivery;

interface PackageDropOff {
  type: PayloadType.PackageDropOff;
  envelope: Letter[];
}

interface CheckMessageBox {
  type: PayloadType.CheckMessageBox;
  callbackId: string;
  recipient: string;
}

interface PackageDelivery {
  type: PayloadType.PackageDelivery;
  callbackId: string;
  envelope: Letter[];
}

enum PayloadType {
  PackageDropOff = "deliver_this_and_make_it_snappy",
  CheckMessageBox = "hey_mailman_got_anything_for_me",
  PackageDelivery = "just_the_usual_tell_the_misses_i_said_hi",
}

export default class ArchivistProto implements Startable {
  private static readonly code: string = "archivist";
  private static readonly version: `${number}.${number}.${number}` = "0.1.0";

  public static get protocol(): string {
    return `/${this.code}/proto/${this.version}`;
  }

  private privateKey: PrivateKey;
  private peerId: PeerId;
  private connectionManager: ConnectionManager;
  private registrar: Registrar;

  private callbackQueue: Map<string, (pl: Payload) => void> = new Map();
  private messageCache: Map<string, Letter[]> = new Map();

  constructor(components: Components) {
    this.privateKey = components.privateKey;
    this.peerId = components.peerId;
    this.connectionManager = components.connectionManager;
    this.registrar = components.registrar;
  }

  public static Archivist(): (components: Components) => ArchivistProto {
    return (components: Components) => new ArchivistProto(components);
  }

  private static isLetter(item: unknown): item is Letter {
    if (!item || typeof item !== "object") {
      return false;
    }
    const { sender, recipient, message, timestamp } = item as Letter;
    return (
      typeof sender === "string" &&
      typeof recipient === "string" &&
      typeof message === "string" &&
      typeof timestamp === "number"
    );
  }

  private static isEnvelope(envelope: unknown): envelope is Letter[] {
    if (!envelope || !Array.isArray(envelope)) {
      return false;
    }
    return envelope.every(ArchivistProto.isLetter);
  }

  private static isPayload(payload: unknown): payload is Payload {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return false;
    }
    switch ((payload as Payload).type) {
      case PayloadType.PackageDropOff:
        return "envelope" in payload && ArchivistProto.isEnvelope(payload.envelope);
      case PayloadType.CheckMessageBox:
        return "callbackId" in payload && "recipient" in payload;
      case PayloadType.PackageDelivery:
        return "callbackId" in payload && "envelope" in payload && ArchivistProto.isEnvelope(payload.envelope);
      default:
        return false;
    }
  }

  private static async decodeStream(stream: Stream): Promise<string> {
    return await pipe(stream, async (source: AsyncGenerator<Uint8ArrayList>) => {
      let message: string = "";
      for await (const data of source) {
        const partials: string[] = [...data].map((bit: Uint8Array) => toString(bit, "utf-8"));
        message += partials.join("");
      }
      return message;
    });
  }

  private static async sendPayload(connection: Connection, payload: Payload, options?: AbortOptions): Promise<void> {
    if (connection.status !== "open") {
      console.warn("Connection is not open");
      return;
    }

    try {
      const outgoing: Stream = await connection.newStream(ArchivistProto.protocol, options);
      const payloadString: string = JSON.stringify(payload);
      await pipe([Buffer.from(payloadString)], outgoing);
      outgoing.close();
    } catch {
      console.warn("Failed to send payload:", payload);
      connection.close();
    }
  }

  private async handleMessageEvent(event: CustomEvent<any>): Promise<void> {
    const { data } = event.detail.msg;
    const rawMessage: string = toString(data, "utf-8");

    let payload: Payload;
    try {
      payload = JSON.parse(rawMessage);
      if (!ArchivistProto.isPayload(payload)) {
        console.warn("Invalid payload received:", payload);
        return;
      }
    } catch {
      console.warn("Invalid payload.", rawMessage);
      return;
    }

    switch (payload.type) {
      case PayloadType.PackageDropOff: {
        for (const letter of payload.envelope) {
          const { sender, recipient, message, timestamp } = letter;
          const stockpile: Letter[] = this.messageCache.get(recipient) || [];
          stockpile.push({ sender, recipient, message, timestamp });
          this.messageCache.set(recipient, stockpile);
        }
        console.log(
          `You've got mail from ${payload.envelope[0].sender} to ${payload.envelope[0].recipient} at ${payload.envelope[0].timestamp}: ${payload.envelope[0].message}`
        );
        break;
      }
    }
  }

  async start(): Promise<void> {
    await this.registrar.handle(ArchivistProto.protocol, async ({ connection, stream }: any) => {
      const rawMessage: string = await ArchivistProto.decodeStream(stream);
      stream.close();

      let payload: Payload;
      try {
        payload = JSON.parse(rawMessage);
        if (!ArchivistProto.isPayload(payload)) {
          console.warn("Invalid payload received:", payload);
          return;
        }
      } catch {
        console.warn("Invalid payload.", rawMessage);
        return;
      }
    });
  }

  async stop(): Promise<void> {
    this.callbackQueue.clear();
    await this.registrar.unhandle(ArchivistProto.protocol);
  }

  public async sendMessage(destination: PeerId | Multiaddr | Multiaddr[], message: string, options?: AbortOptions) {
    const connection: Connection = await this.connectionManager.openConnection(destination, options);
    const recipient: string = connection.remotePeer.toString();

    const sender: string = this.peerId.toString();
    const letter: Letter = { sender, recipient, message, timestamp: Date.now() };

    const payload: PackageDropOff = { type: PayloadType.PackageDropOff, envelope: [letter] };

    await ArchivistProto.sendPayload(connection, payload, options);
  }
}
