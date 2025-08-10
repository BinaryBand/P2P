type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

interface PeerData {
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

interface GetNearestPeersResponse {
  peers: Address[];
  type: import("./src/handshake-proto").HandshakeTypes.GetNearestPeersResponse;
}

interface GetDataFragmentResponse {
  fragment: string | null;
  type: import("./src/swarm-proto").SwarmTypes.GetDataFragmentResponse;
}

interface GetMetadataResponse {
  metadata: Base64[];
  type: import("./src/message-proto").MessageTypes.GetMetadataResponse;
}

type ResData = EmptyResponse | GetNearestPeersResponse | GetDataFragmentResponse | GetMetadataResponse;

interface InitiationRequest {
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.InitiationRequest;
}

interface PingRequest {
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.PingRequest;
}

interface GetNearestPeersRequest {
  n: number;
  hash: Base64;
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.GetNearestPeersRequest;
}

interface SetDataFragmentRequest {
  data: string;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.SetDataFragmentRequest;
}

interface GetDataFragmentRequest {
  hash: Base64;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.GetDataFragmentRequest;
}

interface SetMetadataRequest {
  owner: Address;
  metadata: Base64[];
  stamp: Base64;
  type: import("./src/message-proto").MessageTypes.SetMetadataRequest;
}

interface GetMetadataRequest {
  address: Address;
  stamp: Base64;
  type: import("./src/message-proto").MessageTypes.GetMetadataRequest;
}

type ReqData =
  | InitiationRequest
  | PingRequest
  | GetNearestPeersRequest
  | SetDataFragmentRequest
  | GetDataFragmentRequest
  | SetMetadataRequest
  | GetMetadataRequest;

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

interface StorageItem {
  data: string;
  hash: Base64;
  timestamp: number;
}

type ProtocolEvents = Record<string, CustomEvent<Parcel<ReqData>>>;

type AsyncIsh<T, U> = (evt: T) => void | U | Promise<void | U>;

type Message = {
  sender: Address;
  text: string;
  timestamp: number;
};

type MessageFragment = {
  id: Uuid;
  content: Base64;
};
