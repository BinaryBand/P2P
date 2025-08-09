import { Components } from "libp2p/dist/src/components";
import { PeerId } from "@libp2p/interface";
import { LRUCache } from "lru-cache";

import SwarmProto, { SwarmEvents } from "./swarm-proto.js";
import { bytesToBase64, decodeAddress, encodePeerId } from "./tools/typing.js";
import { blake2b, reconstructShamirSecret, shamirSecretSharing } from "./tools/cryptography.js";
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
  private static readonly SHAMIR_SHARES: number = 5;
  private static readonly SHAMIR_THRESHOLD: number = 3;

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

  private async storeMetadata(recipient: PeerId, contentHashes: Base64[]): Promise<void> {
    const owner: Address = encodePeerId(recipient);
    const ownerHash: Base64 = bytesToBase64(blake2b(owner));
    const nearestPeers: Address[] = await this.getNearestPeers(ownerHash, MessageProto.METADATA_SWARM_SIZE);
    await Promise.all(nearestPeers.map((addr: Address) => this.storeMetadataRemotely(addr, owner, contentHashes)));
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

  private async sendMessage(message: string) {
    const fragments: Base64[] = await shamirSecretSharing(
      message,
      MessageProto.SHAMIR_SHARES,
      MessageProto.SHAMIR_THRESHOLD
    );

    const id: Uuid = crypto.randomUUID();
    const messageFragments: MessageFragment[] = fragments.map((content: Base64) => ({ id, content }));

    return Promise.all(
      messageFragments.map((fragment: MessageFragment) => {
        const fragmentString: string = JSON.stringify(fragment);
        return this.storeData(fragmentString);
      })
    );
  }

  public async sendMessages(recipient: PeerId, messages: string[]): Promise<void> {
    const hashes: Base64[][] = await Promise.all(Array.from(messages).map(this.sendMessage.bind(this)));
    await this.storeMetadata(recipient, hashes.flat());
  }

  public async getInbox(recipient: PeerId): Promise<string[]> {
    const owner: Address = encodePeerId(recipient);
    const ownerHash: Base64 = bytesToBase64(blake2b(owner));
    const nearestPeers: Address[] = await this.getNearestPeers(ownerHash, MessageProto.METADATA_SWARM_SIZE);

    const metadataPromises: Promise<Base64[]>[] = nearestPeers.map(this.getRemoteMetadata.bind(this));
    const metadataArrays: Base64[][] = await Promise.all(metadataPromises);
    const metadataSet: Set<Base64> = new Set(metadataArrays.flat());

    const rawFragments: (string | null)[] = await Promise.all(Array.from(metadataSet).map(this.fetchData.bind(this)));
    const messageFragments: MessageFragment[] = rawFragments
      .filter((fragment: string | null) => fragment !== null)
      .map((fragment: string) => JSON.parse(fragment));

    const messageMap = messageFragments.reduce((map: Record<Uuid, MessageFragment[]>, fragment: MessageFragment) => {
      if (!map[fragment.id]) map[fragment.id] = [];
      map[fragment.id]!.push(fragment);
      return map;
    }, {});

    const messages: string[] = [];
    for (const [, fragments] of Object.entries(messageMap)) {
      const reconstructed: string | undefined = await reconstructShamirSecret(fragments.map(({ content }) => content));
      if (reconstructed !== undefined) {
        messages.push(reconstructed);
      }
    }

    return messages;
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
