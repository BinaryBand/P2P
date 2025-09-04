/**
 * Peer-related type definitions
 */

import { PeerId } from "@libp2p/interface";
import { Role } from "./core.js";

export interface PeerInfo {
  peerId: PeerId;
  role: Role;
  timestamp: number;
}
