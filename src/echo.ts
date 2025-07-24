import type { ConnectionManager, Registrar } from "@libp2p/interface-internal";
import type { AbortOptions, PeerId, Startable } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";

import { byteStream } from "it-byte-stream";
import { pipe } from "it-pipe";

const PROTOCOL_VERSION = "1.0.0";
const PROTOCOL_NAME = "echo";

interface EchoInit {
  protocolPrefix?: string;
  maxInboundStreams?: number;
  maxOutboundStreams?: number;
  runOnLimitedConnection?: boolean;
}

interface EchoComponents {
  registrar: Registrar;
  connectionManager: ConnectionManager;
}

interface EchoInterface {
  protocol: string;
  echo(peer: PeerId | Multiaddr | Multiaddr[], buf: Uint8Array, options?: AbortOptions): Promise<Uint8Array>;
}

/**
 * A simple echo stream, any data received will be sent back to the sender
 */
class Echo implements Startable, EchoInterface {
  public readonly protocol: string;
  private readonly components: EchoComponents;
  private started: boolean;
  private readonly init: EchoInit;

  constructor(components: EchoComponents, init: EchoInit = {}) {
    this.started = false;
    this.components = components;
    this.protocol = `/${[init.protocolPrefix, PROTOCOL_NAME, PROTOCOL_VERSION].filter(Boolean).join("/")}`;
    this.init = init;
  }

  readonly [Symbol.toStringTag] = "@libp2p/echo";

  async start(): Promise<void> {
    await this.components.registrar.handle(
      this.protocol,
      ({ stream, connection }) => {
        const log = (connection.log as any).newScope("echo");

        void pipe(stream, stream).catch((err: any) => {
          log.error("error piping stream", err);
        });
      },
      {
        maxInboundStreams: this.init.maxInboundStreams,
        maxOutboundStreams: this.init.maxOutboundStreams,
        runOnLimitedConnection: this.init.runOnLimitedConnection,
      }
    );
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.components.registrar.unhandle(this.protocol);
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  async echo(peer: PeerId | Multiaddr | Multiaddr[], buf: Uint8Array, options?: AbortOptions): Promise<Uint8Array> {
    const conn = await this.components.connectionManager.openConnection(peer, options);
    const stream = await conn.newStream(this.protocol, {
      ...this.init,
      ...options,
    });
    const bytes = byteStream(stream);

    const [, output] = await Promise.all([
      bytes.write(buf, options),
      bytes.read({
        ...options,
        bytes: buf.byteLength,
      }),
    ]);

    await stream.close(options);

    return output.subarray();
  }
}

export function echo(init: EchoInit = {}): (components: EchoComponents) => Echo {
  return (components) => new Echo(components, init);
}
