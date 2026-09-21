# Contributing

## Setup

```bash
git clone https://github.com/hajnalben/web3-tools-mcp.git
cd web3-tools-mcp
npm install          # also builds the wallet relay workspace
cp .env.example .env # optional: fill in what you have, everything is optional
npm run build
```

## Running your checkout

Point an MCP client at the local build rather than the published package:

```bash
claude mcp add --scope project web3-tools-dev -- node /absolute/path/to/web3-tools-mcp/dist/index.js
```

`npm run watch` recompiles on save; restart the client to pick up the new build.

To drive it by hand without a client:

```bash
node dist/index.js --help
MCP_HTTP_PORT=3457 MCP_TOKEN=dev node dist/index.js   # then POST JSON-RPC to /mcp
```

## Checks

```bash
npm run lint       # Biome — formatting and lint in one pass
npm run format     # ...and fix what it can
npm run typecheck  # tsc over src, test and scripts
npm test
```

CI runs all four. `npm run format` before committing is usually all it takes.

Most tests hit live RPC endpoints, so a few are flaky without API keys — the Hypersync
tests in `test/tools/logs.test.ts` need `HYPERSYNC_API_KEY` and fail without it. Run a
single file while iterating: `npx vitest run test/preview.test.ts`.

## Layout

| Path | What lives there |
| --- | --- |
| [src/chains.ts](src/chains.ts) | Every supported chain, in one table |
| [src/client.ts](src/client.ts) | viem clients, RPC selection, explorer links |
| [src/tools/](src/tools/) | The MCP tools, grouped by domain; one default-exported object per file |
| [src/preview.ts](src/preview.ts) | Decode + simulate a transaction before signing |
| [src/clear-signing.ts](src/clear-signing.ts) | ERC-7730 lookups against the bundled registry index |
| [src/wallet-client.ts](src/wallet-client.ts) | Talks to the browser wallet relay |
| [src/walletconnect.ts](src/walletconnect.ts) | Phone signing |
| [src/oauth.ts](src/oauth.ts), [src/http-server.ts](src/http-server.ts) | Serving MCP over HTTP |
| [wallet/](wallet/) | The relay and its browser page, published separately as `web3-wallet-relay` |

## Adding a chain

Add one entry to `CHAINS` in [src/chains.ts](src/chains.ts). The `ChainName` type, the tool
schemas, RPC selection, explorer links, Hypersync routing and `--help` all derive from it.
`viem/chains` must export the chain; the `alchemy`, `infura`, `explorer` and `hypersync`
fields are each optional.

## Adding a tool

Add it to the relevant file in [src/tools/](src/tools/) with `createTool(title, description,
schema, handler)` and export it from that file's default object — [src/tools/index.ts](src/tools/index.ts)
registers everything it finds. Return `formatResponse(data)`; it serialises BigInts for you.

Let errors throw. The MCP SDK turns a thrown error into a tool error, so a `catch` that only
re-wraps the message is noise — catch only where you can add something the caller can act on.

## Commits and releases

Conventional commits (`feat:`, `fix:`, `chore:`), and note user-visible changes in
[CHANGELOG.md](CHANGELOG.md). Releases are cut from `main`: bump the version, run the checks,
then `npm publish`. The relay in `wallet/` versions and publishes separately — publish it
first when both changed, so the root package resolves the new version.
