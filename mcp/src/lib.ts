/**
 * What this package offers a host that serves it to other people.
 *
 * The CLI at `index.ts` is a program: importing it parses argv, starts a relay and runs a
 * server. This is the library half — nothing here has an effect until it is called, so a
 * deployment can assemble its own server with its own way of deciding who may do what.
 *
 * The split in what each side owns is deliberate. This package knows how to talk to chains
 * and wallets and how to keep one person's signing away from another's; it holds no opinion
 * about who anybody is, what they are allowed, or what it costs. Those are policy, and they
 * belong to whatever is doing the serving.
 */

export { initializeClientManager, SUPPORTED_CHAINS } from './client.js'
export { DEFAULT_IDENTITY, identityFrom } from './context.js'
export { type HttpServerOptions, startHttpServer } from './http-server.js'
export { attachLogServer, log } from './log.js'
export { createMcpServer } from './mcp-server.js'
export { type Login, OAuthProvider, SingleUserOAuthProvider, tokenLogin } from './oauth.js'
export { registerAllTools, type ToolGroup, type ToolMiddleware, toolGroup } from './tools/index.js'
export type { ChainName, Config, ToolResult } from './types.js'
export { parseCommandLineArgs } from './utils.js'
export { allWalletClients, configureWalletRelay, getWalletClient, WalletClient } from './wallet-client.js'
export { getPhoneSigner, PhoneSigner, qrSvg } from './walletconnect.js'
