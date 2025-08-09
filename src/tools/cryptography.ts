import { blake2b as _blake2b } from "@noble/hashes/blake2.js";
import { blake3 as _blake3 } from "@noble/hashes/blake3.js";
import { combine, split } from "shamir-secret-sharing";
import speakeasy from "speakeasy";

import { base64ToBytes, bytesToBase64, decode, encode, Formats } from "./typing.js";

export function blake2b(input: Uint8Array, key?: Uint8Array | string): Uint8Array {
  const hash: Uint8Array = _blake2b(input, { dkLen: 32, key });
  return hash;
}

export function blake3(input: string, key?: Uint8Array): Uint8Array {
  const hash: Uint8Array = _blake3(input, { dkLen: 32, key });
  return hash;
}

export function totp(secret: Uint8Array, targetTime?: number): Uint8Array {
  const base64Secret: Base64 = bytesToBase64(secret);
  const time: number = Math.floor((targetTime ?? Date.now()) / 1000);
  const otp: string = speakeasy.totp({ secret: base64Secret, encoding: "base64", time });
  return base64ToBytes(`${Formats.Base64},${otp}`);
}

export async function shamirSecretSharing(message: string, shares: number, threshold: number): Promise<Base64[]> {
  const messageBuffer: Uint8Array = encode(JSON.stringify(message));
  const fragments: Uint8Array[] = await split(messageBuffer, shares, threshold);
  return fragments.map(bytesToBase64);
}

export async function reconstructShamirSecret(shares: Base64[]): Promise<string | undefined> {
  const fragments: Uint8Array[] = shares.map(base64ToBytes);
  const secret: Uint8Array = await combine(fragments);
  const rawString: string = decode(secret);
  return rawString;
}
