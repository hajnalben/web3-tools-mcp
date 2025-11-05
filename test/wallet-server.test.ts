import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'http'
import { WalletServer } from '../src/wallet-server.js'

// Helper to create a blocking server on a specific port
function createBlockingServer(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(port, () => {
      resolve(server)
    }).on('error', reject)
  })
}

// Helper to close a server
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('WalletServer Port Conflict Handling', () => {
  const servers: ReturnType<typeof createServer>[] = []
  const walletServers: WalletServer[] = []

  afterEach(async () => {
    // Clean up all wallet servers
    for (const ws of walletServers) {
      await ws.stop()
    }
    walletServers.length = 0

    // Clean up all blocking servers
    for (const server of servers) {
      await closeServer(server)
    }
    servers.length = 0
  })

  it('should start successfully on default port when available', async () => {
    const walletServer = new WalletServer(4000)
    walletServers.push(walletServer)

    await walletServer.start()

    expect(walletServer.getPort()).toBe(4000)
    expect(walletServer['isStarted']).toBe(true)
  })

  it('should retry on next port when default port is in use', async () => {
    const defaultPort = 4001

    // Block the default port
    const blockingServer = await createBlockingServer(defaultPort)
    servers.push(blockingServer)

    const walletServer = new WalletServer(defaultPort)
    walletServers.push(walletServer)

    await walletServer.start()

    // Should have moved to next port
    expect(walletServer.getPort()).toBe(defaultPort + 1)
    expect(walletServer['isStarted']).toBe(true)
  }, 10000) // 10 second timeout

  it('should retry multiple times until finding available port', async () => {
    const defaultPort = 4010

    // Block several consecutive ports
    const blockingServer1 = await createBlockingServer(defaultPort)
    const blockingServer2 = await createBlockingServer(defaultPort + 1)
    const blockingServer3 = await createBlockingServer(defaultPort + 2)
    servers.push(blockingServer1, blockingServer2, blockingServer3)

    const walletServer = new WalletServer(defaultPort)
    walletServers.push(walletServer)

    await walletServer.start()

    // Should have moved to the first available port
    expect(walletServer.getPort()).toBe(defaultPort + 3)
    expect(walletServer['isStarted']).toBe(true)
  }, 15000) // 15 second timeout

  it('should throw error after exhausting all port attempts', async () => {
    const defaultPort = 4020
    const maxAttempts = 10

    // Block all ports that would be tried
    const blockingServers = await Promise.all(
      Array.from({ length: maxAttempts }, (_, i) =>
        createBlockingServer(defaultPort + i)
      )
    )
    servers.push(...blockingServers)

    const walletServer = new WalletServer(defaultPort)
    walletServers.push(walletServer)

    await expect(walletServer.start()).rejects.toThrow(
      /Failed to start wallet server: Ports .* are all in use/
    )

    expect(walletServer['isStarted']).toBe(false)
  }, 20000) // 20 second timeout

  it('should not restart if already started', async () => {
    const walletServer = new WalletServer(4030)
    walletServers.push(walletServer)

    await walletServer.start()
    const port1 = walletServer.getPort()

    // Try to start again
    await walletServer.start()
    const port2 = walletServer.getPort()

    // Port should remain the same
    expect(port1).toBe(port2)
    expect(port1).toBe(4030)
  })

  it('should properly stop and restart on same port', async () => {
    const walletServer = new WalletServer(4040)
    walletServers.push(walletServer)

    // Start server
    await walletServer.start()
    expect(walletServer.getPort()).toBe(4040)
    expect(walletServer['isStarted']).toBe(true)

    // Stop server
    await walletServer.stop()
    expect(walletServer['isStarted']).toBe(false)

    // Start again - should work on same port
    await walletServer.start()
    expect(walletServer.getPort()).toBe(4040)
    expect(walletServer['isStarted']).toBe(true)
  })

})
