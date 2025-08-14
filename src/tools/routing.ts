import { base64ToBytes, isAddress, isBase64 } from "./typing.js";
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

type AgnosticEncoding = Uint8Array | Base64 | Address;

function _calculateDistance_base64(a: Base64, b: Base64): number {
  const aBytes: Uint8Array = base64ToBytes(a);
  const bBytes: Uint8Array = base64ToBytes(b);
  return _calculateDistance_bytes(aBytes, bBytes);
}

function _calculateDistance_Address(a: Address, b: Address): number {
  const aHash: Uint8Array = blake3(a);
  const bHash: Uint8Array = blake3(b);
  return _calculateDistance_bytes(aHash, bHash);
}

function _calculateDistance_bytes(a: Uint8Array, b: Uint8Array): number {
  const length: number = Math.min(a.length, b.length);

  let distance: number = 0;
  for (let i: number = 0; i < length; i++) {
    distance += countSetBits(a[i] ^ b[i]);
  }

  return distance;
}

/**
 * Calculates the distance between two values encoded in Base64.
 *
 * This function is typically used in distributed systems or networking contexts
 * where distances between node identifiers (represented as Base64 strings) are required,
 * such as in DHTs (Distributed Hash Tables) or routing algorithms.
 *
 * @param a - The first Base64-encoded value.
 * @param b - The second Base64-encoded value.
 * @returns The calculated distance as a number.
 */
export function calculateDistance(a: Base64, b: Base64): number;
export function calculateDistance(a: Address, b: Address): number;
export function calculateDistance(a: Uint8Array, b: Uint8Array): number;
export function calculateDistance(a: AgnosticEncoding, b: AgnosticEncoding): number {
  if (isBase64(a) && isBase64(b)) {
    return _calculateDistance_base64(a, b);
  }

  if (isAddress(a) && isAddress(b)) {
    return _calculateDistance_Address(a, b);
  }

  assert(a instanceof Uint8Array && b instanceof Uint8Array, "Invalid types for distance calculation");
  return _calculateDistance_bytes(a as Uint8Array, b as Uint8Array);
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
