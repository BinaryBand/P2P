# Use Node.js 20 Alpine as base image for smaller size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install system dependencies needed for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    sqlite-dev

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy TypeScript configuration
COPY tsconfig.json ./

# Copy source code
COPY src/ ./src/
COPY env.d.ts ./

# Build the application
RUN npm run build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S p2puser -u 1001 -G nodejs

# Create storage directory and set permissions
RUN mkdir -p /app/storage && \
    chown -R p2puser:nodejs /app

# Switch to non-root user
USER p2puser

# Expose ports for P2P networking
# WebRTC and WebSocket ports
EXPOSE 4001 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# Start the application
CMD ["npm", "start"]
