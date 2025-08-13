type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

interface Acceptance<T extends ResData> {
  data: T;
  success: true;
}

interface Rejection {
  message: string;
  success: false;
}

type Return<T extends ResData = ResData> = Acceptance<T> | Rejection;
type Callback<T extends ResData = ResData> = (res: Return<T>) => void;

type ProtocolEvents = Record<string, CustomEvent<Parcel<ReqData>>>;

type AsyncIsh<T, U> = (evt: T) => void | U | Promise<void | U>;

/* Peer */

type Role = "phone" | "tower";

interface PeerData {
  role: Role;
  peerId: import("@libp2p/interface").PeerId;
  timestamp: number;
}

interface PeerDistancePair {
  peer: Address;
  distance: number;
}

/* Requests */

interface InitiationRequest {
  role: Role;
  stamp: Base64;
  type: import("./src/protocols/handshake-proto").HandshakeTypes.InitiationRequest;
}

interface PingRequest {
  stamp: Base64;
  type: import("./src/protocols/handshake-proto").HandshakeTypes.PingRequest;
}

interface GetNeighborsRequest {
  n: number;
  hash: Base64;
  role: Role;
  stamp: Base64;
  type: import("./src/protocols/handshake-proto").HandshakeTypes.GetNeighborsRequest;
}

interface SetMetadataRequest {
  hashKey: Base64;
  metadata: Base64[];
  stamp: Base64;
  type: import("./src/protocols/swarm-proto").SwarmTypes.SetMetadataRequest;
}

interface GetMetadataRequest {
  hashKey: Base64;
  stamp: Base64;
  type: import("./src/protocols/swarm-proto").SwarmTypes.GetMetadataRequest;
}

interface SetFragmentsRequest {
  fragments: string[];
  stamp: Base64;
  type: import("./src/protocols/swarm-proto").SwarmTypes.SetFragmentsRequest;
}

interface GetFragmentsRequest {
  hashes: Base64[];
  stamp: Base64;
  type: import("./src/protocols/swarm-proto").SwarmTypes.GetFragmentsRequest;
}

/* Responses */

interface EmptyResponse {
  type: import("./src/protocols/base-proto").BaseTypes.EmptyResponse;
}

interface PingResponse {
  role: Role;
  type: import("./src/protocols/handshake-proto").HandshakeTypes.PingResponse;
}

interface GetNeighborsResponse {
  peers: Address[];
  type: import("./src/protocols/handshake-proto").HandshakeTypes.GetNeighborsResponse;
}

interface GetMetadataResponse {
  metadata: Base64[];
  type: import("./src/protocols/swarm-proto").SwarmTypes.GetMetadataResponse;
}

interface GetFragmentsResponse {
  fragments: string[];
  type: import("./src/protocols/swarm-proto").SwarmTypes.GetFragmentsResponse;
}

type ReqData =
  | InitiationRequest
  | PingRequest
  | GetNeighborsRequest
  | SetMetadataRequest
  | GetMetadataRequest
  | SetFragmentsRequest
  | GetFragmentsRequest;

type ResData = EmptyResponse | PingResponse | GetNeighborsResponse | GetMetadataResponse | GetFragmentsResponse;

type Payload = ReqData | Return;

type BatchItem<T extends Payload> = {
  callbackId: Uuid;
  payload: T;
};

interface Parcel<T extends Payload> {
  batch: BatchItem<T>;
  receiver: Address;
  sender: Address;
}

type Message = string;

type MessageFragment = {
  id: Uuid;
  content: Base64;
};
