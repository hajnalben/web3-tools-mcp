import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
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
  address?: string
  credential?: string
  expiresAt: number
}

interface StoredToken {
  clientId: string
  scopes: string[]
  address?: string
  credential?: string
  expiresAt: number
}

/** Codes expire in milliseconds, tokens in seconds — the unit OAuth reports them in. */
function expired(key: string, value: unknown): boolean {
  const expiresAt = (value as { expiresAt?: number } | undefined)?.expiresAt
  if (expiresAt === undefined) return false
  return (key.startsWith('code:') ? expiresAt : expiresAt * 1000) < Date.now()
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

  /** `ttl` in seconds lets Redis drop the entry itself; the file is pruned on every write. */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (this.redis) return this.redis.setItem(`oauth:${key}`, value, ttl)
    const data = this.read()
    data[key] = value
    for (const [name, stored] of Object.entries(data)) if (expired(name, stored)) delete data[name]
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

/**
 * How a deployment decides who is at the authorize screen.
 *
 * Deliberately free of any type from the MCP SDK, a chain library, or this package: an
 * implementation renders a page and reads back a form, and everything about *how* somebody
 * proves who they are — a shared token, a wallet signature, a company SSO — stays outside.
 * Returning an address makes the issued token that person's; returning none authenticates
 * the deployment rather than anybody in particular.
 */
export interface Login {
  /**
   * The page served at GET /authorize. `hidden` must be placed inside its form. `request`
   * names who is asking and where the code will be sent, so a person can tell a phishing
   * client from their own; like `error`, its values arrive HTML-escaped.
   */
  page(hidden: string, error?: string, request?: { client: string; redirectHost: string }): string | Promise<string>
  /** Reads the posted form. An `error` re-renders the page; an `address` names the person. */
  identify(form: Record<string, string>): Promise<{ address?: string; error?: string }>
  /**
   * Form fields this login owns. They are kept out of the hidden inputs replayed into the
   * page, so a credential can never be echoed back into the HTML.
   */
  owns?: string[]
  /**
   * A shared secret this login checks against, if it has one. Everything issued is bound to
   * it, so rotating the secret revokes every code and token handed out under the old one.
   */
  credential?: string
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 26rem;
         margin: 12vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.15rem; margin-bottom: .25rem; }
  p { color: #667; margin-top: 0; }
  input, button { font: inherit; width: 100%; padding: .7rem .8rem; border-radius: .5rem;
                  box-sizing: border-box; }
  input { border: 1px solid #ccd; font-family: ui-monospace, monospace; }
  button { margin-top: .75rem; border: 0; background: #3856d6; color: #fff; font-weight: 600; }
  .error { color: #b3251d; font-weight: 600; }`

/** The default: one shared credential, so a self-hoster needs no identity provider. */
export function tokenLogin(accessToken: string): Login {
  return {
    owns: ['token'],
    credential: accessToken,
    page: (hidden, error, request) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to web3-tools-mcp</title>
<style>${PAGE_STYLE}
</style>
<h1>Connect to web3-tools-mcp</h1>
${request ? `<p><strong>${request.client}</strong> is asking for access, and will be sent back to <strong>${request.redirectHost}</strong>.</p>` : ''}
<p>Paste this server's access token to authorise the client.</p>
${error ? `<p class="error">${error}</p>` : ''}
<form method="post">
  ${hidden}
  <input name="token" type="password" placeholder="MCP_TOKEN" autocomplete="off" autofocus>
  <button type="submit">Authorise</button>
</form>`,
    async identify(form) {
      if (!constantTimeEquals(form.token ?? '', accessToken)) return { error: 'That token was not accepted.' }
      // No address: this authenticates the deployment, not a person.
      return {}
    }
  }
}

export class OAuthProvider implements OAuthServerProvider {
  private store = new Store()
  // A hash, so the secret itself never lands in the store.
  private credential: string | undefined

  /**
   * `staticToken` is accepted verbatim in an Authorization header, for clients that can send
   * one and skip the flow entirely. It names no person, so it carries no identity.
   */
  constructor(
    private login: Login,
    private staticToken?: string
  ) {
    this.credential = login.credential && createHash('sha256').update(login.credential).digest('hex').slice(0, 16)
  }

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
   * GET renders the login; POST hands the form to it and, if it names somebody, redirects
   * back with a code. Handling both here keeps the whole login inside the SDK's authorize
   * route, which is the only place the client will follow a redirect from.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request = res.req
    const form = { ...(request.query as Record<string, string>), ...(request.body as Record<string, string>) }

    // The SDK's authorize handler reads its parameters from the body on POST, so the form
    // has to carry the whole authorization request back — minus whatever the login owns,
    // which would mean echoing a credential into the HTML.
    const owned = new Set(this.login.owns ?? [])
    const hidden = Object.entries(form)
      .filter(([name, value]) => !owned.has(name) && typeof value === 'string')
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('\n  ')

    const redirectTo = new URL(params.redirectUri)
    const shown = {
      client: escapeHtml(client.client_name || 'An unnamed client'),
      redirectHost: escapeHtml(redirectTo.host || redirectTo.href)
    }

    // A login page that can be framed can be clickjacked into authorising somebody else.
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")

    const render = async (status: number, error?: string) => {
      res
        .status(status)
        .setHeader('content-type', 'text/html; charset=utf-8')
        .send(await this.login.page(hidden, error ? escapeHtml(error) : undefined, shown))
    }

    if (request.method !== 'POST') return render(200)

    const identified = await this.login.identify(form)
    if (identified.error) return render(401, identified.error)

    const code = randomBytes(24).toString('hex')
    await this.store.set<StoredCode>(
      `code:${code}`,
      {
        clientId: client.client_id,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource?.href,
        scopes: params.scopes ?? [],
        address: identified.address,
        credential: this.credential,
        expiresAt: Date.now() + CODE_TTL
      },
      CODE_TTL / 1000
    )

    redirectTo.searchParams.set('code', code)
    if (params.state) redirectTo.searchParams.set('state', params.state)
    res.redirect(redirectTo.href)
  }

  // Refusals here must be InvalidGrantError: the SDK answers anything else with a 500,
  // where a client needs the 400 invalid_grant to know it should start the flow again.
  private async validCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<StoredCode> {
    const stored = await this.store.get<StoredCode>(`code:${authorizationCode}`)
    if (!stored || stored.expiresAt < Date.now() || stored.credential !== this.credential) {
      throw new InvalidGrantError('Authorization code is invalid or expired')
    }
    if (stored.clientId !== client.client_id) throw new InvalidGrantError('Authorization code was issued to a different client')
    return stored
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return (await this.validCode(client, authorizationCode)).codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const stored = await this.validCode(client, authorizationCode)
    // Optional at the token endpoint because the SDK lets a single-URI client omit it at
    // /authorize too; when sent, it must be the one the code was issued for.
    if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request')
    }

    // One use only: a replayed code must not mint a second token.
    await this.store.remove(`code:${authorizationCode}`)
    return this.issue(client.client_id, stored.scopes, stored.address)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const stored = await this.store.get<StoredToken>(`refresh:${refreshToken}`)
    if (!stored || stored.credential !== this.credential) throw new InvalidGrantError('Refresh token is invalid')
    if (stored.clientId !== client.client_id) throw new InvalidGrantError('Refresh token was issued to a different client')

    await this.store.remove(`refresh:${refreshToken}`)
    if (stored.expiresAt * 1000 < Date.now()) throw new InvalidGrantError('Refresh token has expired')
    // The refreshed token stays the same person's: a refresh proves possession, not identity.
    return this.issue(client.client_id, scopes ?? stored.scopes, stored.address)
  }

  private async issue(clientId: string, scopes: string[], address?: string): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex')
    const refreshToken = randomBytes(32).toString('hex')
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL
    const stored: StoredToken = { clientId, scopes, address, credential: this.credential, expiresAt }

    await this.store.set(`token:${accessToken}`, stored, TOKEN_TTL)
    await this.store.set(`refresh:${refreshToken}`, stored, TOKEN_TTL)

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL,
      refresh_token: refreshToken,
      scope: scopes.join(' ')
    }
  }

  /** Accepts an issued token, or the static one so a client that can send a header still works. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.staticToken && constantTimeEquals(token, this.staticToken)) {
      // requireBearerAuth refuses a token with no expiry, and this one never expires.
      return { token, clientId: 'static', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL }
    }

    // Must be InvalidTokenError specifically: the SDK turns anything else into a 500, and
    // a client needs the 401 to know it should authenticate again.
    const stored = await this.store.get<StoredToken>(`token:${token}`)
    if (!stored || stored.credential !== this.credential) throw new InvalidTokenError('Invalid access token')
    if (stored.expiresAt * 1000 < Date.now()) {
      await this.store.remove(`token:${token}`)
      throw new InvalidTokenError('Access token has expired')
    }

    // `extra.address` is where the tools read the caller's identity from; a token that names
    // nobody leaves it unset, and everything falls back to the shared identity.
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      ...(stored.address ? { extra: { address: stored.address } } : {})
    }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    await this.store.remove(`token:${request.token}`)
    await this.store.remove(`refresh:${request.token}`)
  }
}

/** One shared credential, which is all a self-hosted server needs. */
export class SingleUserOAuthProvider extends OAuthProvider {
  constructor(accessToken: string) {
    super(tokenLogin(accessToken), accessToken)
  }
}

/** PKCE helper, used by the tests to drive the flow the way a real client would. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
