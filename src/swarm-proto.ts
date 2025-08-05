import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import {
  createEnvelope,
  shamirSecretSharing,
  reconstructShamirSecret,
  orderPeersByDistance,
} from "./tools/messenger.js";
import { assert, generateUuid } from "./tools/utils.js";

type ProtocolEvents = HandshakeEvents & Record<keyof SwarmTypes, CustomEvent>;

export interface SwarmEvents extends ProtocolEvents {
  [SwarmTypes.NearestPeersRequest]: CustomEvent<PackagedPayload<NearestPeersRequest>>;
  [SwarmTypes.NearestPeersResponse]: CustomEvent<PackagedPayload<NearestPeersResponse>>;
  [SwarmTypes.StoreMessagesRequest]: CustomEvent<PackagedPayload<StoreMessagesRequest>>;
  [SwarmTypes.GetMessagesRequest]: CustomEvent<PackagedPayload<GetMessagesRequest>>;
  [SwarmTypes.GetMessagesResponse]: CustomEvent<PackagedPayload<GetMessagesResponse>>;
}

export enum SwarmTypes {
  NearestPeersRequest = "swarm:nearest-peers-request",
  NearestPeersResponse = "swarm:nearest-peers-response",
  StoreMessagesRequest = "swarm:storage-messages-request",
  GetMessagesRequest = "swarm:get-messages-request",
  GetMessagesResponse = "swarm:get-messages-response",
}

