type Address = import("./src/tools/typing").Address;
type Base64 = import("./src/tools/typing").Base64;
type Uuid = import("./src/tools/typing").Uuid;

interface PeerData {
  peerId: import("@libp2p/interface").PeerId;
  token?: Token;
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

interface Token {
  challenge: Base64;
  peerId: Address;
  signature: Base64;
  signedAt: number;
  validFor: number;
}

interface EmptyResponse {
  type: import("./src/base-proto").BaseTypes.EmptyResponse;
}

interface TokenResponse {
  publicKey: Base64;
  token: Token;
  type: import("./src/handshake-proto").HandshakeTypes.TokenResponse;
}

interface NearestPeersResponse {
  peers: Address[];
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersResponse;
}

interface FetchResponse {
  fragment: string | undefined;
  type: import("./src/swarm-proto").SwarmTypes.FetchResponse;
}

type ResponseData = EmptyResponse | TokenResponse | NearestPeersResponse | FetchResponse;

interface TokenRequest {
  type: import("./src/handshake-proto").HandshakeTypes.TokenRequest;
}

interface NearestPeersRequest {
  n: number;
  hash: Base64;
  token: Token;
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersRequest;
}

interface StoreRequest {
  data: string;
  token: Token;
  type: import("./src/swarm-proto").SwarmTypes.StoreRequest;
}

interface FetchRequest {
  hash: Base64;
  token: Token;
  type: import("./src/swarm-proto").SwarmTypes.FetchRequest;
}

type RequestData = TokenRequest | NearestPeersRequest | StoreRequest | FetchRequest;

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
