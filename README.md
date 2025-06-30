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
Generate 4-byte function selectors from ABI definitions.

**Parameters:**
- `functionAbi` (string): Function ABI (e.g., `"function transfer(address to, uint256 amount)"`)

**Example:**
```json
{
  "name": "get_function_signature",
  "arguments": {
    "functionAbi": "function balanceOf(address owner) view returns (uint256)"
  }
}
```

#### `get_event_signature`
Generate 32-byte event signatures (topic0) from ABI definitions.

**Parameters:**
- `eventAbi` (string): Event ABI (e.g., `"event Transfer(address indexed from, address indexed to, uint256 value)"`)

#### `get_error_signature`
Generate 4-byte error selectors from ABI definitions.

**Parameters:**
- `errorAbi` (string): Error ABI (e.g., `"error InsufficientBalance(uint256 available, uint256 required)"`)

### 2. Contract Interaction Tools

#### `call_contract_function`
Call view/pure functions on smart contracts.

**Parameters:**
- `chain` (enum): Blockchain network (`mainnet`, `base`, `arbitrum`, `polygon`, `optimism`, `celo`, `localhost`)
- `contractAddress` (string): Contract address to call
- `functionAbi` (string): Function ABI definition
- `args` (array, optional): Function arguments
- `blockNumber` (string, optional): Specific block number to query

**Example:**
```json
{
  "name": "call_contract_function",
  "arguments": {
    "chain": "mainnet",
    "contractAddress": "0xA0b86a33E6441c1e4e9c08975a0c8246e8dB8C4F",
    "functionAbi": "function balanceOf(address owner) view returns (uint256)",
    "args": ["0x742d35Cc6cF36C3e0C37d3f6D1D5e4f2C8F3E8A9"]
  }
}
```

#### `get_contract_abi`
Get comprehensive contract information including ABI, proxy detection, and verification status from Etherscan.

**Parameters:**
- `chain` (enum): Blockchain network
- `address` (string): Contract address

#### `is_contract`
Check if an address is a smart contract or EOA (Externally Owned Account).

**Parameters:**
- `chain` (enum): Blockchain network
- `address` (string): Address to check

### 3. Balance Query Tools

#### `get_balance`
Get native token balance for an address.

**Parameters:**
- `chain` (enum): Blockchain network
- `address` (string): Address to check
- `blockNumber` (string, optional): Specific block number

#### `get_token_balance`
Get ERC20/ERC777 token balance for an address.

**Parameters:**
- `chain` (enum): Blockchain network
- `tokenAddress` (string): Token contract address
- `holderAddress` (string): Address to check balance for
- `blockNumber` (string, optional): Specific block number

#### `batch_native_balances`
Get native token balances for multiple addresses in a single call.

**Parameters:**
- `chain` (enum): Blockchain network
- `addresses` (array): Array of addresses to check
- `blockNumber` (string, optional): Specific block number

#### `batch_token_balances`
Get multiple token balances for multiple addresses efficiently.

**Parameters:**
- `chain` (enum): Blockchain network
- `queries` (array): Array of balance queries with `tokenAddress`, `holderAddress`, and optional `label`
- `blockNumber` (string, optional): Specific block number

### 4. Event Log Tools

#### `get_logs`
Query contract events with decoded output and parameter filtering. Automatically falls back to Hypersync for supported chains when needed.

**Parameters:**
- `chain` (enum): Blockchain network
- `eventAbi` (string): Event ABI definition for decoding
- `address` (string, optional): Contract address to filter logs
- `fromBlock` (string, optional): Start block number
- `toBlock` (string, optional): End block number
- `eventArgs` (object, optional): Filter by indexed event parameters

**Example:**
```json
{
  "name": "get_logs",
  "arguments": {
    "chain": "mainnet",
    "eventAbi": "event Transfer(address indexed from, address indexed to, uint256 value)",
    "address": "0xA0b86a33E6441c1e4e9c08975a0c8246e8dB8C4F",
    "fromBlock": "18000000",
    "toBlock": "18001000",
    "eventArgs": {
      "from": "0x742d35Cc6cF36C3e0C37d3f6D1D5e4f2C8F3E8A9"
    }
  }
}
```

