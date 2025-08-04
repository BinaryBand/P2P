import { BaseTypes } from "./base-proto.js";
import { HandshakeTypes } from "./handshake-proto.js";
import { SwarmTypes } from "./swarm-proto.js";

const PREFERRED_ENCODING: BufferEncoding = "base64";

export const decoder = new TextDecoder("utf-8");
export const encoder = new TextEncoder();

export const bufferFromEncoding = (input: string): Uint8Array => new Uint8Array(Buffer.from(input, PREFERRED_ENCODING));
export const encodingFromBuffer = (input: Uint8Array): string => Buffer.from(input).toString(PREFERRED_ENCODING);

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function isValidUuid(uuid: unknown): uuid is string {
  if (typeof uuid !== "string") {
    return false;
  }

  const uuidRegex: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function isValidId(peerId: unknown): boolean {
  return typeof peerId === "string";
}

function isValidEncodedValue(input: unknown): boolean {
  if (typeof input !== "string") {
    return false;
  }

  try {
    const decoded: Buffer = Buffer.from(input, PREFERRED_ENCODING);
    return decoded.toString(PREFERRED_ENCODING) === input;
  } catch {
    return false;
  }
}

function isValidMessageFragment(fragment: unknown): fragment is MessageFragment {
  if (typeof fragment !== "object" || fragment === null) {
    return false;
  }

  return (
    "fragment" in fragment &&
    typeof fragment.fragment === "string" &&
    "signature" in fragment &&
    isValidEncodedValue(fragment.signature)
  );
}

export function isValidParcel(parcel: unknown): parcel is Parcel {
  if (
    !parcel ||
    typeof parcel !== "object" ||
    !("callbackId" in parcel) ||
    !("success" in parcel) ||
    !isValidUuid(parcel.callbackId) ||
    typeof parcel.success !== "boolean"
  ) {
    return false;
  }

  if (!parcel.success) {
    return "message" in parcel && typeof parcel.message === "string";
  }

  return "from" in parcel && isValidId(parcel.from) && "payload" in parcel && isValidPayload(parcel.payload);
}

export function isValidPayload(payload: unknown): payload is Payload {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  switch (payload.type) {
    case BaseTypes.EmptyPayload:
      return true;
    case HandshakeTypes.ChallengeRequest:
      return "challenge" in payload && isValidEncodedValue(payload.challenge);
    case HandshakeTypes.ChallengeResponse:
      return "proof" in payload && isValidEncodedValue(payload.proof);
    case SwarmTypes.NearestPeersRequest:
      return "n" in payload && typeof payload.n === "number" && "query" in payload && typeof payload.query === "string";
    case SwarmTypes.NearestPeersResponse:
      return "peers" in payload && Array.isArray(payload.peers) && payload.peers.every(isValidId);
    case SwarmTypes.StoreMessagesRequest:
      return (
        "destination" in payload &&
        isValidId(payload.destination) &&
        "messages" in payload &&
        Array.isArray(payload.messages) &&
        payload.messages.every(isValidMessageFragment)
      );
    case SwarmTypes.RetrieveMessagesRequest:
      return "destination" in payload && isValidId(payload.destination);
    case SwarmTypes.RetrieveMessagesResponse:
      return "messages" in payload && Array.isArray(payload.messages) && payload.messages.every(isValidMessageFragment);
    default:
      return false;
  }
}
