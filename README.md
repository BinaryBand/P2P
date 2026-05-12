# P2P Node Application

A peer-to-peer networking application built with Node.js, TypeScript, and libp2p. This application enables decentralized communication between nodes in a P2P network.

## Features

- **Peer-to-peer networking** using libp2p
- **WebRTC and WebSocket support** for various connection types
- **Message routing and delivery** between peers
- **Bootstrap functionality** to connect to existing networks
- **Interactive CLI interface** for node management
- **Persistent storage** for network data
- **Docker support** for easy deployment

## Quick Start

### Prerequisites

- Node.js 18+ (for local development)
- Docker and Docker Compose (for containerized deployment)

### Option 1: Docker Deployment (Recommended)

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd P2P
   ```

2. **Set up Docker (if not already installed):**

   ```bash
   ./deploy/setup-docker.sh
   ```

3. **Start the P2P node:**

   ```bash
   docker-compose up
   ```

4. **For multi-node testing:**
   ```bash
   docker-compose --profile multi-node up
   ```

### Option 2: Local Development

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Build the project:**

   ```bash
   npm run build
   ```

3. **Start the application:**
   ```bash
   npm start
   ```

## Docker Usage

### Quick Commands

```bash
# Start single node
docker-compose up

# Start multiple nodes for testing
docker-compose --profile multi-node up

# Run in background
docker-compose up -d

# Stop containers
docker-compose down

# View logs
docker-compose logs -f
```

### Manual Docker Build

```bash
# Build image
docker build -t p2p-node .

# Run container
docker run -it --rm \
  -p 4001:4001 \
  -p 8080:8080 \
  -v $(pwd)/storage:/app/storage \
  p2p-node
```

### Deployment Scripts

```bash
# Validate Docker setup
./deploy/setup-docker.sh

# Build and optionally push to registry
./deploy/build-and-push.sh [tag] [registry]
```

## Application Usage

Once the application is running, you'll see an interactive menu:

1. **Bootstrap to Peer ID** - Connect to an existing peer
2. **View Neighbors** - See connected peers
3. **Send a message** - Send messages to other peers
4. **View inbox** - Check received messages
5. **Exit** - Stop the application

### Connecting Nodes

To connect multiple nodes:

1. Start the first node and note its Peer ID
2. Start additional nodes
3. Use the "Bootstrap to Peer ID" option with the first node's ID
4. Nodes should now be able to communicate

## Configuration

### Environment Variables

- `NODE_ENV`: Set to `production` for production deployment
- `LOG_LEVEL`: Set logging level (`debug`, `info`, `warn`, `error`)

### Ports

- `4001`: P2P networking port
- `8080`: WebSocket/HTTP port

### Storage

The application stores data in the `storage/` directory:

- Peer information
- Message history
- Network state

## Development

### Project Structure

```
src/
├── index.ts              # Main application entry point
├── client.ts             # P2P client setup
├── helpers/              # Utility functions
│   ├── database.ts       # Database operations
│   ├── distance-cache.ts # Caching utilities
│   └── logger.ts         # Logging configuration
├── protocols/            # P2P protocol implementations
│   ├── base-proto.ts     # Base protocol class
│   ├── handshake-proto.ts# Handshake protocol
│   ├── message-proto.ts  # Message protocol
│   └── swarm-proto.ts    # Swarm protocol
└── tools/                # Core utilities
    ├── cryptography.ts   # Cryptographic functions
    ├── node.ts           # libp2p node factory
    ├── routing.ts        # Message routing
    ├── typing.ts         # Type definitions
    └── utils.ts          # General utilities
```

### Scripts

```bash
npm run build      # Compile TypeScript
npm run start      # Build and run
npm run typecheck  # Type checking only
```

### Dependencies

Key dependencies include:

- **libp2p**: Core P2P networking library
- **@libp2p/tcp**: TCP transport
- **@libp2p/websockets**: WebSocket transport
- **@libp2p/webrtc**: WebRTC transport
- **sqlite3**: Local database
- **winston**: Logging
- **inquirer**: Interactive CLI

## Docker Architecture

### Container Features

- **Alpine Linux base** for minimal size
- **Non-root user** for security
- **Health checks** for monitoring
- **Volume mounts** for persistent data
- **Multi-stage build** for optimization

### Networking

The Docker setup includes:

- Custom bridge network for inter-container communication
- Port mapping for external access
- Resource limits for production deployment

### Multi-Node Setup

The docker-compose configuration supports:

- Single node deployment (default)
- Multi-node deployment (with `--profile multi-node`)
- Separate storage volumes for each node
- Network isolation and communication

## Production Deployment

### Docker Compose Production

For production deployments, see `deploy/README.md` for:

- Production docker-compose configuration
- Resource limits and scaling
- Monitoring and logging setup
- Security considerations

### Kubernetes

For Kubernetes deployment, consider:

- Creating Kubernetes manifests
- Using persistent volumes for storage
- Setting up service discovery
- Implementing horizontal pod autoscaling

## Troubleshooting

### Common Issues

1. **Port conflicts**: Ensure ports 4001 and 8080 are available
2. **Permission errors**: Check storage directory permissions
3. **Connection issues**: Verify network connectivity between nodes
4. **Build failures**: Ensure all dependencies are installed

### Debugging

```bash
# View container logs
docker-compose logs -f p2p-node

# Access container shell
docker-compose exec p2p-node sh

# Check container health
docker inspect --format='{{.State.Health.Status}}' p2p-node
```

### Performance

Monitor resource usage:

```bash
# Container stats
docker stats p2p-node

# System resources
htop
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with Docker
5. Submit a pull request

## License

ISC License - see package.json for details

## Support

For issues and questions:

- Check the troubleshooting section
- Review Docker logs
- Open an issue on the repository

---

For detailed Docker deployment instructions, see [deploy/README.md](deploy/README.md).