### 5. Batch Operations

#### `batch_contract_calls`
Execute multiple contract calls in a single batch operation.

**Parameters:**
- `chain` (enum): Blockchain network
- `calls` (array): Array of contract calls with `contractAddress`, `functionAbi`, `args`, and optional `label`
- `blockNumber` (string, optional): Specific block number

### 6. Advanced Tools

#### `get_storage_at`
Read raw storage data from a contract with ABI-based decoding.

**Parameters:**
- `chain` (enum): Blockchain network
- `address` (string): Contract address
- `slot` (string): Storage slot to read (hex string)
- `abiType` (string): ABI type for decoding (`uint256`, `address`, `bool`, `bytes32`, etc.)
- `blockNumber` (string, optional): Specific block number

#### `get_block_info`
Get comprehensive block information including timestamp, hash, and formatted dates.

**Parameters:**
- `chain` (enum): Blockchain network
- `blockNumber` (string, optional): Block number to query (defaults to latest)

#### `trace_transaction`
Trace a transaction to see detailed execution information including internal calls, state changes, and gas usage.

**Parameters:**
- `chain` (enum): Blockchain network
- `transactionHash` (string): Transaction hash to trace
- `traceType` (enum, optional): Type of trace (`trace`, `vmTrace`, `stateDiff`)

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
bun index.ts --custom-rpc '{"mainnet": "https://my-custom-rpc.com", "base": "https://base-rpc.com"}'
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

## 🚀 Usage Examples

### Basic Contract Call
```json
{
  "name": "call_contract_function",
  "arguments": {
    "chain": "mainnet",
    "contractAddress": "0xA0b86a33E6441c1e4e9c08975a0c8246e8dB8C4F",
    "functionAbi": "function name() view returns (string)",
    "args": []
  }
}
```

### Event Log Analysis
```json
{
  "name": "get_logs",
  "arguments": {
    "chain": "base",
    "eventAbi": "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "fromBlock": "10000000",
    "toBlock": "latest"
  }
}
```

### Batch Balance Queries
```json
{
  "name": "batch_token_balances",
  "arguments": {
    "chain": "mainnet",
    "queries": [
      {
        "tokenAddress": "0xA0b86a33E6441c1e4e9c08975a0c8246e8dB8C4F",
        "holderAddress": "0x742d35Cc6cF36C3e0C37d3f6D1D5e4f2C8F3E8A9",
        "label": "USDC Balance"
      },
      {
        "tokenAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "holderAddress": "0x742d35Cc6cF36C3e0C37d3f6D1D5e4f2C8F3E8A9",
        "label": "WETH Balance"
      }
    ]
  }
}
```

## 📋 Requirements

- **Runtime**: Bun (recommended) or Node.js
- **Dependencies**: viem, @envio-dev/hypersync-client, @modelcontextprotocol/sdk
- **Network Access**: Internet connection for blockchain RPC calls

## 🧪 Testing

The server includes a comprehensive test suite that validates all functionality:

### Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun run test:watch

# Run tests with coverage
bun run test:coverage

# Run type checking
bun run lint
```

### Test Coverage

The test suite covers:

- **ABI Signature Generation**: Function, event, and error signatures
- **Contract Interactions**: Detecting contracts vs EOAs, calling view functions
- **Balance Queries**: Native and token balances, batch operations
- **Block Information**: Latest and historical block data
- **Multi-chain Support**: Testing across different networks
- **Error Handling**: Invalid inputs, network failures, malformed requests
- **Data Type Handling**: BigInt serialization, address normalization
- **Performance**: Batch vs individual operation timing

### Example Usage

```bash
# Run example demonstrations
bun run examples
```

The examples file demonstrates:
- Function signature generation
- Contract vs EOA detection
- Smart contract function calls
- Balance queries
- Block information retrieval

### Test Structure

```
test.ts                 # Main test suite
examples.ts            # Usage examples and demonstrations
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
