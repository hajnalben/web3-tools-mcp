import { createPublicClient, http } from 'viem'
import { CHAINS, type ChainName } from './chains.js'
import type { Config } from './types.js'

export { SUPPORTED_CHAINS } from './chains.js'

/** Custom URL first, then whichever provider key is configured, then the public endpoint. */
function getRpcUrl(chainName: ChainName, config: Config): string {
  const custom = config.customRpcUrls?.[chainName]
  if (custom) return custom

  const { alchemy, infura, fallback } = CHAINS[chainName]
  if (alchemy && config.alchemyApiKey) return `https://${alchemy}.g.alchemy.com/v2/${config.alchemyApiKey}`
  if (infura && config.infuraApiKey) return `https://${infura}.infura.io/v3/${config.infuraApiKey}`
  return fallback
}

/** Named so declaration emit can refer to it: node_modules is hoisted above this package. */
type PublicClient = ReturnType<typeof createPublicClient>

export class ClientManager {
  private clients = new Map<ChainName, PublicClient>()

  constructor(private config: Config) {}

  getClient(chainName: ChainName): PublicClient {
    const cached = this.clients.get(chainName)
    if (cached) return cached

    // Cast because a client built for a concrete chain is not assignable to the generic one.
    const client = createPublicClient({
      chain: CHAINS[chainName].chain,
      transport: http(this.getRpcUrl(chainName))
    }) as PublicClient

    this.clients.set(chainName, client)
    return client
  }

  getConfig(): Config {
    return this.config
  }

  getRpcUrl(chainName: ChainName): string {
    return getRpcUrl(chainName, this.config)
  }
  getChainId(chainName: ChainName): number {
    return CHAINS[chainName].chain.id
  }

  getHypersyncUrl(chainName: ChainName): string | undefined {
    return CHAINS[chainName].hypersync
  }

  /** Undefined where the chain has no explorer — a local node, for one. */
  explorerUrl(chainName: ChainName, path = ''): string | undefined {
    const domain = CHAINS[chainName].explorer
    return domain ? `https://${domain}${path}` : undefined
  }
}

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
