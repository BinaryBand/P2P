import { IdentifyResult, Libp2pEvents, PeerId, TypedEventTarget } from "@libp2p/interface";
import { Components } from "libp2p/dist/src/components";
import { LRUCache } from "lru-cache";

import { bytesToBase64, decodeAddress, encodePeerId, Role } from "../tools/typing.js";
import {
  Address,
  Base64,
  DistancePair,
  ProtocolEvents,
  Parcel,
  ResData,
  Acceptance,
  PingRequest,
  PingResponse,
  InitiationRequest,
  InitiationResponse,
  GetNeighborsRequest,
  GetNeighborsResponse,
} from "../types/index.js";
import { genericHash, hashFromData } from "../tools/cryptography.js";
import { orderPeers } from "../tools/routing.js";
import { assert } from "../tools/utils.js";
import BaseProto from "./base-proto.js";

export interface HandshakeEvents extends ProtocolEvents {
  [HandshakeTypes.InitiationRequest]: CustomEvent<Parcel<InitiationRequest>>;
  [HandshakeTypes.PingRequest]: CustomEvent<Parcel<PingRequest>>;
  [HandshakeTypes.GetNeighborsRequest]: CustomEvent<Parcel<GetNeighborsRequest>>;
}

export enum HandshakeTypes {
  InitiationRequest = "handshake:secret-handshake",
  InitiationResponse = "handshake:initiation-response",
  PingRequest = "handshake:ping-request",
  PingResponse = "handshake:ping-response",
  GetNeighborsRequest = "handshake:get-neighbors-request",
  GetNeighborsResponse = "handshake:get-neighbors-response",
}

export default class HandshakeProto<T extends HandshakeEvents = HandshakeEvents> extends BaseProto<T> {
  private static readonly DEFAULT_PASSPHRASE: string = "reconcile-stranger-clash";
  private static readonly PEER_AUDIT_INTERVAL: number = 20_000; // 20 seconds
  private static readonly MAX_RECURSION_DEPTH: number = 5; // Maximum depth for recursive nearest peer search
  private static readonly NEIGHBORHOOD_SIZE: number = 10; // Nearest 10 peers

  protected events: TypedEventTarget<Libp2pEvents>;

  private peerAuditTimer?: NodeJS.Timeout;
  private queryCache = new LRUCache<Base64, Acceptance<ResData>>({ max: 128, ttl: 30_000 });

  constructor(
    components: Components,
    private readonly passphrase: string = HandshakeProto.DEFAULT_PASSPHRASE,
    private readonly role: Role = Role.Phone
  ) {
    super(components);
    this.events = components.events;
  }

  public getNeighbors(n: number = HandshakeProto.NEIGHBORHOOD_SIZE): Address[] {
    assert(n > 0, "Number of neighbors must be greater than zero");
    return this.peersCache
      .getTop(n)
      .map(({ peerId }) => peerId)
      .map(encodePeerId);
  }

  /**
   * Sends a pulse request to the specified peer and adds the peer to the internal list upon success.
   * If the request fails, logs a warning and removes the peer from the internal list.
   *
   * @param peerId - The identifier of the peer to send the pulse request to.
   * @returns A promise that resolves when the pulse request has been processed.
   */
  protected async requestPulse(address: Address): Promise<void> {
    try {
      const request: PingRequest = { type: HandshakeTypes.PingRequest };
      const response = await this.sendRequest<PingResponse>(address, request);
      assert(response.success, `Failed to verify pulse request from ${address}`);
    } catch (err: unknown) {
      this.logger.warn("requestPulse", err);
      this.peersCache.delete(address);
    }
  }

  private getNearestLocalPairs(hash: Base64, n: number): DistancePair<Address>[] {
    const candidates: Address[] = [this.address, ...this.peersCache.keys];
    return orderPeers(hash, candidates, n);
  }

  private getNearestLocalPeers(hash: Base64, n: number = HandshakeProto.NEIGHBORHOOD_SIZE): Address[] {
    return this.getNearestLocalPairs(hash, n).map(({ value }) => value);
  }

