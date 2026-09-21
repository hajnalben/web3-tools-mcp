import { spawn, ChildProcess } from 'child_process'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

export interface AnvilInstance {
  process: ChildProcess
  port: number
  rpcUrl: string
  client: ReturnType<typeof createPublicClient>
}

export interface AnvilConfig {
  forkUrl: string
  forkBlockNumber?: bigint
  port?: number
  chainId?: number
}

// Check if anvil is installed
export async function isAnvilInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('anvil', ['--version'], { shell: true })
    proc.on('close', code => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

// Find an available port
async function findAvailablePort(startPort: number = 8545): Promise<number> {
  const net = await import('net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(startPort, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        server.close(() => resolve(address.port))
      } else {
        server.close(() => reject(new Error('Could not get port')))
      }
    })
    server.on('error', () => {
      // Port in use, try next one
      findAvailablePort(startPort + 1).then(resolve).catch(reject)
    })
  })
}

// Start an Anvil instance
export async function startAnvil(config: AnvilConfig): Promise<AnvilInstance> {
  const installed = await isAnvilInstalled()
  if (!installed) {
    throw new Error(
      'Anvil is not installed. Please install Foundry: https://book.getfoundry.sh/getting-started/installation'
    )
  }

  const port = config.port ?? (await findAvailablePort())
  const rpcUrl = `http://127.0.0.1:${port}`

  const args = ['--fork-url', config.forkUrl, '--port', port.toString(), '--silent']

  if (config.forkBlockNumber !== undefined) {
    args.push('--fork-block-number', config.forkBlockNumber.toString())
  }

  if (config.chainId !== undefined) {
    args.push('--chain-id', config.chainId.toString())
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('anvil', args, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    proc.stderr?.on('data', data => {
      stderr += data.toString()
    })

    proc.on('error', err => {
      reject(new Error(`Failed to start Anvil: ${err.message}`))
    })

    proc.on('close', code => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Anvil exited with code ${code}: ${stderr}`))
      }
    })

    // Wait for Anvil to be ready by polling the RPC
    const maxAttempts = 50 // 5 seconds
    let attempts = 0

    const checkReady = async () => {
      attempts++
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1
          })
        })
        if (response.ok) {
          // Add small delay to ensure all RPC methods are ready (including debug_*)
          await new Promise(r => setTimeout(r, 100))
          const client = createPublicClient({
            chain: mainnet, // Chain is overridden by fork anyway
            transport: http(rpcUrl)
          })
          resolve({ process: proc, port, rpcUrl, client })
        } else if (attempts < maxAttempts) {
          setTimeout(checkReady, 100)
        } else {
          proc.kill()
          reject(new Error('Anvil failed to start within timeout'))
        }
      } catch {
        if (attempts < maxAttempts) {
          setTimeout(checkReady, 100)
        } else {
          proc.kill()
          reject(new Error('Anvil failed to start within timeout'))
        }
      }
    }

    // Start checking after a small delay
    setTimeout(checkReady, 200)
  })
}

// Stop an Anvil instance
export function stopAnvil(instance: AnvilInstance): void {
  if (instance.process && !instance.process.killed) {
    instance.process.kill('SIGTERM')
  }
}

// Helper to run a function with a temporary Anvil instance
export async function withAnvil<T>(
  config: AnvilConfig,
  fn: (instance: AnvilInstance) => Promise<T>
): Promise<T> {
  const instance = await startAnvil(config)
  try {
    return await fn(instance)
  } finally {
    stopAnvil(instance)
  }
}

// Archive RPC URLs for chains that need historical state access
const ARCHIVE_RPCS: Record<string, string> = {
  arbitrum: 'https://arbitrum-one.arpc.x.superfluid.dev'
}

// Trace a transaction using Anvil fork
export async function traceTransactionWithAnvil(
  forkUrl: string,
  transactionHash: string,
  blockNumber: bigint,
  tracer: 'callTracer' | 'prestateTracer' | 'stateDiffTracer' = 'callTracer',
  chainName?: string
): Promise<unknown> {
  // Use archive RPC if available for better historical state access
  const archiveUrl = chainName && ARCHIVE_RPCS[chainName] ? ARCHIVE_RPCS[chainName] : forkUrl

  // First, fetch the original transaction from the RPC
  const fetchClient = createPublicClient({
    chain: mainnet,
    transport: http(forkUrl)
  })

  const tx = await fetchClient.getTransaction({
    hash: transactionHash as `0x${string}`
  })

  if (!tx) {
    throw new Error(`Transaction ${transactionHash} not found`)
  }

  // Fork at the block BEFORE the transaction to replay it accurately
  // Note: This requires an archival RPC that has historical state
  const forkBlock = blockNumber > 0n ? blockNumber - 1n : 0n

  return withAnvil(
    {
      forkUrl: archiveUrl,
      forkBlockNumber: forkBlock
    },
    async instance => {
      // Use debug_traceCall to simulate and trace the transaction
      // Note: This replays the tx against the post-block state, which may differ slightly
      // from the original execution if state changed within the block
      const trace = await instance.client.request({
        method: 'debug_traceCall' as never,
        params: [
          {
            from: tx.from,
            to: tx.to,
            data: tx.input,
            value: tx.value ? `0x${tx.value.toString(16)}` : '0x0',
            gas: tx.gas ? `0x${tx.gas.toString(16)}` : undefined
          },
          'latest',
          { tracer }
        ] as never
      })

      return trace
    }
  )
}

// Simulate a call with tracing
export interface SimulateCallParams {
  to: string
  data?: string
  from?: string
  value?: bigint
  gas?: bigint
}

export async function simulateCallWithTrace(
  forkUrl: string,
  params: SimulateCallParams,
  blockNumber?: bigint,
  tracer: 'callTracer' | 'prestateTracer' = 'callTracer'
): Promise<{
  result: string
  trace: unknown
  gasUsed: bigint
  success: boolean
  revertReason?: string
}> {
  return withAnvil(
    {
      forkUrl,
      forkBlockNumber: blockNumber
    },
    async instance => {
      // First, try a regular call to get the result
      let result = '0x'
      let success = true
      let revertReason: string | undefined
      let gasUsed = 0n

      try {
        // Use eth_call to get the result
        result = (await instance.client.request({
          method: 'eth_call' as never,
          params: [
            {
              to: params.to,
              data: params.data,
              from: params.from ?? '0x0000000000000000000000000000000000000000',
              value: params.value ? `0x${params.value.toString(16)}` : undefined,
              gas: params.gas ? `0x${params.gas.toString(16)}` : undefined
            },
            'latest'
          ] as never
        })) as string

        // Estimate gas
        try {
          gasUsed = await instance.client.estimateGas({
            to: params.to as `0x${string}`,
            data: params.data as `0x${string}` | undefined,
            account: params.from as `0x${string}` | undefined,
            value: params.value
          })
        } catch {
          // Ignore gas estimation errors
        }
      } catch (error) {
        success = false
        const errorMessage = (error as Error).message
        // Try to extract revert reason
        const revertMatch = errorMessage.match(/revert(?:ed)?[:\s]*(.+?)(?:\n|$)/i)
        if (revertMatch) {
          revertReason = revertMatch[1].trim()
        } else {
          revertReason = errorMessage
        }
      }

      // Get the trace using debug_traceCall
      let trace: unknown = null
      try {
        trace = await instance.client.request({
          method: 'debug_traceCall' as never,
          params: [
            {
              to: params.to,
              data: params.data,
              from: params.from ?? '0x0000000000000000000000000000000000000000',
              value: params.value ? `0x${params.value.toString(16)}` : undefined,
              gas: params.gas ? `0x${params.gas.toString(16)}` : undefined
            },
            'latest',
            { tracer }
          ] as never
        })
      } catch (traceError) {
        // If tracing fails, include the error
        trace = { error: (traceError as Error).message }
      }

      return {
        result,
        trace,
        gasUsed,
        success,
        revertReason
      }
    }
  )
}
