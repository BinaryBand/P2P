import { createLibp2p } from "libp2p";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { bootstrap } from "@libp2p/bootstrap";
// import { mdns } from "@libp2p/mdns";
import { tcp } from "@libp2p/tcp";

// Service imports
import MessageProto, { MessageEvents } from "../protocols/message-proto.js";
// import SwarmProto, { SwarmEvents } from "../protocols/swarm-proto.js";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";

import { keys } from "@libp2p/crypto";

// Chainsafe
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { genericHash } from "./cryptography.js";
import { toBuffer } from "./typing.js";

const bootstrapNodes = [
  "/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

const stockOptions = {
  connectionEncrypters: [noise()],
  peerDiscovery: [
    // mdns(),
    bootstrap({ list: bootstrapNodes }),
  ],
  streamMuxers: [yamux()],
  transports: [
    circuitRelayTransport(),
    webRTC(),
    webRTCDirect(),
    webSockets(),
    tcp(), // TCP transport
  ],
};

function getClientOptions(addresses: string[], privateKey?: PrivateKey) {
  return {
    ...stockOptions,
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    privateKey,
    services: { dht: kadDHT(), identify: identify(), ping: ping(), relay: circuitRelayServer() },
  };
}

export function getNewClient(addresses: string[], privateKey?: PrivateKey, passphrase?: string): Promise<ClientNode> {
  const options = getClientOptions(addresses, privateKey);
  return createLibp2p({ ...options, services: { ...options.services, proto: MessageProto.init(passphrase) } });
}

export async function getPrivateKeyFromSeed(password: string): Promise<PrivateKey> {
  const passwordBuffer: Uint8Array = toBuffer(password);
  const seed: Uint8Array = genericHash(passwordBuffer);
  return keys.generateKeyPairFromSeed("Ed25519", seed);
}

export type ClientNode = import("@libp2p/interface").Libp2p<{
  proto: MessageProto<MessageEvents>;
}>;
