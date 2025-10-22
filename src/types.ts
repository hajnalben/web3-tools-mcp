import type { AbiParameter } from 'viem'

// Define AbiError type since it's not exported by viem
export interface AbiError {
  type: 'error'
  name: string
  inputs: readonly AbiParameter[]
}

// Configuration interface
export interface Config {
  etherscanApiKey?: string
  alchemyApiKey?: string
  infuraApiKey?: string
  customRpcUrls?: Record<string, string>
  hypersyncApiKey?: string
}

// Chain names
export type ChainName = 'mainnet' | 'base' | 'arbitrum' | 'polygon' | 'optimism' | 'celo' | 'localhost'

// Tool handler result type
export interface ToolResult {
  [x: string]: unknown
  content: Array<{
    type: 'text'
    text: string
  }>
}
