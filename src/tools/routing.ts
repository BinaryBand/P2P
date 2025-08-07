import { blake2b } from "./cryptography.js";

function countSetBits(num: number): number {
  let count: number = 0;
  while (num) {
    count += num & 0b1;
    num >>= 1;
  }
  return count;
}

export function calculateDistance(a: Uint8Array, b: Uint8Array): number {
  const length: number = Math.min(a.length, b.length);

  let distance: number = 0;
  for (let i: number = 0; i < length; i++) {
    distance += countSetBits(a[i] ^ b[i]);
  }

  return distance;
}

/**
 * Orders a list of peer identifiers by their calculated distance to a query string.
 *
 * The function hashes both the query and each candidate peer using the `blake2b` algorithm,
 * computes the distance between the query and each peer, and returns an array of objects
 * containing the peer and its distance, sorted in ascending order of distance.
 *
 * @param query - The query string to compare against candidate peers.
 * @param candidates - An array of peer identifiers to be ordered by distance.
 * @returns An array of `PeerDistancePair` objects, each containing a peer and its distance to the query, sorted by distance.
 */
export function orderPeers(query: string, candidates: Address[]): PeerDistancePair[] {
  const key: Uint8Array = blake2b(query);
  const distances: PeerDistancePair[] = [];

  for (const peer of new Set(candidates)) {
    const peerCode: Uint8Array = blake2b(peer);
    const distance: number = calculateDistance(key, peerCode);
    distances.push({ peer, distance });
  }

  distances.sort((a: PeerDistancePair, b: PeerDistancePair) => a.distance - b.distance);
  return distances;
}
