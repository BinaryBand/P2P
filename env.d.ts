/**
 * Global type declarations for TypeScript
 * This file should only contain truly global types that need to be available everywhere
 * without explicit imports. Most types have been moved to the src/types/ directory.
 */

// Re-export core types for global availability (if needed for backward compatibility)
import type {
  Address,
  Base64,
  Fragment,
  Encoded,
  Uuid,
  Role,
  PeerInfo,
  DistancePair,
  Return,
  Callback,
  ProtocolEvents,
  AsyncIsh,
  Parcel,
  BatchItem,
  Payload,
  ReqData,
  ResData,
  Acceptance,
  Rejection,
  Message,
  MessageFragment,
  Metadata,
  DataFragment,
  PeerId,
  PrivateKey,
  ClientNode,
} from "./src/types/index.js";

// Make key types globally available
declare global {
  type Address = import("./src/types/index.js").Address;
  type Base64 = import("./src/types/index.js").Base64;
  type Fragment = import("./src/types/index.js").Fragment;
  type Encoded = import("./src/types/index.js").Encoded;
  type Uuid = import("./src/types/index.js").Uuid;
  type Role = import("./src/types/index.js").Role;
  type PeerInfo = import("./src/types/index.js").PeerInfo;
  type DistancePair<T> = import("./src/types/index.js").DistancePair<T>;
  type Return<T extends ResData = ResData> = import("./src/types/index.js").Return<T>;
  type Callback<T extends ResData = ResData> = import("./src/types/index.js").Callback<T>;
  type ProtocolEvents = import("./src/types/index.js").ProtocolEvents;
  type AsyncIsh<T, U> = import("./src/types/index.js").AsyncIsh<T, U>;
  type Parcel<T extends Payload> = import("./src/types/index.js").Parcel<T>;
  type BatchItem<T extends Payload> = import("./src/types/index.js").BatchItem<T>;
  type Payload = import("./src/types/index.js").Payload;
  type ReqData = import("./src/types/index.js").ReqData;
  type ResData = import("./src/types/index.js").ResData;
  type Acceptance<T extends ResData> = import("./src/types/index.js").Acceptance<T>;
  type Rejection = import("./src/types/index.js").Rejection;
  type Message = import("./src/types/index.js").Message;
  type MessageFragment = import("./src/types/index.js").MessageFragment;
  type Metadata = import("./src/types/index.js").Metadata;
  type DataFragment = import("./src/types/index.js").DataFragment;
  type PeerId = import("./src/types/index.js").PeerId;
  type PrivateKey = import("./src/types/index.js").PrivateKey;
  type ClientNode = import("./src/types/index.js").ClientNode;

  // Request types
  type InitiationRequest = import("./src/types/index.js").InitiationRequest;
  type PingRequest = import("./src/types/index.js").PingRequest;
  type GetNeighborsRequest = import("./src/types/index.js").GetNeighborsRequest;
  type SetMetadataRequest = import("./src/types/index.js").SetMetadataRequest;
  type GetMetadataRequest = import("./src/types/index.js").GetMetadataRequest;
  type SetFragmentsRequest = import("./src/types/index.js").SetFragmentsRequest;
  type GetFragmentsRequest = import("./src/types/index.js").GetFragmentsRequest;

  // Response types
  type EmptyResponse = import("./src/types/index.js").EmptyResponse;
  type InitiationResponse = import("./src/types/index.js").InitiationResponse;
  type PingResponse = import("./src/types/index.js").PingResponse;
  type GetNeighborsResponse = import("./src/types/index.js").GetNeighborsResponse;
  type GetMetadataResponse = import("./src/types/index.js").GetMetadataResponse;
  type GetFragmentsResponse = import("./src/types/index.js").GetFragmentsResponse;
}
