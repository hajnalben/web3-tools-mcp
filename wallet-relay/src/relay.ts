import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface TransactionRequest {
  id: string
  type: 'send_transaction' | 'sign_message' | 'sign_typed_data'
  chain: string
  data: unknown
  /** Decoded + simulated preview, forwarded to the signer untouched. */
  preview?: unknown
}

export interface TransactionResponse {
  id: string
  success: boolean
  result?: unknown
  error?: string
}

export interface SignerStatus {
  type: 'status'
  /** Signers that reported an account and can actually sign. */
  signers: number
  /** Wallet pages connected at all, including ones with no wallet connected yet. */
  pages: number
  address?: string
  /** URL the wallet page is showing, so a requester can point a user at that tab. */
  pageUrl?: string
  /** User-Agent of the wallet page, so a requester can raise the right browser. */
  pageAgent?: string
}

type Role = 'signer' | 'requester'

interface Hello {
  token: string
  role: Role
  address?: string
  url?: string
}

const HANDSHAKE_TIMEOUT = 10_000

/** Ports a local relay may occupy, 3456 upward. Requesters scan the same span. */
export const LOCAL_PORT_ATTEMPTS = 5

/**
 * Rendezvous between transaction requesters (the MCP server) and signers (the browser
 * wallet page). Both sides are WebSocket clients, so the relay runs unchanged whether
 * it is embedded in the MCP process or deployed to a hosting provider.
 *
 * Every connection authenticates with a shared token in its first message — the relay
 * hands out transactions to sign, so an unauthenticated peer must never reach it.
 */
export class WalletRelay {
  private app: express.Application
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private signers = new Map<WebSocket, { address?: string; url?: string; agent?: string }>()
  private requesters = new Set<WebSocket>()
  private routes = new Map<string, { requester: WebSocket; signer: WebSocket }>()
  private port: number
  private host: string
  readonly token: string

