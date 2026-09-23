<div align="center">

# web3-tools-mcp

**Your agent proposes the transaction. You approve it — in your own wallet, on your phone.** 📱

30 MCP tools for reading any EVM network and signing transactions in *your own* wallet.
Every transaction is decoded, named and simulated before you approve it.

[![npm](https://img.shields.io/npm/v/web3-tools-mcp?color=%233856d6&label=npm)](https://www.npmjs.com/package/web3-tools-mcp)
[![downloads](https://img.shields.io/npm/dm/web3-tools-mcp?color=%233856d6)](https://www.npmjs.com/package/web3-tools-mcp)
[![node](https://img.shields.io/node/v/web3-tools-mcp?color=%233856d6)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/web3-tools-mcp?color=%233856d6)](LICENSE)

</div>

**Claude Desktop, Cursor, VS Code, Windsurf** and **Claude Code** launch it on your machine.
One entry in that client's MCP config:

```json
{ "mcpServers": { "web3-tools": { "command": "npx", "args": ["-y", "web3-tools-mcp"] } } }
```

Each app keeps that config somewhere different —
[the file paths are below ↓](#-setup). You need Node.js ≥ 20; `npx` fetches the rest.

**ChatGPT, Grok** and **claude.ai** cannot launch anything locally — they only reach a URL.
[Host it once ↓](#-hosting) and add it as a connector, and there is nothing running on your
laptop at all.

It runs with no API keys at all — reads on recent state work on public RPCs, and signing
previews still decode. Keys widen what it can reach; [see what each unlocks ↓](#-setup).

## 🔍 No blind signing

Your agent proposes. You see what it actually does, then approve it in your own wallet.
The server never holds a private key.

<table>
<tr><th>What a wallet usually shows</th><th>What you get here</th></tr>
<tr><td>

```
To    0x87870Bca…B4fA4E2
Data  0x617ba037000000000…
Value 0
```

*Unknown contract, unknown call.*

</td><td>

```
Supply · Aave V3
Amount to supply   250 USDC
On behalf of       you

−250 USDC  →  +250 aUSDC
184,207 gas · will succeed
```

</td></tr>
</table>

Four things go into that panel:

| | | |
| --- | --- | --- |
| 🏷️ | **Intent** | Field labels straight from the protocol, via the [ERC-7730 registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) — 600+ contracts, 3,000+ selectors, bundled offline and refreshed weekly by a PR |
| 🔎 | **Decoded call** | Otherwise the function and named arguments, from the verified ABI (Sourcify / Etherscan) — or recovered straight from bytecode with [WhatsABI](https://github.com/shazow/whatsabi) when a contract is unverified. Proxies resolve to their implementation |
| 💰 | **Real amounts** | Formatted with on-chain decimals and symbol. Unlimited approvals are called out |
| 🧪 | **Simulation** | `eth_simulateV1` reports the gas and every ERC-20 movement the transaction would cause, marked in or out. A transaction that would revert says so before you can sign it |

## 📱 Sign on your phone

**Your agent runs wherever it likes. Your keys stay in your pocket.**

A phone can't host a local signing page — so it doesn't have to. Point the server at a
[WalletConnect](https://dashboard.walletconnect.com) project id and it talks to your wallet
app directly, over WalletConnect's own end-to-end encrypted relay. Nothing to load, nothing
to host, no browser anywhere in the path.

```bash
npx web3-tools-mcp --walletconnect-project-id YOUR_PROJECT_ID
```

| | |
| --- | --- |
| 🌍 | **Works hosted.** A deployed server can sign on your phone with nothing running beside you — and now in your browser too, from the page it serves itself |
| 📷 | **Pair once.** Ask the agent to run `pair_phone_wallet`. You get a QR to scan — or, when the agent is already on your phone, a tap-through link straight into your wallet app |
| 💾 | **It sticks.** The session is stored on disk (or in Redis when hosted), so it survives restarts and redeploys. Pair once, not once a day |
| ✍️ | **You choose each time.** Every signing tool takes a required `signWith`, so the agent asks whether this one goes to your phone or the browser. A paired phone never quietly claims a request |
| 🧾 | **You still see the decode.** The full preview comes back in the tool response — your wallet shows its own summary, so read ours before you approve theirs |
| 🔌 | **Drop it any time.** `disconnect_phone_wallet` clears every session and pairing |

Works with **MetaMask · Rabby · Trust · Coinbase Wallet** — anything speaking WalletConnect v2.

> ### ☁️ + 📱 The combination that unlocks everything
>
> Because signing no longer needs anything next to you, the server can live in the cloud and
> **still** have your phone sign. Host it once and every client you own — laptop, browser,
> the Claude phone app — drives the same instance, with approvals landing on your phone
> wherever you are. [Hosting takes about a minute ↓](#-hosting)

<details>
<summary>💻 <b>On a laptop?</b> Sign in the wallet extension you already run — zero configuration</summary>

Nothing to install and nothing to set up: the server serves a local page, and that page talks
to whatever wallet extension your browser already has. The first transaction opens it, you
connect MetaMask, Rabby or Coinbase once, and every later request lands in that same tab.

**One relay per machine** — all your editor sessions share the page, so you connect once and
a transaction from any session shows up there. The page and the server are both clients of a
local relay on `127.0.0.1:3456` (next free port up to 3460), authenticated with a pairing
token carried in the URL fragment (`#t=…`) of the link the server prints. The token lives in
`~/.config/web3-tools-mcp/relay-token` (mode 0600) — delete it to rotate.

Works with MetaMask, Rabby, Coinbase Wallet, and any EIP-1193 browser wallet. `wallet_status`
returns the page URL any time you want to open it yourself.

</details>

## 🧰 Tools

<details>
<summary><b>30 tools</b> — reads, writes, ENS, logs, tracing</summary>

### ✍️ Transactions & signing
| Tool | |
| --- | --- |
| `write_contract` | Send a transaction calling a state-changing function, via your wallet |
| `send_native_token` | Send ETH or a native token |
| `send_erc20_token` | Send an ERC-20 |
| `sign_message` | Sign a message |
| `wallet_status` | Which signer is connected — phone or browser |
| `pair_phone_wallet` | Pair a phone over WalletConnect, returns a QR |
| `disconnect_phone_wallet` | Drop every WalletConnect session and pairing |

The four signing tools take a required `signWith` of `phone` or `browser`. There is no
default on purpose — the agent has to ask you, so a request never lands on a device you are
not holding.

### 📜 Contracts
| Tool | |
| --- | --- |
| `read_contract` | Read state via view/pure functions — batched, no wallet, no gas |
| `simulate_contract` | Simulate without broadcasting, with gas |
| `get_contract_abi` | ABI, with proxy detection and verification status |
| `get_contract_source_code` | Verified source, proxies included |
| `get_contract_source_file` | One file out of the cached source |
| `is_contract` | Contract or EOA |
| `encode_function_data` | Calldata from an ABI and arguments |
| `get_function_signature` | 4-byte selector |
| `get_event_signature` | 32-byte topic0 |
| `get_error_signature` | 4-byte error selector |

### ⛓️ Chain data
| Tool | |
| --- | --- |
| `get_balance` | Native or ERC-20 balances — batched |
| `get_logs` | Query and decode events, with Hypersync fallback |
| `get_block_info` | Block data |
| `get_storage_at` | Storage slots, with type decoding |
| `get_gas_price` | Current gas — legacy and EIP-1559 |
| `estimate_gas` | Gas for any transaction |
| `trace_transaction` | Call tree, VM trace, state diff |
| `debug_call` | Trace a call without broadcasting, falling back to a local anvil fork |

### 🏷️ ENS
| Tool | |
| --- | --- |
| `resolve_ens_name` | Name → address |
| `reverse_resolve_ens` | Address → name |
| `get_ens_text_record` | Text records |
| `get_ens_avatar` | Avatar URI |
| `batch_resolve_ens_names` | Many names at once |

</details>

<details>
<summary>🌐 <b>13 networks</b></summary>

| Network | Chain ID | Hypersync |
| --- | --- | --- |
| Ethereum | 1 | ✅ |
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

Adding one is a single entry in [`mcp/src/chains.ts`](mcp/src/chains.ts).

</details>

## 🔧 Setup

<details open>
<summary>🖥️ <b>Local clients</b> — where the config file lives</summary>

Add the entry below to your client's MCP config, then restart the app. Every one of these
also has a UI route that creates the file for you, which is usually quicker than finding it:

| Client | Config file | Or via the UI |
| --- | --- | --- |
| **Claude Desktop** | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows `%APPDATA%\Claude\claude_desktop_config.json`<br>Linux `~/.config/Claude/claude_desktop_config.json` | Settings → Developer → **Edit Config** |
| **Cursor** | `~/.cursor/mcp.json` (all projects)<br>`.cursor/mcp.json` (this project) | Settings → Tools & MCP → **Add new MCP server** |
| **VS Code** | `.vscode/mcp.json` (workspace)<br>or your user profile | Command Palette → **MCP: Add Server** |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json`<br>global only, no per-project | Cascade panel → **MCP** icon |

```json
{
  "mcpServers": {
    "web3-tools": {
      "command": "npx",
      "args": ["-y", "web3-tools-mcp"],
      "env": {
        "WALLETCONNECT_PROJECT_ID": "<your project id>",
        "ETHERSCAN_API_KEY": "<your key>"
      }
    }
  }
}
```

Drop the whole `env` block if you have no keys yet: the server runs without them, with less
reach. **🔑 API keys** below says exactly what each one turns on.

> ⚠️ **VS Code is the exception.** Its `mcp.json` nests servers under `"servers"`, not
> `"mcpServers"` — paste the block above unchanged and it is silently ignored:
>
> ```json
> { "servers": { "web3-tools": { "command": "npx", "args": ["-y", "web3-tools-mcp"] } } }
> ```

</details>

<details>
<summary>⌨️ <b>Claude Code</b></summary>

```bash
claude mcp add --scope user --transport stdio web3-tools -- npx -y web3-tools-mcp
```

Or, against a hosted instance:

```bash
claude mcp add --transport http web3-tools https://your-host/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

</details>

<details>
<summary>🤖 <b>ChatGPT</b>, 🦾 <b>Grok</b> and 🌐 <b>claude.ai</b> — remote only</summary>

None of these can launch a local process, so they need a hosted instance:
[deploy one ↓](#-hosting), then point the client at `https://your-host/mcp`.

**ChatGPT** — Settings → Apps & Connectors → Advanced → enable Developer mode, then
**Create**. Give it a name and the server URL. The URL has to include the `/mcp` path; that
is the usual mistake. Pick OAuth and it walks you through the login page the server serves,
or pick token and paste `MCP_TOKEN`. Needs a paid plan.

**Grok** — [grok.com/connectors](https://grok.com/connectors) → **New Connector** →
**Custom**, then the same URL and authentication. Needs a paid plan.

**claude.ai** — Settings → Connectors → **Add custom connector**, then the URL. It uses
OAuth, which the server implements against `MCP_TOKEN`: it shows a page asking for the
token and issues one once you paste it.

Once connected, pair your phone and approvals arrive there — no laptop in the loop at all.

</details>

<details>
<summary>🔑 <b>API keys</b> — none required, but they decide how much works</summary>

Nothing here is required to start, and the server will not refuse to run without any of it.
What you lose is reach, not stability — so here is the honest version:

| Key | Free from | Without it |
| --- | --- | --- |
| `WALLETCONNECT_PROJECT_ID` | [walletconnect](https://dashboard.walletconnect.com) | 📱 **No phone signing at all.** Browser wallet only, so a hosted instance has no way to sign |
| `ALCHEMY_API_KEY`<br>or `INFURA_API_KEY`<br>or `CUSTOM_RPC` | [alchemy](https://alchemy.com) · [infura](https://infura.io) | **No historical state.** Public endpoints answer `403 Archive requests require a personal token`, which takes out balances, storage and calls at a past block, event ranges, and `trace_transaction` |
| `ETHERSCAN_API_KEY` | [etherscan](https://etherscan.io/apis) | `get_contract_abi`, `get_contract_source_code` and `get_contract_source_file` refuse. Signing previews still decode — they try Sourcify first, then recover the ABI from bytecode |
| `HYPERSYNC_API_KEY` | [envio](https://envio.dev) | Event queries fall back to plain RPC — slower, and past ranges then need one of the provider keys above |

So with nothing configured you get current balances, contract reads, gas, ENS, simulation
and browser signing. Add `WALLETCONNECT_PROJECT_ID` for your phone and one provider key for
history, and everything above lights up.

Every key has a matching flag (`--etherscan-api-key`, …), RPC selection falls back
Alchemy → Infura → public, and `CUSTOM_RPC` overrides all of it.
`npx web3-tools-mcp --help` lists them; [.env.example](.env.example) documents each one.

```bash
npx web3-tools-mcp --etherscan-api-key KEY --walletconnect-project-id ID
```

</details>

## 🚀 Hosting

With WalletConnect nothing has to run next to you, so the server can live in the cloud and
still have your phone sign. Run your own rather than sharing one: your wallet, your keys,
your quota, and no multi-tenant server in the middle that could push someone else's
transaction at your phone.

<a href="https://render.com/deploy?repo=https://github.com/hajnalben/web3-tools-mcp"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32"></a>
&nbsp;
<a href="https://fly.io/docs/launch/"><img src="https://img.shields.io/badge/Deploy%20on-Fly.io-8b5cf6?style=for-the-badge&logo=flydotio&logoColor=white" alt="Deploy on Fly.io" height="32"></a>

**Render** reads `render.yaml`, generates `MCP_TOKEN` and asks for `WALLETCONNECT_PROJECT_ID`
— genuinely one click.

**Fly** ships no deploy button, so it is four commands. Worth it for a personal instance:
volumes come with any plan, so the pairing survives redeploys without paying for a disk.

```bash
fly launch --no-deploy --copy-config
fly volumes create data --size 1
fly secrets set MCP_TOKEN=$(openssl rand -hex 24) WALLETCONNECT_PROJECT_ID=<id>
fly deploy
```

<details>
<summary>🐳 <b>Docker, and connecting a client</b></summary>

There is a plain `Dockerfile` too, so Railway, Cloud Run or your own box work the same way:

```bash
docker run -p 8080:8080 \
  -e MCP_TOKEN=<long random string> \
  -e WALLETCONNECT_PROJECT_ID=<id> \
  web3-tools-mcp
```

Then point a client at it:

```bash
claude mcp add --transport http web3-tools https://your-host/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Clients that cannot send a header — claude.ai connectors, and the browser and phone apps —
use OAuth, which the server implements against the same credential: it shows a page asking
for `MCP_TOKEN` and issues a token once you paste it. No identity provider, no accounts. Set
`MCP_PUBLIC_URL` to the address clients reach you on, since OAuth metadata must advertise it.

> 🔐 **`MCP_TOKEN` is mandatory** and the server refuses to start without it. Anyone who
> reaches `/mcp` while your phone is paired can push signing prompts at it. You would still
> approve each one, but that is a phishing surface, not a feature.

Two things decide whether the pairing survives:

- ⏰ **Keep the instance awake.** Sleeping drops the WalletConnect socket, so the first
  transaction after an idle period waits for the host to wake — about a minute on a free tier.
- 💾 **Give the session somewhere durable.** Most hosts have an ephemeral filesystem, so a
  plain file is lost on redeploy and you rescan the QR. Attach a volume and point
  `XDG_CONFIG_HOME` at it (what `render.yaml` does), or set `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` ([Upstash](https://upstash.com) has a free plan).

Render's free Key Value instance is not an option here — no persistence, so the pairing
disappears at its next maintenance.

Both signers work on a hosted instance. The signing page is served from the same port as
`/mcp`, so `https://your-host/#t=<relay token>` is your wallet page — no second service to
deploy. Ask the agent for `wallet_status` to get the link; it is behind `MCP_TOKEN`, and the
relay token is minted fresh each boot rather than stored, so the URL changes when you
redeploy.

</details>

<details>
<summary>🖇️ <b>Host the signing page</b> separately</summary>

The relay is its own package, [`wallet-relay/`](wallet-relay) — express, cors and ws, about
4 MB installed against ~180 MB for the server. It runs anywhere that keeps a Node process
alive and supports WebSockets.

```bash
WALLET_TOKEN=<long random string> \
WALLET_PUBLIC_URL=https://wallet.example.com \
npx web3-wallet-relay
```

Then point the server at it with `WALLET_SERVER_URL` and the same `WALLET_TOKEN`.
`render.yaml` deploys it as-is. Anyone holding `WALLET_TOKEN` can send your browser a
transaction to sign — treat it like a password, and always serve over HTTPS.

The pairing link the server prints carries a different token, derived from that one, which
can only answer signing requests and not make them. Sharing a pairing link is therefore not
the same as sharing `WALLET_TOKEN` — but it still lets whoever has it act as your wallet
page, so a signing request can reach them instead of you.

Locally nothing changes: the server embeds the same relay.

</details>

## 🔄 How signing works

1. 🤖 A transaction tool runs. The server decodes and simulates the transaction first.
2. 📨 It goes to the signer you picked — your phone, or the browser page.
3. 👀 You read the summary and approve or reject in your wallet.
4. 🔗 The result, with an explorer link, comes back to the agent.

## 🛠️ Development

```bash
npm install
npm run lint       # Biome; npm run format fixes what it can
npm run typecheck
npm test
```

Two workspaces: [`mcp/`](mcp) is this server, [`wallet-relay/`](wallet-relay) is the signing
page. [CONTRIBUTING.md](CONTRIBUTING.md) covers running a checkout against a client, the
layout, and how to add a chain or a tool. Releases: [CHANGELOG.md](CHANGELOG.md).

Requires Node.js ≥ 20.

## 📄 License

MIT
