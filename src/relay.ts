// import { createLibp2p, Libp2p } from "libp2p";

// import { bootstrap } from "@libp2p/bootstrap";

// import { noise } from "@chainsafe/libp2p-noise";
// import { yamux } from "@chainsafe/libp2p-yamux";

// import { identify } from "@libp2p/identify";
// import { ping } from "@libp2p/ping";

// import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
// import { webRTC } from "@libp2p/webrtc";
// import { webSockets } from "@libp2p/websockets";

// import { multiaddr, Multiaddr } from "@multiformats/multiaddr";
// import { WebRTC, WebSockets } from "@multiformats/multiaddr-matcher";

// import { kadDHT } from "@libp2p/kad-dht";
// import { gossipsub } from "@chainsafe/libp2p-gossipsub";
// import { PeerId } from "@libp2p/interface";

// // Known peers addresses
// const bootstrapMultiaddrs = [
//   "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
//   "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
// ];

// const stockOptions = {
//   connectionEncrypters: [noise()],
//   streamMuxers: [yamux()], // allows multiple data streams over one connection
// };

// const discoveryOptions = {
//   ...stockOptions,
//   addresses: { listen: ["/p2p-circuit", "/webrtc"] },
//   connectionGater: { denyDialMultiaddr: () => false },
//   peerDiscovery: [bootstrap({ list: bootstrapMultiaddrs })],
//   services: {
//     dht: kadDHT(), // data structure to store and retrieve data; find peers efficiently
//     identify: identify(),
//     ping: ping(),
//     relay: circuitRelayServer(),
//   },
//   transports: [
//     circuitRelayTransport(), // relay connections through other peers
//     webRTC(), // used for direct peer-to-peer connections
//     webSockets(), // real-time communication between a client and server
//   ],
// };

// const clientOptions = {
//   ...stockOptions,
//   addresses: { listen: ["/p2p-circuit", "/webrtc"] },
//   connectionGater: { denyDialMultiaddr: () => false },
//   services: {
//     identify: identify(),
//     pubsub: gossipsub(), // decentralized messaging
//   },
//   transports: [
//     circuitRelayTransport(), // relay connections through other peers
//     webRTC(), // used for direct peer-to-peer connections
//     webSockets(), // real-time communication between a client and server
//   ],
// };

// async function main() {
//   console.log("Starting application...");

//   /**
//    * Phase 1: Connect two relay nodes without using localhost addresses
//    */
//   const relay1 = await createLibp2p({ ...discoveryOptions });
//   const relay2 = await createLibp2p({ ...discoveryOptions });

//   console.log("Relay1", relay1.peerId.toString());
//   console.log("Relay2", relay2.peerId.toString());

//   // Clients make relay reservations
//   let relayMultiaddr1: Multiaddr | undefined;
//   let relayMultiaddr2: Multiaddr | undefined;
//   while (!relayMultiaddr1 || !relayMultiaddr2) {
//     relayMultiaddr1 ??= relay1.getMultiaddrs().find((ma) => WebRTC.matches(ma));
//     relayMultiaddr2 ??= relay2.getMultiaddrs().find((ma) => WebRTC.matches(ma));
//     await new Promise((resolve) => setTimeout(resolve, 1000));
//   }

//   await relay1.dial(relayMultiaddr2, { signal: AbortSignal.timeout(15000) });
//   await relay2.dial(relayMultiaddr1, { signal: AbortSignal.timeout(15000) });
//   console.log("Both relay nodes connected.");

//   /**
//    * Phase 2: Connect two client nodes
//    */
//   const client1 = await createLibp2p({ ...clientOptions });
//   const client2 = await createLibp2p({ ...clientOptions });
//   console.log("Relay and client nodes created.");

//   // Clients connected to the relays
//   await client1.dial(relay1.getMultiaddrs(), { signal: AbortSignal.timeout(15000) });
//   await client2.dial(relay2.getMultiaddrs(), { signal: AbortSignal.timeout(15000) });
//   console.log("Both nodes connected to the relays.");

//   // Clients make relay reservations
//   let clientMultiaddr1: Multiaddr | undefined;
//   let clientMultiaddr2: Multiaddr | undefined;
//   while (!clientMultiaddr1 || !clientMultiaddr2) {
//     clientMultiaddr1 ??= client1.getMultiaddrs().find((ma) => WebRTC.matches(ma));
//     clientMultiaddr2 ??= client2.getMultiaddrs().find((ma) => WebRTC.matches(ma));
//     await new Promise((resolve) => setTimeout(resolve, 1000));
//   }

//   // Dial each other's WebRTC multiaddrs through the relays
//   await client2.dial(clientMultiaddr1, { signal: AbortSignal.timeout(15000) });
//   await client1.dial(clientMultiaddr2, { signal: AbortSignal.timeout(15000) });
//   console.log("Both nodes connected through the relays.");

