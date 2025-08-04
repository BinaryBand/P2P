import { combine, split } from "shamir-secret-sharing";
import {
  decoder,
  encoder,
  bufferFromEncoded,
  encodedFromBuffer,
  generateUuid,
  assert,
  isValidUuid,
  isValidPeerId,
} from "./utils.js";

export function createEnvelope(content: string, recipient: Base58, sender: Base58): Envelope {
  return { id: generateUuid(), content, recipient, sender, timestamp: Date.now() };
}

export function parseEnvelope(raw: string): Envelope | undefined {
  try {
    const parsed: Envelope = JSON.parse(raw);
    assert(isValidUuid(parsed.id), `Invalid UUID in envelope: ${parsed.id}`);
    assert(isValidPeerId(parsed.sender), `Invalid sender in envelope: ${parsed.sender}`);
    assert(isValidPeerId(parsed.recipient), `Invalid recipient in envelope: ${parsed.recipient}`);
    return parsed;
  } catch {
    return;
  }
}

export async function shamirSecretSharing(message: Envelope, shares: number, threshold: number): Promise<Encoded[]> {
  const messageBuffer: Uint8Array = encoder.encode(JSON.stringify(message));
  const fragments: Uint8Array[] = await split(messageBuffer, shares, threshold);
  return fragments.map(encodedFromBuffer);
}

export async function reconstructShamirSecret(shares: Encoded[]): Promise<Envelope | undefined> {
  const fragments: Uint8Array[] = shares.map(bufferFromEncoded);
  const secret: Uint8Array = await combine(fragments);
  const rawString: string = decoder.decode(secret);
  return parseEnvelope(rawString);
}
