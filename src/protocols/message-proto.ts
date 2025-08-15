import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";

import { decodeFragment, encodeFragment, encodePeerId, isMessage, isMessageFragment } from "../tools/typing.js";
import { reconstructShamirSecret, shamirSecretSharing } from "../tools/cryptography.js";
import SwarmProto, { SwarmEvents } from "./swarm-proto.js";
import { assert } from "../tools/utils.js";

export interface MessageEvents extends SwarmEvents {}

export enum MessageTypes {}

export default class MessageProto<T extends MessageEvents = MessageEvents> extends SwarmProto<T> {
  private static readonly SHAMIR_SHARES: number = 5;
  private static readonly SHAMIR_THRESHOLD: number = 3;

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Message<T extends MessageEvents>(passphrase?: string): (params: Components) => MessageProto<T> {
    return (params: Components) => new MessageProto(params, passphrase);
  }

  private async uploadMessage(text: Message): Promise<Base64[]> {
    const fragments: Base64[] = await shamirSecretSharing(
      text,
      MessageProto.SHAMIR_SHARES,
      MessageProto.SHAMIR_THRESHOLD
    );

    const id: Uuid = crypto.randomUUID();
    const messageFragments: MessageFragment[] = fragments.map((content: Base64) => ({ id, content }));
    assert(messageFragments.every(isMessageFragment), "All fragments must be valid MessageFragment");

    const fragmentStrings: Fragment[] = messageFragments.map(encodeFragment);
    return this.storeFragments(fragmentStrings);
  }

  public async sendMessages(recipient: PeerId, texts: string[]): Promise<void> {
    this.logger.info("sendMessages", { recipient, texts });

    const messages: Message[] = texts;

    const hashes: Base64[][] = await Promise.all(messages.map(this.uploadMessage.bind(this)));
    const address: Address = encodePeerId(recipient);
    await this.storeMetadata(address, hashes.flat());
  }

  public async getInbox(peerId: PeerId): Promise<Message[]> {
    this.logger.info("getInbox", { peerId });

    const recipient: Address = encodePeerId(peerId);
    const metadata: Base64[] = await this.fetchMetadata(recipient);

    const fragments: MessageFragment[] = (await this.fetchFragments(metadata))
      .map(decodeFragment)
      .filter(isMessageFragment);

    const puzzlePieces = fragments.reduce((acc: Record<Uuid, Set<Base64>>, fragment: MessageFragment) => {
      if (!acc[fragment.id]) {
        acc[fragment.id] = new Set<Base64>();
      }
      acc[fragment.id].add(fragment.content);
      return acc;
    }, {});

    const reconstructedMessages: (Message | undefined)[] = await Promise.all(
      Object.values(puzzlePieces).map(async (contents) => reconstructShamirSecret(Array.from(contents)))
    );

    return reconstructedMessages.filter(isMessage);
  }

  public async start(): Promise<void> {
    await super.start();
  }

  public async stop(): Promise<void> {
    await super.stop();
  }
}
