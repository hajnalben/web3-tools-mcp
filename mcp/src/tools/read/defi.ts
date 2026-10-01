import { type Address, formatUnits, type Hex, isAddress, zeroAddress } from 'viem'
import { z } from 'zod'
import { CHAINS, type ChainName, SUPPORTED_CHAINS } from '../../chains.js'
import { getClientManager } from '../../client.js'
import { createTool, formatResponse, MAX_BATCH, rpcReason } from '../../utils.js'

/** Token ids per DefiLlama price request, to keep the URL short. */
const PRICE_BATCH = 50
const MAX_TOKEN_PAGES = 10

interface LlamaPrice {
  symbol: string
  price: number
  decimals?: number
  confidence?: number
  timestamp: number
}

interface LlamaPool {
  pool: string
  chain: string
  project: string
  symbol: string
  poolMeta: string | null
  tvlUsd: number
  apy: number | null
  apyBase: number | null
  apyReward: number | null
  apyMean30d: number | null
  stablecoin: boolean
  ilRisk: string
  exposure: string
  outlier: boolean
  underlyingTokens: string[] | null
}

/** DefiLlama's public API: free, keyless, and the same for every caller. */
async function llama<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`DefiLlama answered ${response.status} for ${url}`)
  return (await response.json()) as T
}

function llamaNames(chain: ChainName) {
  const names = CHAINS[chain].llama
  if (!names) throw new Error(`DefiLlama has no data for ${chain}`)
  return names
}

/** Prices by lowercased token address; a token DefiLlama cannot price is absent. */
async function llamaPrices(chain: ChainName, tokens: string[], timestamp?: number): Promise<Map<string, LlamaPrice>> {
  const prefix = llamaNames(chain).coins
  const when = timestamp ? `historical/${timestamp}` : 'current'
  const batches = Array.from({ length: Math.ceil(tokens.length / PRICE_BATCH) }, (_, index) =>
    tokens.slice(index * PRICE_BATCH, (index + 1) * PRICE_BATCH)
  )

  const answers = await Promise.all(
    batches.map((batch) =>
      llama<{ coins: Record<string, LlamaPrice> }>(
        `https://coins.llama.fi/prices/${when}/${batch.map((token) => `${prefix}:${token}`).join(',')}`
      )
    )
  )
  // DefiLlama keys its answer by the id as sent, but not reliably in the same case.
  return new Map(
    answers.flatMap(({ coins }) => Object.entries(coins).map(([id, price]) => [id.slice(prefix.length + 1).toLowerCase(), price]))
  )
}

/**
 * Every ERC20 the address holds a non-zero balance of, as Alchemy indexes them.
 *
 * ponytail: stops after MAX_TOKEN_PAGES pages; past that a wallet is nearly all spam, but a
 * real token beyond the cut is missed. `truncated` says when that happened.
 */
async function erc20Balances(chain: ChainName, address: Address) {
  const client = getClientManager().getClient(chain)
  const balances: [string, bigint][] = []
  let pageKey: string | undefined

  for (let page = 0; page < MAX_TOKEN_PAGES; page++) {
    const result = (await client.request({
      method: 'alchemy_getTokenBalances',
      params: [address, 'erc20', { maxCount: 100, ...(pageKey && { pageKey }) }]
    } as never)) as { tokenBalances: { contractAddress: string; tokenBalance: Hex | null }[]; pageKey?: string }

    for (const { contractAddress, tokenBalance } of result.tokenBalances) {
      if (tokenBalance && BigInt(tokenBalance) > 0n) balances.push([contractAddress, BigInt(tokenBalance)])
    }
    pageKey = result.pageKey
    if (!pageKey) break
  }

  return { balances, truncated: Boolean(pageKey) }
}

async function holdingsOn(chain: ChainName, address: Address, minValueUsd: number) {
  const [native, erc20] = await Promise.all([
    getClientManager().getClient(chain).getBalance({ address }),
    erc20Balances(chain, address)
  ])
  const held = native > 0n ? [[zeroAddress, native] as [string, bigint], ...erc20.balances] : erc20.balances
  const prices = await llamaPrices(
    chain,
    held.map(([token]) => token)
  )

  const holdings = []
  let unpriced = 0
  let belowMinValue = 0
  for (const [token, raw] of held) {
    const price = prices.get(token.toLowerCase())
    if (!price || price.decimals === undefined) {
      unpriced++
      continue
    }
    const amount = formatUnits(raw, price.decimals)
    const valueUsd = Number(amount) * price.price
    if (valueUsd < minValueUsd) {
      belowMinValue++
      continue
    }
    holdings.push({
      chain,
      token: token === zeroAddress ? 'native' : token,
      symbol: price.symbol,
      amount,
      priceUsd: price.price,
      valueUsd: Math.round(valueUsd * 100) / 100
    })
  }

  return { chain, holdings, unpriced, belowMinValue, truncated: erc20.truncated }
}

