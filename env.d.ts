type Base58 = import("./src/tools/utils").Base58;
type Encoded = import("./src/tools/utils").Encoded;
type Uuid = import("./src/tools/utils").Uuid;

interface PeerData {
  peerId: import("@libp2p/interface").PeerId;
  token?: Token;
}

interface _BaseReturn {
  type: import("./src/base-proto").BaseTypes;
}

interface Acceptance<T extends ResponseData> extends _BaseReturn {
  data: T;
  success: true;
}

interface Rejection extends _BaseReturn {
  message: string;
  success: false;
}

type Return<T extends ResponseData = ResponseData> = Acceptance<T> | Rejection;

interface Token {
  challenge: Encoded;
  peerId: Base58;
  signature: Encoded;
  signedAt: number;
  validFor: number;
}

interface EmptyResponse {
  type: import("./src/base-proto").BaseTypes.EmptyResponse;
}

interface TokenResponse {
  publicKey: Encoded;
  token: Token;
  type: import("./src/handshake-proto").HandshakeTypes.TokenResponse;
}

interface NearestPeersResponse {
  peers: Base58[];
  type: import("./src/message").MessageTypes.NearestPeersResponse;
}

type ResponseData = TokenResponse | EmptyResponse | NearestPeersResponse;

interface TokenRequest {
  type: import("./src/handshake-proto").HandshakeTypes.TokenRequest;
}

interface _TokenRequired {
  token: Token;
}

interface NearestPeersRequest extends _TokenRequired {
  n: number;
  query: Base58 | Encoded;
  type: import("./src/message").MessageTypes.NearestPeersRequest;
}

type RequestData = TokenRequest | NearestPeersRequest;

interface Parcel<T extends RequestData | Return> {
  callbackId: Uuid;
  payload: T;
  sender: Base58;
}

type Callback<T extends ResponseData = ResponseData> = (res: Return<T>) => void;

interface PeerDistancePair {
  peer: Base58;
  distance: number;
}

type ProtocolEvents = Record<string, CustomEvent<Parcel<RequestData>>>;
