import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IDENTITY, identityFrom } from '../src/context.js'
import { type Login, OAuthProvider, pkce, tokenLogin } from '../src/oauth.js'
import { registerAllTools } from '../src/tools/index.js'

// Issued codes and tokens persist; keep them out of the real config dir and any Redis in .env.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'oauth-test-'))
delete process.env.UPSTASH_REDIS_REST_URL
delete process.env.UPSTASH_REDIS_REST_TOKEN

// The hosted flag is read when the package loads, and the setup file has loaded it
// already — so set it and load the server afresh.
process.env.MCP_HOSTED = '1'
vi.resetModules()
const { startHttpServer } = await import('../src/http-server.js')

const TOKEN = 'oauth-test-token'
const PORT = 4300
const BASE = `http://127.0.0.1:${PORT}`

/**
 * Walks the flow a claude.ai connector performs: discover metadata after a 401, register
 * itself, log in, exchange the code, then call a tool with the issued token.
 */
describe('OAuth for clients that cannot send a header', () => {
  beforeAll(async () => {
    await startHttpServer({
      port: PORT,
      host: '127.0.0.1',
      token: TOKEN,
      publicUrl: BASE,
      createMcpServer: () => {
        const server = new McpServer({ name: 'web3-tools-mcp', version: 'test' })
        registerAllTools(server)
        return server
      }
    })
  })

  it('points an unauthenticated client at its resource metadata', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })

    expect(res.status).toBe(401)
    // Without this header a spec-following client has nowhere to go — which is exactly
    // how the static-token-only server failed.
    const header = res.headers.get('www-authenticate') as string
    expect(header).toContain('resource_metadata')

    // The advertised document must actually exist — pointing at a 404 strands the client.
    const advertised = /resource_metadata="([^"]+)"/.exec(header)?.[1] as string
    expect((await fetch(advertised)).status).toBe(200)
  })

  it('publishes discovery documents', async () => {
    // Mounted under the resource path; the 401 above must point at this exact URL.
    const resource = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()
    expect(resource.authorization_servers?.length).toBeGreaterThan(0)

    const server = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()
    expect(server.authorization_endpoint).toBe(`${BASE}/authorize`)
    expect(server.token_endpoint).toBe(`${BASE}/token`)
    expect(server.code_challenge_methods_supported).toContain('S256')
  })

  it('completes registration, login, code exchange and a tool call', async () => {
    // 1. The client registers itself, because nobody can pre-provision it.
    const registration = await (
      await fetch(`${BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Public client with PKCE, which is what an MCP client registers as.
        body: JSON.stringify({
          client_name: 'test client',
          redirect_uris: ['http://localhost:9999/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code']
        })
      })
    ).json()
    expect(registration.client_id).toBeTruthy()

    // 2. The authorize page asks for the token.
    const { verifier, challenge } = pkce()
    const authorizeUrl = new URL(`${BASE}/authorize`)
    authorizeUrl.searchParams.set('client_id', registration.client_id)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost:9999/callback')
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('state', 'xyz')

    const form = await fetch(authorizeUrl)
    expect(form.status).toBe(200)
    expect(await form.text()).toContain('MCP_TOKEN')

    // 3. A wrong token gets no code.
    // Post back what the form carries, the way a browser would.
    const formFields = new URLSearchParams(authorizeUrl.search)
    const submit = (token: string) =>
      fetch(authorizeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...Object.fromEntries(formFields), token }),
        redirect: 'manual'
      })

    const refused = await submit('not-the-token')
    expect(refused.status).toBe(401)

    // 4. The right one redirects back with a code.
    const accepted = await submit(TOKEN)
    expect(accepted.status).toBe(302)
    const callback = new URL(accepted.headers.get('location') as string)
    const code = callback.searchParams.get('code') as string
    expect(code).toBeTruthy()
    expect(callback.searchParams.get('state')).toBe('xyz')

    // 5. Exchange it, with the PKCE verifier.
    const tokens = await (
      await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: registration.client_id,
          redirect_uri: 'http://localhost:9999/callback',
          code_verifier: verifier
        })
      })
    ).json()
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.token_type).toBe('Bearer')

    // 6. The issued token works on /mcp.
    const call = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(call.status).toBe(200)
    expect((await call.json()).result.tools.length).toBeGreaterThan(20)

    // 7. A code cannot be replayed.
    const replay = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: registration.client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_verifier: verifier
      })
    })
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')
  })

  it('names the client and where it will be sent, and cannot be framed', async () => {
    const registration = await (
      await fetch(`${BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: '<script>alert(1)</script>',
          redirect_uris: ['https://callback.example/cb'],
          token_endpoint_auth_method: 'none'
        })
      })
    ).json()

    const authorizeUrl = new URL(`${BASE}/authorize`)
    authorizeUrl.searchParams.set('client_id', registration.client_id)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('code_challenge', pkce().challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    const page = await fetch(authorizeUrl)
    const html = await page.text()
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('callback.example')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('still accepts the static token, so header-capable clients keep working', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(200)
  })
})

/**
 * A host serving several people supplies its own login. What matters here is that whoever it
 * names survives all the way to the token the tools read their identity from — if it did not,
 * every tenant would quietly collapse back onto the shared identity.
 */
