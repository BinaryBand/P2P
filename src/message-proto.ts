import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
// import { LRUCache } from "lru-cache";

import { bytesToBase64, decodeAddress, encode, encodePeerId, isMessageFragment } from "./tools/typing.js";
import { blake3, reconstructShamirSecret, shamirSecretSharing } from "./tools/cryptography.js";
import SwarmProto, { SwarmEvents } from "./swarm-proto.js";
import { assert } from "./tools/utils.js";

export interface MessageEvents extends SwarmEvents {}

export enum MessageTypes {}

export default class MessageProto<T extends MessageEvents> extends SwarmProto<T> {
  private static readonly METADATA_SWARM_SIZE: number = 5;
  private static readonly SHAMIR_SHARES: number = 5;
  private static readonly SHAMIR_THRESHOLD: number = 3;

  constructor(components: Components, passphrase?: string, role: Role = "tower") {
    super(components, passphrase, role);
  }

  public static Message<T extends MessageEvents>(passphrase?: string): (params: Components) => MessageProto<T> {
    return (params: Components) => new MessageProto(params, passphrase);
  }

  private async uploadMessage(text: string): Promise<Base64[]> {
    const message: Message = text;
    const fragments: string[] = await shamirSecretSharing(
      message,
      MessageProto.SHAMIR_SHARES,
      MessageProto.SHAMIR_THRESHOLD
    );

    const id: Uuid = crypto.randomUUID();
    const messageFragments: MessageFragment[] = fragments.map((content: string) => ({ id, content }));
    assert(messageFragments.every(isMessageFragment), "All fragments must be valid MessageFragment");

    const fragmentStrings: string[] = messageFragments.map((fragment: MessageFragment) => JSON.stringify(fragment));
    return this.storeFragments(fragmentStrings);
  }

  public async sendMessages(recipient: PeerId, messages: string[]): Promise<void> {
    const hashes: Base64[][] = await Promise.all(Array.from(messages).map(this.uploadMessage.bind(this)));

    const address: Address = encodePeerId(recipient);
    await this.storeMetadata(address, hashes.flat());
  }

  // private static tryParse<T>(rawString: string): T | undefined {
  //   try {
  //     const result: T = JSON.parse(rawString);
  //     return result;
  //   } catch {}
  //   return undefined;
  // }

  public async getInbox(peerId: PeerId): Promise<Message[]> {
    console.log("Get Inbox");

    const recipient: Address = encodePeerId(peerId);
    const ownerHash: Base64 = bytesToBase64(blake3(recipient));
    const nearestPeers: Address[] = await this.getNearestPeers(ownerHash, MessageProto.METADATA_SWARM_SIZE, "tower");

    console.log("Nearest Peers:", nearestPeers);
    console.log("Metadata:", [...this.metadataCache.values()]);
    console.log("Storage:", [...this.storageCache.values()]);

    // // Fetch metadata from nearest peers
    // const metadataPromises: Promise<Base64[]>[] = nearestPeers.map((addr: Address) =>
    //   this.getRemoteMetadata(peerId, addr)
    // );
    // const metadataArrays: Base64[][] = await Promise.all(metadataPromises);
    // const metadataSet: Set<Base64> = new Set(metadataArrays.flat());

    // console.log("Storage:", [...this.storage.values()]);

    // console.log("Metadata:", [...this.metadata.values()]);

    // // Fetch all fragments from the metadata set
    // const rawFragments: (string | undefined)[] = await Promise.all(
    //   Array.from(metadataSet).map(this.fetchData.bind(this))
    // );
    // const messageFragments: MessageFragment[] = rawFragments
    //   .filter((fragment): fragment is string => fragment !== undefined)
    //   .map(MessageProto.tryParse.bind(this))
    //   .filter(isMessageFragment);

    // // Group fragments by their ID
    // const messageMap = messageFragments.reduce((map: Record<Uuid, MessageFragment[]>, fragment: MessageFragment) => {
    //   if (map[fragment.id] === undefined) {
    //     map[fragment.id] = [];
    //   }
    //   map[fragment.id]!.push(fragment);
    //   return map;
    // }, {});

    // // Reconstruct messages from fragments
    // const messages: (string | undefined)[] = await Promise.all(
    //   Object.values(messageMap).map((fragments: MessageFragment[]) =>
    //     reconstructShamirSecret(fragments.map(({ content }) => content))
    //   )
    // );

    // // TODO: Fix encoding issues. Messages are double JSON encoded
    // return messages
    //   .filter((message?: string) => message !== undefined)
    //   .map((message: string) => JSON.parse(message) as string)
    //   .map((message: string) => JSON.parse(message) as Message);

    return [];
  }

  public async start(): Promise<void> {
    await super.start();
  }

  public async stop(): Promise<void> {
    await super.stop();
  }
}
