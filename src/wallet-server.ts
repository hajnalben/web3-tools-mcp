import express from 'express'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { exec } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface TransactionRequest {
  id: string
  type: 'send_transaction' | 'sign_message' | 'sign_typed_data'
  chain: string
  data: unknown
}

export interface TransactionResponse {
  id: string
  success: boolean
  result?: unknown
  error?: string
}

export class WalletServer {
  private app: express.Application
  private httpServer: ReturnType<typeof createServer>
  private wss: WebSocketServer
  private clients: Set<WebSocket> = new Set()
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }> = new Map()
  private port: number
  private isStarted = false

  constructor(port = 3456) {
    this.port = port
    this.app = express()
    this.httpServer = createServer(this.app)
    this.wss = new WebSocketServer({ server: this.httpServer })

    this.setupExpress()
    this.setupWebSocket()
  }

  private setupExpress() {
    this.app.use(cors())
    this.app.use(express.json())
    this.app.use(express.static(join(__dirname, '..', 'public')))

    this.app.get('/', (_req, res) => {
      res.sendFile(join(__dirname, '..', 'public', 'wallet.html'))
    })

    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        clients: this.clients.size,
        pendingRequests: this.pendingRequests.size
      })
    })
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket) => {
      console.error('[Wallet Server] Client connected')
      this.clients.add(ws)

      ws.on('message', (data: Buffer) => {
        try {
          const response: TransactionResponse = JSON.parse(data.toString())
          console.error('[Wallet Server] Received response:', response.id)
          console.error('[Wallet Server] Response data:', JSON.stringify(response))

          const pending = this.pendingRequests.get(response.id)
          if (pending) {
            if (response.success) {
              pending.resolve(response.result)
            } else {
              pending.reject(new Error(response.error || 'Transaction failed'))
            }
            this.pendingRequests.delete(response.id)
          }
        } catch (error) {
          console.error('[Wallet Server] Error parsing message:', error)
        }
      })

      ws.on('close', () => {
        console.error('[Wallet Server] Client disconnected')
        this.clients.delete(ws)
      })

      ws.on('error', (error) => {
        console.error('[Wallet Server] WebSocket error:', error)
        this.clients.delete(ws)
      })
    })
  }

  async start() {
    if (this.isStarted) {
      return
    }

    return this.startWithRetry()
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a fresh server for this attempt
      const tempServer = createServer(this.app)

      const cleanup = () => {
        tempServer.removeAllListeners()
      }

      const onError = (error: NodeJS.ErrnoException) => {
        cleanup()
        reject(error)
      }

      const onListening = () => {
        cleanup()
        // Success! Replace our server instance with this working one
        this.httpServer = tempServer
        this.wss = new WebSocketServer({ server: this.httpServer })
        this.setupWebSocket()
        resolve()
      }

      tempServer.once('error', onError)
      tempServer.once('listening', onListening)
      tempServer.listen(port)
    })
  }

  private async startWithRetry(maxAttempts = 10): Promise<void> {
    const originalPort = this.port

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.tryListen(this.port)

        // Success - server started
        this.isStarted = true
        if (this.port !== originalPort) {
          console.error(`[Wallet Server] Port ${originalPort} was in use, using port ${this.port} instead`)
        }
        console.error(`[Wallet Server] Running on http://localhost:${this.port}`)
        return
      } catch (error: unknown) {
        const errnoError = error as NodeJS.ErrnoException
        if (errnoError.code === 'EADDRINUSE') {
          console.error(`[Wallet Server] Port ${this.port} in use, trying port ${this.port + 1}...`)
          this.port++
        } else {
          throw error
        }
      }
    }

    // If we exhausted all attempts
    throw new Error(
      `Failed to start wallet server: Ports ${originalPort}-${originalPort + maxAttempts - 1} are all in use. ` +
      `Please free up a port or specify a different starting port.`
    )
  }

  async stop() {
    return new Promise<void>((resolve) => {
      this.clients.forEach(client => client.close())
      this.wss.close(() => {
        this.httpServer.close(() => {
          this.isStarted = false
          console.error('[Wallet Server] Stopped')
          resolve()
        })
      })
    })
  }

  openBrowser() {
    const url = `http://localhost:${this.port}`
    const platform = process.platform

    let command: string
    if (platform === 'darwin') {
      command = `open "${url}"`
    } else if (platform === 'win32') {
      command = `start "${url}"`
    } else {
      command = `xdg-open "${url}"`
    }

    exec(command, (error) => {
      if (error) {
        console.error('[Wallet Server] Failed to open browser:', error)
        console.error(`[Wallet Server] Please open manually: ${url}`)
      } else {
        console.error(`[Wallet Server] Opened browser at ${url}`)
      }
    })
  }

  async sendTransaction(request: TransactionRequest): Promise<unknown> {
    if (!this.isStarted) {
      await this.start()
    }

    // Always open/focus browser for transaction requests
    this.openBrowser()

    // Open browser if no clients connected
    if (this.clients.size === 0) {
      // Wait for client to connect (max 30 seconds)
      const timeout = 30000
      const startTime = Date.now()
      while (this.clients.size === 0 && Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      if (this.clients.size === 0) {
        throw new Error('No wallet connected. Please open the browser and connect your wallet.')
      }
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject })

      // Send to first available connected client only
      const message = JSON.stringify(request)
      let sent = false
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message)
          sent = true
          break
        }
      }

      if (!sent) {
        this.pendingRequests.delete(request.id)
        reject(new Error('No active wallet connection'))
        return
      }

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id)
          reject(new Error('Transaction request timed out'))
        }
      }, 300000)
    })
  }

  isConnected(): boolean {
    return this.clients.size > 0
  }

  getPort(): number {
    return this.port
  }
}

// Singleton instance
let walletServer: WalletServer | null = null

export function getWalletServer(): WalletServer {
  if (!walletServer) {
    walletServer = new WalletServer()
  }
  return walletServer
}

export async function startWalletServer(): Promise<WalletServer> {
  const server = getWalletServer()
  await server.start()
  return server
}
