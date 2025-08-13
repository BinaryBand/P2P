import { calculateDistance } from "../tools/routing.js";

export default class DistanceCache {
  private peersCache: Map<Address, PeerInfo> = new Map();

  private sortedList: Array<{ address: Address; distance: number }> = new Array();

  constructor(private address: Address) {}

  public get keys(): Array<Address> {
    return Array.from(this.peersCache.keys());
  }

  public get entries(): Array<[Address, PeerInfo]> {
    return Array.from(this.peersCache.entries());
  }

  private insertSorted(address: Address, distance: number): void {
    const newPeer = { address, distance };
    const index: number = this.sortedList.findIndex((peer) => peer.distance > distance);

    // If not found, it means the new peer is the farthest
    if (index !== -1) {
      this.sortedList.splice(index, 0, newPeer);
      return;
    }

    this.sortedList.push(newPeer);
  }

  private deleteSorted(address: Address): void {
    this.sortedList = this.sortedList.filter((peer) => peer.address !== address);
  }

  public add(key: Address, value: PeerInfo): void {
    if (!this.peersCache.has(key)) {
      const distance: number = calculateDistance(key, this.address);
      this.insertSorted(key, distance);
      this.peersCache.set(key, value);
    }
  }

  public has(address: Address): boolean {
    return this.peersCache.has(address);
  }

  public get(address: Address): PeerInfo | undefined {
    return this.peersCache.get(address);
  }

  public getTop(n: number): Array<PeerInfo> {
    return this.sortedList
      .slice(0, n)
      .map(({ address }) => this.peersCache.get(address))
      .filter((peer?: PeerInfo): peer is PeerInfo => peer !== undefined);
  }

  public delete(address: Address): void {
    if (this.peersCache.delete(address)) {
      this.deleteSorted(address);
    }
  }
}
