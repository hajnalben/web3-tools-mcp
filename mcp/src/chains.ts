import type { Chain } from 'viem'
import {
  arbitrum,
  arc,
  avalanche,
  base,
  bsc,
  celo,
  gnosis,
  hyperEvm,
  ink,
  linea,
  localhost,
  mainnet,
  mantle,
  monad,
  optimism,
  plasma,
  polygon,
  robinhood,
  unichain,
  zksync
} from 'viem/chains'
import { HOSTED } from './hosted.js'

/**
 * Every chain this server knows, in one table. Adding one here is the whole change: the
 * `ChainName` union, the tool schemas, RPC selection, explorer links, Hypersync routing and
 * the `--help` listing are all derived from it.
 */
interface ChainInfo {
  chain: Chain
  /** Subdomain under g.alchemy.com; absent where Alchemy has no endpoint. */
  alchemy?: string
  /** False where Alchemy serves the RPC but not its token API, which `get_portfolio` needs. */
  alchemyTokenApi?: false
  /** Used when no Alchemy key is configured, or Alchemy has no endpoint. */
  fallback: string
  /** Block explorer domain, for links. Absent where there is nothing to link to. */
  explorer?: string
  hypersync?: string
  /** DefiLlama's two names for the chain: the prefix of a coin id, and the `chain` of a yield pool. */
  llama?: { coins: string; yields: string }
}

