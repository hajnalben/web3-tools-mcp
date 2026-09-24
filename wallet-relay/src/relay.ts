import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import type { TransactionRequest, TransactionResponse } from './protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Defined next door so the signing page can be checked against the same shapes, and
// re-exported so the package's consumers see no difference.
export type {
  ReadyMessage,
  SendTransactionData,
  SignMessageData,
  TransactionRequest,
  TransactionResponse,
  TxPreview
} from './protocol.js'

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

export type Role = 'signer' | 'requester'

/**
 * A token admitting one role to one room, signed by the relay's secret.
 *
 * The room travels in the token so the relay needs no record of who exists: it recomputes
 * the signature and believes the room only if it matches. Whoever holds the secret — the
 * MCP server — can mint a pair per person; nobody else can mint any.
 *
 * The roles are separated because they are not equally exposed. The page's token rides in
 * a URL the user opens, keeps in history and shares on screen, while the requester's never
 * leaves the server — and a requester can propose transactions, supplying much of what the
 * page then displays about them.
 */
export function roomToken(secret: string, room: Room, role: Role): string {
  const mac = createHmac('sha256', secret).update(`${role}:${room}`).digest('hex').slice(0, 32)
  return `${encodeURIComponent(room)}.${mac}`
}

/** The room a token is good for in this role, or null if it is not ours. */
function verifyRoomToken(secret: string, token: string, role: Role): Room | null {
  const split = token.lastIndexOf('.')
  if (split <= 0) return null

  let room: Room
  try {
    room = decodeURIComponent(token.slice(0, split))
  } catch {
    return null
  }

  // Constant-time: the MAC is the only thing standing between a guess and a room.
  const expected = Buffer.from(roomToken(secret, room, role))
  const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given) ? room : null
}

/** A frame's JSON when it is an object; anything else off the wire is dropped, not thrown on. */
function parseFrame(data: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data.toString())
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

interface Hello {
  token: string
  role: Role
  address?: string
  url?: string
}

/**
 * The boundary between people sharing one relay: a transaction is only ever offered to a
 * wallet page in the same room, and a page only ever learns about its own room's signers.
 *
 * Nothing stores rooms. A room is a label carried by the connections currently in it, so
 * it exists while someone is there and is gone when the last socket closes. Which token
 * belongs to which room is identity, and that lives in the resolver, not here.
 */
export type Room = string

/** Which room a token may join in a given role, or null to refuse the connection. */
export type RoomResolver = (token: string, role: Role) => Room | null | Promise<Room | null>

/** Every self-hosted run: one shared token pair, therefore one room. */
const DEFAULT_ROOM: Room = 'default'

/**
 * The resolver used when the host supplies none: admit any room whose token this secret
 * signed. A self-hosted server only ever mints DEFAULT_ROOM, so it sees one room; a hosted
 * one mints a pair per person and gets isolation without keeping a list of anybody.
 *
 * Replace it to decide rooms some other way — from a database, or to refuse a token that
 * is still validly signed but whose owner has stopped paying.
 */
function signedRooms(secret: string): RoomResolver {
  return (token, role) => verifyRoomToken(secret, token, role)
}

const HANDSHAKE_TIMEOUT = 10_000

/** Generous next to a 32-character default or a 64-character HMAC, and bounds the key. */
const MAX_TOKEN_LENGTH = 512

/**
 * Well clear of a real request — contract creation calldata tops out near 98KB of hex, and
 * a decoded preview adds little — while refusing the 100MB frame ws would otherwise take.
 */
const MAX_PAYLOAD = 512 * 1024

/**
 * Connections one room may hold, counting both roles. A person needs a handful: a wallet
 * tab or two, and a requester per editor session sharing the local relay. The cap is there
 * so one room cannot exhaust the process's sockets for every other room.
 */
