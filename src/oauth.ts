import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { getKeyValueStorage, type KeyValueStorage } from './kv-storage.js'

/**
 * OAuth for clients that will not send a static bearer token — claude.ai connectors, and
 * so anything driving them from a browser or phone, only speak the OAuth flow the MCP spec
 * defines.
 *
 * There are no user accounts here: the single credential is MCP_TOKEN, the same one this
 * server already requires. The authorize step is a one-field page that asks for it, so a
 * self-hoster needs no identity provider and no extra configuration.
 */

const CODE_TTL = 10 * 60 * 1000
const TOKEN_TTL = 30 * 24 * 60 * 60

interface StoredCode {
  clientId: string
  codeChallenge: string
  redirectUri: string
  resource?: string
  scopes: string[]
  expiresAt: number
}

interface StoredToken {
  clientId: string
  scopes: string[]
  expiresAt: number
}

/** Redis where configured, a JSON file otherwise — issued tokens must outlive a restart. */
class Store {
  private redis: KeyValueStorage | undefined
  private file: string
  private cache: Record<string, unknown> | undefined

  constructor() {
    this.redis = getKeyValueStorage()
    const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'web3-tools-mcp')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'oauth.json')
  }

  private read(): Record<string, unknown> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch {
        this.cache = {}
      }
    }
    return this.cache as Record<string, unknown>
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.redis) return this.redis.getItem<T>(`oauth:${key}`)
    return this.read()[key] as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (this.redis) return this.redis.setItem(`oauth:${key}`, value)
    const data = this.read()
    data[key] = value
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 })
  }

  async remove(key: string): Promise<void> {
    if (this.redis) return this.redis.removeItem(`oauth:${key}`)
    const data = this.read()
    delete data[key]
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 })
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function loginPage(params: { error?: string; fields: Record<string, string> }): string {
  // The SDK's authorize handler reads its parameters from the body on POST, so the form
  // has to carry the whole authorization request back, not just the token.
  const hidden = Object.entries(params.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n  ')

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to web3-tools-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 26rem;
         margin: 12vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.15rem; margin-bottom: .25rem; }
  p { color: #667; margin-top: 0; }
  input, button { font: inherit; width: 100%; padding: .7rem .8rem; border-radius: .5rem;
                  box-sizing: border-box; }
  input { border: 1px solid #ccd; font-family: ui-monospace, monospace; }
  button { margin-top: .75rem; border: 0; background: #3856d6; color: #fff; font-weight: 600; }
  .error { color: #b3251d; font-weight: 600; }
</style>
<h1>Connect to web3-tools-mcp</h1>
<p>Paste this server's access token to authorise the client.</p>
${params.error ? `<p class="error">${params.error}</p>` : ''}
<form method="post">
  ${hidden}
  <input name="token" type="password" placeholder="MCP_TOKEN" autocomplete="off" autofocus>
  <button type="submit">Authorise</button>
</form>`
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  private store = new Store()

  constructor(private accessToken: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store
    return {
      async getClient(clientId) {
        return store.get<OAuthClientInformationFull>(`client:${clientId}`)
      },
      // Registration is open because MCP clients register themselves before anyone can
      // log in; holding MCP_TOKEN is what actually grants access.
      async registerClient(client) {
        const registered: OAuthClientInformationFull = {
          ...client,
          client_id: randomBytes(16).toString('hex'),
          client_id_issued_at: Math.floor(Date.now() / 1000)
        }
        await store.set(`client:${registered.client_id}`, registered)
        return registered
      }
    }
  }

  /**
   * GET renders the token prompt; POST checks it and redirects back with a code. Handling
   * both here keeps the whole login inside the SDK's authorize route.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request = res.req
    const submitted = (request.body as { token?: string } | undefined)?.token ?? ''

    // Everything except the token itself is replayed into the form, so the handler sees a
    // complete authorization request when the form posts back.
    const fields = Object.fromEntries(
      Object.entries({ ...(request.query as Record<string, string>), ...(request.body as Record<string, string>) })
        .filter(([name, value]) => name !== 'token' && typeof value === 'string')
    ) as Record<string, string>

    if (request.method !== 'POST') {
      res.setHeader('content-type', 'text/html; charset=utf-8').send(loginPage({ fields }))
      return
    }

    if (!constantTimeEquals(submitted, this.accessToken)) {
      res
        .status(401)
        .setHeader('content-type', 'text/html; charset=utf-8')
        .send(loginPage({ fields, error: 'That token was not accepted.' }))
      return
    }

    const code = randomBytes(24).toString('hex')
    await this.store.set<StoredCode>(`code:${code}`, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL
    })

    const redirect = new URL(params.redirectUri)
    redirect.searchParams.set('code', code)
    if (params.state) redirect.searchParams.set('state', params.state)
    res.redirect(redirect.href)
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const stored = await this.store.get<StoredCode>(`code:${authorizationCode}`)
    if (!stored || stored.expiresAt < Date.now()) throw new Error('Authorization code is invalid or expired')
    return stored.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const stored = await this.store.get<StoredCode>(`code:${authorizationCode}`)
    if (!stored || stored.expiresAt < Date.now()) throw new Error('Authorization code is invalid or expired')
    if (stored.clientId !== client.client_id) throw new Error('Authorization code was issued to a different client')

    // One use only: a replayed code must not mint a second token.
    await this.store.remove(`code:${authorizationCode}`)
    return this.issue(client.client_id, stored.scopes)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const stored = await this.store.get<StoredToken>(`refresh:${refreshToken}`)
    if (!stored) throw new Error('Refresh token is invalid')
    if (stored.clientId !== client.client_id) throw new Error('Refresh token was issued to a different client')

    await this.store.remove(`refresh:${refreshToken}`)
    return this.issue(client.client_id, scopes ?? stored.scopes)
  }

  private async issue(clientId: string, scopes: string[]): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex')
    const refreshToken = randomBytes(32).toString('hex')
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL

    await this.store.set<StoredToken>(`token:${accessToken}`, { clientId, scopes, expiresAt })
    await this.store.set<StoredToken>(`refresh:${refreshToken}`, { clientId, scopes, expiresAt })

    return { access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL, refresh_token: refreshToken, scope: scopes.join(' ') }
  }

  /** Accepts an issued token, or MCP_TOKEN itself so a client that can send a header still works. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (constantTimeEquals(token, this.accessToken)) {
      // requireBearerAuth refuses a token with no expiry, and this one never expires.
      return { token, clientId: 'static', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL }
    }

    // Must be InvalidTokenError specifically: the SDK turns anything else into a 500, and
    // a client needs the 401 to know it should authenticate again.
    const stored = await this.store.get<StoredToken>(`token:${token}`)
    if (!stored) throw new InvalidTokenError('Invalid access token')
    if (stored.expiresAt * 1000 < Date.now()) {
      await this.store.remove(`token:${token}`)
      throw new InvalidTokenError('Access token has expired')
    }

    return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    await this.store.remove(`token:${request.token}`)
    await this.store.remove(`refresh:${request.token}`)
  }
}

/** PKCE helper, used by the tests to drive the flow the way a real client would. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
