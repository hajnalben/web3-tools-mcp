# Changelog

Notable changes per release. Dates are release dates; unreleased work sits at the top.

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
