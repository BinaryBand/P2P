import { calculateDistance } from "../tools/routing.js";
import { Heap } from "heap-js";

type DistancePair<T> = {
  address: T;
  distance: number;
};

export default class DistanceCache<T extends Encoding, U> {
  private addressMap: Map<T, U> = new Map();
  private neighbors = new Heap<DistancePair<T>>((a, b) => a.distance - b.distance); // Nearest neighbors

  constructor(private address: T, private limit: number) {
    this.neighbors.setLimit(this.limit);
  }

  public get keys(): Array<T> {
    return Array.from(this.addressMap.keys());
  }

  public get entries(): Array<[T, U]> {
    return Array.from(this.addressMap.entries());
  }

  public add(key: T, value: U): void {
    const distance: number = calculateDistance(key, this.address);
    const pair: DistancePair<T> = { address: key, distance };
    this.neighbors.push(pair);
    this.addressMap.set(key, value); // Maintain a map for quick lookups
  }

  public has(address: T): boolean {
    return this.addressMap.has(address);
  }

  public get(address: T): U | undefined {
    return this.addressMap.get(address);
  }

  public getTop(n: number): Array<U> {
    const topPairs: DistancePair<T>[] = this.neighbors.top(n);
    return topPairs
      .map(({ address }) => this.addressMap.get(address))
      .filter((peerInfo): peerInfo is U => peerInfo !== undefined);
  }

  public delete(address: T): void {
    if (this.addressMap.delete(address)) {
      const abandonShip = new Heap<DistancePair<T>>((a, b) => a.distance - b.distance);
      const tempArray = this.neighbors.toArray();

      for (const pair of tempArray) {
        if (pair.address !== address) {
          abandonShip.push(pair);
        }
      }

      this.neighbors = abandonShip; // Update the neighbors heap
      this.neighbors.setLimit(this.limit);
    }
  }
}
