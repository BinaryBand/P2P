import { BaseTypes } from "../base-proto.js";
import { HandshakeTypes } from "../handshake-proto.js";
import { SwarmTypes } from "../swarm-proto.js";

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

export function generateUuid(): Uuid {
  return crypto.randomUUID();
}

const PEER_ID_REGEX: RegExp = new RegExp(`^[1-9A-HJ-NP-Za-km-z]+$`);
export function isValidPeerId(peerId: unknown): peerId is Base58 {
  return typeof peerId === "string" && PEER_ID_REGEX.test(peerId);
}

const UUID_REGEX: RegExp = new RegExp(`[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
export function isValidUuid(uuid: unknown): uuid is Uuid {
  return typeof uuid === "string" && UUID_REGEX.test(uuid);
}

function isValidMessageFragment(fragment: unknown): fragment is MessageFragment {
  if (typeof fragment !== "object" || fragment === null) return false;
  return "id" in fragment && isValidUuid(fragment.id) && "fragment" in fragment && isValidEncoded(fragment.fragment);
}

export function isValidParcel(parcel: unknown): parcel is Parcel {
  if (
    !parcel ||
    typeof parcel !== "object" ||
    !("callbackId" in parcel) ||
    !isValidUuid(parcel.callbackId) ||
    !("success" in parcel) ||
    typeof parcel.success !== "boolean"
  ) {
    return false;
  }

  if (!parcel.success) {
    return "message" in parcel && typeof parcel.message === "string";
  }

  return "from" in parcel && isValidPeerId(parcel.from) && "payload" in parcel && isValidPayload(parcel.payload);
}

export function isValidPayload(payload: unknown): payload is Payload {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  switch ((payload as Payload).type) {
    case BaseTypes.EmptyPayload:
      return true;
    case HandshakeTypes.ChallengeRequest:
      return "challenge" in payload && isValidEncoded(payload.challenge);
    case HandshakeTypes.ChallengeResponse:
      return "proof" in payload && isValidEncoded(payload.proof);
    case SwarmTypes.NearestPeersRequest:
      return "n" in payload && typeof payload.n === "number" && "query" in payload && typeof payload.query === "string";
    case SwarmTypes.NearestPeersResponse:
      return "peers" in payload && Array.isArray(payload.peers) && payload.peers.every(isValidPeerId);
    case SwarmTypes.StoreMessagesRequest:
      return (
        "destination" in payload &&
        isValidPeerId(payload.destination) &&
        "messages" in payload &&
        Array.isArray(payload.messages) &&
        payload.messages.every(isValidMessageFragment)
      );
    case SwarmTypes.RetrieveMessagesRequest:
      return "destination" in payload && isValidPeerId(payload.destination);
    case SwarmTypes.RetrieveMessagesResponse:
      return "messages" in payload && Array.isArray(payload.messages) && payload.messages.every(isValidMessageFragment);
    default:
      return false;
  }
}
