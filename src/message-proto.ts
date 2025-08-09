import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import SwarmProto, { SwarmEvents } from "./swarm-proto.js";
import { bytesToBase64, decodeAddress, encodePeerId } from "./tools/typing.js";
import { blake2b } from "./tools/cryptography.js";
import { assert } from "./tools/utils.js";

export interface MessageEvents extends SwarmEvents {
  [MessageTypes.SetMetadataRequest]: CustomEvent<Parcel<SetMetadataRequest>>;
  [MessageTypes.GetMetadataRequest]: CustomEvent<Parcel<GetMetadataRequest>>;
}

export enum MessageTypes {
  SetMetadataRequest = "message:store-metadata-request",
  GetMetadataRequest = "message:get-metadata-request",
  GetMetadataResponse = "message:get-metadata-response",
}

export default class MessageProto<T extends MessageEvents> extends SwarmProto<T> {
  private static readonly METADATA_BUCKET_SIZE: number = 2048;
  private static readonly METADATA_SWARM_SIZE: number = 5;

  protected metadata: LRUCache<Address, Set<Base64>> = new LRUCache({ max: MessageProto.METADATA_BUCKET_SIZE });

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Message<T extends MessageEvents>(passphrase?: string): (params: Components) => MessageProto<T> {
    return (params: Components) => new MessageProto(params, passphrase);
  }

  private storeMetadataLocally(metadata: Base64[]): void {
    const existingHashes: Set<Base64> = this.metadata.get(this.address) || new Set();
    for (const hash of metadata) {
      existingHashes.add(hash);
    }
    this.metadata.set(this.address, existingHashes);
  }

  private async storeMetadataRemotely(holder: Address, owner: Address, metadata: Base64[]): Promise<boolean> {
    if (this.address === holder) {
      this.storeMetadataLocally(metadata);
      return true;
    }

    try {
      const peerId: PeerId = decodeAddress(holder);
      const request: SetMetadataRequest = this.stampRequest({ owner, metadata, type: MessageTypes.SetMetadataRequest });
      await this.sendRequest(peerId, request);
      return true;
    } catch (err) {
      console.warn(`Error storing data to ${holder}:`, err);
      return false;
    }
  }

  private async storeMetadata(recipient: PeerId, contentHash: Base64): Promise<void> {
    const owner: Address = encodePeerId(recipient);
    const ownerHash: Base64 = bytesToBase64(blake2b(owner));
    const nearestPeers: Address[] = await this.getNearestPeers(ownerHash, MessageProto.METADATA_SWARM_SIZE);
    await Promise.all(nearestPeers.map((addr: Address) => this.storeMetadataRemotely(addr, owner, [contentHash])));
  }

  private getLocalMetadata(): Set<Base64> {
    return this.metadata.get(this.address) || new Set();
  }

  private async getRemoteMetadata(address: Address): Promise<Base64[]> {
    if (this.address === address) {
      return Array.from(this.getLocalMetadata());
    }

    try {
      const peerId: PeerId = decodeAddress(address);
      const request: GetMetadataRequest = this.stampRequest({ address, type: MessageTypes.GetMetadataRequest });
      const response: Return<GetMetadataResponse> = await this.sendRequest(peerId, request);
      assert(response.success, `Failed to find nearest peers for ${peerId}`);

      return response.data.metadata || [];
    } catch (err) {
      console.warn(`Error getting remote storage from ${address}:`, err);
      return [];
    }
  }

  /**
   * Sends a message to a specified recipient.
   *
   * This method stores the message content and its associated metadata.
   *
   * @param recipient - The peer identifier of the message recipient.
   * @param content - The message content to be sent.
   * @returns A promise that resolves when the message and metadata have been stored.
   */
  public async sendMessage(recipient: PeerId, content: string): Promise<void> {
    const hash: Base64 = await this.storeData(content);
    await this.storeMetadata(recipient, hash);
  }

  /**
   * Retrieves the inbox messages for a given recipient.
   *
   * This method performs the following steps:
   * 1. Encodes the recipient's peer ID to an address.
   * 2. Hashes the address to obtain a unique owner hash.
   * 3. Finds the nearest peers in the swarm to the owner hash.
   * 4. Fetches metadata from the nearest peers to collect message fragment hashes.
   * 5. Retrieves the actual message fragments using the collected hashes.
   * 6. Filters out any null fragments and returns the list of messages.
   *
   * @param recipient - The peer ID of the recipient whose inbox is to be fetched.
   * @returns A promise that resolves to an array of message fragments (strings) for the recipient.
   */
  public async getInbox(recipient: PeerId): Promise<string[]> {
    const owner: Address = encodePeerId(recipient);
    const ownerHash: Base64 = bytesToBase64(blake2b(owner));
    const nearestPeers: Address[] = await this.getNearestPeers(ownerHash, MessageProto.METADATA_SWARM_SIZE);

    const metadataPromises: Promise<Base64[]>[] = nearestPeers.map(this.getRemoteMetadata.bind(this));
    const metadataArrays: Base64[][] = await Promise.all(metadataPromises);
    const metadataSet: Set<Base64> = new Set(metadataArrays.flat());

    const fragments: (string | null)[] = await Promise.all(
      Array.from(metadataSet).map((hash: Base64) => {
        return this.fetchData(hash);
      })
    );

    return fragments.filter((fragment: string | null) => fragment !== null);
  }

  private async onStoreMetadataRequest({ detail }: CustomEvent<Parcel<SetMetadataRequest>>): Promise<void> {
    console.info(`${this.peerId}: Received metadata store request from ${detail.sender}`);
    this.storeMetadataLocally(detail.payload.metadata);
  }

  private async onGetMetadataRequest({
    detail,
  }: CustomEvent<Parcel<GetMetadataRequest>>): Promise<GetMetadataResponse> {
    console.info(`${this.peerId}: Received metadata get request from ${detail.sender}`);
    const address: Set<Base64> | null = this.metadata.get(detail.payload.address) ?? null;
    return { metadata: [...(address || [])], type: MessageTypes.GetMetadataResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(MessageTypes.SetMetadataRequest, this.onStoreMetadataRequest.bind(this));
    this.addEventListener(MessageTypes.GetMetadataRequest, this.onGetMetadataRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(MessageTypes.SetMetadataRequest, this.onStoreMetadataRequest.bind(this));
    this.removeEventListener(MessageTypes.GetMetadataRequest, this.onGetMetadataRequest.bind(this));
    this.metadata.clear();
  }
}
