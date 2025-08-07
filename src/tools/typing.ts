import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { BaseTypes } from "../base-proto.js";
import { HandshakeTypes } from "../handshake-proto.js";
import { SwarmTypes } from "../swarm-proto.js";
import { assert } from "./utils.js";

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;
export type Uuid = `${Formats.Uuid},${string}-${string}-${string}-${string}-${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
  Uuid = "uuid",
}

export const decode = TextDecoder.prototype.decode.bind(new TextDecoder("utf-8"));
export const encode = TextEncoder.prototype.encode.bind(new TextEncoder());

const BASE64_REGEX: RegExp = new RegExp(`^${Formats.Base64},([a-zA-Z0-9+/]+={0,2})$`);

function isBase64(input: unknown): input is Base64 {
  return typeof input === "string" && BASE64_REGEX.test(input);
}

export function base64ToBytes(input: Base64): Uint8Array {
  const withoutPrefix: string = BASE64_REGEX.exec(input)![1];
  return new Uint8Array(Buffer.from(withoutPrefix, Formats.Base64));
}

export function bytesToBase64(input: Uint8Array): Base64 {
  return `${Formats.Base64},${Buffer.from(input).toString(Formats.Base64)}`;
}

const ADDRESS_REGEX: RegExp = new RegExp(`^${Formats.Base58},([1-9A-HJ-NP-Za-km-z]+)$`);

export function isAddress(peerId: unknown): peerId is Address {
  return typeof peerId === "string" && ADDRESS_REGEX.test(peerId);
}

export function encodePeerId(peerId: PeerId): Address {
  return `${Formats.Base58},${peerId.toString()}`;
}

export function decodeAddress(address: Address): PeerId {
  const match: RegExpExecArray | null = ADDRESS_REGEX.exec(address);
  assert(match, `Invalid Address format: ${address}`);
  return peerIdFromString(match[1]);
}

export function newUuid(): Uuid {
  return `${Formats.Uuid},${crypto.randomUUID()}`;
}

function isUuid(uuid: unknown): uuid is Uuid {
  const uuidRegex: RegExp = new RegExp(
    `${Formats.Uuid},[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
  );
  return typeof uuid === "string" && uuidRegex.test(uuid);
}

export function isParcel(parcel: unknown): parcel is Parcel<ReqData | Return> {
  return (
    parcel !== null &&
    typeof parcel === "object" &&
    "callbackId" in parcel &&
    isUuid(parcel.callbackId) &&
    "sender" in parcel &&
    isAddress(parcel.sender) &&
    "payload" in parcel &&
    (isRequest(parcel.payload) || isReturn(parcel.payload))
  );
}

export function isRequest(payload: unknown): payload is ReqData {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  let control: ReqData;
  switch (payload.type) {
    case HandshakeTypes.InitiationRequest: {
      if ("stamp" in payload && isBase64(payload.stamp)) {
        control = { stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    }
    case SwarmTypes.NearestPeersRequest:
      if (
        "n" in payload &&
        typeof payload.n === "number" &&
        "hash" in payload &&
        isBase64(payload.hash) &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        control = { n: payload.n, hash: payload.hash, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.StoreRequest:
      if ("data" in payload && typeof payload.data === "string" && "stamp" in payload && isBase64(payload.stamp)) {
        control = { data: payload.data, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.FetchRequest:
      if ("hash" in payload && isBase64(payload.hash) && "stamp" in payload && isBase64(payload.stamp)) {
        control = { hash: payload.hash, stamp: payload.stamp, type: payload.type };
        return true;
      }
  }

  return false;
}

export function isReturn(returnValue: unknown): returnValue is Return {
  if (
    !returnValue ||
    typeof returnValue !== "object" ||
    !("success" in returnValue) ||
    typeof returnValue.success !== "boolean"
  ) {
    return false;
  }

  if (!returnValue.success) {
    return "message" in returnValue && typeof returnValue.message === "string";
  }

  if ("data" in returnValue) {
    return isResponse(returnValue.data);
  }

  return false;
}

function isResponse(response: unknown): response is ResData {
  if (!response || typeof response !== "object" || !("type" in response)) {
    return false;
  }

  let control: ResData;
  switch (response.type) {
    case BaseTypes.EmptyResponse: {
      control = { type: response.type };
      return true;
    }
    case SwarmTypes.NearestPeersResponse:
      {
        if ("peers" in response && Array.isArray(response.peers) && response.peers.every(isAddress)) {
          control = { peers: response.peers, type: response.type };
          return true;
        }
      }
      break;
    case SwarmTypes.FetchResponse: {
      if ("fragment" in response && (typeof response.fragment === "string" || response.fragment === null)) {
        control = { fragment: response.fragment, type: response.type };
        return true;
      }
    }
  }

  return false;
}
