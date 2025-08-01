import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { blake2b } from "@noble/hashes/blake2";
import { LRUCache } from "lru-cache";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";

interface PeerDistancePair {
  candidate: string;
  distance: number;
}

type ProtocolEvents = HandshakeEvents & Record<keyof SwarmTypes, CustomEvent>;

export interface SwarmEvents extends ProtocolEvents {
  [SwarmTypes.NearestPeersRequest]: CustomEvent<PackagedPayload<NearestPeersRequest>>;
  [SwarmTypes.NearestPeersResponse]: CustomEvent<PackagedPayload<NearestPeersResponse>>;
  [SwarmTypes.StoreMessageRequest]: CustomEvent<PackagedPayload<StoreMessageRequest>>;
}

export enum SwarmTypes {
  NearestPeersRequest = "swarm:nearest-peers-request",
  NearestPeersResponse = "swarm:nearest-peers-response",
  StoreMessageRequest = "swarm:storage-message-request",
}

export default class SwarmProto<T extends SwarmEvents> extends HandshakeProto<T> {
  private static readonly MAX_RECURSION_DEPTH: number = 8;
  private static readonly STORAGE_LIMIT: number = 256; // Max number of messages to store
  private static readonly MAX_STORAGE_TIME: number = 1000 * 60 * 60 * 72; // 3 days

  private storage = new LRUCache<string, string[]>({ max: SwarmProto.STORAGE_LIMIT, ttl: SwarmProto.MAX_STORAGE_TIME });

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
    if (a.length !== b.length) {
      throw new Error("Uint8Arrays must be of the same length");
    }

    let distance: number = 0;
    for (let i: number = 0; i < a.length; i++) {
      distance += SwarmProto.countSetBits(a[i] ^ b[i]);
    }

    return distance;
  }

  private findAndOrderNearestPeers(query: string, candidates: string[]): PeerDistancePair[] {
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
    const distances: PeerDistancePair[] = this.findAndOrderNearestPeers(query, candidates);
    const topPeers: string[] = distances.slice(0, n).map(({ candidate }) => candidate);
    return topPeers;
  }

  private async findNearestRemotePeers(peerId: PeerId, query: string, n: number): Promise<string[]> {
    if (peerId.equals(this.peerId)) {
      return this.findNearestLocalAddresses(query, n);
    }

    const nearestPeersRequest: NearestPeersRequest = { n, query, type: SwarmTypes.NearestPeersRequest };

    const callbackId: string = crypto.randomUUID();
    try {
      const result: NearestPeersResponse = await this.sendPayload(peerId, nearestPeersRequest, callbackId);
      this.sendConfirmation(peerId, callbackId);
      return result.peers;
    } catch (err) {
      this.sendRejection(peerId, callbackId, "Failed to find nearest remote peers");
      console.warn(`Failed to find nearest remote peers for ${peerId}:`, err);
      return [];
    }
  }

  public async findNearestPeers(query: string, n: number = 5): Promise<string[]> {
    const candidates: string[] = Array.from(this.peers.keys());
    let nearestAddresses: PeerDistancePair[] = this.findAndOrderNearestPeers(query, candidates);

    try {
      let prevMinDistance: number = nearestAddresses[0]?.distance ?? Infinity;
      for (let i: number = 0; i < SwarmProto.MAX_RECURSION_DEPTH; i++) {
        const wideNet: string[][] = await Promise.all(
          nearestAddresses.map(async ({ candidate }) => {
            const peerId: PeerId = peerIdFromString(candidate);
            return this.findNearestRemotePeers(peerId, query, n);
          })
        );
        nearestAddresses = this.findAndOrderNearestPeers(query, wideNet.flat());

        const currMinDistance: number = nearestAddresses[0]?.distance ?? prevMinDistance;
        if (currMinDistance >= prevMinDistance || nearestAddresses.length === 0) {
          break;
        }
        prevMinDistance = currMinDistance;
      }
    } catch (err) {
      console.warn(`Failed to find nearest remote peers. Continuing from local peers:`, err);
    }

    return nearestAddresses.map(({ candidate }) => candidate).slice(0, n);
  }

  private async sendStoreMessageRequest(peerId: string, destination: string, message: string): Promise<boolean> {
    const storeMessageRequest: StoreMessageRequest = { destination, message, type: SwarmTypes.StoreMessageRequest };
    const callbackId: string = crypto.randomUUID();

    try {
      await this.sendPayload(peerIdFromString(peerId), storeMessageRequest, callbackId);
      this.sendConfirmation(peerIdFromString(peerId), callbackId);
      return true;
    } catch (err) {
      this.sendRejection(peerIdFromString(peerId), callbackId, "Failed to store message");
      console.warn(`Failed to store message for ${peerId}:`, err);
      return false;
    }
  }

  public async sendMessage(destination: string, message: string): Promise<number> {
    const nearestPeers: string[] = await this.findNearestPeers(destination, 5);

    const results: boolean[] = await Promise.all(
      nearestPeers
        .filter((pId: string) => !this.peerId.equals(pId))
        .map((pId: string) => this.sendStoreMessageRequest(pId, destination, message))
    );

    // Count successful message stores
    return results.filter(Boolean).length;
  }

  private async onNearestPeersRequest({ detail }: CustomEvent<PackagedPayload<NearestPeersRequest>>): Promise<void> {
    console.info(`${this.peerId}: Received nearest peers request from ${detail.from}`);

    const query: string = detail.payload.query;
    const peersPayload: NearestPeersResponse = {
      peers: this.findNearestLocalAddresses(query, detail.payload.n),
      type: SwarmTypes.NearestPeersResponse,
    };

    const peerId: PeerId = peerIdFromString(detail.from);
    try {
      await this.sendPayload(peerId, peersPayload, detail.callbackId);
      console.info(`${this.peerId}: Sending nearest peers response to ${detail.from}`);
    } catch (err) {
      this.sendRejection(peerId, detail.callbackId, "Failed to send nearest peers response");
      console.warn(`${this.peerId}: Failed to send nearest peers response to ${detail.from}`, err);
    }
  }

  private async onStorageMessageRequest({ detail }: CustomEvent<PackagedPayload<StoreMessageRequest>>): Promise<void> {
    console.info(`${this.peerId}: Received store message request from ${detail.from}`);

    const existingMessages: string[] = this.storage.get(detail.payload.destination) || [];
    this.storage.set(detail.payload.destination, [...existingMessages, detail.payload.message]);
    this.sendConfirmation(peerIdFromString(detail.from), detail.callbackId);
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.addEventListener(SwarmTypes.StoreMessageRequest, this.onStorageMessageRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(SwarmTypes.NearestPeersRequest, this.onNearestPeersRequest.bind(this));
    this.removeEventListener(SwarmTypes.StoreMessageRequest, this.onStorageMessageRequest.bind(this));
    this.storage.clear();
  }
}