//   // Stop the relay nodes
//   await relay1.stop();
//   await relay2.stop();
//   console.log("We have both WebRTC multiaddrs, so we can stop the relay.");

//   await new Promise((resolve) => setTimeout(resolve, 1000));

//   console.log(client1.peerId, "Client1 peers:", client1.getPeers());
//   console.log(client2.peerId, "Client2 peers:", client2.getPeers());

//   /**
//    * Phase 3: Send messages between nodes
//    */

//   // Create a shared communication channel
//   const key: string = crypto.randomUUID();
//   client1.services.pubsub.subscribe(key);
//   client2.services.pubsub.subscribe(key);

//   // Wait for the nodes to be connected and subscribed to the topic
//   let subscribers: PeerId[] = [];
//   while (subscribers.length === 0) {
//     subscribers = client1.services.pubsub.getSubscribers(key);
//     await new Promise((resolve) => setTimeout(resolve, 1000));
//   }
//   console.log(`Client1 has ${subscribers.length} subscribers for topic ${key}`);

//   await new Promise(async (resolve) => {
//     // Client1 listens for messages on the topic
//     client1.services.pubsub.addEventListener("message", (message) => {
//       console.log(`${message.detail.topic}:`, new TextDecoder().decode(message.detail.data));
//       resolve(true);
//     });

//     // Client2 publishes a message to the topic
//     await client2.services.pubsub.publish(key, new TextEncoder().encode("banana"));
//   });

//   /**
//    * Phase 4: Cleanup
//    */
//   await client1.stop();
//   await client2.stop();
//   console.log("All clients stopped.");
//   process.exit(0);
// }

// main().catch((error) => {
//   console.error("An error occurred:", error);
//   process.exit(1);
// });

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

import { kadDHT } from "@libp2p/kad-dht";
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
  },
  transports: [circuitRelayTransport(), webSockets()],
};

const clientOptions = {
  ...stockOptions,
  transports: [webRTCDirect()],
};

async function main() {
  console.log("Starting application...");

  /**
   * Phase 1: Connect two relay nodes without using localhost addresses
   */
  const relay1 = await createLibp2p({ ...discoveryOptions, addresses: { listen: ["/p2p-circuit"] } });
  const relay2 = await createLibp2p({ ...discoveryOptions, addresses: { listen: ["/p2p-circuit"] } });
  console.log("Relay1", relay1.peerId.toString());
  console.log("Relay2", relay2.peerId.toString());

  // Allow relay nodes to connect to each other
  let relayP2pAddress1: Multiaddr | undefined;
  let relayP2pAddress2: Multiaddr | undefined;
  while (!relayP2pAddress1 || !relayP2pAddress2) {
    relayP2pAddress1 ??= relay1.getMultiaddrs().find((ma) => P2P.matches(ma));
    relayP2pAddress2 ??= relay2.getMultiaddrs().find((ma) => P2P.matches(ma));
    await new Promise((res) => setTimeout(res, 1000));
  }
  await relay1.dial(relayP2pAddress2, { signal: AbortSignal.timeout(15000) });
  await relay2.dial(relayP2pAddress1, { signal: AbortSignal.timeout(15000) });
  console.log("Both relay nodes connected.");

  // Stop the relay nodes
  await relay1.stop();
  await relay2.stop();
  console.log("We have both WebRTC multiaddrs, so we can stop the relay.");

  /**
   * Phase 2: Connect two client nodes
   */
  const client1 = await createLibp2p({ ...clientOptions, addresses: { listen: ["/ip4/0.0.0.0/udp/1/webrtc-direct"] } });
  const client2 = await createLibp2p({ ...clientOptions, addresses: { listen: ["/ip4/0.0.0.0/udp/2/webrtc-direct"] } });
  console.log("Client1", client1.peerId.toString());
  console.log("Client2", client2.peerId.toString());

  // Allow client nodes to connect to each other
  let clientP2pAddress1: Multiaddr | undefined;
  let clientP2pAddress2: Multiaddr | undefined;
  while (!clientP2pAddress1 || !clientP2pAddress2) {
    clientP2pAddress1 ??= client1.getMultiaddrs().find((ma) => WebRTCDirect.matches(ma));
    clientP2pAddress2 ??= client2.getMultiaddrs().find((ma) => WebRTCDirect.matches(ma));
    await new Promise((res) => setTimeout(res, 1000));
  }
  await client1.dial(clientP2pAddress2, { signal: AbortSignal.timeout(15000) });
  await client2.dial(clientP2pAddress1, { signal: AbortSignal.timeout(15000) });
  console.log("Both client nodes connected.");

  console.log(client1.peerId, "->", client1.getPeers());
  console.log(client2.peerId, "->", client2.getPeers());

  await client1.stop();
  await client2.stop();
  console.log("All clients stopped.");

  /**
   * Phase 3: Cleanup
   */
  process.exit(0);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
