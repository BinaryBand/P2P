#!/bin/bash

# Build and Push Docker Image Script
# Usage: ./deploy/build-and-push.sh [tag] [registry]

set -e

# Default values
DEFAULT_TAG="latest"
DEFAULT_REGISTRY="localhost"
IMAGE_NAME="p2p-node"

# Parse arguments
TAG=${1:-$DEFAULT_TAG}
REGISTRY=${2:-$DEFAULT_REGISTRY}
FULL_IMAGE_NAME="${REGISTRY}/${IMAGE_NAME}:${TAG}"

echo "🐳 Building Docker image: ${FULL_IMAGE_NAME}"

# Build the Docker image
docker build -t "${FULL_IMAGE_NAME}" .

echo "✅ Successfully built image: ${FULL_IMAGE_NAME}"

# Push to registry if not localhost
if [ "$REGISTRY" != "localhost" ]; then
    echo "📤 Pushing image to registry: ${REGISTRY}"
    docker push "${FULL_IMAGE_NAME}"
    echo "✅ Successfully pushed image: ${FULL_IMAGE_NAME}"
else
    echo "ℹ️  Skipping push for localhost registry"
fi

# Show image info
echo "📋 Image information:"
docker images "${FULL_IMAGE_NAME}"

echo "🎉 Build complete!"
echo "To run the container:"
echo "  docker run -p 4001:4001 -p 8080:8080 ${FULL_IMAGE_NAME}"
echo "Or use docker-compose:"
echo "  docker-compose up"
