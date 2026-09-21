# Contributing

## Setup

```bash
git clone https://github.com/hajnalben/web3-tools-mcp.git
cd web3-tools-mcp
npm install          # installs both workspaces
npm run build        # builds them in dependency order
cp .env.example .env # optional: fill in what you have, everything is optional
```

Run every command from the repo root — it is the workspace root, and the scripts below
delegate to the right package.

## Running your checkout

Point an MCP client at the local build rather than the published package:

```bash
claude mcp add --scope project web3-tools-dev -- node /absolute/path/to/web3-tools-mcp/mcp/dist/index.js
```

`npm run watch` recompiles on save; restart the client to pick up the new build.

To drive it by hand without a client:

```bash
node mcp/dist/index.js --help
MCP_HTTP_PORT=3457 MCP_TOKEN=dev node mcp/dist/index.js   # then POST JSON-RPC to /mcp
```

## Checks

```bash
npm run lint       # Biome — formatting and lint in one pass
npm run format     # ...and fix what it can
npm run typecheck  # tsc over src, test and scripts
npm test
```

CI runs all four. `npm run format` before committing is usually all it takes.

The tests reach live chains, and a public RPC serves only recent state. Anything needing
historical state, logs over a past range, `eth_simulateV1` or tracing skips itself when the
matching credential is absent, so `npm test` is green on a checkout with no `.env` at all —
it just covers less (88 of 135 tests). For the full run set `ALCHEMY_API_KEY` (or
`INFURA_API_KEY`, or `CUSTOM_RPC`) and `HYPERSYNC_API_KEY`; tracing also needs Foundry on
your PATH. The flags live in [mcp/test/setup.ts](mcp/test/setup.ts).

Run a single file while iterating: `npm test -w web3-tools-mcp -- test/preview.test.ts`, or
`cd mcp` and use `npx vitest` directly.

## Layout

Two workspaces. `mcp/` is the published `web3-tools-mcp`; `wallet-relay/` is the browser
signing relay, published as `web3-wallet-relay` because it can be hosted on its own. The
repo root holds only shared tooling, docs and the deployment files.

| Path | What lives there |
| --- | --- |
| [mcp/src/chains.ts](mcp/src/chains.ts) | Every supported chain, in one table |
| [mcp/src/client.ts](mcp/src/client.ts) | viem clients, RPC selection, explorer links |
| [mcp/src/tools/](mcp/src/tools/) | The MCP tools, grouped by domain; one default-exported object per file |
| [mcp/src/preview.ts](mcp/src/preview.ts) | Decode + simulate a transaction before signing |
| [mcp/src/clear-signing.ts](mcp/src/clear-signing.ts) | ERC-7730 lookups against the bundled registry index |
| [mcp/src/wallet-client.ts](mcp/src/wallet-client.ts) | Talks to the browser wallet relay |
| [mcp/src/walletconnect.ts](mcp/src/walletconnect.ts) | Phone signing |
| [mcp/src/oauth.ts](mcp/src/oauth.ts), [mcp/src/http-server.ts](mcp/src/http-server.ts) | Serving MCP over HTTP |
| [wallet-relay/](wallet-relay/) | The relay and its browser page, published separately as `web3-wallet-relay` |

## Adding a chain

Add one entry to `CHAINS` in [mcp/src/chains.ts](mcp/src/chains.ts). The `ChainName` type, the tool
schemas, RPC selection, explorer links, Hypersync routing and `--help` all derive from it.
`viem/chains` must export the chain; the `alchemy`, `infura`, `explorer` and `hypersync`
fields are each optional.

## Adding a tool

Add it to the relevant file in [mcp/src/tools/](mcp/src/tools/) with `createTool(title, description,
schema, handler)` and export it from that file's default object — [mcp/src/tools/index.ts](mcp/src/tools/index.ts)
registers everything it finds. Return `formatResponse(data)`; it serialises BigInts for you.

Let errors throw. The MCP SDK turns a thrown error into a tool error, so a `catch` that only
re-wraps the message is noise — catch only where you can add something the caller can act on.

## Commits and releases

Conventional commits (`feat:`, `fix:`, `chore:`), and note user-visible changes in
[CHANGELOG.md](CHANGELOG.md). Releases are cut from `main`: bump the version, run the checks,
then publish from the root, naming the workspace. The repo root itself is private and is
never published.

```bash
npm publish -w web3-wallet-relay   # first when both changed, so the server resolves it
npm publish -w web3-tools-mcp
```

A `prepack` script copies the shared documents into each package at publish time, so there
is one copy of each to keep current: the licence for both, and the root README and changelog
for the server — its npm page is the README you are reading this next to. They are
gitignored. A symlink will not do here: npm silently omits it and the package ships with no
README at all.

`wallet-relay/` keeps its own README, since it describes a different thing.
