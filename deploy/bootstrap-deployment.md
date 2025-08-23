# Bootstrap Node Deployment Guide

This guide explains how to deploy your P2P application as a bootstrap node that other peers can connect to.

## What is a Bootstrap Node?

A bootstrap node is a well-known, stable P2P node that helps new peers discover and connect to the network. It acts as an entry point for the P2P network, allowing new nodes to find other peers and establish connections.

## Prerequisites

- Docker and Docker Compose installed
- A server with a public IP address
- Ports 4001 and 8080 open in your firewall
- Domain name (optional but recommended)

## Quick Deployment

### 1. Set Bootstrap Seed Password

Create a `.env` file in your project root:

```bash
echo "BOOTSTRAP_SEED_PASSWORD=your-secure-bootstrap-seed-here" > .env
```

**Important**: Use a strong, unique seed password. This will generate a consistent Peer ID for your bootstrap node.

### 2. Deploy Bootstrap Node

```bash
# Build and start the bootstrap node
docker-compose -f docker-compose.bootstrap.yml up -d

# Check if it's running
docker-compose -f docker-compose.bootstrap.yml ps

# View logs
docker-compose -f docker-compose.bootstrap.yml logs -f
```

### 3. Get Your Bootstrap Node's Peer ID

```bash
# Check the logs for the Peer ID
docker-compose -f docker-compose.bootstrap.yml logs | grep "Client started with ID"
```

The output will show something like:

```
Client started with ID: 12D3KooWABC123...
```

Save this Peer ID - other nodes will use it to bootstrap to your node.

## Production Deployment

### Using a Cloud Provider

#### AWS EC2 / DigitalOcean / Linode

1. **Launch a server instance:**

   - Minimum: 1 CPU, 1GB RAM
   - Recommended: 2 CPU, 2GB RAM
   - Open ports: 22 (SSH), 4001 (P2P), 8080 (WebSocket)

2. **Install Docker:**

   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker $USER
   ```

3. **Clone and deploy:**
   ```bash
   git clone https://github.com/BinaryBand/P2P.git
   cd P2P
   echo "BOOTSTRAP_SEED_PASSWORD=your-secure-seed" > .env
   docker-compose -f docker-compose.bootstrap.yml up -d
   ```

#### Using Docker Registry

1. **Build and push to registry:**

   ```bash
   ./deploy/build-and-push.sh latest your-registry.com
   ```

2. **Create production compose file:**
   ```yaml
   version: "3.8"
   services:
     p2p-bootstrap:
       image: your-registry.com/p2p-node:latest
       container_name: p2p-bootstrap-node
       restart: always
       ports:
         - "4001:4001"
         - "8080:8080"
       environment:
         - NODE_ENV=production
         - BOOTSTRAP_SEED_PASSWORD=${BOOTSTRAP_SEED_PASSWORD}
       volumes:
         - bootstrap-storage:/app/storage
   volumes:
     bootstrap-storage:
   ```

### Domain Setup (Recommended)

1. **Point your domain to the server:**

   ```
   bootstrap.yourdomain.com -> YOUR_SERVER_IP
   ```

2. **Set up SSL with Let's Encrypt (optional):**

   ```bash
   # Install certbot
   sudo apt install certbot

   # Get certificate
   sudo certbot certonly --standalone -d bootstrap.yourdomain.com
   ```

## Configuration Options

### Environment Variables

- `BOOTSTRAP_SEED_PASSWORD`: Seed for generating consistent Peer ID
- `NODE_ENV`: Set to `production`
- `LOG_LEVEL`: Logging level (`debug`, `info`, `warn`, `error`)

### Resource Limits

The bootstrap configuration includes:

- Memory limit: 1GB
- CPU limit: 1 core
- Health checks every 30 seconds

## Monitoring Your Bootstrap Node

### Health Checks

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' p2p-bootstrap-node

# View detailed logs
docker-compose -f docker-compose.bootstrap.yml logs -f

# Monitor resource usage
docker stats p2p-bootstrap-node
```

### Log Analysis

```bash
# Check for successful connections
docker logs p2p-bootstrap-node | grep "Connected to peer"

# Check for bootstrap requests
docker logs p2p-bootstrap-node | grep "bootstrapping"

# Monitor errors
docker logs p2p-bootstrap-node | grep -i error
```

## Using Your Bootstrap Node

Once deployed, other P2P nodes can connect to your bootstrap node using:

### Connection Information

- **Peer ID**: `12D3KooWABC123...` (from your logs)
- **Address**: `your-server-ip:4001` or `bootstrap.yourdomain.com:4001`

### Client Connection Example

Other nodes can bootstrap to your node by:

1. Starting their P2P client
2. Selecting "Bootstrap to Peer ID"
3. Entering your bootstrap node's Peer ID

## Multiple Bootstrap Nodes

For better network resilience, deploy multiple bootstrap nodes:

```bash
# Deploy on different servers
server1: docker-compose -f docker-compose.bootstrap.yml up -d
server2: docker-compose -f docker-compose.bootstrap.yml up -d
server3: docker-compose -f docker-compose.bootstrap.yml up -d
```

Each should use the same `BOOTSTRAP_SEED_PASSWORD` to maintain the same Peer ID.

## Troubleshooting

### Common Issues

1. **Port conflicts:**

   ```bash
   sudo netstat -tulpn | grep :4001
   sudo netstat -tulpn | grep :8080
   ```

2. **Firewall issues:**

   ```bash
   # Ubuntu/Debian
   sudo ufw allow 4001
   sudo ufw allow 8080

   # CentOS/RHEL
   sudo firewall-cmd --permanent --add-port=4001/tcp
   sudo firewall-cmd --permanent --add-port=8080/tcp
   sudo firewall-cmd --reload
   ```

3. **Container not starting:**
   ```bash
   docker-compose -f docker-compose.bootstrap.yml logs
   ```

### Performance Tuning

For high-traffic bootstrap nodes:

```yaml
deploy:
  resources:
    limits:
      memory: 2G
      cpus: "2.0"
    reservations:
      memory: 1G
      cpus: "1.0"
```

## Security Considerations

1. **Use strong seed passwords**
2. **Keep Docker images updated**
3. **Monitor for unusual traffic**
4. **Use fail2ban for SSH protection**
5. **Regular security updates**

## Backup and Recovery

### Backup Bootstrap Data

```bash
# Backup storage volume
docker run --rm -v bootstrap-storage:/data -v $(pwd):/backup alpine tar czf /backup/bootstrap-backup.tar.gz /data

# Backup configuration
cp .env bootstrap-config-backup.env
```

### Restore Bootstrap Data

```bash
# Restore storage volume
docker run --rm -v bootstrap-storage:/data -v $(pwd):/backup alpine tar xzf /backup/bootstrap-backup.tar.gz -C /
```

## Maintenance

### Updates

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker-compose -f docker-compose.bootstrap.yml down
docker-compose -f docker-compose.bootstrap.yml build --no-cache
docker-compose -f docker-compose.bootstrap.yml up -d
```

### Log Rotation

```bash
# Set up log rotation
echo '/var/lib/docker/containers/*/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}' | sudo tee /etc/logrotate.d/docker
```

## Support

For issues with bootstrap node deployment:

1. Check the logs first
2. Verify network connectivity
3. Ensure proper firewall configuration
4. Monitor resource usage

Your bootstrap node is now ready to help other peers join the P2P network!
