import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Serve the MCP over HTTP instead of stdio, so the server can live somewhere other than the
 * machine running the agent. Only worth doing alongside WalletConnect: a hosted server has
 * no browser to open, so a phone wallet is the only way it can have anything signed.
 *
 * Stateless — a server per request — because every tool here is a one-shot call and the
 * signing state lives in the WalletConnect session, not in the transport.
 */

const DEFAULT_PORT = 3457

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } }))
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface HttpServerOptions {
  port?: number
  host?: string
  token?: string
  createMcpServer: () => McpServer
}

export async function startHttpServer(options: HttpServerOptions): Promise<{ url: string; port: number }> {
  const port = options.port ?? Number(process.env.MCP_HTTP_PORT) ?? DEFAULT_PORT
  const host = options.host ?? process.env.HOST ?? (process.env.MCP_HTTP_HOST ? process.env.MCP_HTTP_HOST : '0.0.0.0')
  const token = options.token ?? process.env.MCP_TOKEN

  // A reachable MCP server with a paired phone can push signing prompts at that phone. It
  // never runs without a token.
  if (!token) {
    throw new Error('MCP_TOKEN is required to serve MCP over HTTP — anyone reaching the URL could request signatures')
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }

    const presented = req.headers.authorization?.replace(/^Bearer /i, '') ?? ''
    if (!tokenMatches(presented, token)) {
      unauthorized(res)
      return
    }

    const mcp = options.createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })

    res.on('close', () => {
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })

    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      console.error('[MCP] Request failed:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return { url: `http://${host}:${port}/mcp`, port }
}
