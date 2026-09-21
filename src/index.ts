#!/usr/bin/env node

import packageJson from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeClientManager } from "./client.js";
import { registerAllTools } from "./tools/index.js";
import { parseCommandLineArgs } from "./utils.js";
import { getWalletClient } from "./wallet-client.js";
import { startHttpServer } from "./http-server.js";

// Parse configuration
const config = parseCommandLineArgs();

// Show help if requested
if (config.showHelp) {
  console.log(`
Web3 Tools MCP Server v${packageJson.version}
${packageJson.description}

USAGE:
  npx web3-tools-mcp [OPTIONS]

OPTIONS:
  --help, -h                    Show this help message
  --etherscan-api-key <key>     Etherscan API key (for contract ABI retrieval)
  --alchemy-api-key <key>       Alchemy API key (for enhanced RPC)
  --infura-api-key <key>        Infura API key (for alternative RPC)
  --hypersync-api-key <key>     Hypersync API key (for fast event queries)
  --walletconnect-project-id <id>
                                WalletConnect project id, to sign from a phone
  --custom-rpc <json>           Custom RPC URLs as JSON object
                                Example: '{"mainnet":"https://...", "base":"https://..."}'

ENVIRONMENT VARIABLES:
  ETHERSCAN_API_KEY             Alternative to --etherscan-api-key
  ALCHEMY_API_KEY               Alternative to --alchemy-api-key
  INFURA_API_KEY                Alternative to --infura-api-key
  HYPERSYNC_API_KEY             Alternative to --hypersync-api-key
  WALLETCONNECT_PROJECT_ID      Alternative to --walletconnect-project-id
  MCP_HTTP_PORT                 Serve MCP over HTTP on this port instead of stdio
  MCP_TOKEN                     Bearer token required by the HTTP transport
  UPSTASH_REDIS_REST_URL        Keep WalletConnect sessions in Redis, not on disk
  UPSTASH_REDIS_REST_TOKEN
  WALLET_SERVER_URL             URL of a hosted wallet relay (omit to run one locally)
  WALLET_TOKEN                  Shared pairing token for the wallet relay

SUPPORTED CHAINS:
  mainnet, arbitrum, avalanche, base, bnb, gnosis, sonic, optimism, polygon, zksync, linea, unichain, localhost

EXAMPLES:
  # Use with npx (recommended)
  npx web3-tools-mcp --etherscan-api-key YOUR_KEY

  # Use environment variables
  export ETHERSCAN_API_KEY=your_key
  npx web3-tools-mcp

  # Use custom RPC
  npx web3-tools-mcp --custom-rpc '{"mainnet":"https://my-rpc.com"}'

DOCUMENTATION:
  GitHub: ${packageJson.repository.url.replace('git+', '').replace('.git', '')}
  Issues: ${packageJson.bugs.url}

For MCP client configuration, see the README.md file.
`);
  process.exit(0);
}

// Log configuration info
if (config.etherscanApiKey) {
  console.error("[MCP] Etherscan API key configured");
}
if (config.alchemyApiKey) {
  console.error("[MCP] Alchemy API key configured");
}
if (config.infuraApiKey) {
  console.error("[MCP] Infura API key configured");
}
if (config.walletConnectProjectId) {
  console.error("[MCP] WalletConnect project id configured — phone signing available");
}
if (config.customRpcUrls) {
  console.error("[MCP] Custom RPC URLs:", Object.keys(config.customRpcUrls));
}

// Initialize client manager
initializeClientManager(config);

function createMcpServer() {
  const server = new McpServer({
    name: "web3-tools-mcp",
    version: packageJson.version,
  });
  registerAllTools(server);
  return server;
}

// Serving over HTTP means there is no browser on this machine to open, so the wallet relay
// is skipped and signing goes to a paired phone over WalletConnect.
const httpMode = Boolean(process.env.MCP_HTTP_PORT);

const wallet = getWalletClient();
const walletReady = httpMode
  ? Promise.resolve()
  : wallet.connect().catch((error) => {
      console.error("[MCP] Wallet relay unavailable:", error.message);
      console.error("[MCP] Transaction signing features will not be available");
    });

// The wallet relay's listening socket keeps the event loop alive, so this process would
// outlive the client that spawned it and go on holding its port. Leave when the client does.
let shuttingDown = false;
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[MCP] Shutting down (${reason})`);
  await wallet.stop().catch(() => {});
  process.exit(0);
}

process.stdin.on("end", () => shutdown("client disconnected"));
process.stdin.on("close", () => shutdown("client disconnected"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
async function main() {
  if (httpMode) {
    const { url } = await startHttpServer({ createMcpServer });
    console.error(`Web3 Tools MCP Server listening on ${url}`);
    if (!config.walletConnectProjectId) {
      console.error("[MCP] No WalletConnect project id — a hosted server has no way to sign transactions");
    }
    return;
  }

  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  console.error("Web3 Tools MCP Server running on stdio");
  // The relay may still be picking a free port, and its URL carries the pairing token.
  await walletReady;
  console.error(`Wallet interface available at ${wallet.getUrl()}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
