import { createLibp2p, Libp2p } from "libp2p";

import { bootstrap } from "@libp2p/bootstrap";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";

import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";

import { multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebSockets, P2P, WebRTCDirect } from "@multiformats/multiaddr-matcher";

import { DialPeerEvent, kadDHT, QueryEvent } from "@libp2p/kad-dht";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { PeerId } from "@libp2p/interface";

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

  const client1 = await createLibp2p({ ...discoveryOptions, addresses: { listen: ["/p2p-circuit", "/webrtc"] } });
  const client2 = await createLibp2p({ ...discoveryOptions, addresses: { listen: ["/p2p-circuit", "/webrtc"] } });
  console.log("Client1", client1.peerId.toString());
  console.log("Client2", client2.peerId.toString());

  // Allow client nodes to connect to each other
  let relayP2pAddress1: Multiaddr | undefined;
  let relayP2pAddress2: Multiaddr | undefined;
  while (!relayP2pAddress1 || !relayP2pAddress2) {
    relayP2pAddress1 ??= client1.getMultiaddrs().find((ma) => WebRTC.matches(ma));
    relayP2pAddress2 ??= client2.getMultiaddrs().find((ma) => WebRTC.matches(ma));
    await new Promise((res) => setTimeout(res, 1000));
  }
  await client1.dial(relayP2pAddress2, { signal: AbortSignal.timeout(15000) });
  await client2.dial(relayP2pAddress1, { signal: AbortSignal.timeout(15000) });
  console.log("Both client nodes connected.");

  const testAddress: string = "12D3KooWEMdqy8sUoS1ReDRQ2obyE8tNcguGsft41JBK1ors6xdZ";
  const queryResults: AsyncIterable<QueryEvent> = client1.services.dht.findPeer(client2.peerId, {
    signal: AbortSignal.timeout(15000),
  });

  let foundPeerAddresses: Multiaddr[] = undefined!;
  for await (const event of queryResults) {
    if (event.name === "FINAL_PEER") {
      foundPeerAddresses = event.peer.multiaddrs;
      break;
    }
  }

  const key: string = crypto.randomUUID();
  client1.services.pubsub.subscribe(key);
  client2.services.pubsub.subscribe(key);

  let [x, y] = [false, false];
  while (!x || !y) {
    x ||= client1.services.pubsub.getSubscribers(key).length > 0;
    y ||= client2.services.pubsub.getSubscribers(key).length > 0;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await new Promise(async (resolve) => {
    // Client1 listens for messages on the topic
    client1.services.pubsub.addEventListener("message", (message) => {
      console.log(`${message.detail.topic}:`, new TextDecoder().decode(message.detail.data));
      resolve(true);
    });

    // Client2 publishes a message to the topic
    await client2.services.pubsub.publish(key, new TextEncoder().encode("banana"));
  });

  // Stop the client nodes
  await client1.stop();
  await client2.stop();
  console.log("Stop both nodes.");

  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
