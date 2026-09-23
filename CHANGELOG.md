# Changelog

Notable changes per release. Dates are release dates; unreleased work sits at the top.

## [3.0.0] — 2026-09-23

The theme is multi-tenancy: one server can now carry several people without their wallets
meeting. Nothing turns that on by itself — a server still authenticates its deployment
rather than a person, so everyone on it remains the same user until something issues
distinct identities.

`web3-wallet-relay` goes to 2.0.0 alongside, and `web3-tools-mcp` pins it exactly: the
handshake changed, so a mismatched pair cannot pair at all.

### Changed

- **Tracing uses a node that is already running, instead of starting one.** Each trace used
  to spawn an Anvil fork and kill it afterwards, which on a shared server is unbounded child
  processes. It now talks to `ANVIL_RPC_URL`, defaulting to `127.0.0.1:8545` — any node
  exposing `debug_traceCall` will do, and a provider whose RPC can trace is still preferred.

  Anvil serves no block below its own fork height, so replaying an older transaction means
  re-forking the node there, which clears whatever state it held. That only happens with
  `ANVIL_ALLOW_RESET=1`; without it the trace fails and says so. The node is returned to
  head afterwards rather than left pinned to an old block.

  Re-forking reads state from the chain's configured RPC, so tracing an old transaction
  needs one with archive access — a provider key or a `CUSTOM_RPC`. The hard-coded archive
  endpoint for Arbitrum is gone.

### Added

- **Several phone wallets can be paired at once** — a hot wallet and a hardware one, say.
  `pair_phone_wallet` used to report that one was already paired and stop; it now pairs, and
  says which wallets the new one joins. `wallet_status` lists them all, and the signing
  tools take `account` to choose between them, as does `disconnect_phone_wallet` — which
  still clears everything when no account is named. With one wallet paired nothing changes,
  and omitting `account` uses the most recently paired.

### Security

- **Signing is scoped to whoever asked for it.** Every tool call now carries the identity it
  is acting for, and both signers are keyed by it: a wallet page reaches only the person it
  belongs to, and a phone session is matched by a binding recorded when it was approved.
  Sessions were previously picked as "the most recently paired", so on a server with more
  than one user a signing request could be sent to somebody else's phone — and
  `disconnect_phone_wallet` ended everybody's sessions. Phones paired before this keep
  working on a single-user server.

- **Relay tokens name the room they admit you to**, signed by the relay's secret, so the
  server can mint a pair per person and the relay needs no record of who exists. Naming a
  room without the signature is refused.

- **The relay bounds what one room can take.** A frame over 512KB is refused, rather than
  the 100MB the WebSocket library would otherwise accept, and a room holds at most 16
  connections. Neither is reachable in normal use — contract creation calldata tops out
  near 98KB of hex, and a person needs a wallet tab or two plus a requester per editor
  session — but without them one connection could exhaust the process for everybody else.

- **`localhost` is not a chain a hosted server will accept.** It resolves to the machine
  running the server, so on a shared deployment it was a way to aim requests at whatever
  that host had listening on its own loopback. Self-hosted runs are unaffected.

  The same switch keeps a hosted server from probing its own loopback for a tracing node
  and from opening a browser on itself. The CLI flips it with `MCP_HTTP_PORT`; a host that
  assembles its own server from the library sets `MCP_HOSTED=1` before importing it, and
  `startHttpServer` refuses to run without one of the two.

- **The relay drops a frame it cannot use instead of dying on it.** A peer that had
  authenticated could send `null` — valid JSON, not an object — and take the relay down,
  along with the MCP server it is embedded in when hosted. Tokens are also compared in
  constant time.

- **A request signs from the account it named.** With a session exposing several
  addresses, `account` chose the session but the transaction was still sent from its first
  address. Concurrent pairings on one server no longer overwrite each other's ownership
  record, and a hosted server closes a person's idle relay socket after ten minutes
  instead of holding one open per person forever.

- **The signing page and the MCP server now hold different tokens.** One token granted both
  roles, and a relay client may either answer transaction proposals (the page) or make them
  (the server). The page's token is the exposed one — it rides in a URL you open, keep in
  history and show on screen — so anyone who saw it could push proposals at your wallet.
  The page's token is derived from the server's and grants the signing role only; the
  server's never reaches a browser.

  **Re-open the signing page from the link the server prints.** Pairing URLs issued before
  this carry a token the relay no longer accepts for signing.

- **The signing page no longer takes the transaction's value from the preview.** The preview
  travels with the request and is forwarded untouched, so a hostile requester could state
  one amount while the calldata did another. The value is now read from the transaction
  itself, and the calldata is shown even when a decoded view is available, so a claim that
  disagrees with the bytes is visible on the same screen.

- **A relay can serve several people without their wallets meeting.** Connections resolve to
  a room, and a transaction only ever reaches a page in the same one. Previously the relay
  offered each transaction to whichever page was first in its pool, broadcast the first
  signer's address to every requester, and let any page answer a request by its id. A
  self-hosted relay keeps one room and behaves exactly as before.

## [2.0.2] — 2026-09-22

### Fixed

