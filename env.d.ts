type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Fragment = import("./src/tools/typing").Fragment;
type Encoding = Address | Base64 | Fragment;

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

interface PeerInfo {
  peerId: import("@libp2p/interface").PeerId;
  role: Role;
  timestamp: number;
}

interface PeerDistancePair {
  address: Address;
  distance: number;
}

/* Requests */

type Unstamped<T extends ReqData> = Omit<T, "stamp">;

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
  fragments: Fragment[];
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
  fragments: Fragment[];
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

/* Messages */

interface Metadata {
  id: number;
  hashKey: Base64;
  hash: Base64;
  timestamp: number;
}

interface DataFragment {
  hashKey: Base64;
  data: Fragment;
  timestamp: number;
}

type Message = string;

type MessageFragment = {
  id: Uuid;
  content: Base64;
};
