# Bootstrap Usage Guide

This P2P application now supports custom bootstrap addresses via command line arguments.

## Usage

### Default Bootstrap (uses built-in bootstrap nodes)

```bash
npm start
```

### Custom Bootstrap Addresses

```bash
npm start -- --bootstrap /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWExample1 --bootstrap /ip4/192.168.1.100/tcp/4001/p2p/12D3KooWExample2
```

### Multiple Bootstrap Addresses

You can specify multiple bootstrap addresses by repeating the `--bootstrap` flag:

```bash
npm start -- --bootstrap <address1> --bootstrap <address2> --bootstrap <address3>
```

## Examples

### Bootstrap to a local peer

```bash
npm start -- --bootstrap /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8
```

### Bootstrap to multiple peers

```bash
npm start -- --bootstrap /ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ --bootstrap /dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN
```

## How it works

1. The application parses command line arguments looking for `--bootstrap` flags
2. Each `--bootstrap` flag should be followed by a valid libp2p multiaddress
3. If custom bootstrap addresses are provided, they replace the default bootstrap nodes
4. If no custom addresses are provided, the application uses the built-in bootstrap nodes
5. The gateway node will attempt to connect to these bootstrap peers on startup

## Address Format

Bootstrap addresses should be valid libp2p multiaddresses, such as:

- `/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...`
- `/dnsaddr/bootstrap.libp2p.io/p2p/QmNno...`
- `/ip4/192.168.1.100/udp/4001/quic-v1/p2p/12D3KooW...`
