import { createLibp2p, Libp2p } from "libp2p";

import { bootstrap } from "@libp2p/bootstrap";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

import { peerIdFromPrivateKey, peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import { keys } from "@libp2p/crypto";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { Ed25519PeerId, Ed25519PrivateKey, PeerId } from "@libp2p/interface";
import { convertPeerId } from "@libp2p/kad-dht/dist/src/utils";

// Known peers addresses
const bootstrapMultiaddrs = [
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
];

const stockOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()], // allows multiple data streams over one connection
};

const discoveryOptions = {
  ...stockOptions,
  addresses: { listen: ["/p2p-circuit", "/webrtc"] },
  peerDiscovery: [bootstrap({ list: bootstrapMultiaddrs })],
  services: {
    dht: kadDHT(), // data structure to store and retrieve data; find peers efficiently
    identify: identify(),
    ping: ping(),
    pubsub: gossipsub(),
  },
  transports: [circuitRelayTransport(), webRTC(), webSockets()],
};

async function main() {
  console.log("Starting application...");

  // const seed: Uint8Array = new Uint8Array(32);
  // seed.set(Buffer.from("AppleMango"));
  // const privateKey: Ed25519PrivateKey = await keys.generateKeyPairFromSeed("Ed25519", seed);

  const targetId: string = "12D3KooWA9YG5RBdzzDM3aif3JHGd3uyLKoqAELEpcuNgUBWsKEX";
  const targetPeerId: PeerId = peerIdFromString(targetId);

  const client = await createLibp2p({ ...discoveryOptions });
  console.log("Client ID:", client.peerId.toString());

  let multiAddresses: Multiaddr[] | undefined;
  while (!multiAddresses || multiAddresses.length === 0) {
    try {
      const queryResults = client.services.dht.findPeer(targetPeerId, { signal: AbortSignal.timeout(15000) });
      for await (const event of queryResults) {
        if (event.type === 2) {
          multiAddresses = event.peer.multiaddrs;
          break;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // const key: string = "waffle-iron-test";
  // client1.services.pubsub.subscribe(key);
  // // client2.services.pubsub.subscribe(key);

  // client1.services.pubsub.addEventListener("message", (message) => {
  //   console.log(`${message.detail.topic}:`, new TextDecoder().decode(message.detail.data));
  // });

  // let [x, y] = [false, false];
  // while (!x || !y) {
  //   x ||= client1.services.pubsub.getSubscribers(key).length > 0;
  //   y ||= client2.services.pubsub.getSubscribers(key).length > 0;
  //   await new Promise((resolve) => setTimeout(resolve, 1000));
  // }

  // Stop the client nodes
  await client.stop();
  // await client2.stop();
  // console.log("Stop both nodes.");

  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
