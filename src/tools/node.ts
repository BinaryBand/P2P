import { createLibp2p } from "libp2p";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { bootstrap } from "@libp2p/bootstrap";
// import { mdns } from "@libp2p/mdns";
import { tcp } from "@libp2p/tcp";

// Service imports
// import MessageProto, { MessageEvents } from "../protocols/message-proto.js";
// import SwarmProto, { SwarmEvents } from "../protocols/swarm-proto.js";
import HandshakeProto, { HandshakeEvents } from "../protocols/handshake-proto.js";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";

import { keys } from "@libp2p/crypto";

// Chainsafe
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { encodePeerId, isAddress, toBuffer } from "./typing.js";
import { genericHash } from "./cryptography.js";
import { assert } from "./utils.js";

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

function getClientOptions(addresses: string[], privateKey?: PrivateKey, customBootstrapNodes?: string[]) {
  const bootstrapList = customBootstrapNodes && customBootstrapNodes.length > 0 ? customBootstrapNodes : bootstrapNodes;

  return {
    ...stockOptions,
    peerDiscovery: [
      // mdns(),
      bootstrap({ list: bootstrapList }),
    ],
    addresses: { listen: [...addresses, "/p2p-circuit", "/webrtc"] },
    privateKey,
    services: { dht: kadDHT(), identify: identify(), ping: ping(), relay: circuitRelayServer() },
  };
}

export async function bootstrapNode(gateway: GatewayNode, peerId: PeerId): Promise<void> {
  assert(!gateway.peerId.equals(peerId), "Cannot bootstrap to self");
  assert(isAddress(encodePeerId(peerId)), "Invalid peer ID format");

  console.log("Started bootstrapping with peer:", peerId.toString());

  const abortController: AbortController = new AbortController();

  try {
    await gateway.peerRouting.findPeer(peerId, { signal: abortController.signal });
    console.log("Found peer:", peerId.toString());

    await gateway.dial(peerId, { signal: abortController.signal });
    console.log("Connected to peer:", peerId.toString());
  } catch (err: unknown) {
    console.warn("Error during bootstrapping:", err);
    abortController.abort();
  }
}

export function getNewGatewayNode(
  addresses: string[],
  privateKey?: PrivateKey,
  passphrase?: string,
  customBootstrapNodes?: string[]
): Promise<GatewayNode> {
  const options = getClientOptions(addresses, privateKey, customBootstrapNodes);
  return createLibp2p({ ...options, services: { ...options.services, proto: HandshakeProto.init(passphrase) } });
}

export async function getPrivateKeyFromSeed(password: string): Promise<PrivateKey> {
  const passwordBuffer: Uint8Array = toBuffer(password);
  const seed: Uint8Array = genericHash(passwordBuffer);
  return keys.generateKeyPairFromSeed("Ed25519", seed);
}

export type GatewayNode = import("@libp2p/interface").Libp2p<{
  proto: HandshakeProto<HandshakeEvents>;
}>;
