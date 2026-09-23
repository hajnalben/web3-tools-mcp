import type { AbiParameter } from 'viem'
import type { z } from 'zod'
import type { Config, ToolResult } from './types.js'

// Create tool helper
export function createTool<T extends z.ZodType>(
  title: string,
  description: string,
  schema: T,
  handler: (args: z.infer<T>, identity: string) => Promise<ToolResult>
) {
  return {
    title,
    description,
    schema,
    handler
  }
}

// Convert BigInt values to strings for JSON serialization
export function convertBigIntToString(obj: unknown): unknown {
  if (typeof obj === 'bigint') {
    return obj.toString()
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => convertBigIntToString(item))
  }
  if (obj && typeof obj === 'object') {
    const converted: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertBigIntToString(value)
    }
    return converted
  }
  return obj
}

// Summarize a call trace for compact output
export interface SummarizedCall {
  type: string
  from: string
  to: string
  selector?: string
  error?: string
  depth: number
}

export function summarizeTrace(trace: unknown): { hasError: boolean; errorPath: SummarizedCall[] | null; summary: string } {
  // Use ref object to avoid TypeScript closure narrowing issues
  const result: { errorPath: SummarizedCall[]; errorMessage: string } | null = findErrorInTrace(trace)

  // Generate summary
  let summary: string
  if (result) {
    const lastCall = result.errorPath[result.errorPath.length - 1]
    summary = `REVERTED at depth ${lastCall.depth}: ${lastCall.to} (${lastCall.selector || 'unknown'}) - ${result.errorMessage}`
  } else {
    // For successful txs, just show top-level calls
    const topCalls: string[] = []
    const rootCall = trace as Record<string, unknown>
    const subcalls = rootCall.calls as Record<string, unknown>[] | undefined
    if (subcalls) {
      for (const sub of subcalls) {
        const type = sub.type as string
        if (type !== 'DELEGATECALL') {
          const input = sub.input as string | undefined
          const selector = input && input.length >= 10 ? input.slice(0, 10) : '?'
          topCalls.push(`${type} ${sub.to} (${selector})`)
        }
      }
    }
    summary = `SUCCESS - ${topCalls.length} top-level calls: ${topCalls.slice(0, 5).join(', ')}${topCalls.length > 5 ? '...' : ''}`
  }

  return {
    hasError: result !== null,
    errorPath: result?.errorPath ?? null,
    summary
  }
}

function findErrorInTrace(trace: unknown): { errorPath: SummarizedCall[]; errorMessage: string } | null {
  if (!trace || typeof trace !== 'object') return null

  function findError(
    call: Record<string, unknown>,
    path: SummarizedCall[]
  ): { errorPath: SummarizedCall[]; errorMessage: string } | null {
    const type = (call.type as string) || 'CALL'
    const error = (call.error as string) || (call.revertReason as string)
    const subcalls = call.calls as Record<string, unknown>[] | undefined
    const input = call.input as string | undefined

    // Skip DELEGATECALL for cleaner output
    if (type === 'DELEGATECALL') {
      if (subcalls) {
        for (const subcall of subcalls) {
          const result = findError(subcall, path)
          if (result) return result
        }
      }
      return null
    }

    const currentCall: SummarizedCall = {
      type,
      from: (call.from as string) || '',
      to: (call.to as string) || '',
      selector: input && input.length >= 10 ? input.slice(0, 10) : undefined,
      error: error || undefined,
      depth: path.length
    }

    const newPath = [...path, currentCall]

    // Check subcalls first (error might be deeper)
    if (subcalls) {
      for (const subcall of subcalls) {
        const result = findError(subcall, newPath)
        if (result) return result
      }
    }

    // If this call has an error and no subcall had one, this is the source
    if (error) {
      return { errorPath: newPath, errorMessage: error }
    }

    return null
  }

  return findError(trace as Record<string, unknown>, [])
}

/**
 * Coerce a JSON value into what viem expects for an ABI type. Tuples, arrays and anything
 * else pass through: viem validates them, and guessing here would only mangle them.
 */
function coerce(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null

  if (type === 'address' || type === 'string' || type.startsWith('bytes')) {
    return String(value)
  }

  if (type === 'bool') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value.toLowerCase() === 'true'
    return Boolean(value)
  }

  if (type.startsWith('uint') || type.startsWith('int')) {
    if (typeof value === 'number' || typeof value === 'string') return BigInt(value)
    throw new Error(`Invalid type for ${type}: ${typeof value}`)
  }

  return value
}

export function convertArgumentsToTypes(
  args: (string | number | boolean | null)[],
  abiInputs: readonly AbiParameter[]
): unknown[] {
  if (args.length > abiInputs.length) {
    throw new Error(`Too many arguments provided. Expected ${abiInputs.length}, got ${args.length}`)
  }

  return args.map((arg, index) => {
    const param = abiInputs[index]
    if (!param?.type) {
      throw new Error(`Missing type information for parameter at index ${index}`)
    }
    return coerce(arg, param.type)
  })
}

export function convertEventArgsToTypes(
  eventArgs: Record<string, unknown>,
  abiInputs: readonly AbiParameter[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(eventArgs).map(([argName, argValue]) => {
      const param = abiInputs.find((input) => input.name === argName)
      if (!param) {
        throw new Error(`Parameter '${argName}' not found in event ABI`)
      }
      if (!param.type) {
        throw new Error(`Missing type information for parameter '${argName}'`)
      }
      return [argName, coerce(argValue, param.type)]
    })
  )
}

// Format response as tool result
export function formatResponse(data: unknown): ToolResult {
  const serializable = convertBigIntToString(data)
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(serializable, null, 2)
      }
    ]
  }
}

// Parse command line arguments
export function parseCommandLineArgs(): Config & { showHelp?: boolean } {
  const config: Config & { showHelp?: boolean } = {}

  function getArgValue(argName: string): string | undefined {
    const args = process.argv
    const index = args.indexOf(argName)
    return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
  }

  function hasArg(argName: string): boolean {
    return process.argv.includes(argName)
  }

  // Check for help flag
  if (hasArg('--help') || hasArg('-h')) {
    config.showHelp = true
    return config
  }

  // Parse environment variables and command line arguments
  config.etherscanApiKey = process.env.ETHERSCAN_API_KEY || getArgValue('--etherscan-api-key')
  config.alchemyApiKey = process.env.ALCHEMY_API_KEY || getArgValue('--alchemy-api-key')
  config.infuraApiKey = process.env.INFURA_API_KEY || getArgValue('--infura-api-key')
  config.hypersyncApiKey = process.env.HYPERSYNC_API_KEY || getArgValue('--hypersync-api-key')
  config.walletConnectProjectId = process.env.WALLETCONNECT_PROJECT_ID || getArgValue('--walletconnect-project-id')

  // Parse custom RPC URLs
  const customRpcs = process.env.CUSTOM_RPC || getArgValue('--custom-rpc')
  if (customRpcs) {
    try {
      config.customRpcUrls = JSON.parse(customRpcs)
    } catch {
      console.error('Invalid JSON for --custom-rpc:', customRpcs)
    }
  }

  return config
}
