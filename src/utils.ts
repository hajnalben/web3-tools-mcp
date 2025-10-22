import type { AbiParameter } from 'viem'
import type { ToolResult } from './types.js'
import { z } from 'zod'

// Create tool helper
export function createTool<T extends z.ZodType>(
  title: string,
  description: string,
  schema: T,
  handler: (args: z.infer<T>) => Promise<ToolResult>
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
    return obj.map(item => convertBigIntToString(item))
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

// Convert arguments to appropriate types based on ABI
export function convertArgumentsToTypes(
  args: (string | number | boolean | null)[],
  abiInputs: readonly AbiParameter[]
): unknown[] {
  return args.map((arg, index) => {
    if (index >= abiInputs.length) {
      throw new Error(`Too many arguments provided. Expected ${abiInputs.length}, got ${args.length}`)
    }

    const param = abiInputs[index]
    if (!param?.type) {
      throw new Error(`Missing type information for parameter at index ${index}`)
    }

    const paramType = param.type

    // Handle null values
    if (arg === null) {
      return null
    }

    // Handle different parameter types
    if (paramType === 'address') {
      return String(arg)
    }

    if (paramType === 'bool') {
      if (typeof arg === 'boolean') return arg
      if (typeof arg === 'string') return arg.toLowerCase() === 'true'
      return Boolean(arg)
    }

    if (paramType.startsWith('uint') || paramType.startsWith('int')) {
      if (typeof arg === 'number') return BigInt(arg)
      if (typeof arg === 'string') return BigInt(arg)
      throw new Error(`Invalid type for ${paramType}: ${typeof arg}`)
    }

    if (paramType === 'string') {
      return String(arg)
    }

    if (paramType === 'bytes' || paramType.startsWith('bytes')) {
      return String(arg)
    }

    // For other types, try to convert appropriately
    if (typeof arg === 'string' && arg.startsWith('0x')) {
      return arg // Assume it's already properly formatted
    }
    return arg
  })
}

// Convert event arguments to appropriate types
export function convertEventArgsToTypes(
  eventArgs: Record<string, unknown>,
  abiInputs: readonly AbiParameter[]
): Record<string, unknown> {
  const converted: Record<string, unknown> = {}

  for (const [argName, argValue] of Object.entries(eventArgs)) {
    // Find the parameter definition for this argument name
    const param = abiInputs.find(input => input.name === argName)

    if (!param) {
      throw new Error(`Parameter '${argName}' not found in event ABI`)
    }

    if (!param.type) {
      throw new Error(`Missing type information for parameter '${argName}'`)
    }

    const paramType = param.type

    // Handle null/undefined values
    if (argValue === null || argValue === undefined) {
      converted[argName] = null
      continue
    }

    // Handle different parameter types
    if (paramType === 'address') {
      converted[argName] = String(argValue)
    } else if (paramType === 'bool') {
      if (typeof argValue === 'boolean') {
        converted[argName] = argValue
      } else if (typeof argValue === 'string') {
        converted[argName] = argValue.toLowerCase() === 'true'
      } else {
        converted[argName] = Boolean(argValue)
      }
    } else if (paramType.startsWith('uint') || paramType.startsWith('int')) {
      if (typeof argValue === 'number') {
        converted[argName] = BigInt(argValue)
      } else if (typeof argValue === 'string') {
        converted[argName] = BigInt(argValue)
      } else {
        throw new Error(`Invalid type for ${paramType}: ${typeof argValue}`)
      }
    } else if (paramType === 'string') {
      converted[argName] = String(argValue)
    } else if (paramType === 'bytes' || paramType.startsWith('bytes')) {
      converted[argName] = String(argValue)
    } else {
      // For other types, handle arrays and try to convert appropriately
      if (Array.isArray(argValue)) {
        converted[argName] = argValue
      } else if (typeof argValue === 'string' && argValue.startsWith('0x')) {
        converted[argName] = argValue // Assume it's already properly formatted
      } else {
        converted[argName] = argValue
      }
    }
  }

  return converted
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
export function parseCommandLineArgs(): {
  etherscanApiKey?: string
  alchemyApiKey?: string
  infuraApiKey?: string
  customRpcUrls?: Record<string, string>
  hypersyncApiKey?: string
  showHelp?: boolean
} {
  const config: {
    etherscanApiKey?: string
    alchemyApiKey?: string
    infuraApiKey?: string
    customRpcUrls?: Record<string, string>
    hypersyncApiKey?: string
    showHelp?: boolean
  } = {}

  function getArgValue(argName: string): string | undefined {
    const args = process.argv
    const index = args.findIndex(arg => arg === argName)
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

  // Parse custom RPC URLs
  const customRpcs = getArgValue('--custom-rpc')
  if (customRpcs) {
    try {
      config.customRpcUrls = JSON.parse(customRpcs)
    } catch {
      console.error('Invalid JSON for --custom-rpc:', customRpcs)
    }
  }

  return config
}
