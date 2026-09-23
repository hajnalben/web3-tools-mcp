import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { HOSTED } from './hosted.js'

/**
 * Tracing through a node that already supports `debug_*`, usually a local Anvil. Nothing
 * is started here.
 *
 * Anvil serves no block below its own fork height — `debug_traceCall` at an earlier one
 * fails with BlockOutOfRangeError — so replaying an old transaction means re-forking the
 * node there with `anvil_reset`. That discards whatever state it held, which is why it
 * happens only when ANVIL_ALLOW_RESET says so. A provider whose endpoint exposes
 * `debug_traceTransaction` needs none of this and is tried first.
 */

const DEFAULT_DEBUG_RPC = 'http://127.0.0.1:8545'

/** Re-forking clears the node, so it is never done to someone's dev chain uninvited. */
const ALLOW_RESET = ['1', 'true', 'yes'].includes((process.env.ANVIL_ALLOW_RESET ?? '').toLowerCase())

/**
 * The node to ask for traces, or undefined when there is none.
 *
 * Hosted, only an explicit setting counts: defaulting to loopback would turn every trace
 * into a request against the server's own private network.
 */
export function debugRpcUrl(): string | undefined {
  if (process.env.ANVIL_RPC_URL) return process.env.ANVIL_RPC_URL
  return HOSTED ? undefined : DEFAULT_DEBUG_RPC
}

function debugClient(url: string) {
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

/** Whether a tracing node is reachable and actually offers the debug namespace. */
export async function isDebugNodeAvailable(): Promise<boolean> {
  const url = debugRpcUrl()
  if (!url) return false

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'web3_clientVersion', params: [], id: 1 }),
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

export interface SimulateCallParams {
  to: string
  data?: string
  from?: string
  value?: bigint
  gas?: bigint
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function callObject(params: SimulateCallParams) {
  return {
    to: params.to,
    data: params.data,
    from: params.from ?? ZERO_ADDRESS,
    value: params.value ? `0x${params.value.toString(16)}` : undefined,
    gas: params.gas ? `0x${params.gas.toString(16)}` : undefined
  }
}

function blockTag(blockNumber?: bigint): string {
  return blockNumber === undefined ? 'latest' : `0x${blockNumber.toString(16)}`
}

function requireDebugNode(): string {
  const url = debugRpcUrl()
  if (!url) {
    throw new Error('No tracing node configured. Set ANVIL_RPC_URL to a node exposing debug_traceCall, such as a local Anvil.')
  }
  return url
}

function isBlockOutOfRange(error: unknown): boolean {
  return /BlockOutOfRangeError|block height is/i.test((error as Error)?.message ?? '')
}

type DebugClient = ReturnType<typeof debugClient>

/**
 * Run something against a block, re-forking the node when it cannot reach that far back.
 *
 * Returns to head afterwards rather than leaving the node pinned to an old block, which
 * would silently break whatever the owner does with it next. Its state is gone either way.
 */
async function atBlock<T>(
  client: DebugClient,
  forkUrl: string,
  blockNumber: bigint | undefined,
  run: (block: string) => Promise<T>
): Promise<T> {
  try {
    return await run(blockTag(blockNumber))
  } catch (error) {
    if (blockNumber === undefined || !isBlockOutOfRange(error)) throw error

    if (!ALLOW_RESET) {
      throw new Error(
        `The tracing node is forked past block ${blockNumber}, and Anvil serves nothing earlier. Re-forking it there would clear its state, so set ANVIL_ALLOW_RESET=1 to allow that — or use an RPC whose endpoint supports debug_traceTransaction.`
      )
    }

    const refork = (block?: bigint) =>
      client.request({
        method: 'anvil_reset' as never,
        params: [{ forking: { jsonRpcUrl: forkUrl, ...(block === undefined ? {} : { blockNumber: Number(block) }) } }] as never
      })

    await refork(blockNumber)
    try {
      return await run('latest')
    } finally {
      await refork().catch(() => {})
    }
  }
}

function traceCall(client: DebugClient, call: ReturnType<typeof callObject>, block: string, tracer: string): Promise<unknown> {
  return client.request({ method: 'debug_traceCall' as never, params: [call, block, { tracer }] as never })
}

/**
 * Replay a transaction through the tracing node.
 *
 * Run against the block before it, so the state is what the transaction actually saw. The
 * node needs archive access to that block; without it this fails rather than quietly
 * tracing against the wrong state.
 */
export async function traceTransactionWithAnvil(
  forkUrl: string,
  transactionHash: string,
  blockNumber: bigint,
  tracer: 'callTracer' | 'prestateTracer' | 'stateDiffTracer' = 'callTracer'
): Promise<unknown> {
  const tx = await debugClient(forkUrl).getTransaction({ hash: transactionHash as `0x${string}` })
  if (!tx) throw new Error(`Transaction ${transactionHash} not found`)

  const client = debugClient(requireDebugNode())
  const call = callObject({ to: tx.to ?? ZERO_ADDRESS, data: tx.input, from: tx.from, value: tx.value, gas: tx.gas })
  return atBlock(client, forkUrl, blockNumber > 0n ? blockNumber - 1n : 0n, (block) => traceCall(client, call, block, tracer))
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
  const client = debugClient(requireDebugNode())
  const call = callObject(params)

  // Call, gas and trace all inside one atBlock, so they describe the same state: a block
  // the node cannot serve re-forks it once, instead of being reported as a revert.
  return atBlock(client, forkUrl, blockNumber, async (block) => {
    let result = '0x'
    let success = true
    let revertReason: string | undefined
    let gasUsed = 0n

    try {
      result = (await client.request({ method: 'eth_call' as never, params: [call, block] as never })) as string
      gasUsed = await client
        .request({ method: 'eth_estimateGas' as never, params: [call, block] as never })
        .then((gas) => BigInt(gas as string))
        // Gas estimation is a nicety; a failure here says nothing about the call itself.
        .catch(() => 0n)
    } catch (error) {
      if (isBlockOutOfRange(error)) throw error
      success = false
      const message = (error as Error).message
      revertReason = message.match(/revert(?:ed)?[:\s]*(.+?)(?:\n|$)/i)?.[1]?.trim() ?? message
    }

    const trace = await traceCall(client, call, block, tracer).catch((error) => {
      if (isBlockOutOfRange(error)) throw error
      return { error: (error as Error).message }
    })

    return { result, trace, gasUsed, success, revertReason }
  })
}
