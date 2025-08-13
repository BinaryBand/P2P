import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";

import { reconstructShamirSecret, shamirSecretSharing } from "../tools/cryptography.js";
import { encodePeerId, isMessageFragment } from "../tools/typing.js";
import SwarmProto, { SwarmEvents } from "./swarm-proto.js";
import { assert } from "../tools/utils.js";
import BaseProto from "./base-proto.js";

export interface MessageEvents extends SwarmEvents {}

export enum MessageTypes {}

export default class MessageProto<T extends MessageEvents> extends SwarmProto<T> {
  private static readonly SHAMIR_SHARES: number = 5;
  private static readonly SHAMIR_THRESHOLD: number = 3;

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Message<T extends MessageEvents>(passphrase?: string): (params: Components) => MessageProto<T> {
    return (params: Components) => new MessageProto(params, passphrase);
  }

  private async uploadMessage(text: string): Promise<Base64[]> {
    const fragments: Base64[] = await shamirSecretSharing(
      text,
      MessageProto.SHAMIR_SHARES,
      MessageProto.SHAMIR_THRESHOLD
    );

    const id: Uuid = crypto.randomUUID();
    const messageFragments: MessageFragment[] = fragments.map((content: Base64) => ({ id, content }));
    assert(messageFragments.every(isMessageFragment), "All fragments must be valid MessageFragment");

    const fragmentStrings: string[] = messageFragments.map((fragment: MessageFragment) => JSON.stringify(fragment));
    return this.storeFragments(fragmentStrings);
  }

  public async sendMessages(recipient: PeerId, messages: string[]): Promise<void> {
    const hashes: Base64[][] = await Promise.all(Array.from(messages).map(this.uploadMessage.bind(this)));

    const address: Address = encodePeerId(recipient);
    await this.storeMetadata(address, hashes.flat());
  }

  private static tryParse<T>(rawString: string): T | undefined {
    try {
      const result: T = JSON.parse(rawString);
      return result;
    } catch (err: unknown) {
      BaseProto.handleError(err, "tryParse");
    }
    return undefined;
  }

  public async getInbox(peerId: PeerId): Promise<string[]> {
    const recipient: Address = encodePeerId(peerId);
    const hashes: Base64[] = await this.fetchMetadata(recipient);
    const fragmentStrings: string[] = await this.fetchFragments(hashes);
    const fragments: MessageFragment[] = fragmentStrings.map(MessageProto.tryParse).filter(isMessageFragment);

    const puzzlePieces = fragments.reduce((acc: Record<Uuid, Set<Base64>>, fragment: MessageFragment) => {
      if (!acc[fragment.id]) {
        acc[fragment.id] = new Set<Base64>();
      }
      acc[fragment.id].add(fragment.content);
      return acc;
    }, {});

    const reconstructedMessages: (string | undefined)[] = await Promise.all(
      Object.values(puzzlePieces).map(async (contents) => reconstructShamirSecret(Array.from(contents)))
    );

    return reconstructedMessages.filter((msg): msg is string => msg !== undefined);
  }

  public async start(): Promise<void> {
    await super.start();
  }

  public async stop(): Promise<void> {
    await super.stop();
  }
}