const MAX_PER_ROOM = 16

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
  /** True when the server was handed to us by attach(), so stop() must leave it alone. */
  private borrowedServer = false
  private wss: WebSocketServer | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private signers = new Map<WebSocket, { room: Room; address?: string; url?: string; agent?: string }>()
  private requesters = new Map<WebSocket, Room>()
  private routes = new Map<string, { requester: WebSocket; signer: WebSocket }>()
  private resolveRoom: RoomResolver
  private port: number
  private host: string
  /**
   * The secret every room's tokens are signed with — not itself a credential, and never
   * given to a browser. Holding it is enough to mint a token for any room, so it stays on
   * the server that decides who gets one.
   */
  readonly token: string
  /** The default room's page credential, which is the whole of a self-hosted deployment. */
  readonly signerToken: string

  constructor(private options: { port?: number; host?: string; token?: string; publicUrl?: string; rooms?: RoomResolver } = {}) {
    this.port = options.port ?? (Number(process.env.PORT) || 3456)
    // Hosted deployments set PORT and need every interface; local runs stay on loopback.
    this.host = options.host ?? process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
    this.token = options.token ?? process.env.WALLET_TOKEN ?? randomBytes(16).toString('hex')
    this.signerToken = roomToken(this.token, DEFAULT_ROOM, 'signer')
    this.resolveRoom = options.rooms ?? signedRooms(this.token)

    this.app = express()
    this.app.use(cors())
    this.app.use(express.static(join(__dirname, '..', 'public'), { index: 'wallet.html' }))
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', signers: this.signers.size, requesters: this.requesters.size, pending: this.routes.size })
    })
  }

  /**
   * Share a server the caller already owns, instead of listening on a port of our own.
   *
   * A hosted deployment gets one port from its platform, and the MCP endpoint is already on
   * it — so the signing page rides along on the same origin rather than needing a second
   * service. The page derives its socket from `location`, so same-origin is all it needs.
   */
  attach(server: Server, mount: (app: express.Application) => void): void {
    if (this.httpServer) throw new Error('Relay is already running')

    mount(this.app)
    this.httpServer = server
    this.wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.headers['user-agent'], req.headers.origin))
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients ?? []) ws.ping()
    }, 30_000)
    this.heartbeat.unref()
    // The caller owns this server's lifetime, so stop() must not close it.
    this.borrowedServer = true
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
        this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: MAX_PAYLOAD })
        this.wss.on('connection', (ws, req) => this.onConnection(ws, req.headers['user-agent'], req.headers.origin))
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

  /**
   * Origins the signing page may legitimately be served from.
   *
   * WebSockets are not subject to the same-origin policy, and the local port is
   * predictable, so without this any site you have open could connect to the relay and
   * either push a transaction proposal at your wallet page or register as a signer and
   * intercept one. A browser always sends Origin, so a page on any other site is refused
   * before it can present a token at all.
   *
   * A non-browser client — the MCP server itself — sends no Origin, and the token stays
   * its only gate. That is not a hole: anything able to forge the header can forge it to
   * whatever we would accept.
   */
  private isAllowedOrigin(origin?: string): boolean {
    if (!origin) return true

    const allowed = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`])
    for (const base of [process.env.WALLET_PUBLIC_URL, this.options.publicUrl]) {
      if (!base) continue
      try {
        allowed.add(new URL(base).origin)
      } catch {
        // Not a URL we can parse; nothing to allow.
      }
    }

    return allowed.has(origin)
  }

  private onConnection(ws: WebSocket, userAgent?: string, origin?: string) {
    if (!this.isAllowedOrigin(origin)) {
      console.error(`[Wallet] Rejected connection from origin ${origin}`)
      ws.close(4003, 'forbidden origin')
      return
    }

    const timer = setTimeout(() => ws.close(4001, 'handshake timeout'), HANDSHAKE_TIMEOUT)

    ws.once('message', async (raw: Buffer) => {
      clearTimeout(timer)

      const hello = parseFrame(raw) as Hello | null
      if (!hello) {
        ws.close(4001, 'invalid handshake')
        return
      }

      // A peer may send its first request in the same read as the handshake. Resolving a
      // room can yield, and a message emitted in that gap would reach no listener at all,
      // so hold anything that arrives and replay it once the role's handler is attached.
      const early: Buffer[] = []
      const hold = (data: Buffer) => early.push(data)
      ws.on('message', hold)

      // `Hello` describes what a peer should send; nothing makes it. The token becomes a
      // lookup key in a resolver we do not own, so check it here rather than trusting the
      // shape — the page is plain JS and anything at all can open a socket.
      const token = typeof hello.token === 'string' && hello.token.length <= MAX_TOKEN_LENGTH ? hello.token : null

      let room: Room | null = null
      if (token !== null && (hello.role === 'signer' || hello.role === 'requester')) {
        try {
          room = await this.resolveRoom(token, hello.role)
        } catch (error) {
          console.error(`[Wallet] Room lookup failed: ${(error as Error).message}`)
        }
      }

      ws.off('message', hold)

      // A resolver may go to storage, and the socket can be gone by the time it answers.
      if (ws.readyState !== WebSocket.OPEN) return

      if (!room) {
        console.error('[Wallet] Rejected connection: bad token or role')
        ws.close(4001, 'unauthorized')
        return
      }

      if (this.roomSize(room) >= MAX_PER_ROOM) {
        console.error(`[Wallet] Rejected connection: room already holds ${MAX_PER_ROOM} connections`)
        ws.close(4008, 'room is full')
        return
      }

      if (hello.role === 'signer') {
        this.signers.set(ws, { room, address: hello.address, url: hello.url, agent: userAgent })
        ws.on('message', (data: Buffer) => this.onSignerMessage(ws, data))
        ws.on('close', () => this.onSignerClose(ws))
      } else {
        this.requesters.set(ws, room)
        ws.on('message', (data: Buffer) => this.onRequesterMessage(ws, data))
        ws.on('close', () => this.onRequesterClose(ws))
      }

      ws.on('error', () => ws.close())
      console.error(`[Wallet] ${hello.role} joined${hello.address ? ` as ${hello.address}` : ''}`)
      ws.send(JSON.stringify({ type: 'ready' }))
      this.broadcastStatus(room)

      for (const data of early) {
        if (hello.role === 'signer') this.onSignerMessage(ws, data)
        else this.onRequesterMessage(ws, data)
      }
    })
  }

  /** Live connections in a room, both roles — what MAX_PER_ROOM bounds. */
  private roomSize(room: Room): number {
    let count = 0
    for (const meta of this.signers.values()) if (meta.room === room) count++
    for (const held of this.requesters.values()) if (held === room) count++
    return count
  }

  private onRequesterMessage(requester: WebSocket, data: Buffer) {
    const request = parseFrame(data) as TransactionRequest | null
    if (!request || typeof request.id !== 'string') return

    // Only this requester's own room: another room's wallet must never be offered the
    // transaction, nor learn that it exists. Prefer a page that has an account there;
    // fall back to any open page in the room.
    const room = this.requesters.get(requester)
    const open = [...this.signers.entries()].filter(([ws, meta]) => meta.room === room && ws.readyState === WebSocket.OPEN)
    const signer = (open.find(([, meta]) => meta.address) ?? open[0])?.[0]
    if (!signer) {
      this.respond(requester, { id: request.id, success: false, error: 'No wallet connected' })
      return
    }

    this.routes.set(request.id, { requester, signer })
    console.error(`[Wallet] Routed ${request.type} ${request.id.slice(0, 8)} on ${request.chain} to a signer`)
    signer.send(JSON.stringify(request))
  }

  private onSignerMessage(signer: WebSocket, data: Buffer) {
    const response = parseFrame(data) as TransactionResponse | null
    if (!response) return

    // Update the signer's address when the page reports an account change.
    if ((response as unknown as { type?: string }).type === 'status') {
      const update = response as unknown as { address?: string; url?: string }
      const previous = this.signers.get(signer)
      if (!previous) return
      this.signers.set(signer, {
        room: previous.room,
        address: update.address,
        url: update.url ?? previous.url,
        agent: previous.agent
      })
      this.broadcastStatus(previous.room)
      return
    }

    // Request ids are chosen by the requester, so answering one must be reserved to the
    // page it was actually handed to — otherwise a room could answer another's request.
    const route = this.routes.get(response.id)
    if (!route || route.signer !== signer) return
    this.routes.delete(response.id)
    this.respond(route.requester, response)
  }

  private onSignerClose(signer: WebSocket) {
    const room = this.signers.get(signer)?.room
    this.signers.delete(signer)
    // Fail anything in flight instead of leaving the requester hanging until timeout.
    for (const [id, route] of this.routes) {
      if (route.signer === signer) {
        this.routes.delete(id)
        this.respond(route.requester, { id, success: false, error: 'Wallet disconnected before responding' })
      }
    }
    if (room) this.broadcastStatus(room)
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

  private broadcastStatus(room: Room) {
    const pages = [...this.signers.values()].filter((s) => s.room === room)
    const address = pages.find((s) => s.address)?.address
    const withAccount = pages.filter((s) => s.address).length
    const page = pages.find((s) => s.url) ?? pages[0]
    const status: SignerStatus = {
      type: 'status',
      signers: withAccount,
      pages: pages.length,
      address,
      pageUrl: page?.url,
      pageAgent: page?.agent
    }
    const message = JSON.stringify(status)
    for (const [requester, requesterRoom] of this.requesters) {
      if (requesterRoom === room && requester.readyState === WebSocket.OPEN) requester.send(message)
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
   *
   * Defaults to the single-room case. With a `rooms` resolver there is a token per room,
   * and the caller passes the one belonging to whoever is being sent this link.
   */
  getUrl(token: string = this.signerToken): string {
    const base = process.env.WALLET_PUBLIC_URL ?? (this.borrowedServer ? '/' : `http://127.0.0.1:${this.port}/`)
    return `${base}#t=${token}`
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const ws of [...this.signers.keys(), ...this.requesters.keys()]) ws.close()
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()))

    if (!this.borrowedServer) {
      // Upgraded sockets keep the HTTP server alive, so drop them rather than wait them out.
      this.httpServer?.closeAllConnections()
      await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()))
    }

    this.wss = null
    this.httpServer = null
    this.borrowedServer = false
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
