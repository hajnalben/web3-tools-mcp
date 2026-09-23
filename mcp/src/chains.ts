import type { Chain } from 'viem'
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
  /** Subdomain under infura.io; absent where Infura has no endpoint. */
  infura?: string
  /** Used when no provider key is configured. */
  fallback: string
  /** Block explorer domain, for links. Absent where there is nothing to link to. */
  explorer?: string
  hypersync?: string
}

const TABLE = {
  mainnet: {
    chain: mainnet,
    alchemy: 'eth-mainnet',
    infura: 'mainnet',
    fallback: 'https://ethereum-rpc.publicnode.com',
    explorer: 'etherscan.io',
    hypersync: 'https://eth.hypersync.xyz'
  },
  arbitrum: {
    chain: arbitrum,
    alchemy: 'arb-mainnet',
    infura: 'arbitrum-mainnet',
    fallback: 'https://arb1.arbitrum.io/rpc',
    explorer: 'arbiscan.io',
    hypersync: 'https://arbitrum.hypersync.xyz'
  },
  avalanche: {
    chain: avalanche,
    alchemy: 'avax-mainnet',
    infura: 'avalanche-mainnet',
    fallback: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'snowtrace.io',
    hypersync: 'https://avalanche.hypersync.xyz'
  },
  base: {
    chain: base,
    alchemy: 'base-mainnet',
    // publicnode refuses receipts and anything else it calls an archive request
    fallback: 'https://mainnet.base.org',
    explorer: 'basescan.org',
    hypersync: 'https://base.hypersync.xyz'
  },
  bnb: {
    chain: bsc,
    alchemy: 'bnb-mainnet',
    infura: 'bsc-mainnet',
    fallback: 'https://bsc-dataseed.bnbchain.org',
    explorer: 'bscscan.com',
    hypersync: 'https://bsc.hypersync.xyz'
  },
  gnosis: {
    chain: gnosis,
    alchemy: 'gnosis-mainnet',
    fallback: 'https://rpc.gnosischain.com',
    explorer: 'gnosisscan.io',
    hypersync: 'https://gnosis.hypersync.xyz'
  },
  sonic: {
    chain: sonic,
    alchemy: 'sonic-mainnet',
    fallback: 'https://rpc.soniclabs.com',
    explorer: 'sonicscan.org',
    hypersync: 'https://sonic.hypersync.xyz'
  },
  optimism: {
    chain: optimism,
    alchemy: 'opt-mainnet',
    infura: 'optimism-mainnet',
    fallback: 'https://mainnet.optimism.io',
    explorer: 'optimistic.etherscan.io',
    hypersync: 'https://optimism.hypersync.xyz'
  },
  polygon: {
    chain: polygon,
    alchemy: 'polygon-mainnet',
    infura: 'polygon-mainnet',
    // polygon-rpc.com now answers 401 "API key disabled" to anonymous callers
    fallback: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'polygonscan.com',
    hypersync: 'https://polygon.hypersync.xyz'
  },
  zksync: {
    chain: zksync,
    alchemy: 'zksync-mainnet',
    infura: 'zksync-mainnet',
    fallback: 'https://mainnet.era.zksync.io',
    explorer: 'era.zksync.network',
    hypersync: 'https://zksync.hypersync.xyz'
  },
  linea: {
    chain: linea,
    alchemy: 'linea-mainnet',
    infura: 'linea-mainnet',
    fallback: 'https://rpc.linea.build',
    explorer: 'lineascan.build',
    hypersync: 'https://linea.hypersync.xyz'
  },
  unichain: {
    chain: unichain,
    alchemy: 'unichain-mainnet',
    infura: 'unichain-mainnet',
    fallback: 'https://mainnet.unichain.org',
    explorer: 'uniscan.xyz',
    hypersync: 'https://unichain.hypersync.xyz'
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
