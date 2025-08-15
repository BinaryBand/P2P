import { base64ToBytes, bytesToBase64, stringify, toBuffer } from "./typing.js";

import { combine, split } from "shamir-secret-sharing";
import { LRUCache } from "lru-cache";
import sodium from "libsodium-wrappers";

const hashCache = new LRUCache<string, Uint8Array>({ max: 256 });

export function genericHash(input: Encoded, key?: Uint8Array): Uint8Array;
export function genericHash(input: Uint8Array, key?: Uint8Array): Uint8Array;
export function genericHash(input: Encoded | Uint8Array, key?: Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) {
    return sodium.crypto_generichash(32, input, key);
  }

  let hash: Uint8Array | undefined = hashCache.get(input);
  if (hash === undefined) {
    hash = sodium.crypto_generichash(32, input, key);
    hashCache.set(input, hash);
  }

  return hash;
}

const TIME_STEP: number = 30_000;

export function totp(secret: Uint8Array, targetTime: number = Date.now(), timeStep: number = TIME_STEP): Uint8Array {
  const time: number = Math.floor(targetTime / timeStep);
  const timeBuffer: Uint8Array = new Uint8Array(4);
  timeBuffer.set([time >>> 12, time >>> 8, time >>> 4, time], 0);
  return sodium.crypto_generichash(32, timeBuffer, secret);
}

// export function fingerprintPayload(object: Payload, key?: Uint8Array): Uint8Array {
//   // const stringPrint: string = Object.entries(object)
//   //   .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
//   //   .map(([, val]) => String(val))
//   //   .join(",");
//   // return sodium.crypto_generichash(32, stringPrint, key);
// }

export async function shamirSecretSharing(message: Message, shares: number, threshold: number): Promise<Base64[]> {
  const messageBuffer: Uint8Array = toBuffer(JSON.stringify(message));
  const fragments: Uint8Array[] = await split(messageBuffer, shares, threshold);
  return fragments.map(bytesToBase64);
}

export async function reconstructShamirSecret(shares: Base64[]): Promise<Message | undefined> {
  const fragments: Uint8Array[] = shares.map(base64ToBytes);
  const secret: Uint8Array = await combine(fragments);
  return stringify(secret);
}

export { sodium };
