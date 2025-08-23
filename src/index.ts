import { P2PRPCServer } from "./rpc-server.js";

async function main(): Promise<void> {
  console.log("Starting P2P RPC Server...");

  const port = parseInt(process.env.PORT || "8080");
  const server = new P2PRPCServer(port);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.start();
    console.log("P2P RPC Server started successfully!");
    console.log("Use the following endpoints:");
    console.log(`  Health: http://localhost:${port}/health`);
    console.log(`  RPC: http://localhost:${port}/rpc`);
    console.log(`  REST API: http://localhost:${port}/api/*`);
    console.log("\nExample usage:");
    console.log(
      `  curl -X POST http://localhost:${port}/api/initialize -H "Content-Type: application/json" -d '{"seedPassword":"your-password"}'`
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
