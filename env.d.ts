type Callback<T extends Payload = Payload> = (p: Parcel<T>) => void;

type Parcel<T extends Payload = Payload> = PackagedPayload<T> | Rejection;

type PackagedPayload<T extends Payload> = {
  callbackId: string;
  from: string;
  payload: T;
  success: true;
};

type Rejection = {
  callbackId: string;
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
  challenge: string;
  type: import("./src/handshake-proto").HandshakeTypes.ChallengeRequest;
}

interface ChallengeResponse {
  proof: string;
  type: import("./src/handshake-proto").HandshakeTypes.ChallengeResponse;
}

interface NearestPeersRequest {
  n: number;
  query: string;
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersRequest;
}

interface NearestPeersResponse {
  peers: string[];
  type: import("./src/swarm-proto").SwarmTypes.NearestPeersResponse;
}

interface StoreMessagesRequest {
  destination: string;
  messages: string[];
  type: import("./src/swarm-proto").SwarmTypes.StoreMessagesRequest;
}

interface RetrieveMessagesRequest {
  destination: string;
  type: import("./src/swarm-proto").SwarmTypes.RetrieveMessagesRequest;
}

interface RetrieveMessagesResponse {
  messages: string[];
  type: import("./src/swarm-proto").SwarmTypes.RetrieveMessagesResponse;
}

interface PeerDistancePair {
  candidate: string;
  distance: number;
}
