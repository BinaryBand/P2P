import { peerIdFromString } from "@libp2p/peer-id";
import { PeerId } from "@libp2p/interface";
import _ from "lodash";

import { BaseTypes } from "../protocols/base-proto.js";
import { HandshakeTypes } from "../protocols/handshake-proto.js";
import { SwarmTypes } from "../protocols/swarm-proto.js";
// import { MessageTypes } from "../message-proto.js";

export enum Role {
  Phone = "phone",
  Tower = "tower",
  Gateway = "gateway",
}

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;
export type Fragment = `${Formats.Utf8},${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
  Utf8 = "utf8",
}

export const stringify = TextDecoder.prototype.decode.bind(new TextDecoder());
export const toBuffer = TextEncoder.prototype.encode.bind(new TextEncoder());

// Regular expressions for validation
const ADDRESS_REGEX: RegExp = new RegExp(`^${Formats.Base58},([1-9A-HJ-NP-Za-km-z]+)$`);
const BASE64_REGEX: RegExp = new RegExp(`^${Formats.Base64},([a-zA-Z0-9+/]+={0,2})$`);
const FRAGMENT_REGEX: RegExp = new RegExp(`^${Formats.Utf8},(.*)$`);
const UUID_REGEX: RegExp = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

// Primitive type guards
export const isAddress = (pId: unknown): pId is Address => typeof pId === "string" && ADDRESS_REGEX.test(pId);
export const isBase64 = (b64: unknown): b64 is Base64 => typeof b64 === "string" && BASE64_REGEX.test(b64);
export const isFragment = (frag: unknown): frag is Fragment => typeof frag === "string" && FRAGMENT_REGEX.test(frag);
export const isUuid = (uuid: unknown): uuid is Uuid => typeof uuid === "string" && UUID_REGEX.test(uuid);

// Encoding and decoding functions
export const encodePeerId = (pId: PeerId): Address => `${Formats.Base58},${pId}`;
export const decodeAddress = (addr: Address): PeerId => peerIdFromString(ADDRESS_REGEX.exec(addr)![1]);

export const base64ToBytes = (b64: Base64): Uint8Array =>
  Uint8Array.from(Buffer.from(BASE64_REGEX.exec(b64)![1], Formats.Base64));
export const bytesToBase64 = (b: Uint8Array): Base64 => `${Formats.Base64},${Buffer.from(b).toString(Formats.Base64)}`;

export const encodeFragment = (msg: MessageFragment): Fragment => `${Formats.Utf8},${JSON.stringify(msg)}`;
export const decodeFragment = (frag: Fragment): MessageFragment => JSON.parse(FRAGMENT_REGEX.exec(frag)![1]);

function isObject<K extends string>(object: unknown, withKeys?: K[]): object is Record<K, unknown> {
  if (!_.isObject(object)) {
    return false;
  }
  return withKeys?.every((key) => key in object) ?? true;
}

function isArray<T>(array: unknown, typeGuard?: (item: unknown) => item is T): array is T[] {
  if (!Array.isArray(array)) {
    return false;
  }
  return typeGuard ? array.every(typeGuard) : true;
}

export function isMessageFragment(fragment: unknown): fragment is MessageFragment {
  if (isObject(fragment, ["id", "content"]) && isUuid(fragment.id) && isBase64(fragment.content)) {
    const control: MessageFragment = { id: fragment.id, content: fragment.content };
    return _.isEqual(control, fragment);
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
  if (
    isObject(parcel, ["batch", "receiver", "sender"]) &&
    isBatchItem(parcel.batch) &&
    isAddress(parcel.receiver) &&
    isAddress(parcel.sender)
  ) {
    const control: Parcel<Payload> = { batch: parcel.batch, receiver: parcel.receiver, sender: parcel.sender };
    return _.isEqual(control, parcel);
  }
  return false;
}

export function isBatchItem(batchItem: unknown): batchItem is BatchItem<Payload> {
  if (
    isObject(batchItem, ["callbackId", "payload"]) &&
    isUuid(batchItem.callbackId) &&
    (isRequest(batchItem.payload) || isReturn(batchItem.payload))
  ) {
    const control: BatchItem<Payload> = { callbackId: batchItem.callbackId, payload: batchItem.payload };
    return _.isEqual(control, batchItem);
  }
  return false;
}

export function isRequest(request: unknown): request is ReqData {
  if (!isObject(request, ["type"])) {
    return false;
  }

  switch (request.type) {
    case HandshakeTypes.InitiationRequest:
      if (isObject(request, ["role"]) && isRole(request.role)) {
        const control: InitiationRequest = { role: request.role, type: request.type };
        return _.isEqual(control, request);
      }
      break;
    case HandshakeTypes.PingRequest:
      const control: PingRequest = { type: request.type };
      return _.isEqual(control, request);
    case HandshakeTypes.GetNeighborsRequest:
      if (
        isObject(request, ["n", "role", "hash", "type"]) &&
        typeof request.n === "number" &&
        isRole(request.role) &&
        isBase64(request.hash)
      ) {
        const control: GetNeighborsRequest = {
          n: request.n,
          role: request.role,
          hash: request.hash,
          type: request.type,
        };
        return _.isEqual(control, request);
      }
      break;
    case SwarmTypes.SetFragmentsRequest:
      if (isObject(request, ["fragments"]) && isArray(request.fragments, isFragment)) {
        const control: SetFragmentsRequest = { fragments: request.fragments, type: request.type };
        return _.isEqual(control, request);
      }
      break;
    case SwarmTypes.GetFragmentsRequest:
      if (isObject(request, ["hashes"]) && isArray(request.hashes, isBase64)) {
        const control: GetFragmentsRequest = { hashes: request.hashes, type: request.type };
        return _.isEqual(control, request);
      }
      break;
    case SwarmTypes.SetMetadataRequest:
      if (
        isObject(request, ["hashKey", "metadata", "type"]) &&
        isBase64(request.hashKey) &&
        isArray(request.metadata, isBase64)
      ) {
        const control: SetMetadataRequest = {
          hashKey: request.hashKey,
          metadata: request.metadata,
          type: request.type,
        };
        return _.isEqual(control, request);
      }
      break;
    case SwarmTypes.GetMetadataRequest:
      if (isObject(request, ["hashKey"]) && isBase64(request.hashKey)) {
        const control: GetMetadataRequest = { hashKey: request.hashKey, type: request.type };
        return _.isEqual(control, request);
      }
      break;
  }

  return false;
}

export function isReturn(payload: unknown): payload is Return {
  if (!isObject(payload, ["success"])) {
    return false;
  }

  switch (payload.success) {
    case true:
      if (isObject(payload, ["data"]) && isResponse(payload.data)) {
        const control: Acceptance<ResData> = { success: payload.success, data: payload.data };
        return _.isEqual(control, payload);
      }
      break;
    case false:
      if (isObject(payload, ["message"]) && typeof payload.message === "string") {
        const control: Rejection = { success: payload.success, message: payload.message };
        return _.isEqual(control, payload);
      }
      break;
  }

  return false;
}

function isResponse(response: unknown): response is ResData {
  if (!isObject(response, ["type"])) {
    return false;
  }

  switch (response.type) {
    case BaseTypes.EmptyResponse:
      return _.isEqual({ type: response.type }, response);
    case HandshakeTypes.InitiationResponse:
      if (
        isObject(response, ["passphrase", "role"]) &&
        typeof response.passphrase === "string" &&
        isRole(response.role)
      ) {
        const control: InitiationResponse = {
          passphrase: response.passphrase,
          role: response.role,
          type: response.type,
        };
        return _.isEqual(control, response);
      }
      break;
    case HandshakeTypes.PingResponse:
      const control: PingResponse = { type: response.type };
      return _.isEqual(control, response);

    case HandshakeTypes.GetNeighborsResponse:
      if (isObject(response, ["peers"]) && isArray(response.peers, isAddress)) {
        const control: GetNeighborsResponse = { peers: response.peers, type: response.type };
        return _.isEqual(control, response);
      }
      break;
    case SwarmTypes.GetFragmentsResponse:
      if (isObject(response, ["fragments"]) && isArray(response.fragments, isFragment)) {
        const control: GetFragmentsResponse = { fragments: response.fragments, type: response.type };
        return _.isEqual(control, response);
      }
      break;
    case SwarmTypes.GetMetadataResponse:
      if (isObject(response, ["metadata"]) && isArray(response.metadata, isBase64)) {
        const control: GetMetadataResponse = { metadata: response.metadata, type: response.type };
        return _.isEqual(control, response);
      }
      break;
  }

  return false;
}
