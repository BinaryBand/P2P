import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { BaseTypes } from "../protocols/base-proto.js";
import { HandshakeTypes } from "../protocols/handshake-proto.js";
import { SwarmTypes } from "../protocols/swarm-proto.js";
// import { MessageTypes } from "../message-proto.js";
import { assert } from "./utils.js";

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
}

export const decode = TextDecoder.prototype.decode.bind(new TextDecoder());
export const encode = TextEncoder.prototype.encode.bind(new TextEncoder());

const BASE64_REGEX: RegExp = new RegExp(`^${Formats.Base64},([a-zA-Z0-9+/]+={0,2})$`);

export function isBase64(input: unknown): input is Base64 {
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
  let _control: MessageFragment;
  if (
    fragment !== undefined &&
    fragment !== null &&
    typeof fragment === "object" &&
    "id" in fragment &&
    isUuid(fragment.id) &&
    "content" in fragment &&
    isBase64(fragment.content)
  ) {
    _control = { id: fragment.id, content: fragment.content };
    return true;
  }
  return false;
}

export function isMessage(message: unknown): message is Message {
  return typeof message === "string";
  // if (
  //   message !== undefined &&
  //   message !== null &&
  //   typeof message === "object" &&
  //   "sender" in message &&
  //   isAddress(message.sender) &&
  //   "text" in message &&
  //   isBase64(message.text) &&
  //   "timestamp" in message &&
  //   typeof message.timestamp === "number"
  // ) {
  //   const __control: Message = { sender: message.sender, text: message.text, timestamp: message.timestamp };
  //   return true;
  // }
  // return false;
}

export function isParcel(parcel: unknown): parcel is Parcel<ReqData | Return> {
  let _control: Parcel<ReqData | Return>;
  if (
    parcel !== undefined &&
    parcel !== null &&
    typeof parcel === "object" &&
    "batch" in parcel &&
    isBatchItem(parcel.batch) &&
    "receiver" in parcel &&
    isAddress(parcel.receiver) &&
    "sender" in parcel &&
    isAddress(parcel.sender)
  ) {
    _control = { batch: parcel.batch, receiver: parcel.receiver, sender: parcel.sender };
    return true;
  }
  return false;
}

export function isBatchItem(batchItem: unknown): batchItem is BatchItem<Payload> {
  let _control: BatchItem<Payload>;
  if (
    batchItem !== undefined &&
    batchItem !== null &&
    typeof batchItem === "object" &&
    "callbackId" in batchItem &&
    isUuid(batchItem.callbackId) &&
    "payload" in batchItem &&
    isPayload(batchItem.payload)
  ) {
    _control = { callbackId: batchItem.callbackId, payload: batchItem.payload };
    return true;
  }
  return false;
}

export function isPayload(payload: unknown): payload is Payload {
  return isRequest(payload) || isReturn(payload);
}

export function isRequest(payload: unknown): payload is ReqData {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  let _control: ReqData;
  switch (payload.type) {
    case HandshakeTypes.InitiationRequest: {
      if (
        "role" in payload &&
        (payload.role === "phone" || payload.role === "tower") &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        _control = { role: payload.role, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    }
    case HandshakeTypes.PingRequest: {
      if ("stamp" in payload && isBase64(payload.stamp)) {
        _control = { stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    }
    case HandshakeTypes.GetNeighborsRequest:
      if (
        "n" in payload &&
        typeof payload.n === "number" &&
        "role" in payload &&
        (payload.role === "phone" || payload.role === "tower") &&
        "hash" in payload &&
        isBase64(payload.hash) &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        _control = { n: payload.n, role: payload.role, hash: payload.hash, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.SetFragmentsRequest:
      if ("fragments" in payload && Array.isArray(payload.fragments) && "stamp" in payload && isBase64(payload.stamp)) {
        _control = { fragments: payload.fragments, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.GetFragmentsRequest:
      if (
        "hashes" in payload &&
        Array.isArray(payload.hashes) &&
        payload.hashes.every(isBase64) &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        _control = { hashes: payload.hashes, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.SetMetadataRequest:
      if (
        "hashKey" in payload &&
        isBase64(payload.hashKey) &&
        "metadata" in payload &&
        Array.isArray(payload.metadata) &&
        payload.metadata.every(isBase64) &&
        "stamp" in payload &&
        isBase64(payload.stamp)
      ) {
        _control = { hashKey: payload.hashKey, metadata: payload.metadata, stamp: payload.stamp, type: payload.type };
        return true;
      }
      break;
    case SwarmTypes.GetMetadataRequest:
      if (
        "hashKey" in payload &&
        isBase64(payload.hashKey) &&
        "stamp" in payload &&
        isBase64(payload.stamp) &&
        payload.type === SwarmTypes.GetMetadataRequest
      ) {
        _control = { hashKey: payload.hashKey, stamp: payload.stamp, type: payload.type };
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

  let _control: ResData;
  switch (response.type) {
    case BaseTypes.EmptyResponse:
      _control = { type: response.type };
      return true;
    case HandshakeTypes.PingResponse:
      if ("role" in response && (response.role === "phone" || response.role === "tower")) {
        _control = { role: response.role, type: response.type };
        return true;
      }
      break;
    case HandshakeTypes.GetNeighborsResponse:
      if ("peers" in response && Array.isArray(response.peers) && response.peers.every(isAddress)) {
        _control = { peers: response.peers, type: response.type };
        return true;
      }
      break;
    case SwarmTypes.GetFragmentsResponse:
      if (
        "fragments" in response &&
        Array.isArray(response.fragments) &&
        response.fragments.every((frag) => typeof frag === "string")
      ) {
        _control = { fragments: response.fragments, type: response.type };
        return true;
      }
      break;
    case SwarmTypes.GetMetadataResponse:
      if ("metadata" in response && Array.isArray(response.metadata) && response.metadata.every(isBase64)) {
        _control = { metadata: response.metadata, type: response.type };
        return true;
      }
      break;
  }

  return false;
}