- **Phone signing hung, for real this time.** 2.0.1 had the right symptom but the wrong
  cause, and did not fix it. Naming the agent in `pair_phone_wallet` started a second
  WalletConnect client, because the handler had already started one to check for an
  existing session. The first client's engine kept running, and its heartbeat sweeps
  "orphaned" subscriptions against its own, empty session list — so two seconds after the
  new session settled, it unsubscribed the session's topic. Every reply the wallet sent
  after that went nowhere. Closing the old transport, which is what 2.0.1 did, never
  stopped that heartbeat.

  Now there is only ever one client. The agent's name is set before it starts, and a
  running client is never replaced. If one already exists, the wallet dialog keeps the
  earlier name, which costs far less than signing that silently hangs.

  Found by trapping every `unsubscribe` with a stack trace. If you paired under 2.0.0 or
  2.0.1, run `disconnect_phone_wallet` and pair again.

## [2.0.1] — 2026-09-22

### Fixed

- **A phone signature could never come back.** Naming the agent in `pair_phone_wallet`
  replaces the WalletConnect client, because its metadata is fixed at init — but the old
  one was dropped without being closed. Two clients then shared one storage directory and
  overwrote each other's subscription record, so the surviving session was left subscribed
  to nothing: a request reached the wallet, you approved it, and the reply was published
  where nobody was listening. The tool simply hung. The replaced client is closed now.

  If you hit this, re-pair after upgrading — the stored session's subscription is what was
  lost, and a fresh client rebuilds it.

## [2.0.0] — 2026-09-21

The theme is signing: where a transaction can be signed, and what you are told before you
sign it.

### Added

- **Sign from a phone over WalletConnect.** `pair_phone_wallet` once by QR, and the server
  can request signatures from a wallet app with no browser and no local relay. Sessions
  survive restarts; `disconnect_phone_wallet` clears them.
- **Host the server yourself.** MCP over Streamable HTTP, with one-click deploys for Render
  and Fly. Pairings persist on a volume, or in Redis where the filesystem is ephemeral.
- **OAuth**, so clients that cannot send an `Authorization` header — claude.ai connectors,
  and anything driving them — can connect. `MCP_TOKEN` stays the single credential; there
  are no user accounts to manage.
- **Clear signing.** Transactions are described from the ERC-7730 registry (651 contracts,
  3253 selectors, bundled) instead of shown as raw calldata.
- **Preview before signing** — the transaction is decoded and simulated, so the amounts,
  the protocol and the resulting asset changes are on screen before you approve.
- **Redesigned browser signing page**, with explorer links, contract labels and a persistent
  wallet connection.
- `CUSTOM_RPC` as an environment alias for `--custom-rpc`, so a hosted deployment can set
  per-chain RPCs.

### Changed

- **Browser signing works on a hosted server.** The signing page is served from the same
  port as `/mcp`, so a deployment offers both signers without a second service. Its relay
  token is minted per boot rather than persisted: the pairing URL is fetched through
  `wallet_status`, which already requires `MCP_TOKEN`, so nobody has to type it.
- **The relay checks the WebSocket `Origin`.** WebSockets ignore the same-origin policy and
  the local port is predictable, so any page you had open could previously reach the relay
  and either push a transaction at your wallet or register as a signer to intercept one.
  A browser on any other origin is now refused before it can present a token at all;
  non-browser clients send no `Origin` and are still gated by the token.
- **Signing tools now require `signWith`.** `send_native_token`, `send_erc20_token`,
  `write_contract` and `sign_message` take `phone` or `browser`, with no default, so the
  agent has to ask rather than silently preferring a paired phone. Asking for a signer that
  is not available now fails with a message saying how to fix it, instead of falling back
  to the other one.
- **Renamed two tools.** `call_contract_function` is now `read_contract`, and
  `call_contract_write` is now `write_contract` — the old pair gave no hint which one
  spent gas. The names now match viem's, and a saved prompt naming the old ones will need
  updating.
- Every supported chain now lives in one table ([mcp/src/chains.ts](mcp/src/chains.ts)). Adding a
  chain is a single entry; the tool schemas, RPC selection, explorer links, Hypersync
  routing and `--help` all derive from it.
- Tool errors surface the underlying failure rather than a re-wrapped message that hid it.
- Biome formats and lints the repo; CI runs lint, typecheck and tests.
- `web3-wallet-relay` 1.2.0 moves to express 5, matching the server.

### Fixed

- `get_logs` over Hypersync was broken three ways: indexed addresses were sent as 20-byte
  topics and rejected outright, an unfiltered topic position was dropped rather than left
  empty so later filters matched the wrong parameter, and matched logs came back with no
  decoded arguments at all. The fallback now works without an RPC provider key.
- Explorer links are omitted on `localhost` instead of pointing at Etherscan.
- The public RPC fallback for Unichain pointed at Sepolia, not mainnet.
- A hosted server no longer advertises a browser relay it cannot reach.
- The wallet approval dialog names the agent requesting the signature, not the source repo.

## [1.6.0] — 2026-09

- Wallet relay extracted to its own package, `web3-wallet-relay`, so the signing page can be
  hosted separately.
- Token-paired relay replacing the old wallet server; focuses an open tab rather than
  opening another.
- Report why a wallet refused a request, instead of a generic failure.
- Repair dead public RPC defaults.

## [1.4.0] — 2026-08

- Anvil-backed `trace_transaction` and `debug_call`.
- Multicall support on Anvil.

## [1.3.x] — 2025

- Transaction tools and wallet write functions.
- RPC connectivity test suite.
- Fix wallet server port conflicts ([#1](https://github.com/hajnalben/web3-tools-mcp/issues/1)).

## [1.2.0] — 2025

- Support for 12 networks with per-provider RPC configuration.
- ENS tools with multi-chain support.

## [1.0.0] — 2025

- Initial release: balances, contract reads, ABIs, logs, gas and block data over viem,
  Etherscan and Hypersync.
