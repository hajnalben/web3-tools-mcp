# Web3 Tools MCP Server

A Model Context Protocol (MCP) server for blockchain interactions using [viem](https://viem.sh/), [Etherscan](https://etherscan.io), and [Hypersync](https://docs.envio.dev/docs/HyperSync/overview).

## Features

- Multi-chain support (Ethereum, Arbitrum, Avalanche, Base, BNB Chain, Gnosis, Sonic, Optimism, Polygon, zkSync Era, Linea, Unichain)
- **🔐 Transaction signing** in a browser wallet (MetaMask, Rabby, Coinbase) or on your phone over WalletConnect
- Clear signing: transactions are decoded, named and simulated before you approve them
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
- `--walletconnect-project-id` or `WALLETCONNECT_PROJECT_ID` - Sign from a phone

**Wallet relay (all optional):**
- `WALLET_SERVER_URL` + `WALLET_TOKEN` - Use a hosted relay instead of a local one
- `PORT`, `HOST`, `WALLET_PUBLIC_URL` - Read by the relay itself when you host it

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
| Localhost | 1337 | ❌ |

## 🔐 Browser Wallet Integration

The server includes a built-in wallet interface for secure transaction signing without exposing private keys.

### How It Works

1. When you use a transaction tool (e.g., `send_native_token`), the server automatically:
   - Starts a local wallet relay on `http://127.0.0.1:3456` (the next free port up to 3460)
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

- **What it means** — for contracts in the [Ledger ERC-7730 registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry)
  (651 contracts, 3253 selectors), the protocol's own intent and field labels: *Supply ·
  Aave · Amount to supply: 250 USDC*, rather than `supply(address,uint256,address,uint16)`.
  The index ships gzipped (~60KB) and a weekly workflow opens a PR when it changes.
- **Decoded call** — otherwise the function name and named arguments, from the verified ABI
  (Sourcify / Etherscan) or, for unverified contracts, from selectors recovered from bytecode
  via [WhatsABI](https://github.com/shazow/whatsabi). Proxies resolve to their implementation.
- **Token amounts** — formatted with on-chain decimals and symbol; unlimited approvals are
  flagged explicitly.
- **Simulation** — `eth_simulateV1` (falling back to `eth_call` + `estimateGas`) reports the
  gas estimate and every ERC20 transfer the transaction would cause, marked in/out for your
  account. A reverting transaction is shown as such before you can approve it.

### Signing From a Phone

A phone cannot run the relay, so it does not have to: with a
[WalletConnect](https://dashboard.reown.com) project id the MCP server talks to your phone
wallet directly, over WalletConnect's own (end-to-end encrypted) relay. No page to load,
nothing to host.

```bash
npx web3-tools-mcp --walletconnect-project-id YOUR_PROJECT_ID
```

Then ask the agent to pair — `pair_phone_wallet` returns a QR code to scan with MetaMask,
Rabby, Trust or any WalletConnect wallet. The session is stored in
`~/.config/web3-tools-mcp/walletconnect.db`, so you pair once and it survives restarts.

While a phone is paired it signs everything; the browser page takes over again when it is
not. Either way the transaction is decoded and simulated first, and that summary comes back
in the tool response — your phone wallet shows its own preview, so read ours before you
approve theirs.

### Hosting Your Own

With WalletConnect there is nothing left that has to run next to you — no browser to open,
no page to reach — so the server can live in the cloud and still have your phone sign.

Run your own instance rather than sharing one: it keeps your wallet, your API keys and your
WalletConnect quota to yourself, and there is no multi-tenant server in the middle that
could send someone else's transaction to your phone.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hajnalben/web3-tools-mcp)

Render reads `render.yaml`, generates `MCP_TOKEN` for you and asks for
`WALLETCONNECT_PROJECT_ID` (free from [dashboard.reown.com](https://dashboard.reown.com)).
Or on [Fly](https://fly.io), where volumes come with any plan, so the pairing survives
redeploys without paying for a disk:

```bash
fly launch --no-deploy --copy-config          # pick a name and region
fly volumes create data --size 1
fly secrets set MCP_TOKEN=$(openssl rand -hex 24) WALLETCONNECT_PROJECT_ID=<id>
fly deploy
```

There is also a plain `Dockerfile`, so Railway, Cloud Run or your own box work the same way:

```bash
docker build -t web3-tools-mcp .
docker run -p 8080:8080 \
  -e MCP_TOKEN=<long random string> \
  -e WALLETCONNECT_PROJECT_ID=<id> \
  web3-tools-mcp
```

Or without any host at all:

```bash
MCP_HTTP_PORT=3457 MCP_TOKEN=<long random string> \
  WALLETCONNECT_PROJECT_ID=<id> npx web3-tools-mcp
```

```bash
claude mcp add --transport http web3-tools https://your-host/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Clients that cannot send a header — claude.ai connectors, and so the browser and phone apps
— use OAuth instead, which the server implements against the same credential: it sends them
to a page that asks for `MCP_TOKEN` and issues a token once you paste it. Nothing to
configure, no identity provider, no accounts. Set `MCP_PUBLIC_URL` to the address clients
reach you on, since OAuth metadata has to advertise it.

`MCP_TOKEN` is mandatory and the server refuses to start without it: anyone who can reach
`/mcp` while your phone is paired can push signing prompts at it. You would still approve
each one, but that is a phishing surface, not a feature.

Two things decide whether the pairing survives:

- **Keep the instance awake.** Sleeping drops the WalletConnect socket your phone pairing
  depends on, so the first transaction after an idle period waits for the host to wake
  (about a minute on a free tier) before it reaches your phone.
- **Give the session somewhere durable to live.** Most hosts have an ephemeral filesystem,
  so a plain file is lost on every redeploy and you rescan the QR. Either attach a volume
  and point `XDG_CONFIG_HOME` at it (what `render.yaml` does), or set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
  ([Upstash](https://upstash.com) has a free plan) and the session moves to Redis.

Render's own free Key Value instance is not an option for this: it has no persistence, so
the pairing would disappear on its next maintenance.

A hosted server skips the wallet relay entirely — there is no browser on the host to open —
so WalletConnect is its only way to sign.

### Hosting the Wallet Page

The relay lives in its own workspace, [`wallet-relay/`](wallet-relay), and depends only on express, cors
and ws (~4MB installed, against ~180MB for the MCP server). It deploys on its own to any host
that keeps a Node process alive and supports WebSockets — Render, Railway, Fly:

```bash
# On the host, from wallet-relay/ — PORT is provided by the platform
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
- `encode_function_data` - Encode a call's calldata from its ABI and arguments

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
- `wallet_status` - Check which signer is connected (phone or browser)
- `pair_phone_wallet` - Pair a phone wallet over WalletConnect, returning a QR to scan

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
- `debug_call` - Trace a call without broadcasting it, falling back to a local anvil fork

## Advanced Configuration

### Custom RPC
```bash
npx web3-tools-mcp --custom-rpc '{"mainnet":"https://my-rpc.com","base":"https://base-rpc.com"}'
```
Or set `CUSTOM_RPC` to the same JSON, which is what a hosted deployment does. See
[.env.example](.env.example) for every setting.

### RPC Failover
Automatic provider selection: Alchemy → Infura → Public RPCs

### Batch Operations
Many tools support batching for improved efficiency (contract calls, balances, ENS resolution).

## Requirements

- Node.js ≥ 20.0.0
- Internet connection for RPC calls

## Development

```bash
npm install && npm run build
npm run lint          # Biome; `npm run format` fixes what it can
npm run typecheck
npm test              # also: test:watch, test:ui
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for running your checkout against a client, the
repository layout, and how to add a chain or a tool. Release notes are in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT
