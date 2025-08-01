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
  | StoreMessageRequest;

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

interface StoreMessageRequest {
  destination: string;
  message: string;
  type: import("./src/swarm-proto").SwarmTypes.StoreMessageRequest;
}
