import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Express } from 'express'
import type { WalletRelay } from 'web3-wallet-relay'
import { HOSTED } from './hosted.js'
import { SingleUserOAuthProvider } from './oauth.js'

/**
 * Serve the MCP over HTTP instead of stdio, so the server can live somewhere other than the
 * machine running the agent. Signing still reaches you: a paired phone over WalletConnect,
 * or the signing page, which is mounted on this same server so one platform port carries
 * both it and /mcp.
 *
 * Two ways in, because clients differ: a static `Authorization: Bearer <MCP_TOKEN>` header
 * (Claude Code), and the OAuth flow the MCP spec defines (claude.ai connectors, which offer
 * no way to send a header). Both end up at the same single credential.
 *
 * Stateless — a server per request — because every tool here is a one-shot call and the
 * signing state lives in the WalletConnect session, not in the transport.
 */

const DEFAULT_PORT = 3457

export interface HttpServerOptions {
  port?: number
  host?: string
  token?: string
  /** Public URL clients reach this server on; OAuth metadata must advertise it. */
  publicUrl?: string
  /** Serve the signing page on this same server, so browser signing works when hosted. */
  walletRelay?: WalletRelay
  createMcpServer: () => McpServer
  /**
   * Who may connect, and as whom.
   *
   * The default authenticates the deployment rather than a person: one token, shared. A
   * host serving several people supplies its own — logging them in however it likes, and
   * putting the identity in the issued token's `extra`, which is where the tools read it
   * from. `MCP_TOKEN` is then no longer required.
   */
  provider?: OAuthServerProvider
  /** A host's own routes, mounted before the signing page claims whatever is left at the root. */
  routes?: (app: Express) => void
}

export async function startHttpServer(options: HttpServerOptions): Promise<{ url: string; port: number; walletUrl?: string }> {
  // The guards a shared host needs — no `localhost` chain, no loopback tracing node, no
  // browser opened on the server — were decided when the package loaded, and cannot be
  // switched on from here.
  if (!HOSTED) {
    throw new Error(
      'Serving over HTTP needs MCP_HOSTED=1 (or MCP_HTTP_PORT) in the environment before web3-tools-mcp is imported'
    )
  }

  const port = options.port ?? Number(process.env.MCP_HTTP_PORT) ?? DEFAULT_PORT
  const host = options.host ?? process.env.MCP_HTTP_HOST ?? '0.0.0.0'
  const token = options.token ?? process.env.MCP_TOKEN

  // A reachable MCP server with a paired phone can push signing prompts at that phone. It
  // never runs unauthenticated — either a host brought its own way to log people in, or
  // there is a token.
  if (!options.provider && !token) {
    throw new Error('MCP_TOKEN is required to serve MCP over HTTP — anyone reaching the URL could request signatures')
  }

  const publicUrl = options.publicUrl ?? process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`
  const issuer = new URL(publicUrl)
  const provider = options.provider ?? new SingleUserOAuthProvider(token as string)

  const app = express()
  app.use(express.json())
  // The login form posts a token, so the authorize route needs form bodies too.
  app.use(express.urlencoded({ extended: false }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // /authorize, /token, /register, /revoke and the metadata documents a client discovers
  // after a 401.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      baseUrl: issuer,
      resourceServerUrl: new URL('/mcp', issuer),
      resourceName: 'web3-tools-mcp',
      scopesSupported: []
    })
  )

  // The metadata document is mounted under the resource path, so the 401 has to advertise
  // that exact URL — a bare /.well-known/oauth-protected-resource 404s, and a client that
  // follows it gives up right where discovery should have started.
  const authenticate = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', issuer))
  })

  options.routes?.(app)

  app.all('/mcp', authenticate, async (req, res) => {
    const mcp = options.createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })

    res.on('close', () => {
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })

    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('[MCP] Request failed:', error)
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } })
      }
    }
  })

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening))
    listening.once('error', reject)
  })

  // The signing page rides on this same server, so a hosted deployment can offer browser
  // signing without a second service: one platform port serves both /mcp and the page.
  // Mounted last, so the routes above keep their paths — the relay only claims what is
  // left, which is the static page at the root.
  let walletUrl: string | undefined
  if (options.walletRelay) {
    options.walletRelay.attach(server, (relayApp) => app.use(relayApp))
    walletUrl = `${publicUrl.replace(/\/$/, '')}/#t=${options.walletRelay.signerToken}`
  }

  return { url: `${publicUrl.replace(/\/$/, '')}/mcp`, port: (server.address() as { port: number }).port, walletUrl }
}