const PASSPHRASE: string = "sureness-prankish-frostlike";

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
  private static readonly MAX_RECURSION_DEPTH: number = 8;
  private static readonly STORAGE_LIMIT: number = 256000; // Max number of messages to store
  private static readonly MAX_STORAGE_TIME: number = 1000 * 60 * 60 * 72; // 3 days

  private storage = new LRUCache<Base58, MessageFragment[]>({
    max: SwarmProto.STORAGE_LIMIT,
    ttl: SwarmProto.MAX_STORAGE_TIME,
  });

  private queryCache = new LRUCache<string, number>({ max: 128, ttl: 1000 * 10 }); // 10 seconds

  constructor(components: Components, passphrase: string = PASSPHRASE) {
    super(components, passphrase);
  }

  public static Swarm<T extends {}>(passphrase?: string): (params: Components) => SwarmProto<T & SwarmEvents> {
    return (params: Components) => new SwarmProto(params, passphrase);
  }

  private findNearestLocalAddresses(query: string, n: number): string[] {
    const candidates: string[] = Array.from(this.peers.keys());
    const distances: PeerDistancePair[] = orderPeersByDistance(query, candidates);
    return distances.slice(0, n).map(({ candidate }) => candidate);
  }

  private async findNearestRemotePeers(address: string, query: string, n: number): Promise<string[]> {
    if (this.peerId.equals(address)) {
      return this.findNearestLocalAddresses(query, n);
    }

    const callbackId: Uuid = generateUuid();
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
      this.storeNewMessages(destination, messages);
      return true;
    }

    const callbackId: Uuid = generateUuid();
    const peerId: PeerId = peerIdFromString(address);
    const storeMessagesRequest: StoreMessagesRequest = { destination, messages, type: SwarmTypes.StoreMessagesRequest };
    await this.sendPayload(peerId, storeMessagesRequest, callbackId);
    this.sendConfirmation(peerId, callbackId);

    return true;
  }

  private async sendGetMessagesRequest(node: string, destination: string): Promise<MessageFragment[]> {
    if (this.peerId.equals(node)) {
      return this.storage.get(destination) || [];
    }

    const callbackId: Uuid = generateUuid();
    try {
      const peerId: PeerId = peerIdFromString(node);
      const request: GetMessagesRequest = { destination, type: SwarmTypes.GetMessagesRequest };
      const result: GetMessagesResponse = await this.sendPayload(peerId, request, callbackId);
      this.sendConfirmation(peerId, callbackId);
      return result.messages;
    } catch (error) {
      console.error(`Failed to get messages from ${node}: ${error}`);
      this.sendRejection(peerIdFromString(node), callbackId, "Failed to retrieve messages");
    }

    return [];
  }

  public async findNearestPeers(query: string, n: number = 5): Promise<string[]> {
    const candidates: string[] = Array.from(this.peers.keys());
    let peers: PeerDistancePair[] = orderPeersByDistance(query, candidates);

    try {
      let prevMinDistance: number = peers[0]?.distance ?? Infinity;
      for (let i: number = 0; i < SwarmProto.MAX_RECURSION_DEPTH; i++) {
        const wideNet: string[][] = await Promise.all(
          peers.map(async ({ candidate }) => this.findNearestRemotePeers(candidate, query, n))
        );
        peers = orderPeersByDistance(query, wideNet.flat());
        const currMinDistance: number = peers[0]?.distance ?? prevMinDistance;
        if (currMinDistance >= prevMinDistance || peers.length === 0) break;
        prevMinDistance = currMinDistance;
      }
    } catch (err) {
      console.warn(`Failed to find nearest remote peers. Returning last successful search`);
    }

    return peers.map(({ candidate }) => candidate).slice(0, n);
  }

  public async sendMessages(destination: string, messages: string[]): Promise<void> {
    const envelopes: Envelope[] = messages.map((msg) => createEnvelope(msg, destination, this.peerId.toString()));

    // Find nearest peers to send messages to
    const candidates: string[] = await this.findNearestPeers(destination, 5);

    // Split each message into shares using Shamir's Secret Sharing
    const messageIds: Uuid[] = messages.map(generateUuid);
    const sharedMessages: Encoded[][] = await Promise.all(envelopes.map((msg) => shamirSecretSharing(msg, 5, 3)));
    assert(messageIds.length === sharedMessages.length, "IDs and messages must match in length");

    // Prepare the fragmented messages for each peer
    const fragments: MessageFragment[] = [];
    for (let i: number = 0; i < messageIds.length; i++) {
      for (let j: number = 0; j < sharedMessages[i].length; j++) {
        fragments.push({ id: messageIds[i], destination, fragment: sharedMessages[i][j] });
      }
    }

    // Send fragments to peers, ensuring each peer gets a unique set of shares
    await Promise.all(
      candidates.map((pId: string, i: number) => {
        const batch: MessageFragment[] = fragments.filter((_, j) => j % candidates.length === i);
        return this.sendStoreMessageRequest(pId, destination, batch);
      })
    );
  }

  public async sendMessage(destination: string, message: string): Promise<void> {
    this.sendMessages(destination, [message]);
  }

  public async getMessages(destination: string): Promise<Envelope[]> {
    const peers: string[] = await this.findNearestPeers(destination, 5);
    const remoteMessages = await Promise.all(peers.map((pId: string) => this.sendGetMessagesRequest(pId, destination)));

    // Reconstruct the messages from the received fragments
    const acc: Record<string, Set<Encoded>> = {};
    for (const messages of remoteMessages) {
      for (const { id, fragment } of messages) {
        if (!acc[id]) acc[id] = new Set();
        acc[id].add(fragment);
      }
    }

    // Reconstruct each message from its fragments
    const reconstructions: (Envelope | undefined)[] = await Promise.all(
      Object.values(acc)
        .map((a) => Array.from(a))
        .map(reconstructShamirSecret)
    );

    return reconstructions.filter((env): env is Envelope => env !== undefined);
  }

  private storeNewMessages(destination: string, messages: MessageFragment[]): void {
    const existingMessages: MessageFragment[] = this.storage.get(destination) || [];
    this.storage.set(destination, [...existingMessages, ...messages]);
  }

  private async onNearestPeersRequest({ detail }: CustomEvent<PackagedPayload<NearestPeersRequest>>): Promise<void> {
    try {
      const query: string = detail.payload.query;
      const peersPayload: NearestPeersResponse = {
        peers: this.findNearestLocalAddresses(query, detail.payload.n),
        type: SwarmTypes.NearestPeersResponse,
      };
      const peerId: PeerId = peerIdFromString(detail.from);
      this.sendPayload(peerId, peersPayload, detail.callbackId);
    } catch (err) {
      console.warn(`Failed to handle nearest peers request from ${detail.from}:`, err);
      this.sendRejection(peerIdFromString(detail.from), detail.callbackId, "Failed to find nearest peers");
    }
  }

  private async onStoreMessagesRequest({ detail }: CustomEvent<PackagedPayload<StoreMessagesRequest>>): Promise<void> {
    try {
      this.storeNewMessages(detail.payload.destination, detail.payload.messages);
      this.sendConfirmation(peerIdFromString(detail.from), detail.callbackId);
    } catch (err) {
      console.warn(`Failed to store messages for ${detail.payload.destination}:`, err);
      this.sendRejection(peerIdFromString(detail.from), detail.callbackId, "Failed to store messages");
    }
  }

  private async onGetMessagesRequest({ detail }: CustomEvent<PackagedPayload<GetMessagesRequest>>): Promise<void> {
    try {
      this.queryCache.set(detail.payload.destination, (this.queryCache.get(detail.payload.destination) || 0) + 1);

      let messages: MessageFragment[] = this.storage.get(detail.payload.destination) ?? [];

      // If we haven't seen this query before, fetch messages from remote peers too
      if (this.queryCache.get(detail.payload.destination) === 0) {
        const nearestPeers: string[] = [...this.peers.keys()].sort((a, b) => a.localeCompare(b)).slice(0, 2);
        const remoteMessages: MessageFragment[][] = await Promise.all(
          nearestPeers.map((peer) => this.sendGetMessagesRequest(peer, detail.payload.destination))
        );
        messages.push(...remoteMessages.flat());
      }

      const response: GetMessagesResponse = { messages, type: SwarmTypes.GetMessagesResponse };
      this.sendPayload(peerIdFromString(detail.from), response, detail.callbackId);
    } catch (err) {
      console.warn(`Failed to retrieve messages for ${detail.payload.destination}:`, err);
      this.sendRejection(peerIdFromString(detail.from), detail.callbackId, "Failed to retrieve messages");
    }
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.addEventListener(SwarmTypes.StoreMessagesRequest, this.onStoreMessagesRequest.bind(this));
    this.addEventListener(SwarmTypes.GetMessagesRequest, this.onGetMessagesRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.removeEventListener(SwarmTypes.StoreMessagesRequest, this.onStoreMessagesRequest.bind(this));
    this.removeEventListener(SwarmTypes.GetMessagesRequest, this.onGetMessagesRequest.bind(this));
    this.storage.clear();
  }
}
