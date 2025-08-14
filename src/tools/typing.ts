import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";

import { BaseTypes } from "../protocols/base-proto.js";
import { HandshakeTypes } from "../protocols/handshake-proto.js";
import { SwarmTypes } from "../protocols/swarm-proto.js";
// import { MessageTypes } from "../message-proto.js";

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;
export type Fragment = `${Formats.Utf8},${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
  Utf8 = "utf8",
}

export const decode = TextDecoder.prototype.decode.bind(new TextDecoder());
export const encode = TextEncoder.prototype.encode.bind(new TextEncoder());

const ADDRESS_REGEX: RegExp = new RegExp(`^${Formats.Base58},([1-9A-HJ-NP-Za-km-z]+)$`);
export const isAddress = (pId: unknown): pId is Address => typeof pId === "string" && ADDRESS_REGEX.test(pId);
export const encodePeerId = (pId: PeerId): Address => `${Formats.Base58},${pId}`;
export const decodeAddress = (addr: Address): PeerId => peerIdFromString(ADDRESS_REGEX.exec(addr)![1]);

const BASE64_REGEX: RegExp = new RegExp(`^${Formats.Base64},([a-zA-Z0-9+/]+={0,2})$`);
export const isBase64 = (s: unknown): s is Base64 => typeof s === "string" && BASE64_REGEX.test(s);
export const base64ToBytes = (b64: Base64): Uint8Array =>
  Uint8Array.from(Buffer.from(BASE64_REGEX.exec(b64)![1], Formats.Base64));
export const bytesToBase64 = (b: Uint8Array): Base64 => `${Formats.Base64},${Buffer.from(b).toString(Formats.Base64)}`;

const FRAGMENT_REGEX: RegExp = new RegExp(`^${Formats.Utf8},(.*)$`);
export const isFragment = (frag: unknown): frag is Fragment => typeof frag === "string" && FRAGMENT_REGEX.test(frag);
export const encodeFragment = (msg: MessageFragment): Fragment => `${Formats.Utf8},${JSON.stringify(msg)}`;
export const decodeFragment = (frag: Fragment): MessageFragment => JSON.parse(FRAGMENT_REGEX.exec(frag)![1]);

const UUID_REGEX: RegExp = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
export const isUuid = (uuid: unknown): uuid is Uuid => typeof uuid === "string" && UUID_REGEX.test(uuid);

export function isMessageFragment(fragment: unknown): fragment is MessageFragment {
  let _control: MessageFragment;
  if (
    fragment &&
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

export function isRole(role: unknown): role is Role {
  switch (role) {
    case "phone":
    case "tower":
      return true;
  }

  return false;
}

export function isMessage(message: unknown): message is Message {
  return typeof message === "string";
}

export function isParcel(parcel: unknown): parcel is Parcel<Payload> {
  let _control: Parcel<Payload>;
  if (
    parcel &&
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
    batchItem &&
    typeof batchItem === "object" &&
    "callbackId" in batchItem &&
    isUuid(batchItem.callbackId) &&
    "payload" in batchItem &&
    (isRequest(batchItem.payload) || isReturn(batchItem.payload))
  ) {
    _control = { callbackId: batchItem.callbackId, payload: batchItem.payload };
    return true;
  }
  return false;
}

export function isRequest(request: unknown): request is ReqData {
  if (
    !request ||
    typeof request !== "object" ||
    !("type" in request) ||
    !("stamp" in request) ||
    !isBase64(request.stamp)
  ) {
    return false;
  }

  let _control: ReqData;
  const stamp: Base64 = request.stamp;
  switch (request.type) {
    case HandshakeTypes.InitiationRequest:
      if ("role" in request && isRole(request.role)) {
        _control = { role: request.role, stamp, type: request.type };
        return true;
      }
      break;
    case HandshakeTypes.PingRequest:
      _control = { stamp, type: request.type };
      return true;
    case HandshakeTypes.GetNeighborsRequest:
      if (
        "n" in request &&
        typeof request.n === "number" &&
        "role" in request &&
        isRole(request.role) &&
        "hash" in request &&
        isBase64(request.hash)
      ) {
        _control = {
          n: request.n,
          role: request.role,
          hash: request.hash,
          stamp,
          type: request.type,
        };
        return true;
      }
      break;
    case SwarmTypes.SetFragmentsRequest:
      if ("fragments" in request && Array.isArray(request.fragments) && request.fragments.every(isFragment)) {
        _control = { fragments: request.fragments, stamp, type: request.type };
        return true;
      }
      break;
    case SwarmTypes.GetFragmentsRequest:
      if ("hashes" in request && Array.isArray(request.hashes) && request.hashes.every(isBase64)) {
        _control = { hashes: request.hashes, stamp, type: request.type };
        return true;
      }
      break;
    case SwarmTypes.SetMetadataRequest:
      if (
        "hashKey" in request &&
        isBase64(request.hashKey) &&
        "metadata" in request &&
        Array.isArray(request.metadata) &&
        request.metadata.every(isBase64)
      ) {
        _control = {
          hashKey: request.hashKey,
          metadata: request.metadata,
          stamp,
          type: request.type,
        };
        return true;
      }
      break;
    case SwarmTypes.GetMetadataRequest:
      if ("hashKey" in request && isBase64(request.hashKey)) {
        _control = { hashKey: request.hashKey, stamp, type: request.type };
        return true;
      }
      break;
  }

  return false;
}

export function isReturn(payload: unknown): payload is Return {
  if (!payload || typeof payload !== "object" || !("success" in payload) || typeof payload.success !== "boolean") {
    return false;
  }

  let _control: Return;
  switch (payload.success) {
    case true:
      if ("data" in payload && isResponse(payload.data)) {
        _control = { success: payload.success, data: payload.data };
        return true;
      }
      break;
    case false:
      if ("message" in payload && typeof payload.message === "string") {
        _control = { success: payload.success, message: payload.message };
        return true;
      }
      break;
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
      if ("role" in response && isRole(response.role)) {
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
      if ("fragments" in response && Array.isArray(response.fragments) && response.fragments.every(isFragment)) {
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
