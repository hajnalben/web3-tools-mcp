# web3-wallet-relay

The browser signing page for [web3-tools-mcp](https://www.npmjs.com/package/web3-tools-mcp),
and the WebSocket rendezvous behind it. The MCP server sends a transaction, the page shows
what it does, and your wallet extension signs it — the relay only passes messages between
the two and holds no keys.

You normally never install this. The MCP server embeds it and starts one on localhost when
a transaction needs signing.

Install it separately only to **host the page**, so a machine without a browser can still
have something signed. It depends only on express and ws, so it runs anywhere that keeps a
Node process alive and supports WebSockets.

```bash
WALLET_TOKEN=<long random string> \
WALLET_PUBLIC_URL=https://wallet.example.com \
npx web3-wallet-relay
```

Then point the MCP server at it with `WALLET_SERVER_URL` and the same `WALLET_TOKEN`.

The pairing link carries a token derived from `WALLET_TOKEN` that can only answer signing
requests, not make them. Sharing a pairing link is therefore not the same as sharing
`WALLET_TOKEN` — but whoever has it can act as your wallet page, so a signing request can
reach them instead of you.

| Variable | |
| --- | --- |
| `WALLET_TOKEN` | The MCP server's secret. Anyone holding it can send your browser a transaction to sign — treat it like a password, and serve over HTTPS. Generated per run if unset. The signing page gets a separate token derived from this one, which may only answer requests; that is what pairing links carry. |
| `PORT` | Provided by most hosts. Set, the relay binds `0.0.0.0` and takes that one port; unset, it binds loopback and scans 3456-3460. |
| `HOST` | Override the bind address. |
| `WALLET_PUBLIC_URL` | The URL to print in pairing links, when it differs from the bind address. |

It is also usable as a library — `WalletRelay`, plus the `TransactionRequest` and
`TransactionResponse` types.

Part of the [web3-tools-mcp](https://github.com/hajnalben/web3-tools-mcp) repo, where the
full documentation lives.

MIT