const TABLE = {
  mainnet: {
    chain: mainnet,
    alchemy: 'eth-mainnet',
    fallback: 'https://ethereum-rpc.publicnode.com',
    explorer: 'etherscan.io',
    hypersync: 'https://eth.hypersync.xyz',
    llama: { coins: 'ethereum', yields: 'Ethereum' }
  },
  arbitrum: {
    chain: arbitrum,
    alchemy: 'arb-mainnet',
    fallback: 'https://arb1.arbitrum.io/rpc',
    explorer: 'arbiscan.io',
    hypersync: 'https://arbitrum.hypersync.xyz',
    llama: { coins: 'arbitrum', yields: 'Arbitrum' }
  },
  avalanche: {
    chain: avalanche,
    alchemy: 'avax-mainnet',
    fallback: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'snowtrace.io',
    hypersync: 'https://avalanche.hypersync.xyz',
    llama: { coins: 'avax', yields: 'Avalanche' }
  },
  base: {
    chain: base,
    alchemy: 'base-mainnet',
    // publicnode refuses receipts and anything else it calls an archive request
    fallback: 'https://mainnet.base.org',
    explorer: 'basescan.org',
    hypersync: 'https://base.hypersync.xyz',
    llama: { coins: 'base', yields: 'Base' }
  },
  bnb: {
    chain: bsc,
    alchemy: 'bnb-mainnet',
    fallback: 'https://bsc-dataseed.bnbchain.org',
    explorer: 'bscscan.com',
    hypersync: 'https://bsc.hypersync.xyz',
    llama: { coins: 'bsc', yields: 'BSC' }
  },
  gnosis: {
    chain: gnosis,
    alchemy: 'gnosis-mainnet',
    fallback: 'https://rpc.gnosischain.com',
    explorer: 'gnosisscan.io',
    hypersync: 'https://gnosis.hypersync.xyz',
    llama: { coins: 'xdai', yields: 'Gnosis' }
  },
  optimism: {
    chain: optimism,
    alchemy: 'opt-mainnet',
    fallback: 'https://mainnet.optimism.io',
    explorer: 'optimistic.etherscan.io',
    hypersync: 'https://optimism.hypersync.xyz',
    llama: { coins: 'optimism', yields: 'OP Mainnet' }
  },
  polygon: {
    chain: polygon,
    alchemy: 'polygon-mainnet',
    // polygon-rpc.com now answers 401 "API key disabled" to anonymous callers
    fallback: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'polygonscan.com',
    hypersync: 'https://polygon.hypersync.xyz',
    llama: { coins: 'polygon', yields: 'Polygon' }
  },
  zksync: {
    chain: zksync,
    alchemy: 'zksync-mainnet',
    fallback: 'https://mainnet.era.zksync.io',
    explorer: 'era.zksync.network',
    hypersync: 'https://zksync.hypersync.xyz',
    llama: { coins: 'era', yields: 'ZKsync Era' }
  },
  linea: {
    chain: linea,
    alchemy: 'linea-mainnet',
    fallback: 'https://rpc.linea.build',
    explorer: 'lineascan.build',
    hypersync: 'https://linea.hypersync.xyz',
    llama: { coins: 'linea', yields: 'Linea' }
  },
  unichain: {
    chain: unichain,
    alchemy: 'unichain-mainnet',
    fallback: 'https://mainnet.unichain.org',
    explorer: 'uniscan.xyz',
    hypersync: 'https://unichain.hypersync.xyz',
    llama: { coins: 'unichain', yields: 'Unichain' }
  },
  monad: {
    chain: monad,
    alchemy: 'monad-mainnet',
    fallback: 'https://rpc.monad.xyz',
    explorer: 'monadscan.com',
    hypersync: 'https://monad.hypersync.xyz',
    llama: { coins: 'monad', yields: 'Monad' }
  },
  robinhood: {
    chain: robinhood,
    alchemy: 'robinhood-mainnet',
    fallback: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'robinhoodchain.blockscout.com',
    hypersync: 'https://robinhood.hypersync.xyz',
    llama: { coins: 'robinhood', yields: 'Robinhood Chain' }
  },
  arc: {
    chain: arc,
    alchemy: 'arc-mainnet',
    fallback: 'https://rpc.mainnet.arc.io',
    explorer: 'explorer.arc.io',
    hypersync: 'https://arc.hypersync.xyz',
    llama: { coins: 'arc', yields: 'Arc' }
  },
  plasma: {
    chain: plasma,
    alchemy: 'plasma-mainnet',
    alchemyTokenApi: false,
    fallback: 'https://rpc.plasma.to',
    explorer: 'plasmascan.to',
    hypersync: 'https://plasma.hypersync.xyz',
    llama: { coins: 'plasma', yields: 'Plasma' }
  },
  ink: {
    chain: ink,
    alchemy: 'ink-mainnet',
    fallback: 'https://rpc-gel.inkonchain.com',
    explorer: 'explorer.inkonchain.com',
    hypersync: 'https://ink.hypersync.xyz',
    llama: { coins: 'ink', yields: 'Ink' }
  },
  mantle: {
    chain: mantle,
    alchemy: 'mantle-mainnet',
    alchemyTokenApi: false,
    fallback: 'https://rpc.mantle.xyz',
    explorer: 'mantlescan.xyz',
    hypersync: 'https://mantle.hypersync.xyz',
    llama: { coins: 'mantle', yields: 'Mantle' }
  },
  celo: {
    chain: celo,
    alchemy: 'celo-mainnet',
    fallback: 'https://forno.celo.org',
    explorer: 'celoscan.io',
    hypersync: 'https://celo.hypersync.xyz',
    llama: { coins: 'celo', yields: 'Celo' }
  },
  hyperevm: {
    chain: hyperEvm,
    alchemy: 'hyperliquid-mainnet',
    fallback: 'https://rpc.hyperliquid.xyz/evm',
    explorer: 'hyperevmscan.io',
    hypersync: 'https://hyperliquid.hypersync.xyz',
    llama: { coins: 'hyperliquid', yields: 'Hyperliquid L1' }
  },
  localhost: {
    chain: localhost,
    fallback: 'http://localhost:8545'
  }
} as const satisfies Record<string, ChainInfo>

export type ChainName = keyof typeof TABLE

// Widened: `as const` above is only there to infer ChainName from the keys, and reading a
// literal entry would otherwise lose the fields that not every chain sets.
export const CHAINS: Record<ChainName, ChainInfo> = TABLE

/**
 * Chains the tools will accept.
 *
 * `localhost` is dropped when hosted. It resolves to the machine running the server, so on
 * a shared host it is not the caller's dev node — it is a way to aim requests at whatever
 * that host has listening on its own loopback.
 *
 * Tuple rather than array, because `z.enum` needs a non-empty literal list.
 */
export const SUPPORTED_CHAINS = (HOSTED ? Object.keys(CHAINS).filter((name) => name !== 'localhost') : Object.keys(CHAINS)) as [
  ChainName,
  ...ChainName[]
]