  constructor(options: { port?: number; host?: string; token?: string } = {}) {
    this.port = options.port ?? (Number(process.env.PORT) || 3456)
    // Hosted deployments set PORT and need every interface; local runs stay on loopback.
    this.host = options.host ?? process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
    this.token = options.token ?? process.env.WALLET_TOKEN ?? randomBytes(16).toString('hex')

    this.app = express()
    this.app.use(cors())
    this.app.use(express.static(join(__dirname, '..', 'public'), { index: 'wallet.html' }))
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', signers: this.signers.size, requesters: this.requesters.size, pending: this.routes.size })
    })
  }

  async start(): Promise<void> {
    if (this.httpServer) return

    // A fixed PORT (hosted) must fail loudly; a local default may shift if taken. The span
    // must match the one requesters scan, or a relay lands where nobody looks for it.
    const maxAttempts = process.env.PORT ? 1 : LOCAL_PORT_ATTEMPTS
    const firstPort = this.port

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.httpServer = await this.listen(this.port)
        this.wss = new WebSocketServer({ server: this.httpServer })
        this.wss.on('connection', (ws, req) => this.onConnection(ws, req.headers['user-agent']))
        // Proxies in front of a hosted relay close idle sockets; keep them warm.
        this.heartbeat = setInterval(() => {
          for (const ws of this.wss?.clients ?? []) ws.ping()
        }, 30_000)
        this.heartbeat.unref()
        console.error(`[Wallet] Relay listening on http://${this.host}:${this.port}`)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        this.port++
      }
    }

    throw new Error(`Failed to start wallet relay: ports ${firstPort}-${this.port - 1} are all in use`)
  }

  private listen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer(this.app)
      server.once('error', reject)
      server.listen(port, this.host, () => {
        server.removeListener('error', reject)
        resolve(server)
      })
    })
  }

  private onConnection(ws: WebSocket, userAgent?: string) {
    const timer = setTimeout(() => ws.close(4001, 'handshake timeout'), HANDSHAKE_TIMEOUT)

    ws.once('message', (raw: Buffer) => {
      clearTimeout(timer)

      let hello: Hello
      try {
        hello = JSON.parse(raw.toString())
      } catch {
        ws.close(4001, 'invalid handshake')
        return
      }

      if (hello.token !== this.token || (hello.role !== 'signer' && hello.role !== 'requester')) {
        console.error('[Wallet] Rejected connection: bad token or role')
        ws.close(4001, 'unauthorized')
        return
      }

      if (hello.role === 'signer') {
        this.signers.set(ws, { address: hello.address, url: hello.url, agent: userAgent })
        ws.on('message', (data: Buffer) => this.onSignerMessage(ws, data))
        ws.on('close', () => this.onSignerClose(ws))
      } else {
        this.requesters.add(ws)
        ws.on('message', (data: Buffer) => this.onRequesterMessage(ws, data))
        ws.on('close', () => this.onRequesterClose(ws))
      }

      ws.on('error', () => ws.close())
      ws.send(JSON.stringify({ type: 'ready' }))
      this.broadcastStatus()
    })
  }

  private onRequesterMessage(requester: WebSocket, data: Buffer) {
    let request: TransactionRequest
    try {
      request = JSON.parse(data.toString())
    } catch {
      return
    }

    // Prefer a page that has an account; fall back to any open page.
    const open = [...this.signers.entries()].filter(([ws]) => ws.readyState === WebSocket.OPEN)
    const signer = (open.find(([, meta]) => meta.address) ?? open[0])?.[0]
    if (!signer) {
      this.respond(requester, { id: request.id, success: false, error: 'No wallet connected' })
      return
    }

    this.routes.set(request.id, { requester, signer })
    signer.send(JSON.stringify(request))
  }

  private onSignerMessage(signer: WebSocket, data: Buffer) {
    let response: TransactionResponse
    try {
      response = JSON.parse(data.toString())
    } catch {
      return
    }

    // Update the signer's address when the page reports an account change.
    if ((response as unknown as { type?: string }).type === 'status') {
      const update = response as unknown as { address?: string; url?: string }
      const previous = this.signers.get(signer)
      this.signers.set(signer, { address: update.address, url: update.url ?? previous?.url, agent: previous?.agent })
      this.broadcastStatus()
      return
    }

    const route = this.routes.get(response.id)
    if (!route) return
    this.routes.delete(response.id)
    this.respond(route.requester, response)
  }

  private onSignerClose(signer: WebSocket) {
    this.signers.delete(signer)
    // Fail anything in flight instead of leaving the requester hanging until timeout.
    for (const [id, route] of this.routes) {
      if (route.signer === signer) {
        this.routes.delete(id)
        this.respond(route.requester, { id, success: false, error: 'Wallet disconnected before responding' })
      }
    }
    this.broadcastStatus()
  }

  private onRequesterClose(requester: WebSocket) {
    this.requesters.delete(requester)
    for (const [id, route] of this.routes) {
      if (route.requester === requester) this.routes.delete(id)
    }
  }

  private respond(ws: WebSocket, response: TransactionResponse) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
  }

  private broadcastStatus() {
    const address = [...this.signers.values()].find((s) => s.address)?.address
    const withAccount = [...this.signers.values()].filter((s) => s.address).length
    const page = [...this.signers.values()].find((s) => s.url) ?? [...this.signers.values()][0]
    const status: SignerStatus = {
      type: 'status',
      signers: withAccount,
      pages: this.signers.size,
      address,
      pageUrl: page?.url,
      pageAgent: page?.agent
    }
    const message = JSON.stringify(status)
    for (const requester of this.requesters) {
      if (requester.readyState === WebSocket.OPEN) requester.send(message)
    }
  }

  getPort(): number {
    return this.port
  }

  /**
   * Pairing URL: the token travels in the fragment so it stays out of server logs.
   *
   * Names 127.0.0.1 rather than localhost on purpose — localhost resolves to ::1 first on
   * macOS, which would reach a process holding the wildcard port instead of ours.
   */
  getUrl(): string {
    const base = process.env.WALLET_PUBLIC_URL ?? `http://127.0.0.1:${this.port}/`
    return `${base}#t=${this.token}`
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const ws of [...this.signers.keys(), ...this.requesters]) ws.close()
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()))
    // Upgraded sockets keep the HTTP server alive, so drop them rather than wait them out.
    this.httpServer?.closeAllConnections()
    await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()))
    this.wss = null
    this.httpServer = null
  }
}

// Standalone entry point, for hosting the wallet frontend separately from the MCP server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = new WalletRelay()
  relay.start().then(() => {
    if (!process.env.WALLET_TOKEN) {
      console.error('[Wallet] WALLET_TOKEN not set — generated one for this run only:')
    }
    console.error(`[Wallet] Open ${relay.getUrl()}`)
  })
}
