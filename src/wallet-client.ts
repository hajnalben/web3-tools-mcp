import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type TransactionRequest, type TransactionResponse, WalletRelay } from 'web3-wallet-relay'
import { WebSocket } from 'ws'

const REQUEST_TIMEOUT = 300_000
const SIGNER_WAIT_TIMEOUT = 30_000
const CONNECT_ATTEMPTS = 8
const MAX_CONNECT_BACKOFF = 15_000
const READY_TIMEOUT = 3_000
// A tab we opened moments ago is already frontmost; raising it again is noise.
const RECENT_OPEN_MS = 10_000

// Browser apps we can raise on macOS, matched against the wallet page's User-Agent. Edge
// and Opera also say "Chrome", so they are checked first; Chrome says "Safari" too.
const BROWSER_APPS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, 'Microsoft Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Google Chrome'],
  [/Safari\//, 'Safari']
]

function browserApp(userAgent?: string): string | undefined {
  if (!userAgent) return undefined
  return BROWSER_APPS.find(([pattern]) => pattern.test(userAgent))?.[1]
}

// Every MCP process on this machine looks for a relay here before starting one, so all
// sessions end up sharing a single wallet page instead of each opening its own tab.
const LOCAL_PORTS = [3456, 3457, 3458, 3459, 3460]

/**
 * Token shared by every local session, so a process can join a relay another one owns.
 * Stored 0600 because holding it is enough to push transactions at the signer.
 */
function localToken(): string {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'web3-tools-mcp')
  const file = join(dir, 'relay-token')

  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // not created yet
  }

  const token = randomBytes(16).toString('hex')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, token, { mode: 0o600, flag: 'wx' })
    return token
  } catch {
    // Another process created it between our read and write — theirs wins.
    return readFileSync(file, 'utf8').trim()
  }
}

/**
 * Requester side of the wallet relay. Connects to a hosted relay when
 * WALLET_SERVER_URL is set, otherwise starts one in-process and talks to that.
 */
export class WalletClient {
  private relay: WalletRelay | null = null
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private signers = 0
  private pages = 0
  private signerAddress: string | undefined
  private pairingUrl: string | undefined
  private pageUrl: string | undefined
  private pageAgent: string | undefined
  private lastOpenedAt = 0
  /** Instance field so tests can shorten the wait instead of sitting out the real one. */
  private signerWaitTimeout = SIGNER_WAIT_TIMEOUT

  private readonly remoteUrl = process.env.WALLET_SERVER_URL
  private readonly remoteToken = process.env.WALLET_TOKEN

  constructor(private relayOptions: { port?: number; token?: string } = {}) {}

  get isRemote(): boolean {
    return Boolean(this.remoteUrl)
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.connecting) return this.connecting

