import { createLibp2p } from "libp2p";

import { noise } from "@chainsafe/libp2p-noise";
import { webSockets } from "@libp2p/websockets";
import { yamux } from "@chainsafe/libp2p-yamux";

import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { gossipsub, GossipsubEvents } from "@chainsafe/libp2p-gossipsub";

import { PubSub } from "@libp2p/interface";
import type { Libp2p } from "libp2p";
import type { Identify } from "@libp2p/identify";

type GossipNode = Libp2p<{ pubsub: PubSub<GossipsubEvents>; identify: Identify }>;

const stockOptions = {
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

async function isConnected(node: GossipNode, key: string): Promise<boolean> {
  while (node.services.pubsub.getSubscribers(key).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return true;
}

async function main() {
  console.log("Starting application...");

  const node1: GossipNode = await createLibp2p({
    ...stockOptions,
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    services: { pubsub: gossipsub(), identify: identify() },
  });

  const listenAddresses = node1.getMultiaddrs().map((ma) => ma.toString());
  console.log(`${node1.peerId} is listening on the following addresses: `, listenAddresses);

  const node2: GossipNode = await createLibp2p({
    ...stockOptions,
    peerDiscovery: [bootstrap({ list: listenAddresses })],
    services: { pubsub: gossipsub(), identify: identify() },
  });

  node1.services.pubsub.addEventListener("message", (message) => {
    console.log(`${message.detail.topic}:`, new TextDecoder().decode(message.detail.data));
  });

  node2.services.pubsub.addEventListener("message", (message) => {
    console.log(`${message.detail.topic}:`, new TextDecoder().decode(message.detail.data));
  });

  const key: string = "zOrQMb6AumqKXtvSQCUVndBUs4onJ9v3hVjdJX2CIiz65NpesF";
  node1.services.pubsub.subscribe(key);
  node2.services.pubsub.subscribe(key);

  await Promise.all([isConnected(node1, key), isConnected(node2, key)]);
  console.log("Both nodes are connected and subscribed to the topic:", key);
  console.log(node1.services.pubsub.getSubscribers(key));
  console.log(node2.services.pubsub.getSubscribers(key));

  node1.services.pubsub.publish(key, new TextEncoder().encode("banana"));
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
