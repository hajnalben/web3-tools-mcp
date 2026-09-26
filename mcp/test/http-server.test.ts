import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyValueStorage } from '../src/kv-storage.js'

// Starting a server opens the OAuth store; keep it out of the real config dir and any Redis in .env.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'http-server-test-'))
delete process.env.UPSTASH_REDIS_REST_URL
delete process.env.UPSTASH_REDIS_REST_TOKEN

// The hosted flag is read when the package loads, and the setup file has loaded it
// already — so set it and load the server afresh.
process.env.MCP_HOSTED = '1'
vi.resetModules()
const { startHttpServer } = await import('../src/http-server.js')
// The fresh module graph has its own client manager, which a real server initializes first.
;(await import('../src/client.js')).initializeClientManager({})

const TOKEN = 'test-mcp-token'

function mcpCall(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
}

describe('MCP over HTTP', () => {
  it('refuses to start without a token', async () => {
    await expect(startHttpServer({ port: 4200, token: undefined, createMcpServer: () => ({}) as never })).rejects.toThrow(
      /MCP_TOKEN is required/
    )
  })

  it('rejects requests without the bearer token and serves them with it', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { registerAllTools } = await import('../src/tools/index.js')

    const { url } = await startHttpServer({
      port: 4201,
      host: '127.0.0.1',
      token: TOKEN,
      createMcpServer: () => {
        const server = new McpServer({ name: 'web3-tools-mcp', version: 'test' })
        registerAllTools(server)
        return server
      }
    })

    expect((await mcpCall(url, initialize)).status).toBe(401)
    // A bad token must be 401, not 500 — 401 is what tells a client to re-authenticate.
    expect((await mcpCall(url, initialize, 'wrong-token')).status).toBe(401)

    const authorized = await mcpCall(url, initialize, TOKEN)
    expect(authorized.status).toBe(200)
    const body = await authorized.json()
    expect(body.result.serverInfo.name).toBe('web3-tools-mcp')
  })

  it('falls back to the default port when MCP_HTTP_PORT is unset', async () => {
    const previous = process.env.MCP_HTTP_PORT
    delete process.env.MCP_HTTP_PORT
    try {
      // A local server may already hold the default port; the refusal still names it.
      const port = await startHttpServer({ host: '127.0.0.1', token: TOKEN, createMcpServer: () => ({}) as never }).then(
        (started) => started.port,
        (error) => error.port
      )
      expect(port).toBe(3457)
    } finally {
      if (previous !== undefined) process.env.MCP_HTTP_PORT = previous
    }
  })

  it('takes the client address from X-Forwarded-For only when told how many proxies to trust', async () => {
    const ipOf = async (port: number) => {
      await startHttpServer({
        port,
        host: '127.0.0.1',
        token: TOKEN,
        createMcpServer: () => ({}) as never,
        routes: (app) => app.get('/ip', (req, res) => res.send(req.ip))
      })
      return (await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'x-forwarded-for': '203.0.113.7' } })).text()
    }

    delete process.env.MCP_TRUST_PROXY
    expect(await ipOf(4203)).not.toBe('203.0.113.7')

    process.env.MCP_TRUST_PROXY = '1'
    try {
      expect(await ipOf(4204)).toBe('203.0.113.7')
    } finally {
      delete process.env.MCP_TRUST_PROXY
    }
  })
})

describe('WalletConnect session storage', () => {
  const servers: Server[] = []

  afterEach(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve))
    servers.length = 0
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it('falls back to the file store when Upstash is not configured', () => {
    expect(getKeyValueStorage()).toBeUndefined()
  })

  it('round-trips sessions through the Redis REST API', async () => {
    // Stand-in for Upstash: a hash held in memory, same command/result shape.
    const hash = new Map<string, string>()
    const received: string[][] = []

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const [command, , field, value] = JSON.parse(body) as string[]
        received.push([command as string, field ?? ''])
        let result: unknown = null

        if (command === 'HSET') hash.set(field as string, value as string)
        if (command === 'HGET') result = hash.get(field as string) ?? null
        if (command === 'HDEL') hash.delete(field as string)
        if (command === 'HKEYS') result = [...hash.keys()]
        if (command === 'HGETALL') result = [...hash.entries()].flat()

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(4202, '127.0.0.1', resolve))

    process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:4202'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token'

    const storage = getKeyValueStorage()
    expect(storage).toBeDefined()

    await storage!.setItem('wc@2:client:session', { topic: 'abc', expiry: 123 })
    expect(await storage!.getItem('wc@2:client:session')).toEqual({ topic: 'abc', expiry: 123 })
    expect(await storage!.getKeys()).toEqual(['wc@2:client:session'])
    expect(await storage!.getEntries()).toEqual([['wc@2:client:session', { topic: 'abc', expiry: 123 }]])

    await storage!.removeItem('wc@2:client:session')
    expect(await storage!.getItem('wc@2:client:session')).toBeUndefined()

    expect(received.map(([c]) => c)).toContain('HSET')
  })
})
