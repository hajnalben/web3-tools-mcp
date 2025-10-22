# Web3 Tools MCP Server

A Model Context Protocol (MCP) server that provides comprehensive blockchain interaction capabilities using [viem](https://viem.sh/), [Etherscan APIs](https://etherscan.io), and [Hypersync](https://docs.envio.dev/docs/HyperSync/overview). This server enables AI assistants to interact with multiple blockchain networks, query contract data, analyze transactions, and work with smart contracts with enhanced performance and reliability.

## 📦 Installation & Setup

### Quick Start (Recommended)
The easiest way to use this MCP server is with `npx` - no installation required! Add it directly to your MCP client configuration.

### MCP Client Configuration
Add to your MCP client configuration (e.g., Claude Desktop `config.json`):

```json
{
  "mcp": {
    "servers": {
      "web3-tools": {
        "command": "npx",
        "args": [
          "-y",
          "web3-tools-mcp",
          "--etherscan-api-key",
          "YOUR_ETHERSCAN_API_KEY",
          "--hypersync-api-key",
          "YOUR_HYPERSYNC_API_KEY"
        ]
      }
    }
  }
}
```

**Why npx?**
- ✅ No global installation required
- ✅ Always uses the latest version
- ✅ Automatic dependency management
- ✅ Works across different environments

### Alternative: Global Installation
If you prefer to install globally:
```bash
npm install -g web3-tools-mcp
```

Then use in your MCP config:
```json
{
  "mcp": {
    "servers": {
      "web3-tools": {
        "command": "web3-tools-mcp",
        "args": [
          "--etherscan-api-key", "YOUR_ETHERSCAN_API_KEY",
          "--hypersync-api-key", "YOUR_HYPERSYNC_API_KEY"
        ]
      }
    }
  }
}
```

### Command Line Usage
You can also run the server directly:
```bash
# Using npx (recommended)
npx web3-tools-mcp --etherscan-api-key YOUR_KEY --hypersync-api-key YOUR_KEY

# Or if globally installed
web3-tools-mcp --etherscan-api-key YOUR_KEY --hypersync-api-key YOUR_KEY
```

### Environment Variables
Alternative to command line arguments:
```bash
export ETHERSCAN_API_KEY=your_etherscan_key_here
export HYPERSYNC_API_KEY=your_hypersync_key_here
export ALCHEMY_API_KEY=your_alchemy_key_here  # optional
export INFURA_API_KEY=your_infura_key_here    # optional
npx web3-tools-mcp
```

### API Keys
- **Etherscan API Key**: Required for contract ABI fetching and verification status
  - Get free API key at [etherscan.io/apis](https://etherscan.io/apis)
- **Hypersync API Key**: Required for fast event log querying
  - Get free API key at [hypersync.xyz](https://hypersync.xyz)
- **Alchemy API Key**: Optional, provides enhanced RPC reliability
  - Get free API key at [alchemy.com](https://alchemy.com)
- **Infura API Key**: Optional, additional RPC provider for failover
  - Get free API key at [infura.io](https://infura.io)

## 🌟 Key Features

- **Multi-chain Support**: Works with Ethereum mainnet, Base, Arbitrum, Polygon, Optimism, Celo, and localhost
- **Smart Contract Interactions**: Call view/pure functions, get contract ABIs, and analyze contract bytecode
- **Event Log Analysis**: Query and decode blockchain events with flexible filtering
- **Token Operations**: Get native and ERC20 token balances for single or multiple addresses
- **ABI Utilities**: Generate function, event, and error signatures from ABI definitions
- **Batch Operations**: Execute multiple contract calls or balance queries efficiently
- **Transaction Analysis**: Trace transactions for detailed execution information
- **Enhanced RPC Support**: Automatic failover between providers (Alchemy, Infura, public RPCs)
- **Hypersync Integration**: Fast event log querying with fallback support

## 🚀 Supported Blockchain Networks

| Network | Chain ID | Default RPC | Hypersync Support |
|---------|----------|-------------|------------------|
| Ethereum Mainnet | 1 | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ |
| Arbitrum One | 42161 | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ |
| Celo | 42220 | ✅ | ❌ |
| Localhost | 31337 | ✅ | ❌ |

## 🛠 Available Tools

### 1. ABI Signature Tools

#### `get_function_signature`
Generate 4-byte function selectors from ABI definitions. Supports batch operations for multiple functions at once.

#### `get_event_signature`
Generate 32-byte event signatures (topic0) from ABI definitions. Supports batch operations for multiple events at once.

#### `get_error_signature`
Generate 4-byte error selectors from ABI definitions. Supports batch operations for multiple errors at once.

### 2. Contract Interaction Tools

#### `call_contract_function`
Call view/pure functions on smart contracts. Supports batch operations for executing multiple calls efficiently across different contracts and chains.

#### `get_contract_abi`
Get comprehensive contract information including ABI, proxy detection, compilation info, creation info, and verification status from Etherscan. Includes smart caching for performance.

#### `get_contract_source_code`
Retrieve verified contract source code from Etherscan with proxy support and flexible output options (full source, summary, or metadata only). Features smart caching.

#### `get_contract_source_file`
Retrieve specific source file from cached contract data. Use after calling `get_contract_source_code` with full source option.

#### `is_contract`
Check if an address is a smart contract or EOA (Externally Owned Account). Returns contract status and bytecode length.

### 3. Balance Query Tools

#### `get_balance`
Get native or ERC20 token balances for single or multiple addresses efficiently. Supports batch operations for optimal performance. Omit `tokenAddress` for native balance, include it for ERC20 tokens.

### 4. Event Log Tools

#### `get_logs`
Query contract events with decoded output and parameter filtering. Automatically falls back to Hypersync for supported chains when needed. Supports filtering by contract address, block range, and indexed event parameters.

### 5. Advanced Tools

#### `get_storage_at`
Read raw storage data from a contract with ABI-based decoding. Supports various types like uint256, address, bool, bytes32, etc.

#### `get_block_info`
Get comprehensive block information including timestamp, hash, parent hash, and formatted dates. Defaults to latest block if not specified.

#### `trace_transaction`
Trace a transaction to see detailed execution information including internal calls, state changes, and gas usage. Supports multiple trace types: `trace` (call tree), `vmTrace` (VM execution), `stateDiff` (state changes).

## ⚙️ Configuration

The server supports multiple configuration options through environment variables or command-line arguments:

### API Keys
- `ETHERSCAN_API_KEY` / `--etherscan-api-key`: For contract ABI retrieval
- `ALCHEMY_API_KEY` / `--alchemy-api-key`: Enhanced RPC endpoints
- `INFURA_API_KEY` / `--infura-api-key`: Alternative RPC provider
- `HYPERSYNC_API_KEY` / `--hypersync-api-key`: Fast event log querying

### Custom RPC URLs
- `--custom-rpc`: JSON object with custom RPC URLs per chain

**Example:**
```bash
npx web3-tools-mcp --custom-rpc '{"mainnet": "https://my-custom-rpc.com", "base": "https://base-rpc.com"}'
```

## 🔧 Technical Features

### Enhanced RPC Configuration
- **Automatic Provider Selection**: Prioritizes Alchemy → Infura → Public RPCs
- **Custom RPC Support**: Override default providers with custom endpoints
- **Failover Mechanisms**: Graceful handling of RPC failures

### Hypersync Integration
- **Fast Event Queries**: Significantly faster than traditional RPC for event logs
- **Automatic Fallback**: Falls back to regular viem when Hypersync fails
- **Selective Support**: Available for mainnet, Base, Arbitrum, Polygon, and Optimism

### Data Type Handling
- **BigInt Serialization**: Automatic conversion of BigInt values to strings for JSON compatibility
- **Type Conversion**: Smart conversion of arguments based on ABI parameter types
- **Error Handling**: Comprehensive error messages and graceful failure handling

### Batch Operations
- **Multicall Support**: Execute multiple contract calls efficiently
- **Balance Batching**: Query multiple balances in parallel
- **Result Aggregation**: Organized results with success/failure tracking

## 📋 Requirements

- **Runtime**: Node.js v20.0.0 or higher
- **Package Manager**: npm (recommended) or yarn/pnpm
- **Dependencies**: viem, @envio-dev/hypersync-client, @modelcontextprotocol/sdk
- **Network Access**: Internet connection for blockchain RPC calls

## 🧪 Testing

The server includes a comprehensive test suite with 70 tests covering all functionality:

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui
```

## 🔗 Related Tools

This server is designed to work seamlessly with other blockchain development tools and can be used alongside:
- Block explorers (Etherscan, Basescan, etc.)
- DeFi protocols analysis
- Smart contract development workflows
- Token analysis and portfolio tracking
- Event monitoring and alerting systems

## 🎯 Use Cases

- **Smart Contract Analysis**: Analyze contract behavior, storage, and interactions
- **Token Research**: Query token balances, transfers, and metadata
- **DeFi Protocol Monitoring**: Track liquidity, swaps, and protocol events
- **Transaction Analysis**: Understand complex transaction flows and internal calls
- **Multi-chain Portfolio Tracking**: Monitor assets across different networks
- **Event-driven Analysis**: Build insights from blockchain event data
- **Contract Verification**: Check contract deployment and proxy patterns

This MCP server provides a comprehensive toolkit for blockchain interaction, making it easy for AI assistants to help users analyze, query, and understand blockchain data across multiple networks.