  private async getNearestRemotePeers(address: Address, hash: Base64, n: number, role: Role): Promise<Address[]> {
    if (this.address === address) {
      return this.getNearestLocalPeers(hash, n);
    }

    const addressBuffer: Uint8Array = genericHash(address);
    const requestId: Uint8Array = genericHash(hash, addressBuffer);
    const requestKey: Base64 = bytesToBase64(requestId);

    try {
      let response: Acceptance<ResData> | undefined = this.queryCache.get(requestKey);
      if (response === undefined) {
        const request: GetNeighborsRequest = { n, role, hash, type: HandshakeTypes.GetNeighborsRequest };
        response = await this.sendRequest<GetNeighborsResponse>(address, request);
      }

      assert(response.success, `Failed to get neighbors from ${address}`);
      assert(response.data.type === HandshakeTypes.GetNeighborsResponse, "Invalid response type for neighbors request");

      this.queryCache.set(requestKey, response);
      return response.data.peers;
    } catch (err: unknown) {
      this.logger.error("getNearestRemotePeers", err);
      return [];
    }
  }

  /**
   * Finds and returns the addresses of the nearest peers to a given query.
   *
   * This method first retrieves the nearest local peers, then iteratively queries those peers
   * for their nearest peers, up to a maximum recursion depth defined by `SwarmProto.MAX_RECURSION_DEPTH`.
   * The process stops early if no closer peers are found in an iteration.
   *
   * @param query - The identifier or key to search nearest peers for.
   * @param n - The maximum number of nearest peers to return. Defaults to 3.
   * @returns A promise that resolves to an array of the nearest peer addresses.
   */
  // protected async getNearestPeers(query: Base64, n: number, role: Role): Promise<Address[]> {
  //   const hash: Base64 = hashFromData(query);
  //   let peers: DistancePair<Address>[] = this.getNearestLocalPairs(hash, n);

  //   let prevMinDistance: number = peers[0]?.distance ?? Infinity;
  //   for (let depth: number = 0; depth < HandshakeProto.MAX_RECURSION_DEPTH; depth++) {
  //     // Query the wide network for more peers
  //     const wideNetPromises: Promise<Address[]>[] = peers
  //       .map(({ value }: DistancePair<Address>) => this.getNearestRemotePeers(value, hash, n, role))
  //       .map((prom: Promise<Address[]>) => this.getWithTimeout(prom, BaseProto.HEAVY_CALLBACK_TIMEOUT));

  //     // Wait for all wide network queries to settle
  //     const wideNetResults: PromiseSettledResult<Address[]>[] = await Promise.allSettled(wideNetPromises);
  //     const validResults: Address[] = wideNetResults
  //       .filter((res): res is PromiseFulfilledResult<Address[]> => res.status === "fulfilled")
  //       .flatMap(({ value }: PromiseFulfilledResult<Address[]>) => value);

  //     peers = orderPeers(hash, validResults, n);

  //     const currMinDistance: number = peers[0]?.distance ?? prevMinDistance;
  //     if (currMinDistance >= prevMinDistance || peers.length === 0) {
  //       break;
  //     }

  //     prevMinDistance = currMinDistance;
  //   }

  //   return peers.map(({ value }) => value).slice(0, n);
  // }

  protected async getNearestPeers(query: Base64, n: number, role: Role): Promise<Address[]> {
    const hashKey: Base64 = hashFromData(query);

    let queryQueue: Address[] = this.getNearestLocalPeers(hashKey, n);
    const queriedPeers = new Set<Address>(queryQueue);

    for (let depth: number = 0; depth < HandshakeProto.MAX_RECURSION_DEPTH; depth++) {
      const peersToQuery: Address[] = queryQueue.splice(0, queryQueue.length);

      if (peersToQuery.length === 0) {
        break; // No remote peers to query
      }

      const promises: Promise<Address[]>[] = peersToQuery
        .map((peer: Address) => this.getNearestRemotePeers(peer, hashKey, n, role))
        .map((prom: Promise<Address[]>) => this.getWithTimeout(prom, BaseProto.HEAVY_CALLBACK_TIMEOUT));

      // Wait for all wide network queries to settle
      const results: PromiseSettledResult<Address[]>[] = await Promise.allSettled(promises);
      const newFoundPeers: Address[] = results
        .filter((res): res is PromiseFulfilledResult<Address[]> => res.status === "fulfilled")
        .flatMap(({ value }: PromiseFulfilledResult<Address[]>) => value);

      const prevSize: number = queriedPeers.size;
      newFoundPeers.forEach((peer: Address) => {
        // Only add new peers to the queue if we haven't seen them before.
        if (!queriedPeers.has(peer)) {
          queryQueue.push(peer);
          queriedPeers.add(peer);
        }
      });

      // Check for convergence: if the size of the queried set hasn't grown, we've found all we can.
      if (queriedPeers.size <= prevSize) {
        break;
      }
    }

    const resultArray: Address[] = Array.from(queriedPeers);
    resultArray.map(decodeAddress).forEach((pId: PeerId) => this.addPeer(pId, role));

    const orderedPeers: DistancePair<Address>[] = orderPeers(hashKey, resultArray, n);
    return orderedPeers.map(({ value }) => value).slice(0, n);
  }

