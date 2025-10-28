import { http, createPublicClient } from 'viem'
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  linea,
  localhost,
  mainnet,
  optimism,
  polygon,
  sonic,
  unichain,
  zksync
} from 'viem/chains'
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
        : 'https://polygon-rpc.com',

    optimism: config.alchemyApiKey
      ? `https://opt-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://optimism-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://mainnet.optimism.io',

    avalanche: config.alchemyApiKey
      ? `https://avax-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://avalanche-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://api.avax.network/ext/bc/C/rpc',

    bnb: config.alchemyApiKey
      ? `https://bnb-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://bsc-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://bsc-dataseed.bnbchain.org',

    gnosis: config.alchemyApiKey
      ? `https://gnosis-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : 'https://rpc.gnosischain.com',

    sonic: config.alchemyApiKey
      ? `https://sonic-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : 'https://rpc.soniclabs.com',

    zksync: config.alchemyApiKey
      ? `https://zksync-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://zksync-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://mainnet.era.zksync.io',

    linea: config.alchemyApiKey
      ? `https://linea-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://linea-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://rpc.linea.build',

    unichain: config.alchemyApiKey
      ? `https://unichain-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
      : config.infuraApiKey
        ? `https://unichain-mainnet.infura.io/v3/${config.infuraApiKey}`
        : 'https://sepolia.unichain.org',

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
  avalanche: {
    chain: avalanche,
    get rpc() {
      return getRpcUrl('avalanche', config)
    }
  },
  bnb: {
    chain: bsc,
    get rpc() {
      return getRpcUrl('bnb', config)
    }
  },
  gnosis: {
    chain: gnosis,
    get rpc() {
      return getRpcUrl('gnosis', config)
    }
  },
  sonic: {
    chain: sonic,
    get rpc() {
      return getRpcUrl('sonic', config)
    }
  },
  zksync: {
    chain: zksync,
    get rpc() {
      return getRpcUrl('zksync', config)
    }
  },
  linea: {
    chain: linea,
    get rpc() {
      return getRpcUrl('linea', config)
    }
  },
  unichain: {
    chain: unichain,
    get rpc() {
      return getRpcUrl('unichain', config)
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
  mainnet: 'https://eth.hypersync.xyz', // Chain ID 1
  arbitrum: 'https://arbitrum.hypersync.xyz', // Chain ID 42161
  avalanche: 'https://avalanche.hypersync.xyz', // Chain ID 43114
  base: 'https://base.hypersync.xyz', // Chain ID 8453
  bnb: 'https://bsc.hypersync.xyz', // Chain ID 56
  gnosis: 'https://gnosis.hypersync.xyz', // Chain ID 100
  sonic: 'https://sonic.hypersync.xyz', // Chain ID 146
  optimism: 'https://optimism.hypersync.xyz', // Chain ID 10
  polygon: 'https://polygon.hypersync.xyz', // Chain ID 137
  zksync: 'https://zksync.hypersync.xyz', // Chain ID 324
  linea: 'https://linea.hypersync.xyz', // Chain ID 59144
  unichain: 'https://unichain.hypersync.xyz' // Chain ID 130
  // localhost is not supported by hypersync
}

export const SUPPORTED_CHAINS = [
  'mainnet',
  'arbitrum',
  'avalanche',
  'base',
  'bnb',
  'gnosis',
  'sonic',
  'optimism',
  'polygon',
  'zksync',
  'linea',
  'unichain',
  'localhost'
] as const

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
      avalanche: 'snowtrace.io',
      bnb: 'bscscan.com',
      gnosis: 'gnosisscan.io',
      sonic: 'sonicscan.org',
      zksync: 'era.zksync.network',
      linea: 'lineascan.build',
      unichain: 'uniscan.xyz',
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
