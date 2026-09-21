/**
 * On-chain metadata every layer of the preview needs: contract ABIs, token symbols and
 * human labels for addresses. Kept apart from the preview and the clear-signing registry
 * so both can use it without importing each other.
 */
import { type Abi, type Address, parseAbiItem } from 'viem'
import { whatsabi } from '@shazow/whatsabi'
import { getClientManager } from './client.js'
import type { ChainName } from './types.js'

const ERC20_META_ABI = [
  parseAbiItem('function decimals() view returns (uint8)'),
  parseAbiItem('function symbol() view returns (string)')
]

const abiCache = new Map<string, { abi: Abi; source: 'verified' | 'guessed'; proxy?: string; name?: string }>()
const labelCache = new Map<string, string | undefined>()
const metaCache = new Map<string, { symbol?: string; decimals?: number }>()

export async function loadAbi(chain: ChainName, address: string) {
  const key = `${chain}:${address.toLowerCase()}`
  const cached = abiCache.get(key)
  if (cached) return cached

  const clientManager = getClientManager()
  const client = clientManager.getClient(chain)
  const etherscanApiKey = clientManager.getConfig().etherscanApiKey

  const loaders: whatsabi.loaders.ABILoader[] = [new whatsabi.loaders.SourcifyABILoader({ chainId: clientManager.getChainId(chain) })]
  if (etherscanApiKey) {
    loaders.push(new whatsabi.loaders.EtherscanV2ABILoader({ apiKey: etherscanApiKey, chainId: clientManager.getChainId(chain) }))
  }

  const result = await whatsabi.autoload(address as Address, {
    provider: client,
    abiLoader: new whatsabi.loaders.MultiABILoader(loaders),
    signatureLookup: new whatsabi.loaders.OpenChainSignatureLookup(),
    followProxies: true
  })

  // Bytecode-guessed ABIs carry no argument names; verified ones do.
  const source = result.abi.some((item) => item.type === 'function' && item.inputs?.some((i) => i.name)) ? 'verified' : 'guessed'
  const loaded = {
    abi: result.abi as Abi,
    source: source as 'verified' | 'guessed',
    proxy: result.address !== address ? result.address : undefined,
    name: result.contractResult?.name ?? undefined
  }
  abiCache.set(key, loaded)
  return loaded
}

export async function tokenMeta(chain: ChainName, token: string) {
  const key = `${chain}:${token.toLowerCase()}`
  const cached = metaCache.get(key)
  if (cached) return cached

  const client = getClientManager().getClient(chain)
  const [decimals, symbol] = await client.multicall({
    contracts: [
      { address: token as Address, abi: ERC20_META_ABI, functionName: 'decimals' },
      { address: token as Address, abi: ERC20_META_ABI, functionName: 'symbol' }
    ],
    ...(chain === 'localhost' && { deployless: true })
  })

  const meta = {
    decimals: decimals.status === 'success' ? Number(decimals.result) : undefined,
    symbol: symbol.status === 'success' ? (symbol.result as string) : undefined
  }
  metaCache.set(key, meta)
  return meta
}

/**
 * Human label for an address: token symbol first (more recognisable than the contract
 * name — "USDC" beats "FiatTokenProxy"), then the verified contract name. EOAs get none,
 * and the bytecode check keeps us from asking explorers about plain wallets.
 */
export async function addressLabel(chain: ChainName, address: string): Promise<string | undefined> {
  const key = `${chain}:${address.toLowerCase()}`
  if (labelCache.has(key)) return labelCache.get(key)

  let label: string | undefined
  try {
    const code = await getClientManager().getClient(chain).getBytecode({ address: address as Address })
    if (code && code !== '0x') {
      label = (await tokenMeta(chain, address).catch(() => ({ symbol: undefined }))).symbol
      if (!label) label = (await loadAbi(chain, address)).name
    }
  } catch {
    // Unknown address — show it bare rather than failing the preview.
  }

  labelCache.set(key, label)
  return label
}


/** uint256 max and anything near it means "infinite" in an approval. */
export const MAX_UINT256 = (1n << 256n) - 1n
export const UNLIMITED_THRESHOLD = MAX_UINT256 / 2n
