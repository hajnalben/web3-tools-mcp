# Web3 Tools MCP Server

A Model Context Protocol (MCP) server for blockchain interactions using [viem](https://viem.sh/), [Etherscan](https://etherscan.io), and [Hypersync](https://docs.envio.dev/docs/HyperSync/overview).

## Features

- Multi-chain support (Ethereum, Arbitrum, Avalanche, Base, BNB Chain, Gnosis, Sonic, Optimism, Polygon, zkSync Era, Linea, Unichain)
- **🔐 Transaction Signing via Browser Wallet** (MetaMask, Rabby, Coinbase Wallet)
- Smart contract interactions (read & write functions, ABI retrieval, source code)
- Contract simulation & gas estimation (simulate transactions, estimate costs)
- Real-time gas price tracking (legacy & EIP-1559)
- ENS resolution (names ↔ addresses, text records, avatars)
- Token balances & transfers (native & ERC20, batch queries)
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

## 🔐 Browser Wallet Integration

The server includes a built-in wallet interface for secure transaction signing without exposing private keys.

### How It Works

1. When you use a transaction tool (e.g., `send_native_token`), the server automatically:
   - Starts a local wallet relay on `http://localhost:3456`
   - Opens your browser to connect your wallet (MetaMask, Rabby, Coinbase Wallet, etc.)
2. You connect your wallet once in the browser
3. The transaction is decoded and simulated, then the request appears in the browser for approval
4. Sign or reject transactions directly in your wallet

The browser page and the MCP server are both clients of the relay, authenticated with a
pairing token that travels in the URL fragment (`#t=…`) of the link the server prints.

**One relay per machine.** Every local MCP process looks for an existing relay on ports
3456-3460 before starting one, so all your editor sessions share a single wallet page —
connect once, and a transaction from any session lands in that tab. They authenticate with
a token kept in `~/.config/web3-tools-mcp/relay-token` (mode 0600); delete it to rotate.

### Before You Sign

Each request shows what the transaction actually does, not just calldata:

- **Decoded call** — function name and named arguments, from the verified ABI (Sourcify /
  Etherscan) or, for unverified contracts, from selectors recovered from bytecode via
  [WhatsABI](https://github.com/shazow/whatsabi). Proxies are resolved to their implementation.
- **Token amounts** — formatted with on-chain decimals and symbol; unlimited approvals are
  flagged explicitly.
- **Simulation** — `eth_simulateV1` (falling back to `eth_call` + `estimateGas`) reports the
  gas estimate and every ERC20 transfer the transaction would cause, marked in/out for your
  account. A reverting transaction is shown as such before you can approve it.

### Hosting the Wallet Page

The relay lives in its own workspace, [`wallet/`](wallet), and depends only on express, cors
and ws (~4MB installed, against ~180MB for the MCP server). It deploys on its own to any host
that keeps a Node process alive and supports WebSockets — Render, Railway, Fly:

```bash
# On the host, from wallet/ — PORT is provided by the platform
WALLET_TOKEN=<long random string> WALLET_PUBLIC_URL=https://wallet.example.com npm start
```

Then point the MCP server at it:

```bash
export WALLET_SERVER_URL=https://wallet.example.com
export WALLET_TOKEN=<the same token>
npx web3-tools-mcp
```

`render.yaml` deploys the relay as-is (`rootDir: wallet`, so only its dependencies are
installed). Anyone holding `WALLET_TOKEN` can send your browser transactions to sign, so
treat it like a password and always serve the page over HTTPS.

Locally nothing changes: the MCP server embeds the same relay and `npm run start:wallet`
runs it from the workspace.

### Supported Wallets

- MetaMask
- Rabby
- Coinbase Wallet
- Any browser wallet supporting EIP-1193

### Manual Access

Visit the wallet URL printed by the server (`wallet_status` also returns it) anytime to:
- Check wallet connection status
- See pending transactions
- View transaction history

**Note:** The relay starts automatically with the MCP server. No additional setup required.

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
- `call_contract_write` - Execute state-changing contract functions via browser wallet
- `simulate_contract` - Simulate contract calls without broadcasting (includes gas estimate)

### Transactions (Browser Wallet Required)
- `send_native_token` - Send ETH/native tokens to an address
- `send_erc20_token` - Send ERC20 tokens to an address
- `sign_message` - Sign messages with your wallet
- `wallet_status` - Check wallet connection status

### Gas & Simulation
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
