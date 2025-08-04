import { split, combine } from "shamir-secret-sharing";
import { decoder, encoder, bufferFromEncoding, encodingFromBuffer } from "./utils.js";

export async function shamirSecretSharing(secret: string, shares: number, threshold: number): Promise<string[]> {
  const fragments: Uint8Array[] = await split(encoder.encode(secret), shares, threshold);
  return fragments.map(encodingFromBuffer);
}

export async function reconstructShamirSecret(shares: string[]): Promise<string> {
  const fragments: Uint8Array[] = shares.map(bufferFromEncoding);
  const secret: Uint8Array = await combine(fragments);
  return decoder.decode(secret);
}
