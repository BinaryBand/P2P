import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

import { circuitRelayTransport, circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { echo } from "@libp2p/echo";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { WebRTC } from "@multiformats/multiaddr-matcher";
import type { Multiaddr } from "@multiformats/multiaddr";
import { pipe } from "it-pipe";

const protocolOptions = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
};

async function main() {
  console.log("Starting the application...");

  const relay = await createLibp2p({
    ...protocolOptions,
    addresses: { listen: [`/ip4/127.0.0.1/tcp/0/ws`] },
    transports: [webSockets()],
    services: { identify: identify(), relay: circuitRelayServer() },
  });

  const listener = await createLibp2p({
    ...protocolOptions,
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    services: { identify: identify(), echo: echo() },
  });

  await listener.dial(relay.getMultiaddrs(), {
    signal: AbortSignal.timeout(5000),
  });

  const dialer = await createLibp2p({
    ...protocolOptions,
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    services: { identify: identify(), echo: echo() },
  });
  let webRTCMultiaddr: Multiaddr | undefined;
  while (!webRTCMultiaddr) {
    webRTCMultiaddr = listener.getMultiaddrs().find((ma) => WebRTC.matches(ma));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // dial the listener and open an echo protocol stream
  const stream = await dialer.dialProtocol(webRTCMultiaddr, dialer.services.echo.protocol, {
    signal: AbortSignal.timeout(5000),
  });

  // we can now stop the relay
  await relay.stop();
  console.log(`Dialed echo protocol on ${webRTCMultiaddr.toString()}`);

  await pipe([new TextEncoder().encode("hello world")], stream, async (source) => {
    for await (const buf of source) {
      console.info(new TextDecoder().decode(buf.subarray()));
    }
  });
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
