type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

interface PeerData {
  peerId: import("@libp2p/interface").PeerId;
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

interface NearestPeersResponse {
  peers: Address[];
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersResponse;
}

interface FetchResponse {
  fragment: string | null;
  type: import("./src/swarm-proto").SwarmTypes.FetchResponse;
}

type ResData = EmptyResponse | NearestPeersResponse | FetchResponse;

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

type ReqData = InitiationRequest | NearestPeersRequest | StoreRequest | FetchRequest;

interface Parcel<T extends ReqData | Return> {
  callbackId: Uuid;
  payload: T;
  sender: Address;
}

type Callback<T extends ResData = ResData> = (res: Return<T>) => void;

interface PeerDistancePair {
  peer: Address;
  distance: number;
}

type ProtocolEvents = Record<string, CustomEvent<Parcel<ReqData>>>;

type AsyncIsh<T, U> = (evt: T) => void | U | Promise<void | U>;
