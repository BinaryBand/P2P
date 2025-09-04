/**
 * Message-related type definitions
 */

import { Base64, Fragment, Uuid } from "./core.js";

export type Message = string;

export interface MessageFragment {
  id: Uuid;
  content: Base64;
}

export interface Metadata {
  id: number;
  hashKey: Base64;
  hash: Base64;
  timestamp: number;
}

export interface DataFragment {
  hashKey: Base64;
  data: Fragment;
  timestamp: number;
}
