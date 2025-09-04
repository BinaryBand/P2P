/**
 * LibP2P-related type definitions
 */

import { PeerId, PrivateKey } from "@libp2p/interface";
import { ClientNode } from "../tools/client.js";

// Re-export commonly used LibP2P types
export type { PeerId, PrivateKey };

// Project-specific LibP2P types
export type { ClientNode };
