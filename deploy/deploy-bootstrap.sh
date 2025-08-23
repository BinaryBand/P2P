#!/bin/bash

# Bootstrap Node Deployment Script
# Usage: ./deploy/deploy-bootstrap.sh [seed-password]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEFAULT_SEED="bootstrap-$(date +%s)"
COMPOSE_FILE="docker-compose.bootstrap.yml"

echo -e "${BLUE}🚀 P2P Bootstrap Node Deployment Script${NC}"
echo "=========================================="

# Parse arguments
SEED_PASSWORD=${1:-$DEFAULT_SEED}

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed. Please install Docker Compose first.${NC}"
    exit 1
fi

# Create .env file
echo -e "${YELLOW}📝 Setting up environment configuration...${NC}"
echo "BOOTSTRAP_SEED_PASSWORD=${SEED_PASSWORD}" > .env
echo -e "${GREEN}✅ Created .env file with bootstrap seed${NC}"

# Stop any existing bootstrap containers
echo -e "${YELLOW}🛑 Stopping any existing bootstrap containers...${NC}"
docker-compose -f $COMPOSE_FILE down 2>/dev/null || true

# Build and start the bootstrap node
echo -e "${YELLOW}🔨 Building and starting bootstrap node...${NC}"
docker-compose -f $COMPOSE_FILE up -d --build

# Wait for container to start
echo -e "${YELLOW}⏳ Waiting for bootstrap node to start...${NC}"
sleep 10

# Check if container is running
if docker-compose -f $COMPOSE_FILE ps | grep -q "Up"; then
    echo -e "${GREEN}✅ Bootstrap node is running successfully!${NC}"
    
    # Get container logs to find Peer ID
    echo -e "${YELLOW}🔍 Retrieving Peer ID...${NC}"
    sleep 5
    
    # Try to get the Peer ID from logs
    PEER_ID=$(docker-compose -f $COMPOSE_FILE logs 2>/dev/null | grep "Client started with ID" | tail -1 | sed 's/.*Client started with ID: //' | tr -d '\r\n' || echo "")
    
    if [ -n "$PEER_ID" ]; then
        echo -e "${GREEN}🎉 Bootstrap node deployed successfully!${NC}"
        echo ""
        echo "📋 Bootstrap Node Information:"
        echo "=============================="
        echo -e "Peer ID: ${BLUE}${PEER_ID}${NC}"
        echo -e "P2P Port: ${BLUE}4001${NC}"
        echo -e "WebSocket Port: ${BLUE}8080${NC}"
        echo ""
        echo "🌐 Connection Information:"
        echo "========================="
        echo "Other nodes can bootstrap to this node using the Peer ID above."
        echo ""
        echo "📊 Monitoring Commands:"
        echo "======================"
        echo "View logs:     docker-compose -f $COMPOSE_FILE logs -f"
        echo "Check status:  docker-compose -f $COMPOSE_FILE ps"
        echo "Stop node:     docker-compose -f $COMPOSE_FILE down"
        echo "Restart node:  docker-compose -f $COMPOSE_FILE restart"
        echo ""
    else
        echo -e "${YELLOW}⚠️  Bootstrap node is running, but Peer ID not yet available.${NC}"
        echo "Check logs in a few moments: docker-compose -f $COMPOSE_FILE logs -f"
    fi
    
    # Show resource usage
    echo "💻 Resource Usage:"
    echo "=================="
    docker stats --no-stream p2p-bootstrap-node 2>/dev/null || echo "Resource stats not available yet"
    
else
    echo -e "${RED}❌ Failed to start bootstrap node${NC}"
    echo "Check logs for errors:"
    docker-compose -f $COMPOSE_FILE logs
    exit 1
fi

echo ""
echo -e "${GREEN}🎊 Deployment complete!${NC}"
echo "Your P2P bootstrap node is now ready to accept connections."
