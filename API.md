# P2P RPC API Documentation

This P2P application now runs as an HTTP RPC service instead of an interactive CLI. You can interact with it using HTTP requests.

## Base URL

- Default: `http://localhost:8080`
- Health Check: `GET /health`

## Authentication

No authentication required for this version.

## API Endpoints

### Health Check

```bash
GET /health
```

Returns server status and connection information.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2025-01-20T12:00:00.000Z",
  "client_connected": true,
  "peer_id": "12D3KooW..."
}
```

### Initialize P2P Client

```bash
POST /api/initialize
Content-Type: application/json

{
  "seedPassword": "your-secret-password"
}
```

**Response:**

```json
{
  "success": true,
  "peerId": "12D3KooW..."
}
```

### Bootstrap to Peer

```bash
POST /api/bootstrap
Content-Type: application/json

{
  "peerId": "12D3KooW..."
}
```

**Response:**

```json
{
  "success": true,
  "message": "Bootstrap completed"
}
```

### Get Connected Neighbors

```bash
GET /api/neighbors
```

**Response:**

```json
{
  "success": true,
  "neighbors": ["12D3KooW...", "12D3KooW..."]
}
```

### Send Messages

```bash
POST /api/send
Content-Type: application/json

{
  "recipient": "12D3KooW...",
  "messages": ["Hello, World!", "Second message"]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Messages sent successfully"
}
```

### Get Inbox

```bash
GET /api/inbox
# or
GET /api/inbox/12D3KooW...
```

**Response:**

```json
{
  "success": true,
  "messages": ["Hello from peer!", "Another message"]
}
```

## JSON-RPC 2.0 Endpoint

You can also use the JSON-RPC 2.0 protocol:

```bash
POST /rpc
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "seedPassword": "your-secret-password"
  },
  "id": 1
}
```

### Available RPC Methods:

- `initialize` - Initialize the P2P client
- `bootstrap` - Bootstrap to a peer
- `getNeighbors` - Get connected neighbors
- `sendMessage` - Send messages to a peer
- `getInbox` - Get inbox messages
- `getStatus` - Get client status

## Example Usage

### 1. Start the server

```bash
docker run -p 8080:8080 your-image
```

### 2. Initialize the client

```bash
curl -X POST http://localhost:8080/api/initialize \
  -H "Content-Type: application/json" \
  -d '{"seedPassword":"my-secret-password"}'
```

### 3. Bootstrap to a peer

```bash
curl -X POST http://localhost:8080/api/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"peerId":"12D3KooW..."}'
```

### 4. Send a message

```bash
curl -X POST http://localhost:8080/api/send \
  -H "Content-Type: application/json" \
  -d '{"recipient":"12D3KooW...","messages":["Hello P2P!"]}'
```

### 5. Check inbox

```bash
curl http://localhost:8080/api/inbox
```

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `500` - Internal Server Error

Error responses include details:

```json
{
  "success": false,
  "error": "Client not initialized. Call initialize first."
}
```

## Environment Variables

- `PORT` - Server port (default: 8080)

## Docker Usage

The application is designed to run in Docker containers without requiring interactive input.

```bash
# Build
docker build -t p2p-rpc .

# Run
docker run -p 8080:8080 p2p-rpc

# Run with custom port
docker run -p 3000:3000 -e PORT=3000 p2p-rpc
```
