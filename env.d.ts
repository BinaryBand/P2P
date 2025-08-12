type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

type Role = "phone" | "tower";

interface PeerData {
  role: Role;
  peerId: import("@libp2p/interface").PeerId;
  timestamp: number;
}

interface Acceptance<T extends ResData> {
  data: T;
  success: true;
}

interface Rejection {
  message: string;
  success: false;
}

type Return<T extends ResData = ResData> = Acceptance<T> | Rejection;

interface EmptyResponse {
  type: import("./src/base-proto").BaseTypes.EmptyResponse;
}

interface PingResponse {
  role: Role;
  type: import("./src/handshake-proto").HandshakeTypes.PingResponse;
}

interface GetNeighborsResponse {
  peers: Address[];
  type: import("./src/handshake-proto").HandshakeTypes.GetNeighborsResponse;
}

interface GetMetadataResponse {
  metadata: Base64[];
  type: import("./src/swarm-proto").SwarmTypes.GetMetadataResponse;
}

interface GetFragmentsResponse {
  fragments: string[];
  type: import("./src/swarm-proto").SwarmTypes.GetFragmentsResponse;
}

type ResData = EmptyResponse | PingResponse | GetNeighborsResponse | GetMetadataResponse | GetFragmentsResponse;

interface InitiationRequest {
  role: Role;
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.InitiationRequest;
}

interface PingRequest {
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.PingRequest;
}

interface GetNeighborsRequest {
  n: number;
  hash: Base64;
  role: Role;
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.GetNeighborsRequest;
}

interface SetMetadataRequest {
  owner: Address;
  metadata: Base64[];
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.SetMetadataRequest;
}

interface GetMetadataRequest {
  owner: Address;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.GetMetadataRequest;
}

interface SetFragmentsRequest {
  fragments: string[];
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.SetFragmentsRequest;
}

interface GetFragmentsRequest {
  hashes: Base64[];
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.GetFragmentsRequest;
}

type ReqData =
  | InitiationRequest
  | PingRequest
  | GetNeighborsRequest
  | SetMetadataRequest
  | GetMetadataRequest
  | SetFragmentsRequest
  | GetFragmentsRequest;

interface Parcel<T extends ReqData | Return> {
  callbackId: Uuid;
  payload: T;
  receiver: Address;
  sender: Address;
}

type Callback<T extends ResData = ResData> = (res: Return<T>) => void;

interface PeerDistancePair {
  peer: Address;
  distance: number;
}

type ProtocolEvents = Record<string, CustomEvent<Parcel<ReqData>>>;

type AsyncIsh<T, U> = (evt: T) => void | U | Promise<void | U>;

type Message = string;

type MessageFragment = {
  id: Uuid;
  content: string;
};
