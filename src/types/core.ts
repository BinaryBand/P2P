/**
 * Core type definitions for the P2P system
 */

export type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export enum Formats {
  Base58 = "base58",
  Base64 = "base64",
  Utf8 = "utf8",
}

export type Address = `${Formats.Base58},${string}`;
export type Base64 = `${Formats.Base64},${string}`;
export type Fragment = `${Formats.Utf8},${string}`;
export type Encoded = Address | Base64 | Fragment;

export enum Role {
  Phone = "phone",
  Tower = "tower",
  Gateway = "gateway",
}

export interface DistancePair<T> {
  value: T;
  distance: number;
}
