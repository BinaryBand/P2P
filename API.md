# P2P RPC API Documentation (Client-Agnostic)

This P2P RPC server is now **client-agnostic** and operates as a pure request processor. Instead of managing its own P2P node, it provides validation and processing services for external P2P clients.

## Base URL

- Default: `http://localhost:8080`
- Health Check: `GET /health`

## Authentication

No authentication required for this version.

## What Changed

The server no longer:

- Creates or manages P2P nodes internally
- Maintains connection state
- Requires initialization with seed passwords

The server now:

- Validates P2P requests and data formats
- Processes client-provided data
- Provides stateless validation services
- Acts as a pure request processor

## API Endpoints

### Health Check

```bash
GET /health
```

Returns server status and version information.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2025-01-20T12:00:00.000Z",
  "message": "P2P RPC Server is running",
  "version": "2.0.0-client-agnostic"
}
```

## Validation Endpoints

### Validate Bootstrap Request

Validates a bootstrap request between two peers.

```bash
POST /api/validate/bootstrap
Content-Type: application/json

{
  "peerId": "12D3KooW...",
  "clientPeerId": "12D3KooW..."
}
```

**Response:**

```json
{
  "success": true,
  "validation": {
    "valid": true,
    "targetPeer": "12D3KooW...",
    "clientPeer": "12D3KooW...",
    "message": "Bootstrap validation successful"
  }
}
```

### Validate Send Message Request

Validates a message sending request.

```bash
POST /api/validate/send
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
  "validation": {
    "valid": true,
    "recipient": "12D3KooW...",
    "messageCount": 2,
    "messages": [
      { "index": 0, "length": 13 },
      { "index": 1, "length": 14 }
    ],
    "message": "Send message validation successful"
  }
}
```

### Validate Peer ID

Validates a peer ID format and encoding.

```bash
POST /api/validate/peer
Content-Type: application/json

{
  "peerId": "12D3KooW..."
}
```

**Response:**

```json
{
  "success": true,
  "validation": {
    "valid": true,
    "peerId": "12D3KooW...",
    "encodedPeerId": "encoded_peer_id_here",
    "message": "Peer ID validation successful"
  }
}
```

## Processing Endpoints

### Process Neighbors Data

Processes and validates a list of neighbor peer IDs.

```bash
POST /api/process/neighbors
Content-Type: application/json

{
  "neighbors": ["12D3KooW...", "12D3KooW...", "invalid_peer_id"]
}
```

**Response:**

```json
{
  "success": true,
  "processed": {
    "total": 3,
    "valid": 2,
    "invalid": 1,
    "neighbors": [
      {
        "index": 0,
        "peerId": "12D3KooW...",
        "valid": true,
        "encoded": "encoded_peer_id_here"
      },
      {
        "index": 1,
        "peerId": "12D3KooW...",
        "valid": true,
        "encoded": "encoded_peer_id_here"
      },
      {
        "index": 2,
        "peerId": "invalid_peer_id",
        "valid": false,
        "error": "Invalid peer ID format"
      }
    ],
    "message": "Neighbors processing completed"
  }
}
```

### Process Inbox Data

Processes inbox messages for a peer.

```bash
POST /api/process/inbox
Content-Type: application/json

{
  "messages": ["Hello from peer!", "Another message"],
  "peerId": "12D3KooW..." // optional
}
```

**Response:**

```json
{
  "success": true,
  "processed": {
    "messageCount": 2,
    "peerId": "12D3KooW...",
    "messages": [
      {
        "index": 0,
        "length": 17,
        "preview": "Hello from peer!",
        "timestamp": "2025-01-20T12:00:00.000Z"
      },
      {
        "index": 1,
        "length": 15,
        "preview": "Another message",
        "timestamp": "2025-01-20T12:00:00.000Z"
      }
    ],
    "totalBytes": 32,
    "message": "Inbox processing completed"
  }
}
```

## JSON-RPC 2.0 Endpoint

You can also use the JSON-RPC 2.0 protocol:

```bash
POST /rpc
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "validateBootstrap",
  "params": {
    "peerId": "12D3KooW...",
    "clientPeerId": "12D3KooW..."
  },
  "id": 1
}
```

### Available RPC Methods:

- `validateBootstrap` - Validate bootstrap request between peers
- `validateSendMessage` - Validate message sending request
- `validatePeerId` - Validate peer ID format
- `processNeighbors` - Process and validate neighbors list
- `processInbox` - Process inbox messages
- `getServerStatus` - Get server status and version

## Example Usage with External P2P Client

### 1. Start the server

```bash
docker run -p 8080:8080 your-image
```

### 2. Validate bootstrap request (from your P2P client)

```bash
curl -X POST http://localhost:8080/api/validate/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "peerId": "12D3KooWTarget...",
    "clientPeerId": "12D3KooWClient..."
  }'
```

### 3. Validate message before sending

```bash
curl -X POST http://localhost:8080/api/validate/send \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "12D3KooW...",
    "messages": ["Hello P2P!"]
  }'
```

### 4. Process received neighbors list

```bash
curl -X POST http://localhost:8080/api/process/neighbors \
  -H "Content-Type: application/json" \
  -d '{
    "neighbors": ["12D3KooW...", "12D3KooW..."]
  }'
```

### 5. Process inbox messages

```bash
curl -X POST http://localhost:8080/api/process/inbox \
  -H "Content-Type: application/json" \
  -d '{
    "messages": ["Message 1", "Message 2"],
    "peerId": "12D3KooW..."
  }'
```

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200` - Success
- `400` - Bad Request (invalid parameters or validation failure)
- `500` - Internal Server Error

Error responses include details:

```json
{
  "success": false,
  "error": "Both peerId and clientPeerId are required"
}
```

## Integration with P2P Clients

This server is designed to work with external P2P clients that:

1. **Manage their own P2P nodes** - Create and maintain libp2p instances
2. **Handle connections** - Bootstrap to peers and maintain connections
3. **Send/receive messages** - Use the message protocol for communication
4. **Use validation services** - Call this server to validate requests before processing
5. **Process data** - Send data to this server for processing and analysis

### Example Integration Flow

1. Your P2P client wants to bootstrap to a peer
2. Client calls `/api/validate/bootstrap` to validate the request
3. If valid, client proceeds with actual bootstrap using libp2p
4. Client receives neighbor list from P2P network
5. Client calls `/api/process/neighbors` to process and validate the list
6. Client receives messages from peers
7. Client calls `/api/process/inbox` to process the messages

## Environment Variables

- `PORT` - Server port (default: 8080)

## Docker Usage

```bash
# Build
docker build -t p2p-rpc-server .

# Run
docker run -p 8080:8080 p2p-rpc-server

# Run with custom port
docker run -p 3000:3000 -e PORT=3000 p2p-rpc-server
```

## Migration from Previous Version

If you were using the previous version that managed P2P nodes internally:

1. **Extract P2P logic** - Move node creation and management to your client application
2. **Update API calls** - Change from action-based to validation/processing-based endpoints
3. **Handle state externally** - Manage peer connections and state in your client
4. **Use validation** - Call validation endpoints before performing P2P operations
5. **Process data** - Send received data to processing endpoints for analysis

The new architecture provides better separation of concerns and allows multiple clients to use the same validation and processing services.
