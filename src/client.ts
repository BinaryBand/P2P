import { encodePeerId, isAddress } from "./tools/typing.js";
import { PeerId } from "@libp2p/interface";
import { assert } from "./tools/utils.js";
import { getNewClient, getPrivateKeyFromSeed } from "./tools/node.js";

export async function bootstrapClient(client: ClientNode, peerId: PeerId): Promise<void> {
  assert(!client.peerId.equals(peerId), "Cannot bootstrap to self");
  assert(isAddress(encodePeerId(peerId)), "Invalid peer ID format");

  console.log("Started bootstrapping with peer:", peerId.toString());

  const abortController: AbortController = new AbortController();

  try {
    await client.peerRouting.findPeer(peerId, { signal: abortController.signal });
    console.log("Found peer:", peerId.toString());

    await client.dial(peerId, { signal: abortController.signal });
    console.log("Connected to peer:", peerId.toString());
  } catch (err: unknown) {
    console.warn("Error during bootstrapping:", err);
    abortController.abort();
  }
}

const clients: { [key: string]: ClientNode } = {};

export async function getClient(seedPassword: string = "disco_magic"): Promise<ClientNode> {
  if (clients[seedPassword]) {
    return clients[seedPassword];
  }

  // Generate the private key from the seed password
  const privateKey: PrivateKey = await getPrivateKeyFromSeed(seedPassword);
  const client = await getNewClient(["/ip4/0.0.0.0/udp/0/webrtc-direct", "/ip4/127.0.0.1/tcp/0/ws"], privateKey);
  clients[seedPassword] = client;

  return client;
}
