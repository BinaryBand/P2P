type Base58 = import("./src/tools/utils").Base58;
type Encoded = import("./src/tools/utils").Encoded;
type Uuid = import("./src/tools/utils").Uuid;

type Callback<T extends Payload = Payload> = (p: Parcel<T>) => void;
type Parcel<T extends Payload = Payload> = PackagedPayload<T> | Rejection;

type PackagedPayload<T extends Payload> = {
  callbackId: Uuid;
  from: Base58;
  payload: T;
  success: true;
};

type Rejection = {
  callbackId: Uuid;
  message: string;
  success: false;
};

type Payload =
  | EmptyPayload
  | ChallengeRequest
  | ChallengeResponse
  | NearestPeersRequest
  | NearestPeersResponse
  | StoreMessagesRequest
  | RetrieveMessagesRequest
  | RetrieveMessagesResponse;

interface EmptyPayload {
  type: import("./src/base-proto").BaseTypes.EmptyPayload;
}

interface ChallengeRequest {
  challenge: Encoded;
  type: import("./src/handshake-proto").HandshakeTypes.ChallengeRequest;
}

interface ChallengeResponse {
  proof: Encoded;
  type: import("./src/handshake-proto").HandshakeTypes.ChallengeResponse;
}

interface NearestPeersRequest {
  n: number;
  query: string;
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersRequest;
}

interface NearestPeersResponse {
  peers: Base58[];
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersResponse;
}

interface StoreMessagesRequest {
  destination: Base58;
  messages: MessageFragment[];
  type: import("./src/swarm-proto").SwarmTypes.StoreMessagesRequest;
}

interface RetrieveMessagesRequest {
  destination: Base58;
  type: import("./src/swarm-proto").SwarmTypes.RetrieveMessagesRequest;
}

interface RetrieveMessagesResponse {
  messages: MessageFragment[];
  type: import("./src/swarm-proto").SwarmTypes.RetrieveMessagesResponse;
}

interface PeerDistancePair {
  candidate: Base58;
  distance: number;
}

interface Envelope {
  id: Uuid;
  content: string;
  recipient: Base58;
  sender: Base58;
  timestamp: number;
}

interface MessageFragment {
  id: Uuid;
  destination: Base58;
  fragment: Encoded;
}
