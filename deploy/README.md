# Docker Deployment Guide

This guide explains how to build, run, and deploy the P2P Node application using Docker.

## Quick Start

### Using Docker Compose (Recommended)

1. **Start a single P2P node:**

   ```bash
   docker-compose up
   ```

2. **Start multiple P2P nodes for testing:**

   ```bash
   docker-compose --profile multi-node up
   ```

3. **Run in background:**

   ```bash
   docker-compose up -d
   ```

4. **Stop containers:**
   ```bash
   docker-compose down
   ```

### Using Docker directly

1. **Build the image:**

   ```bash
   docker build -t p2p-node .
   ```

2. **Run the container:**
   ```bash
   docker run -it --rm \
     -p 4001:4001 \
     -p 8080:8080 \
     -v $(pwd)/storage:/app/storage \
     p2p-node
   ```

## Configuration

### Environment Variables

- `NODE_ENV`: Set to `production` for production deployment
- `LOG_LEVEL`: Set logging level (`debug`, `info`, `warn`, `error`)

### Ports

- `4001`: P2P networking port
- `8080`: WebSocket/HTTP port

### Volumes

- `/app/storage`: Persistent storage for P2P data
- `/app/logs`: Application logs (optional)

## Deployment Scripts

### Build and Push Script

Use the build script to build and optionally push to a registry:

```bash
# Build locally
./deploy/build-and-push.sh

# Build and tag with version
./deploy/build-and-push.sh v1.0.0

# Build and push to registry
./deploy/build-and-push.sh latest your-registry.com
```

Make the script executable:

```bash
chmod +x deploy/build-and-push.sh
```

## Production Deployment

### Docker Compose Production

For production, create a `docker-compose.prod.yml`:

```yaml
version: "3.8"

services:
  p2p-node:
    image: your-registry.com/p2p-node:latest
    container_name: p2p-node-prod
    restart: always
    ports:
      - "4001:4001"
      - "8080:8080"
    volumes:
      - p2p-storage:/app/storage
      - p2p-logs:/app/logs
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    networks:
      - p2p-network
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"

volumes:
  p2p-storage:
    driver: local
  p2p-logs:
    driver: local

networks:
  p2p-network:
    driver: bridge
```

Deploy with:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Health Checks

The container includes a health check that runs every 30 seconds. Check container health:

```bash
docker ps
docker inspect --format='{{.State.Health.Status}}' p2p-node
```

## Troubleshooting

### View Logs

```bash
# Docker Compose
docker-compose logs -f

# Docker directly
docker logs -f p2p-node
```

### Interactive Shell

```bash
# Docker Compose
docker-compose exec p2p-node sh

# Docker directly
docker exec -it p2p-node sh
```

### Common Issues

1. **Port conflicts**: Make sure ports 4001 and 8080 are not in use
2. **Permission issues**: Ensure storage directory is writable
3. **Build failures**: Check that all dependencies are properly installed

### Resource Usage

Monitor container resource usage:

```bash
docker stats p2p-node
```

## Security Considerations

- The container runs as a non-root user (`p2puser`)
- Sensitive data should be stored in mounted volumes
- Use secrets management for production deployments
- Keep the base image updated for security patches

## Multi-Node Testing

To test P2P functionality with multiple nodes:

1. Start multiple nodes:

   ```bash
   docker-compose --profile multi-node up
   ```

2. Connect to each node:

   ```bash
   # Node 1 (port 4001)
   docker-compose exec p2p-node sh

   # Node 2 (port 4002)
   docker-compose exec p2p-node-2 sh
   ```

3. Use the application's bootstrap functionality to connect nodes

## Monitoring

For production deployments, consider adding:

- Log aggregation (ELK stack, Fluentd)
- Metrics collection (Prometheus)
- Container orchestration (Kubernetes, Docker Swarm)
- Load balancing for multiple instances
