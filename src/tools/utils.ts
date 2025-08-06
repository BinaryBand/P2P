import { BaseTypes } from "../base-proto.js";
import { HandshakeTypes } from "../handshake-proto.js";
import { MessageTypes } from "../message.js";

export type Base58 = string;
export type Encoded = `${Text.Encoded},${string}`;
export type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export enum Text {
  Encoded = "base64",
  Uuid = "uuid",
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export const decoder = new TextDecoder("utf-8");
export const encoder = new TextEncoder();

const ENCODED_REGEX: RegExp = new RegExp(`^${Text.Encoded},([a-zA-Z0-9+/]+={0,2})$`);
function isValidEncoded(input: unknown): input is Encoded {
  return typeof input === "string" && ENCODED_REGEX.test(input);
}
export function bufferFromEncoded(input: Encoded): Uint8Array {
  const errorMessage: string = `Invalid Encoded format: ${input}`;
  try {
    assert(isValidEncoded(input), errorMessage);
    const withoutPrefix: string = ENCODED_REGEX.exec(input)![1];
    return new Uint8Array(Buffer.from(withoutPrefix, Text.Encoded));
  } catch (error) {
    throw new Error(errorMessage);
  }
}

export function encodedFromBuffer(input: Uint8Array): Encoded {
  return `${Text.Encoded},${Buffer.from(input).toString(Text.Encoded)}`;
}

const PEER_ID_REGEX: RegExp = new RegExp(`^[1-9A-HJ-NP-Za-km-z]+$`);
export function isValidPeerId(peerId: unknown): peerId is Base58 {
  return typeof peerId === "string" && PEER_ID_REGEX.test(peerId);
}

export function generateUuid(): Uuid {
  return crypto.randomUUID();
}

const UUID_REGEX: RegExp = new RegExp(`[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
export function isValidUuid(uuid: unknown): uuid is Uuid {
  return typeof uuid === "string" && UUID_REGEX.test(uuid);
}

function isValidToken(token: unknown): token is Token {
  return (
    typeof token === "object" &&
    token !== null &&
    "challenge" in token &&
    isValidEncoded(token.challenge) &&
    "peerId" in token &&
    isValidPeerId(token.peerId) &&
    "signature" in token &&
    isValidEncoded(token.signature) &&
    "signedAt" in token &&
    typeof token.signedAt === "number" &&
    "validFor" in token &&
    typeof token.validFor === "number"
  );
}

export function isValidParcel(parcel: unknown): parcel is Parcel<RequestData | Return> {
  if (
    typeof parcel !== "object" ||
    parcel === null ||
    !("callbackId" in parcel) ||
    !("sender" in parcel) ||
    !("payload" in parcel)
  ) {
    return false;
  }

  return (
    isValidUuid(parcel.callbackId) &&
    isValidPeerId(parcel.sender) &&
    (isValidRequest(parcel.payload) || isValidReturn(parcel.payload))
  );
}

export function isValidRequest(payload: unknown): payload is RequestData {
  if (typeof payload !== "object" || payload === null || !("type" in payload)) {
    return false;
  }

  switch (payload.type) {
    case HandshakeTypes.TokenRequest:
      return true;
    case MessageTypes.NearestPeersRequest:
      return (
        "n" in payload &&
        typeof payload.n === "number" &&
        "query" in payload &&
        typeof payload.query === "string" &&
        "token" in payload &&
        isValidToken(payload.token)
      );
    default:
      return false;
  }
}

export function isValidReturn(returnValue: unknown): returnValue is Return {
  if (typeof returnValue !== "object" || returnValue === null || !("type" in returnValue)) {
    return false;
  }

  switch (returnValue.type) {
    case BaseTypes.Return:
      return "success" in returnValue && typeof returnValue.success === "boolean";
    default:
      return false;
  }
}
