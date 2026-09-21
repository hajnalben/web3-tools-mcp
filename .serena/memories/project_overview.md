# Web3 Tools MCP Server

## Purpose
A Model Context Protocol (MCP) server for blockchain interactions using viem, Etherscan, and Hypersync.

## Tech Stack
- **Language**: TypeScript (ES2022, NodeNext modules)
- **Runtime**: Node.js >= 20.0.0
- **Core Dependencies**:
  - `viem` - Ethereum client library
  - `@modelcontextprotocol/sdk` - MCP server framework
  - `@envio-dev/hypersync-client` - Fast event queries
  - `express` + `ws` - Wallet server for browser wallet integration
  - `zod` - Schema validation

## Supported Chains
mainnet, arbitrum, avalanche, base, bnb, gnosis, sonic, optimism, polygon, zksync, linea, unichain, localhost

## Key Features
- Multi-chain contract interactions (read/write)
- ENS resolution
- Token balances (native & ERC20)
- Event log queries with Hypersync acceleration
- Transaction tracing
- Browser wallet integration for signing
- Gas estimation and pricing