export default {
  get_token_prices: createTool(
    'Get Token Prices',
    "USD prices from DefiLlama for tokens on one chain, now or at a past timestamp. Use the zero address for the chain's native token. " +
      'Tokens DefiLlama cannot price are listed as unpriced — usually spam or illiquid.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      tokens: z
        .array(z.string())
        .min(1)
        .max(MAX_BATCH)
        .describe(`Token contract addresses (up to ${MAX_BATCH}); ${zeroAddress} for the native token`),
      timestamp: z.number().int().positive().optional().describe('Unix time in seconds for a past price (defaults to now)')
    }),
    async (args) => {
      const invalid = args.tokens.find((token) => !isAddress(token))
      if (invalid) throw new Error(`Invalid token address: ${invalid}`)

      const byToken = await llamaPrices(args.chain as ChainName, args.tokens, args.timestamp)

      const prices = args.tokens.map((token) => {
        const price = byToken.get(token.toLowerCase())
        if (!price) return { token, priced: false }
        return {
          token,
          priced: true,
          symbol: price.symbol,
          priceUsd: price.price,
          decimals: price.decimals,
          confidence: price.confidence,
          updatedAt: new Date(price.timestamp * 1000).toISOString()
        }
      })

      return formatResponse({ chain: args.chain, source: 'DefiLlama', prices })
    }
  ),

  get_portfolio: createTool(
    'Get Portfolio',
    'What a wallet holds across chains, valued in USD: native and ERC20 balances found through Alchemy, priced by ' +
      'DefiLlama, largest first. Tokens DefiLlama cannot price are left out — that drops the spam airdrops most ' +
      'wallets collect. Positions inside DeFi protocols appear only as the receipt tokens DefiLlama happens to price.',
    z.object({
      address: z.string().describe('Wallet address'),
      chains: z
        .array(z.enum(SUPPORTED_CHAINS))
        .optional()
        .describe('Chains to look at (defaults to every chain where both the Alchemy token API and DefiLlama are available)'),
      minValueUsd: z.number().optional().default(1).describe('Leave out holdings worth less than this, in USD (default 1)')
    }),
    async (args) => {
      if (!isAddress(args.address)) throw new Error(`Invalid address: ${args.address}`)
      const address = args.address
      const chains = ((args.chains ?? SUPPORTED_CHAINS) as ChainName[]).filter(
        (chain) => CHAINS[chain].alchemy && CHAINS[chain].alchemyTokenApi !== false && CHAINS[chain].llama
      )

      const scanned: Awaited<ReturnType<typeof holdingsOn>>[] = []
      const failedChains: { chain: ChainName; error: string }[] = []
      await Promise.all(
        chains.map(async (chain) => {
          try {
            scanned.push(await holdingsOn(chain, address, args.minValueUsd))
          } catch (error) {
            failedChains.push({ chain, error: rpcReason(error) })
          }
        })
      )
      const holdings = scanned.flatMap((result) => result.holdings).sort((a, b) => b.valueUsd - a.valueUsd)
      const truncatedChains = scanned.filter((result) => result.truncated).map((result) => result.chain)

      return formatResponse({
        address,
        totalUsd: Math.round(holdings.reduce((sum, holding) => sum + holding.valueUsd, 0) * 100) / 100,
        holdings,
        hidden: {
          unpriced: scanned.reduce((sum, result) => sum + result.unpriced, 0),
          belowMinValue: scanned.reduce((sum, result) => sum + result.belowMinValue, 0)
        },
        ...(truncatedChains.length > 0 && { truncatedChains }),
        ...(failedChains.length > 0 && { failedChains })
      })
    },
    // alchemy_getTokenBalances is what finds the tokens; no other RPC here indexes them.
    () => Boolean(getClientManager().getConfig().alchemyApiKey)
  ),

  get_yield_pools: createTool(
    'Get Yield Pools',
    'DeFi lending, staking and liquidity pools from DefiLlama, highest APY first — e.g. where USDC earns most on ' +
      'Arbitrum, or what Aave pays on Base. Pools DefiLlama flags as APY outliers are left out. APY is a percentage.',
    z.object({
      chain: z
        .enum(SUPPORTED_CHAINS)
        .optional()
        .describe('Only pools on this chain (defaults to every chain this server supports)'),
      symbol: z.string().optional().describe('Only pools holding this token, e.g. "USDC" (matches "USDC" and "USDC-WETH")'),
      project: z.string().optional().describe('Only this protocol, as DefiLlama names it — "aave" matches aave-v3 and aave-v2'),
      stablecoinOnly: z.boolean().optional().default(false).describe('Only pools of stablecoins'),
      minTvlUsd: z.number().optional().default(1_000_000).describe('Leave out pools smaller than this, in USD (default 1M)'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('How many pools to return (default 20)')
    }),
    async (args) => {
      const chains = new Map<string, ChainName>(
        (args.chain ? [args.chain as ChainName] : SUPPORTED_CHAINS)
          .filter((chain) => CHAINS[chain].llama)
          .map((chain) => [llamaNames(chain).yields, chain])
      )
      const symbol = args.symbol?.toUpperCase()
      const project = args.project?.toLowerCase()

      // ponytail: fetches DefiLlama's whole pool list (~12 MB) per call; cache it for a few minutes if calls pile up.
      const { data } = await llama<{ data: LlamaPool[] }>('https://yields.llama.fi/pools')

      const matching = data
        .filter(
          (pool) =>
            chains.has(pool.chain) &&
            !pool.outlier &&
            pool.apy !== null &&
            pool.tvlUsd >= args.minTvlUsd &&
            (!args.stablecoinOnly || pool.stablecoin) &&
            (!project || pool.project.includes(project)) &&
            (!symbol || pool.symbol.toUpperCase().split('-').includes(symbol))
        )
        .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))

      return formatResponse({
        source: 'DefiLlama',
        matched: matching.length,
        pools: matching.slice(0, args.limit).map((pool) => ({
          chain: chains.get(pool.chain),
          project: pool.project,
          symbol: pool.symbol,
          ...(pool.poolMeta && { meta: pool.poolMeta }),
          apy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          apyMean30d: pool.apyMean30d,
          tvlUsd: Math.round(pool.tvlUsd),
          stablecoin: pool.stablecoin,
          ilRisk: pool.ilRisk,
          exposure: pool.exposure,
          underlyingTokens: pool.underlyingTokens,
          url: `https://defillama.com/yields/pool/${pool.pool}`
        }))
      })
    }
  )
}
