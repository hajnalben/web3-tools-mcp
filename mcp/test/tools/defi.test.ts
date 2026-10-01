import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import defiTools from '../../src/tools/read/defi.js'

const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

describe('DeFi Tools', () => {
  it('prices native and ERC20 tokens, and marks the unknown as unpriced', async () => {
    const result = await defiTools.get_token_prices.handler({
      chain: 'arbitrum',
      tokens: [zeroAddress, ARBITRUM_USDC, '0x000000000000000000000000000000000000dEaD']
    })

    const { prices } = JSON.parse(result.content[0].text)
    expect(prices[0]).toMatchObject({ priced: true, symbol: 'ETH' })
    expect(prices[1]).toMatchObject({ priced: true, symbol: 'USDC' })
    expect(prices[1].priceUsd).toBeGreaterThan(0.95)
    expect(prices[2]).toEqual({ token: '0x000000000000000000000000000000000000dEaD', priced: false })
  })

  it('prices a token at a past timestamp', async () => {
    const result = await defiTools.get_token_prices.handler({ chain: 'arbitrum', tokens: [zeroAddress], timestamp: 1735689600 })

    const { prices } = JSON.parse(result.content[0].text)
    expect(prices[0].priceUsd).toBeCloseTo(3333.54, 0)
    expect(prices[0].updatedAt.startsWith('2025-01-01')).toBe(true)
  })

  it('filters yield pools by chain, token and protocol, highest APY first', async () => {
    const result = await defiTools.get_yield_pools.handler({
      chain: 'arbitrum',
      symbol: 'usdc',
      project: 'aave',
      stablecoinOnly: false,
      minTvlUsd: 1_000_000,
      limit: 5
    })

    const { pools } = JSON.parse(result.content[0].text)
    expect(pools.length).toBeGreaterThan(0)
    for (const pool of pools) {
      expect(pool.chain).toBe('arbitrum')
      expect(pool.project).toContain('aave')
      expect(pool.symbol.split('-')).toContain('USDC')
      expect(pool.tvlUsd).toBeGreaterThanOrEqual(1_000_000)
    }
    const apys = pools.map((pool: { apy: number }) => pool.apy)
    expect(apys).toEqual([...apys].sort((a, b) => b - a))
  })

  it.skipIf(!process.env.ALCHEMY_API_KEY)(
    'values a wallet, largest holding first, leaving out what cannot be priced',
    async () => {
      const result = await defiTools.get_portfolio.handler({
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        chains: ['base'],
        minValueUsd: 1
      })

      const portfolio = JSON.parse(result.content[0].text)
      expect(portfolio.failedChains).toBeUndefined()
      expect(portfolio.holdings.length).toBeGreaterThan(0)
      expect(portfolio.hidden.unpriced).toBeGreaterThan(0)
      const values = portfolio.holdings.map((holding: { valueUsd: number }) => holding.valueUsd)
      expect(values).toEqual([...values].sort((a, b) => b - a))
      expect(Math.min(...values)).toBeGreaterThanOrEqual(1)
    }
  )

  it('rejects an invalid token address', async () => {
    await expect(defiTools.get_token_prices.handler({ chain: 'base', tokens: ['nope'] })).rejects.toThrow('Invalid token address')
  })
})
