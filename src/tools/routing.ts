import { base64ToBytes, isAddress, isBase64, isFragment } from "./typing.js";
import { blake3 } from "./cryptography.js";
import { assert } from "./utils.js";

import { Heap } from "heap-js";

function countSetBits(num: number): number {
  let count: number = 0;
  while (num) {
    count += num & 0b1;
    num >>= 1;
  }
  return count;
}

function _calculateDistance(a: Address | Fragment, b: Address | Fragment): number {
  const aHash: Uint8Array = blake3(a);
  const bHash: Uint8Array = blake3(b);
  return _calculateDistance_bytes(aHash, bHash);
}

function _calculateDistance_base64(a: Base64, b: Base64): number {
  const aBytes: Uint8Array = base64ToBytes(a);
  const bBytes: Uint8Array = base64ToBytes(b);
  return _calculateDistance_bytes(aBytes, bBytes);
}

function _calculateDistance_bytes(a: Uint8Array, b: Uint8Array): number {
  const length: number = Math.min(a.length, b.length);

  let distance: number = 0;
  for (let i: number = 0; i < length; i++) {
    distance += countSetBits(a[i] ^ b[i]);
  }

  return distance;
}

export function calculateDistance(a: Encoded, b: Encoded): number;
export function calculateDistance(a: Uint8Array, b: Uint8Array): number;
export function calculateDistance(a: unknown, b: unknown): number {
  if (a instanceof Uint8Array) {
    assert(b instanceof Uint8Array, "Invalid types for distance calculation");
    return _calculateDistance_bytes(a, b);
  }

  if (isBase64(a)) {
    assert(isBase64(b), "Invalid types for distance calculation");
    return _calculateDistance_base64(a, b);
  }

  assert((isAddress(a) && isAddress(b)) || (isFragment(a) && isFragment(b)), "Invalid types for distance calculation");
  return _calculateDistance(a, b);
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
 * @param n - The maximum number of peers to return.
 * @returns An array of `PeerDistancePair` objects, each containing a peer and its distance to the query, sorted by distance.
 */
export function orderPeers(query: Base64, candidates: Address[], n: number): PeerDistancePair[] {
  const key: Uint8Array = blake3(query);
  const minHeap = new Heap<PeerDistancePair>((a, b) => a.distance - b.distance);

  for (const address of candidates) {
    const peerCode: Uint8Array = blake3(address);
    const distance: number = calculateDistance(key, peerCode);
    minHeap.push({ address, distance });
    if (minHeap.size() > n) {
      minHeap.pop();
    }
  }

  return minHeap.toArray();
}
