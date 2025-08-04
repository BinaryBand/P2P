import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { blake2b } from "@noble/hashes/blake2";
import { ed25519 } from "@noble/curves/ed25519.js";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { shamirSecretSharing, reconstructShamirSecret } from "./cryptography.js";
import { assert, bufferFromEncoding, encodingFromBuffer } from "./utils.js";

type ProtocolEvents = HandshakeEvents & Record<keyof SwarmTypes, CustomEvent>;

export interface SwarmEvents extends ProtocolEvents {
  [SwarmTypes.NearestPeersRequest]: CustomEvent<PackagedPayload<NearestPeersRequest>>;
  [SwarmTypes.NearestPeersResponse]: CustomEvent<PackagedPayload<NearestPeersResponse>>;
  [SwarmTypes.StoreMessagesRequest]: CustomEvent<PackagedPayload<StoreMessagesRequest>>;
  [SwarmTypes.RetrieveMessagesRequest]: CustomEvent<PackagedPayload<RetrieveMessagesRequest>>;
  [SwarmTypes.RetrieveMessagesResponse]: CustomEvent<PackagedPayload<RetrieveMessagesResponse>>;
}

export enum SwarmTypes {
  NearestPeersRequest = "swarm:nearest-peers-request",
  NearestPeersResponse = "swarm:nearest-peers-response",
  StoreMessagesRequest = "swarm:storage-messages-request",
  RetrieveMessagesRequest = "swarm:retrieve-messages-request",
  RetrieveMessagesResponse = "swarm:retrieve-messages-response",
}

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
  private static readonly MAX_RECURSION_DEPTH: number = 8;
  private static readonly STORAGE_LIMIT: number = 256000; // Max number of messages to store
  private static readonly MAX_STORAGE_TIME: number = 1000 * 60 * 60 * 72; // 3 days

  private storage = new LRUCache<string, MessageFragment[]>({
    max: SwarmProto.STORAGE_LIMIT,
    ttl: SwarmProto.MAX_STORAGE_TIME,
  });

  constructor(components: Components) {
    super(components);
  }

  public static Swarm<T extends {}>(): (params: Components) => SwarmProto<T & SwarmEvents> {
    return (params: Components) => new SwarmProto(params);
  }

  private static countSetBits(num: number): number {
    let count: number = 0;
    while (num) {
      count += num & 0b1;
      num >>= 1;
    }
    return count;
  }

  private static calculateDistance(a: Uint8Array, b: Uint8Array): number {
    let distance: number = 0;
    const length: number = Math.min(a.length, b.length);
    for (let i: number = 0; i < length; i++) {
      distance += SwarmProto.countSetBits(a[i] ^ b[i]);
    }
    return distance;
  }

  private orderPeersByDistance(query: string, candidates: string[]): PeerDistancePair[] {
    const key: Uint8Array = blake2b(query, { dkLen: 32 });
    const distances: PeerDistancePair[] = [];
    for (const candidate of new Set(candidates)) {
      const peerCode: Uint8Array = blake2b(candidate, { dkLen: 32 });
      const distance: number = SwarmProto.calculateDistance(key, peerCode);
      distances.push({ candidate, distance });
    }
    distances.sort((a, b) => a.distance - b.distance);
    return distances;
  }

  private findNearestLocalAddresses(query: string, n: number): string[] {
    const candidates: string[] = Array.from(this.peers.keys());
    const distances: PeerDistancePair[] = this.orderPeersByDistance(query, candidates);
    return distances.slice(0, n).map(({ candidate }) => candidate);
  }

  private async findNearestRemotePeers(address: string, query: string, n: number): Promise<string[]> {
    if (this.peerId.equals(address)) {
      return this.findNearestLocalAddresses(query, n);
    }

    const callbackId: string = crypto.randomUUID();
    const nearestPeersRequest: NearestPeersRequest = { n, query, type: SwarmTypes.NearestPeersRequest };
    const peerId: PeerId = peerIdFromString(address);
    const result: NearestPeersResponse = await this.sendPayload(peerId, nearestPeersRequest, callbackId);
    this.sendConfirmation(peerId, callbackId);

    return result.peers;
  }

  private async sendStoreMessageRequest(
    address: string,
    destination: string,
    messages: MessageFragment[]
  ): Promise<boolean> {
    if (this.peerId.equals(address)) {
      this.storage.set(destination, messages);
      return true;
    }

    const callbackId: string = crypto.randomUUID();
    const peerId: PeerId = peerIdFromString(address);
    const storeMessagesRequest: StoreMessagesRequest = { destination, messages, type: SwarmTypes.StoreMessagesRequest };
    await this.sendPayload(peerId, storeMessagesRequest, callbackId);
    this.sendConfirmation(peerId, callbackId);

    return true;
  }

  private async sendRetrieveMessageRequest(node: string, destination: string): Promise<MessageFragment[]> {
    if (this.peerId.equals(node)) {
      return this.storage.get(destination) || [];
    }

    const callbackId: string = crypto.randomUUID();
    const peerId: PeerId = peerIdFromString(node);
    const request: RetrieveMessagesRequest = { destination, type: SwarmTypes.RetrieveMessagesRequest };
    const result: RetrieveMessagesResponse = await this.sendPayload(peerId, request, callbackId);
    this.sendConfirmation(peerId, callbackId);

    return result.messages;
  }

  public async findNearestPeers(query: string, n: number = 5): Promise<string[]> {
    const candidates: string[] = Array.from(this.peers.keys());
    let nearestPeers: PeerDistancePair[] = this.orderPeersByDistance(query, candidates);

    try {
      let prevMinDistance: number = nearestPeers[0]?.distance ?? Infinity;
      for (let i: number = 0; i < SwarmProto.MAX_RECURSION_DEPTH; i++) {
        const wideNet: string[][] = await Promise.all(
          nearestPeers.map(async ({ candidate }) => this.findNearestRemotePeers(candidate, query, n))
        );
        nearestPeers = this.orderPeersByDistance(query, wideNet.flat());
        const currMinDistance: number = nearestPeers[0]?.distance ?? prevMinDistance;
        if (currMinDistance >= prevMinDistance || nearestPeers.length === 0) break;
        prevMinDistance = currMinDistance;
      }
    } catch (err) {
      console.warn(`Failed to find nearest remote peers. Returning last successful search`);
    }

    return nearestPeers.map(({ candidate }) => candidate).slice(0, n);
  }

  public async sendMessages(destination: string, messages: string[]): Promise<void> {
    const nearestPeers: string[] = await this.findNearestPeers(destination, 5);
    const signatures: string[] = messages.map((msg) =>
      encodingFromBuffer(ed25519.sign(bufferFromEncoding(msg), this.privateKey))
    );
    const sharedMessages: string[][] = await Promise.all(messages.map((msg) => shamirSecretSharing(msg, 5, 3)));
    assert(signatures.length === sharedMessages.length, "Signatures and messages must match in length");

    const fragmentsBatch: MessageFragment[][] = [];
    for (let i: number = 0; i < signatures.length; i++) {
      const sharedMessage: string[] = sharedMessages[i];
      const fragments: MessageFragment[] = [];
      for (let j: number = 0; j < sharedMessage.length; j++) {
        fragments.push({ fragment: sharedMessage[j], signature: signatures[i] });
      }
      fragmentsBatch.push(fragments);
    }

    await Promise.all(
      nearestPeers.map((pId: string, i: number) =>
        this.sendStoreMessageRequest(
          pId,
          destination,
          fragmentsBatch.map((msg) => msg[i])
        )
      )
    );
  }

  public async sendMessage(destination: string, message: string): Promise<void> {
    this.sendMessages(destination, [message]);
  }

  public async getMessages(destination: string): Promise<string[]> {
    const closestPeers: string[] = await this.findNearestPeers(destination, 5);
    const remoteMessages = await Promise.all(
      closestPeers.map((pId: string) => this.sendRetrieveMessageRequest(pId, destination))
    );

    const acc: Record<string, string[]> = {};
    for (const messages of remoteMessages) {
      for (const { fragment, signature } of messages) {
        if (!acc[signature]) {
          acc[signature] = [];
        }
        acc[signature].push(fragment);
      }
    }

    return Promise.all(Object.values(acc).map(reconstructShamirSecret));
  }

  private storeNewMessages(destination: string, messages: MessageFragment[]): void {
    const existingMessages: MessageFragment[] = this.storage.get(destination) || [];
    this.storage.set(destination, [...existingMessages, ...messages]);
  }

  private async onNearestPeersRequest({ detail }: CustomEvent<PackagedPayload<NearestPeersRequest>>): Promise<void> {
    const query: string = detail.payload.query;
    const peersPayload: NearestPeersResponse = {
      peers: this.findNearestLocalAddresses(query, detail.payload.n),
      type: SwarmTypes.NearestPeersResponse,
    };

    const peerId: PeerId = peerIdFromString(detail.from);
    await this.sendPayload(peerId, peersPayload, detail.callbackId);
  }

  private async onStoreMessagesRequest({ detail }: CustomEvent<PackagedPayload<StoreMessagesRequest>>): Promise<void> {
    this.storeNewMessages(detail.payload.destination, detail.payload.messages);
    this.sendConfirmation(peerIdFromString(detail.from), detail.callbackId);
  }

  private async onRetrieveMessagesRequest({
    detail,
  }: CustomEvent<PackagedPayload<RetrieveMessagesRequest>>): Promise<void> {
    const messages: MessageFragment[] = this.storage.get(detail.payload.destination) || [];
    const response: RetrieveMessagesResponse = { messages, type: SwarmTypes.RetrieveMessagesResponse };
    this.sendPayload(peerIdFromString(detail.from), response, detail.callbackId);
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.addEventListener(SwarmTypes.StoreMessagesRequest, this.onStoreMessagesRequest.bind(this));
    this.addEventListener(SwarmTypes.RetrieveMessagesRequest, this.onRetrieveMessagesRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.removeEventListener(SwarmTypes.StoreMessagesRequest, this.onStoreMessagesRequest.bind(this));
    this.removeEventListener(SwarmTypes.RetrieveMessagesRequest, this.onRetrieveMessagesRequest.bind(this));
    this.storage.clear();
  }
}