describe('a login that names a person', () => {
  const CLIENT = { client_id: 'multi-tenant-client' } as OAuthClientInformationFull

  function fakeResponse(form: Record<string, string>) {
    const sent = { html: '', location: '', status: 200 }
    const res = {
      req: { method: form.submit ? 'POST' : 'GET', query: {}, body: form },
      status(code: number) {
        sent.status = code
        return res
      },
      setHeader() {
        return res
      },
      send(html: string) {
        sent.html = html
      },
      redirect(url: string) {
        sent.location = url
      }
    }
    return { res: res as unknown as Response, sent }
  }

  async function codeFrom(provider: OAuthProvider, form: Record<string, string>): Promise<string> {
    const { res, sent } = fakeResponse(form)
    await provider.authorize(CLIENT, { codeChallenge: 'challenge', redirectUri: 'http://localhost:9999/cb', scopes: [] }, res)
    return new URL(sent.location).searchParams.get('code') ?? ''
  }

  const login = (address?: string): Login => ({
    owns: ['secret'],
    page: (hidden) => `<form>${hidden}</form>`,
    identify: async (form) => (form.secret === 'open' ? { address } : { error: 'no' })
  })

  it('carries the address from the login into the issued token', async () => {
    const provider = new OAuthProvider(login('0xAbC'))
    const code = await codeFrom(provider, { submit: '1', secret: 'open' })
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)

    const auth = await provider.verifyAccessToken(tokens.access_token)
    expect(auth.extra?.address).toBe('0xAbC')
    expect(identityFrom(auth)).toBe('0xAbC')
  })

  it('keeps the person across a refresh, which proves possession and not identity', async () => {
    const provider = new OAuthProvider(login('0xAbC'))
    const code = await codeFrom(provider, { submit: '1', secret: 'open' })
    const first = await provider.exchangeAuthorizationCode(CLIENT, code)

    const refreshed = await provider.exchangeRefreshToken(CLIENT, first.refresh_token as string)
    expect(identityFrom(await provider.verifyAccessToken(refreshed.access_token))).toBe('0xAbC')
  })

  it('falls back to the shared identity when the login names nobody', async () => {
    const provider = new OAuthProvider(login(undefined))
    const code = await codeFrom(provider, { submit: '1', secret: 'open' })
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)

    expect(identityFrom(await provider.verifyAccessToken(tokens.access_token))).toBe(DEFAULT_IDENTITY)
  })

  it('never echoes a field the login owns back into the page', async () => {
    const provider = new OAuthProvider(login('0xAbC'))
    const { res, sent } = fakeResponse({ secret: 'hunter2', state: 'xyz' })
    await provider.authorize(CLIENT, { codeChallenge: 'c', redirectUri: 'http://localhost:9999/cb', scopes: [] }, res)

    expect(sent.html).toContain('xyz')
    expect(sent.html).not.toContain('hunter2')
  })

  it('refuses a login that rejects the form', async () => {
    const provider = new OAuthProvider(login('0xAbC'))
    const { res, sent } = fakeResponse({ submit: '1', secret: 'wrong' })
    await provider.authorize(CLIENT, { codeChallenge: 'c', redirectUri: 'http://localhost:9999/cb', scopes: [] }, res)

    expect(sent.status).toBe(401)
    expect(sent.location).toBe('')
  })

  it('refuses a code sent back with a different redirect_uri', async () => {
    const provider = new OAuthProvider(login('0xAbC'))
    const code = await codeFrom(provider, { submit: '1', secret: 'open' })

    await expect(provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://evil.example/cb')).rejects.toThrow(
      InvalidGrantError
    )
    await expect(provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://localhost:9999/cb')).resolves.toBeTruthy()
  })

  describe('an expired refresh token', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('is refused', async () => {
      const provider = new OAuthProvider(login('0xAbC'))
      const tokens = await provider.exchangeAuthorizationCode(CLIENT, await codeFrom(provider, { submit: '1', secret: 'open' }))

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
      await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token as string)).rejects.toThrow(InvalidGrantError)
    })
  })

  it('revokes everything issued under a token once that token is rotated', async () => {
    const before = new OAuthProvider(tokenLogin('old-token'))
    const tokens = await before.exchangeAuthorizationCode(CLIENT, await codeFrom(before, { submit: '1', token: 'old-token' }))
    const pendingCode = await codeFrom(before, { submit: '1', token: 'old-token' })
    expect(await before.verifyAccessToken(tokens.access_token)).toBeTruthy()

    const after = new OAuthProvider(tokenLogin('new-token'))
    await expect(after.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError)
    await expect(after.exchangeRefreshToken(CLIENT, tokens.refresh_token as string)).rejects.toThrow(InvalidGrantError)
    await expect(after.exchangeAuthorizationCode(CLIENT, pendingCode)).rejects.toThrow(InvalidGrantError)
  })

  it('issues no identity for a static token, which authenticates the deployment', async () => {
    const provider = new OAuthProvider(login('0xAbC'), 'static-secret')
    expect(identityFrom(await provider.verifyAccessToken('static-secret'))).toBe(DEFAULT_IDENTITY)
  })
})
