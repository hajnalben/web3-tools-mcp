import { http, createPublicClient } from 'viem'
import { arbitrum, base, celo, localhost, mainnet, optimism, polygon } from 'viem/chains'
import type { ChainName, Config } from './types.js'

// Enhanced RPC configuration with API keys
function getRpcUrl(chainName: string, config: Config): string {
  // Check for custom RPC URLs first
  if (config.customRpcUrls?.[chainName]) {
    return config.customRpcUrls[chainName]
  }

  // Enhanced RPC URLs with API keys
  const enhancedRpcs: Record<string, string> = {
    mainnet: config.alchemyApiKey
      ? `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://eth.llamarpc.com',

    base: config.alchemyApiKey
      ? `https://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : 'https://base.llamarpc.com',

    arbitrum: config.alchemyApiKey
      ? `https://arb-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://arbitrum-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://arb1.arbitrum.io/rpc',

    polygon: config.alchemyApiKey
      ? `https://polygon-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://polygon-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://polygon-rpc.com/',

    optimism: config.alchemyApiKey
      ? `https://opt-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://optimism-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://mainnet.optimism.io',

    celo: 'https://celo.drpc.org',
    localhost: 'http://localhost:8545'
  }

  return enhancedRpcs[chainName] ?? 'https://eth.llamarpc.com'
}

// Supported chains with their RPC endpoints (now dynamic)
export const CHAINS = (config: Config) => ({
  mainnet: {
    chain: mainnet,
    get rpc() {
      return getRpcUrl('mainnet', config)
    }
  },
  base: {
    chain: base,
    get rpc() {
      return getRpcUrl('base', config)
    }
  },
  arbitrum: {
    chain: arbitrum,
    get rpc() {
      return getRpcUrl('arbitrum', config)
    }
  },
  polygon: {
    chain: polygon,
    get rpc() {
      return getRpcUrl('polygon', config)
    }
  },
  optimism: {
    chain: optimism,
    get rpc() {
      return getRpcUrl('optimism', config)
    }
  },
  celo: {
    chain: celo,
    get rpc() {
      return getRpcUrl('celo', config)
    }
  },
  localhost: {
    chain: localhost,
    get rpc() {
      return getRpcUrl('localhost', config)
    }
  }
})

// Hypersync URLs for supported chains (localhost is not supported)
export const HYPERSYNC_URLS: Partial<Record<ChainName, string>> = {
  base: 'https://base.hypersync.xyz',
  arbitrum: 'https://arbitrum.hypersync.xyz',
  mainnet: 'https://eth.hypersync.xyz',
  polygon: 'https://polygon.hypersync.xyz',
  optimism: 'https://optimism.hypersync.xyz'
  // celo and localhost are not supported by hypersync
}

export const SUPPORTED_CHAINS = ['mainnet', 'base', 'arbitrum', 'polygon', 'optimism', 'celo', 'localhost'] as const

// Client manager
export class ClientManager {
  private clients: Map<ChainName, unknown> = new Map()
  private config: Config

  constructor(config: Config) {
    this.config = config
  }

  getClient(chainName: ChainName) {
    if (!this.clients.has(chainName)) {
      const chains = CHAINS(this.config)
      const { chain, rpc } = chains[chainName]
      const client = createPublicClient({
        chain,
        transport: http(rpc)
      })
      this.clients.set(chainName, client)
    }
    const client = this.clients.get(chainName)
    if (!client) {
      throw new Error(`Failed to create client for chain: ${chainName}`)
    }
    return client as ReturnType<typeof createPublicClient>
  }

  getEtherscanDomain(chainName: ChainName): string {
    const domains: Record<ChainName, string> = {
      mainnet: 'etherscan.io',
      base: 'basescan.org',
      arbitrum: 'arbiscan.io',
      polygon: 'polygonscan.com',
      optimism: 'optimistic.etherscan.io',
      celo: 'celoscan.io',
      localhost: 'etherscan.io'
    }
    return domains[chainName] || 'etherscan.io'
  }
}

// Export a global client manager instance
let clientManager: ClientManager | null = null

export function initializeClientManager(config: Config): ClientManager {
  clientManager = new ClientManager(config)
  return clientManager
}

export function getClientManager(): ClientManager {
  if (!clientManager) {
    throw new Error('Client manager not initialized')
  }
  return clientManager
}
