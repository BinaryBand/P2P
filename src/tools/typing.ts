import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { BaseTypes } from "../base-proto.js";
import { HandshakeTypes } from "../handshake-proto.js";
import { SwarmTypes } from "../swarm-proto.js";
import { assert } from "./utils.js";
import { MessageTypes } from "../message-proto.js";

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
  Uuid = "uuid",
}

export const decode = TextDecoder.prototype.decode.bind(new TextDecoder());
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

const UUID_REGEX: RegExp = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

function isUuid(uuid: unknown): uuid is Uuid {
  return typeof uuid === "string" && UUID_REGEX.test(uuid);
}

export function isMessageFragment(fragment: unknown): fragment is MessageFragment {
  let control: MessageFragment;
  if (
    fragment !== undefined &&
    fragment !== null &&
    typeof fragment === "object" &&
    "id" in fragment &&
    isUuid(fragment.id) &&
    "content" in fragment &&
    isBase64(fragment.content)
  ) {
    control = { id: fragment.id, content: fragment.content };
    return true;
  }
  return false;
}

export function isMessage(message: unknown): message is Message {
  let control: Message;
  if (
    message !== undefined &&
    message !== null &&
    typeof message === "object" &&
    "text" in message &&
    isBase64(message.text) &&
    "timestamp" in message &&
    typeof message.timestamp === "number"
  ) {
    control = { text: message.text, timestamp: message.timestamp };
    return true;
  }
  return false;
}

export function isParcel(parcel: unknown): parcel is Parcel<ReqData | Return> {
  let control: Parcel<ReqData | Return>;
  if (
    parcel !== undefined &&
    parcel !== null &&
    typeof parcel === "object" &&
    "callbackId" in parcel &&
    isUuid(parcel.callbackId) &&
    "receiver" in parcel &&
    isAddress(parcel.receiver) &&
    "sender" in parcel &&
    isAddress(parcel.sender) &&
    "payload" in parcel &&
    (isRequest(parcel.payload) || isReturn(parcel.payload))
  ) {
    control = {
      callbackId: parcel.callbackId,
      payload: parcel.payload,
      receiver: parcel.receiver,
      sender: parcel.sender,
    };
    return true;
  }
  return false;
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
    case HandshakeTypes.RequestPulse: {
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
      break;
    case MessageTypes.SetMetadataRequest:
      if (
        "owner" in payload &&
        isAddress(payload.owner) &&
        "metadata" in payload &&
        Array.isArray(payload.metadata) &&
        payload.metadata.every(isBase64) &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        control = { owner: payload.owner, metadata: payload.metadata, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case MessageTypes.GetMetadataRequest:
      if (
        "address" in payload &&
        isAddress(payload.address) &&
        "stamp" in payload &&
        isBase64(payload.stamp) &&
        payload.type === MessageTypes.GetMetadataRequest
      ) {
        control = { address: payload.address, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
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
    case BaseTypes.EmptyResponse:
      control = { type: response.type };
      return true;
    case SwarmTypes.NearestPeersResponse:
      if ("peers" in response && Array.isArray(response.peers) && response.peers.every(isAddress)) {
        control = { peers: response.peers, type: response.type };
        return true;
      }
      break;
    case SwarmTypes.FetchResponse:
      if ("fragment" in response && (typeof response.fragment === "string" || response.fragment === null)) {
        control = { fragment: response.fragment, type: response.type };
        return true;
      }
      break;
    case MessageTypes.GetMetadataResponse:
      if ("metadata" in response && Array.isArray(response.metadata) && response.metadata.every(isBase64)) {
        control = { metadata: response.metadata, type: response.type };
        return true;
      }
      break;
  }

  return false;
}