  private peerDropped({ detail }: CustomEvent<PeerId>): void {
    this.dropPeer(detail);
  }

  private async initiateHandshake({ detail }: CustomEvent<IdentifyResult>): Promise<void> {
    if (!detail.protocols.includes(this.PROTOCOL)) {
      return;
    }

    const address: Address = encodePeerId(detail.peerId);
    this.logger.debug("initiateHandshake", address);

    try {
      const request: InitiationRequest = { role: this.role, type: HandshakeTypes.InitiationRequest };
      const response = await this.sendRequest<InitiationResponse>(address, request);
      assert(response.success, `Failed to initiate handshake with ${address}`);
      assert(response.data.passphrase === this.passphrase, "Invalid passphrase in handshake response");

      this.addPeer(detail.peerId, response.data.role);
    } catch (err: unknown) {
      this.logger.error("initiateHandshake", err);
    }
  }

  private onInitiationRequest(_event: CustomEvent<Parcel<InitiationRequest>>): InitiationResponse {
    return { passphrase: this.passphrase, role: this.role, type: HandshakeTypes.InitiationResponse };
  }

  private onPingRequest(_event: CustomEvent<Parcel<PingRequest>>): PingResponse {
    return { type: HandshakeTypes.PingResponse };
  }

  private onPeersRequest({ detail }: CustomEvent<Parcel<GetNeighborsRequest>>): GetNeighborsResponse {
    const peers: Address[] = this.getNearestLocalPeers(detail.batch.payload.hash, detail.batch.payload.n);
    return { peers, type: HandshakeTypes.GetNeighborsResponse };
  }

  // Periodically audits nearby peers to ensure they are still reachable
  private async auditPeers(): Promise<void> {
    const neighbors: Address[] = this.getNeighbors(HandshakeProto.NEIGHBORHOOD_SIZE);

    neighbors.forEach(async (neighbor: Address) => {
      this.requestPulse(neighbor).catch((err: unknown) => {
        const peerId: PeerId = decodeAddress(neighbor);
        this.logger.warn("auditPeers", `Failed to request pulse from ${peerId}`, err);
        this.dropPeer(peerId);
      });
    });
  }

  public async start(): Promise<void> {
    await super.start();

    this.addEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.addEventListener(HandshakeTypes.PingRequest, this.onPingRequest.bind(this));
    this.addEventListener(HandshakeTypes.GetNeighborsRequest, this.onPeersRequest.bind(this));
    this.events.addEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.addEventListener("peer:disconnect", this.peerDropped.bind(this));

    const randomDelay: number = Math.random() * 1000;
    this.peerAuditTimer = setInterval(this.auditPeers.bind(this), HandshakeProto.PEER_AUDIT_INTERVAL + randomDelay);
  }

  public async stop(): Promise<void> {
    await super.stop();

    this.removeEventListener(HandshakeTypes.InitiationRequest, this.onInitiationRequest.bind(this));
    this.removeEventListener(HandshakeTypes.PingRequest, this.onPingRequest.bind(this));
    this.removeEventListener(HandshakeTypes.GetNeighborsRequest, this.onPeersRequest.bind(this));
    this.events.removeEventListener("peer:identify", this.initiateHandshake.bind(this));
    this.events.removeEventListener("peer:disconnect", this.peerDropped.bind(this));

    if (this.peerAuditTimer !== undefined) {
      clearInterval(this.peerAuditTimer);
      this.peerAuditTimer = undefined;
    }
  }
}
