# Web3 Tools MCP Server

A Model Context Protocol (MCP) server for blockchain interactions using [viem](https://viem.sh/), [Etherscan](https://etherscan.io), and [Hypersync](https://docs.envio.dev/docs/HyperSync/overview).

## Features

- Multi-chain support (Ethereum, Arbitrum, Avalanche, Base, BNB Chain, Gnosis, Sonic, Optimism, Polygon, zkSync Era, Linea, Unichain)
- Smart contract interactions (read functions, ABI retrieval, source code)
- Contract simulation & gas estimation (simulate transactions, estimate costs)
- Real-time gas price tracking (legacy & EIP-1559)
- ENS resolution (names ↔ addresses, text records, avatars)
- Token balances (native & ERC20, batch queries)
- Event log queries with Hypersync acceleration
- Transaction tracing and analysis
- Storage slot reading with type decoding

## Quick Start

### Claude Code
```bash
claude mcp add --scope user --transport stdio web3-tools -- npx -y web3-tools-mcp
```

### Claude Desktop
Add to `config.json`:
```json
{
  "mcpServers": {
    "web3-tools": {
      "command": "npx",
      "args": ["-y", "web3-tools-mcp"]
    }
  }
}
```

## API Keys (Optional)

All API keys are optional. The server uses public RPCs by default. Add keys to unlock additional features:

**Configuration options:**
- `--etherscan-api-key` or `ETHERSCAN_API_KEY` - Enables contract ABI/source retrieval
- `--hypersync-api-key` or `HYPERSYNC_API_KEY` - Fast event queries (10-100x faster)
- `--alchemy-api-key` or `ALCHEMY_API_KEY` - Enhanced RPC reliability
- `--infura-api-key` or `INFURA_API_KEY` - Additional RPC provider
- `--custom-rpc` - Custom RPC URLs as JSON

**Get free API keys:**
- Etherscan: [etherscan.io/apis](https://etherscan.io/apis)
- Hypersync: [hypersync.xyz](https://hypersync.xyz)
- Alchemy: [alchemy.com](https://alchemy.com)
- Infura: [infura.io](https://infura.io)

**Example with API keys:**
```bash
# Claude Code
claude mcp add --scope user --transport stdio web3-tools -- npx -y web3-tools-mcp --etherscan-api-key YOUR_KEY --hypersync-api-key YOUR_KEY

# Environment variables
export ETHERSCAN_API_KEY=your_key
export HYPERSYNC_API_KEY=your_key
npx web3-tools-mcp
```

## Supported Networks

| Network | Chain ID | Hypersync |
|---------|----------|-----------|
| Ethereum Mainnet | 1 | ✅ |
| Arbitrum | 42161 | ✅ |
| Avalanche | 43114 | ✅ |
| Base | 8453 | ✅ |
| BNB Chain | 56 | ✅ |
| Gnosis | 100 | ✅ |
| Sonic | 146 | ✅ |
| Optimism | 10 | ✅ |
| Polygon | 137 | ✅ |
| zkSync Era | 324 | ✅ |
| Linea | 59144 | ✅ |
| Unichain | 130 | ✅ |
| Localhost | 31337 | ❌ |

## Available Tools

### Signatures
- `get_function_signature` - Generate 4-byte function selectors
- `get_event_signature` - Generate 32-byte event topic0 hashes
- `get_error_signature` - Generate 4-byte error selectors

### Contract Info
- `get_contract_abi` - Get ABI with proxy detection and verification status
- `get_contract_source_code` - Get verified source code with proxy support
- `get_contract_source_file` - Retrieve specific source file from cache
- `is_contract` - Check if address is contract or EOA

### Contract Interaction
- `call_contract_function` - Call view/pure functions (supports batch)

### Gas & Simulation
- `simulate_contract` - Simulate contract calls without broadcasting (includes gas estimate)
- `estimate_gas` - Estimate gas cost for any transaction
- `get_gas_price` - Get current gas prices (legacy & EIP-1559)

### ENS
- `resolve_ens_name` - ENS name → address
- `reverse_resolve_ens` - Address → ENS name
- `get_ens_text_record` - Get text records (avatar, email, twitter, etc.)
- `get_ens_avatar` - Get avatar URI
- `batch_resolve_ens_names` - Batch resolve multiple names

### Balances
- `get_balance` - Get native or ERC20 balances (supports batch)

### Events & Logs
- `get_logs` - Query and decode events with Hypersync fallback

### Advanced
- `get_storage_at` - Read storage slots with type decoding
- `get_block_info` - Get block data (timestamp, hash, etc.)
- `trace_transaction` - Trace execution (call tree, VM, state diff)

## Advanced Configuration

### Custom RPC
```bash
npx web3-tools-mcp --custom-rpc '{"mainnet":"https://my-rpc.com","base":"https://base-rpc.com"}'
```

### RPC Failover
Automatic provider selection: Alchemy → Infura → Public RPCs

### Batch Operations
Many tools support batching for improved efficiency (contract calls, balances, ENS resolution).

## Requirements

- Node.js ≥ 20.0.0
- Internet connection for RPC calls

## Testing

```bash
npm test              # Run all tests
npm run test:watch   # Watch mode
npm run test:ui      # UI mode
```

## License

MIT
