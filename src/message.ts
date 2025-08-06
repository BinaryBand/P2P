import { Components } from "libp2p/dist/src/components";
import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import HandshakeProto, { HandshakeEvents } from "./handshake-proto.js";
import { orderPeers } from "./tools/messenger.js";
import { assert } from "./tools/utils.js";

export type MessageEvents = (ProtocolEvents & HandshakeEvents) & {
  [MessageTypes.NearestPeersRequest]: CustomEvent<Parcel<NearestPeersRequest>>;
};

export enum MessageTypes {
  NearestPeersRequest = "message:nearest-peers-request",
  NearestPeersResponse = "message:nearest-peers-response",
}

export default class MessageProto<T extends MessageEvents> extends HandshakeProto<T> {
  private static readonly MAX_RECURSION_DEPTH: number = 5;

  constructor(components: Components, passphrase?: string) {
    super(components, passphrase);
  }

  public static Messages<T extends MessageEvents>(passphrase?: string): (params: Components) => MessageProto<T> {
    return (params: Components) => new MessageProto(params, passphrase);
  }

  private findNearestLocalPairs(query: Base58 | Encoded, n: number): PeerDistancePair[] {
    const candidates: string[] = Array.from(this.peers.keys());
    const distances: PeerDistancePair[] = orderPeers(query, candidates);
    return distances.slice(0, n);
  }

  private findNearestLocals(query: Base58 | Encoded, n: number): Base58[] {
    const candidates: string[] = Array.from(this.peers.keys());
    const distances: PeerDistancePair[] = orderPeers(query, candidates);
    return distances.slice(0, n).map((pair) => pair.peer);
  }

  protected async getNearestRemote(address: Base58, query: Base58 | Encoded, n: number): Promise<NearestPeersResponse> {
    const peerId: PeerId = peerIdFromString(address);

    const token: Token | undefined = await this.getPeerToken(peerId);
    assert(token !== undefined, `No token found for peer ${peerId}`);

    const request: NearestPeersRequest = { n, query, token, type: MessageTypes.NearestPeersRequest };
    const response: Return<NearestPeersResponse> = await this.sendRequest(peerId, request);
    assert(response.success, `Failed to find nearest peers for ${peerId}`);

    return response.data;
  }

  public async findNearestPeers(query: Base58 | Encoded, n: number = 3): Promise<Base58[]> {
    let peers: PeerDistancePair[] = this.findNearestLocalPairs(query, n);

    try {
      let prevMinDistance: number = peers[0]?.distance ?? Infinity;
      for (let i: number = 0; i < MessageProto.MAX_RECURSION_DEPTH; i++) {
        const wideNet = await Promise.all(peers.map(({ peer }) => this.getNearestRemote(peer, query, n)));
        const flatPeers: Base58[] = wideNet.flatMap(({ peers }) => peers);
        peers = orderPeers(query, flatPeers);

        const currMinDistance: number = peers[0]?.distance ?? prevMinDistance;
        if (currMinDistance >= prevMinDistance || peers.length === 0) break;

        prevMinDistance = currMinDistance;
      }
    } catch (err) {
      console.warn("Failed to find nearest remote peers. Returning last successful search.", err);
    }

    return peers.map((pair: PeerDistancePair) => pair.peer).slice(0, n);
  }

  private async onPeersRequest({ detail }: CustomEvent<Parcel<NearestPeersRequest>>): Promise<NearestPeersResponse> {
    const peers: Base58[] = this.findNearestLocals(detail.payload.query, detail.payload.n);
    return { peers, type: MessageTypes.NearestPeersResponse };
  }

  public async start(): Promise<void> {
    await super.start();
    this.addEventListener(MessageTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
  }

  public async stop(): Promise<void> {
    await super.stop();
    this.removeEventListener(MessageTypes.NearestPeersRequest, this.onPeersRequest.bind(this));
  }
}