    this.connecting = this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    if (this.remoteUrl) return this.connectRemote()
    return this.connectLocal()
  }

  private async connectRemote(): Promise<void> {
    if (!this.remoteToken) {
      throw new Error('WALLET_SERVER_URL is set but WALLET_TOKEN is missing — both are required to use a hosted wallet relay')
    }

    const url = String(this.remoteUrl).replace(/^http/, 'ws')
    let lastError: Error | undefined

    // A hosted relay may be asleep (free tiers spin down) or restarting, and takes about a
    // minute to come back.
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.openSocket(url, this.remoteToken)
        this.pairingUrl = `${this.remoteUrl}#t=${this.remoteToken}`
        return
      } catch (error) {
        lastError = error as Error
        if (attempt === CONNECT_ATTEMPTS - 1) break
        const delay = Math.min(1000 * 2 ** attempt, MAX_CONNECT_BACKOFF)
        console.error(`[Wallet] Relay unreachable, retrying in ${delay / 1000}s`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw lastError
  }

  /**
   * Join the relay another local session already owns, or become the owner.
   *
   * ponytail: two sessions starting in the same instant can each end up owning a relay on a
   * different port, splitting sessions across two wallet tabs. Rare enough to live with —
   * the fix would be for the higher port to hand over when a lower one answers.
   */
  private async connectLocal(): Promise<void> {
    const token = this.relayOptions.token ?? localToken()
    const ports = this.relayOptions.port ? [this.relayOptions.port] : LOCAL_PORTS

    for (const port of ports) {
      try {
        await this.openSocket(`ws://127.0.0.1:${port}`, token)
        this.pairingUrl = `http://127.0.0.1:${port}/#t=${token}`
        return
      } catch {
        // Nothing on this port, or something that isn't our relay — keep looking.
      }
    }

    this.relay = new WalletRelay({ port: ports[0], token })
    await this.relay.start()
    await this.openSocket(`ws://127.0.0.1:${this.relay.getPort()}`, token)
    this.pairingUrl = this.relay.getUrl()
  }

  /**
   * Connect and complete the handshake. Resolves only once the relay acks with `ready`, so
   * a port held by something that isn't our relay fails here instead of looking connected.
   */
  private openSocket(url: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false

      const timer = setTimeout(() => fail('no handshake response'), READY_TIMEOUT)

      function fail(reason: string) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.close()
        reject(new Error(`Wallet relay connection failed: ${reason}`))
      }

      const onHandshake = (data: Buffer) => {
        let message: { type?: string }
        try {
          message = JSON.parse(data.toString())
        } catch {
          return
        }
        if (message.type !== 'ready' || settled) return

        settled = true
        clearTimeout(timer)
        ws.off('message', onHandshake)
        this.ws = ws
        resolve()
      }

      ws.on('message', onHandshake)
      ws.on('message', (data: Buffer) => this.onMessage(data))
      ws.on('open', () => ws.send(JSON.stringify({ token, role: 'requester' })))
      ws.on('error', (error: Error) => {
        fail(error.message)
        ws.close()
      })
      ws.on('close', () => {
        fail('closed during handshake')
        if (this.ws !== ws) return
        this.ws = null
        this.signers = 0
        this.pages = 0
        this.signerAddress = undefined
        this.pageUrl = undefined
        this.pageAgent = undefined
      })
    })
  }

  private onMessage(data: Buffer) {
    let message: TransactionResponse & {
      type?: string
      signers?: number
      pages?: number
      address?: string
      pageUrl?: string
      pageAgent?: string
    }
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    if (message.type === 'status') {
      this.signers = message.signers ?? 0
      this.pages = message.pages ?? 0
      this.signerAddress = message.address
      this.pageUrl = message.pageUrl
      this.pageAgent = message.pageAgent
      return
    }
    if (message.type === 'ready') return

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)

    if (message.success) pending.resolve(message.result)
    else pending.reject(new Error(message.error || 'Transaction failed'))
  }

  /** Wait for a wallet page to connect, opening the browser first when running locally. */
  async waitForSigner(): Promise<void> {
    await this.connect()
    if (this.signers > 0) return

    // Only ever open a tab when no wallet page is connected at all. An open page learns
    // about the request over its own socket and raises itself (tab title + desktop
    // notification); asking the OS to open a URL cannot reliably focus an existing tab —
    // Chrome opens another one — and every attempt to do so left a stray tab behind.
    if (!this.isRemote && this.pages === 0) this.openBrowser()

    const deadline = Date.now() + this.signerWaitTimeout
    while (this.signers === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    if (this.signers === 0) {
      throw new Error(`No wallet connected. Open ${this.getUrl()} and connect your wallet.`)
    }
  }

  async request(request: TransactionRequest): Promise<unknown> {
    await this.waitForSigner()
    this.focusBrowser()

    const ws = this.ws
    if (!ws) throw new Error('Wallet relay disconnected')

    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      ws.send(JSON.stringify(request))

      setTimeout(() => {
        if (this.pending.delete(request.id)) reject(new Error('Transaction request timed out'))
      }, REQUEST_TIMEOUT)
    })
  }

  isConnected(): boolean {
    return this.signers > 0
  }

  getAddress(): string | undefined {
    return this.signerAddress
  }

  /** URL of the tab currently holding the wallet, so a caller can point the user at it. */
  getPageUrl(): string | undefined {
    return this.pageUrl
  }

  /**
   * Pairing URL of the relay actually in use — set once the handshake succeeds. Before that
   * we still hand out a tokened URL: a link without one loads a page that cannot pair.
   */
  getUrl(): string {
    if (this.pairingUrl) return this.pairingUrl
    if (this.remoteUrl) return `${this.remoteUrl}#t=${this.remoteToken ?? ''}`
    return `http://127.0.0.1:${LOCAL_PORTS[0]}/#t=${this.relayOptions.token ?? localToken()}`
  }

  openBrowser() {
    if (this.isRemote) return
    this.lastOpenedAt = Date.now()
    this.open(this.getUrl(), (url) => console.error(`[Wallet] Could not open a browser — visit ${url}`))
  }

  /**
   * Raise the already-open wallet tab. Deliberately drops the `#t=` fragment: the tab has
   * stripped it from its own address bar, and asking for a URL it doesn't currently show
   * makes the browser navigate — a reload would drop the request we are about to send.
   */
  /**
   * Bring the browser holding the wallet page forward.
   *
   * Activates the application rather than opening its URL: measured on macOS, `open <url>`
   * loads the page again in a NEW tab even when an open tab has exactly that URL, which is
   * where every stray tab came from. Activating an app cannot create one. The page itself
   * flags which tab wants attention, via its title and a desktop notification.
   */
  focusBrowser() {
    if (this.isRemote || process.platform !== 'darwin') return
    if (Date.now() - this.lastOpenedAt < RECENT_OPEN_MS) return

    const app = browserApp(this.pageAgent)
    if (app) this.activateApp(app)
  }

  /** Raise an app, but only one already running: launching a browser the user does not use
   *  would be worse than doing nothing (Brave and Arc both report themselves as Chrome). */
  private activateApp(app: string) {
    execFile('pgrep', ['-x', app], (notRunning) => {
      if (notRunning) return
      execFile('open', ['-a', app], () => {})
    })
  }

  /**
   * Hand a URL to the OS. Runs the opener directly rather than through a shell, and only
   * for http(s): the page reports its own URL, so this value is not fully ours to trust.
   */
  private open(url: string, onError?: (url: string) => void) {
    try {
      const { protocol } = new URL(url)
      if (protocol !== 'http:' && protocol !== 'https:') return
    } catch {
      return
    }

    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]]

    execFile(command as string, args as string[], (error) => {
      if (error) onError?.(url)
    })
  }

  async stop(): Promise<void> {
    this.ws?.close()
    await this.relay?.stop()
    this.relay = null
  }
}

let client: WalletClient | null = null

export function getWalletClient(): WalletClient {
  if (!client) client = new WalletClient()
  return client
}
