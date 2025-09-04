/**
 * Protocol type definitions for requests, responses and events
 */

import { BaseTypes } from "../protocols/base-proto.js";
import { HandshakeTypes } from "../protocols/handshake-proto.js";
import { SwarmTypes } from "../protocols/swarm-proto.js";
import { Address, Base64, Fragment, Role, Uuid } from "./core.js";

// Generic response types
export interface Acceptance<T extends ResData> {
  data: T;
  success: true;
}

export interface Rejection {
  message: string;
  success: false;
}

export type Return<T extends ResData = ResData> = Acceptance<T> | Rejection;
export type Callback<T extends ResData = ResData> = (res: Return<T>) => void;

// Request interfaces
export interface InitiationRequest {
  role: Role;
  type: typeof HandshakeTypes.InitiationRequest;
}

export interface PingRequest {
  type: typeof HandshakeTypes.PingRequest;
}

export interface GetNeighborsRequest {
  n: number;
  hash: Base64;
  role: Role;
  type: typeof HandshakeTypes.GetNeighborsRequest;
}

export interface SetMetadataRequest {
  hashKey: Base64;
  metadata: Base64[];
  type: typeof SwarmTypes.SetMetadataRequest;
}

export interface GetMetadataRequest {
  hashKey: Base64;
  type: typeof SwarmTypes.GetMetadataRequest;
}

export interface SetFragmentsRequest {
  fragments: Fragment[];
  type: typeof SwarmTypes.SetFragmentsRequest;
}

export interface GetFragmentsRequest {
  hashes: Base64[];
  type: typeof SwarmTypes.GetFragmentsRequest;
}

// Response interfaces
export interface EmptyResponse {
  type: typeof BaseTypes.EmptyResponse;
}

export interface InitiationResponse {
  passphrase: string;
  role: Role;
  type: typeof HandshakeTypes.InitiationResponse;
}

export interface PingResponse {
  type: typeof HandshakeTypes.PingResponse;
}

export interface GetNeighborsResponse {
  peers: Address[];
  type: typeof HandshakeTypes.GetNeighborsResponse;
}

export interface GetMetadataResponse {
  metadata: Base64[];
  type: typeof SwarmTypes.GetMetadataResponse;
}

export interface GetFragmentsResponse {
  fragments: Fragment[];
  type: typeof SwarmTypes.GetFragmentsResponse;
}

// Union types
export type ReqData =
  | InitiationRequest
  | PingRequest
  | GetNeighborsRequest
  | SetMetadataRequest
  | GetMetadataRequest
  | SetFragmentsRequest
  | GetFragmentsRequest;

export type ResData =
  | EmptyResponse
  | InitiationResponse
  | PingResponse
  | GetNeighborsResponse
  | GetMetadataResponse
  | GetFragmentsResponse;

export type Payload = ReqData | Return;

// Batch and parcel types
export interface BatchItem<T extends Payload> {
  callbackId: Uuid;
  payload: T;
}

export interface Parcel<T extends Payload> {
  batch: BatchItem<T>;
  receiver: Address;
  sender: Address;
}

// Event types
export type ProtocolEvents = Record<string, CustomEvent<Parcel<ReqData>>>;
export type AsyncIsh<T, U> = (evt: T) => void | U | Promise<void | U>;
