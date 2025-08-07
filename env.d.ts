type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = import("./src/tools/typing").Uuid;

interface PeerData {
  peerId: import("@libp2p/interface").PeerId;
}

interface Acceptance<T extends ResponseData> {
  data: T;
  success: true;
}

interface Rejection {
  message: string;
  success: false;
}

type Return<T extends ResponseData = ResponseData> = Acceptance<T> | Rejection;

interface EmptyResponse {
  type: import("./src/base-proto").BaseTypes.EmptyResponse;
}

interface NearestPeersResponse {
  peers: Address[];
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersResponse;
}

interface FetchResponse {
  fragment: string | null;
  type: import("./src/swarm-proto").SwarmTypes.FetchResponse;
}

type ResponseData = EmptyResponse | NearestPeersResponse | FetchResponse;

interface InitiationRequest {
  stamp: Base64;
  type: import("./src/handshake-proto").HandshakeTypes.InitiationRequest;
}

interface NearestPeersRequest {
  n: number;
  hash: Base64;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersRequest;
}

interface StoreRequest {
  data: string;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.StoreRequest;
}

interface FetchRequest {
  hash: Base64;
  stamp: Base64;
  type: import("./src/swarm-proto").SwarmTypes.FetchRequest;
}

type RequestData = InitiationRequest | NearestPeersRequest | StoreRequest | FetchRequest;

interface Parcel<T extends RequestData | Return> {
  callbackId: Uuid;
  payload: T;
  sender: Address;
}

type Callback<T extends ResponseData = ResponseData> = (res: Return<T>) => void;

interface PeerDistancePair {
  peer: Address;
  distance: number;
}

type ProtocolEvents = Record<string, CustomEvent<Parcel<RequestData>>>;
