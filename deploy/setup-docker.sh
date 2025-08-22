#!/bin/bash

# Docker Setup Script for P2P Node
# This script helps set up Docker and validate the containerization

set -e

echo "🐳 P2P Node Docker Setup"
echo "========================"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed."
    echo ""
    echo "Please install Docker using one of these methods:"
    echo "  sudo snap install docker"
    echo "  sudo apt install docker.io"
    echo "  sudo apt install podman-docker"
    echo ""
    echo "After installation, you may need to:"
    echo "  sudo usermod -aG docker \$USER"
    echo "  newgrp docker"
    echo ""
    exit 1
fi

# Check if Docker Compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available."
    echo "Please install Docker Compose or use a newer Docker version with built-in compose."
    exit 1
fi

echo "✅ Docker is installed: $(docker --version)"

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo "❌ Docker daemon is not running."
    echo "Please start Docker service:"
    echo "  sudo systemctl start docker"
    echo "  sudo systemctl enable docker"
    exit 1
fi

echo "✅ Docker daemon is running"

# Validate Dockerfile
if [ ! -f "Dockerfile" ]; then
    echo "❌ Dockerfile not found in current directory"
    exit 1
fi

echo "✅ Dockerfile found"

# Validate docker-compose.yml
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ docker-compose.yml not found in current directory"
    exit 1
fi

echo "✅ docker-compose.yml found"

# Test Docker build
echo ""
echo "🔨 Testing Docker build..."
if docker build -t p2p-node-test . > /tmp/docker-build.log 2>&1; then
    echo "✅ Docker build successful"
    
    # Show image size
    IMAGE_SIZE=$(docker images p2p-node-test --format "table {{.Size}}" | tail -n 1)
    echo "📦 Image size: $IMAGE_SIZE"
    
    # Test container creation (without running)
    echo ""
    echo "🧪 Testing container creation..."
    if docker create --name p2p-node-test-container p2p-node-test > /dev/null 2>&1; then
        echo "✅ Container creation successful"
        
        # Clean up test container
        docker rm p2p-node-test-container > /dev/null 2>&1
        echo "🧹 Test container cleaned up"
    else
        echo "❌ Container creation failed"
        exit 1
    fi
    
    # Clean up test image
    docker rmi p2p-node-test > /dev/null 2>&1
    echo "🧹 Test image cleaned up"
    
else
    echo "❌ Docker build failed. Check the log:"
    cat /tmp/docker-build.log
    exit 1
fi

# Validate docker-compose
echo ""
echo "🔧 Validating docker-compose configuration..."
if docker-compose config > /dev/null 2>&1 || docker compose config > /dev/null 2>&1; then
    echo "✅ docker-compose configuration is valid"
else
    echo "❌ docker-compose configuration is invalid"
    exit 1
fi

# Create necessary directories
echo ""
echo "📁 Creating necessary directories..."
mkdir -p storage logs storage2 logs2
echo "✅ Directories created: storage, logs, storage2, logs2"

echo ""
echo "🎉 Docker setup validation complete!"
echo ""
echo "Next steps:"
echo "1. Build and run with docker-compose:"
echo "   docker-compose up"
echo ""
echo "2. Or build and run manually:"
echo "   docker build -t p2p-node ."
echo "   docker run -it --rm -p 4001:4001 -p 8080:8080 p2p-node"
echo ""
echo "3. For multi-node testing:"
echo "   docker-compose --profile multi-node up"
echo ""
echo "See deploy/README.md for more detailed instructions."
