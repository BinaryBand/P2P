import { createLibp2p } from "libp2p";
import { bootstrap } from "@libp2p/bootstrap";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

// // Known peers addresses
// const bootstrapMultiaddrs = [
//   "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
//   "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
// ];

const protocolOptions = {
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

async function Node(list: string[]) {
  const node = await createLibp2p({
    ...protocolOptions,
    peerDiscovery: [bootstrap({ list })],
  });

  node.addEventListener("peer:discovery", (evt) => {
    console.log(`Node ${node.peerId} discovered ${evt.detail.id}`);
  });

  node.addEventListener("peer:connect", (evt) => {
    console.log(`Node ${node.peerId} connected to ${evt.detail}`);
  });

  return node;
}

async function main() {
  console.log("Starting the application...");

  const relayNode = await createLibp2p({ ...protocolOptions, addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } });

  const listenAddresses = relayNode.getMultiaddrs().map((ma) => ma.toString());
  console.log(`${relayNode.peerId} is listening on the following addresses: `, listenAddresses);

  const _node1 = await Node(listenAddresses);
  const _node2 = await Node(listenAddresses);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
