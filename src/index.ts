#!/usr/bin/env node

import packageJson from "../package.json" with { type: "json" };
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeClientManager } from "./client.js";
import { registerAllTools } from "./tools/index.js";
import { parseCommandLineArgs } from "./utils.js";
import { startWalletServer } from "./wallet-server.js";

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
  --custom-rpc <json>           Custom RPC URLs as JSON object
                                Example: '{"mainnet":"https://...", "base":"https://..."}'

ENVIRONMENT VARIABLES:
  ETHERSCAN_API_KEY             Alternative to --etherscan-api-key
  ALCHEMY_API_KEY               Alternative to --alchemy-api-key
  INFURA_API_KEY                Alternative to --infura-api-key
  HYPERSYNC_API_KEY             Alternative to --hypersync-api-key

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
if (config.customRpcUrls) {
  console.error("[MCP] Custom RPC URLs:", Object.keys(config.customRpcUrls));
}

// Initialize client manager
initializeClientManager(config);

// Create MCP server instance
const server = new McpServer({
  name: "web3-tools-mcp",
  version: packageJson.version,
});

// Register all tools
registerAllTools(server);

// Start wallet server in background
startWalletServer().catch((error) => {
  console.error("[MCP] Wallet server failed to start:", error.message);
  console.error("[MCP] Transaction signing features will not be available");
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Web3 Tools MCP Server running on stdio");
  console.error("Wallet interface available at http://localhost:3456");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
