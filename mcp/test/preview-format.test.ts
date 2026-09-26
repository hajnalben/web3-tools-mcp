import { type Abi, encodeFunctionData, maxUint256, parseAbi, parseAbiItem, parseUnits } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addressLabel, loadAbi, tokenMeta } from '../src/chain-meta.js'
import { resolveClearSigning } from '../src/clear-signing.js'
import { getClientManager } from '../src/client.js'
import { buildTxPreview } from '../src/preview.js'

vi.mock('../src/chain-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chain-meta.js')>()),
  tokenMeta: vi.fn(),
  addressLabel: vi.fn(),
  loadAbi: vi.fn()
}))

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const ONEINCH_V5 = '0x1111111254EEB25477B68fb85Ed929f73A960582'
// In the registry for Optimism only.
const AAVE_OPTIMISM_ONLY = '0x5f2508cAE9923b02316254026CD43d7902866725'
const HOLDER = '0x28C6c06298d514Db089934071355E5743bf21d60'
const PLAIN = '0x000000000000000000000000000000000000dEaD'

const SUPPLY = parseAbiItem('function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)')

function supply(onBehalfOf: string) {
  return {
    to: AAVE_V3_POOL,
    data: encodeFunctionData({ abi: [SUPPLY], args: [USDC, parseUnits('250', 6), onBehalfOf as `0x${string}`, 0] })
  }
}

beforeEach(() => {
  vi.mocked(tokenMeta).mockResolvedValue({ symbol: 'USDC', decimals: 6 })
  vi.mocked(addressLabel).mockResolvedValue(undefined)
  // Simulation is not under test; an unreachable client makes it fail fast and offline.
  vi.spyOn(getClientManager(), 'getClient').mockReturnValue({
    request: () => Promise.reject(new Error('offline')),
    call: () => Promise.reject(new Error('offline')),
    estimateGas: () => Promise.reject(new Error('offline'))
  } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registry field formatting', () => {
  const args = { asset: USDC, amount: 250_000_000n, onBehalfOf: HOLDER, referralCode: 0 }

  it('keeps the token address beside its self-reported symbol', async () => {
    const info = await resolveClearSigning('mainnet', supply(HOLDER), args)
    const amount = info?.fields.find((f) => f.format === 'tokenAmount')
    expect(amount?.value).toBe(`250 USDC (${USDC})`)
    expect(amount?.address).toBe(USDC)
  })

  it('shows the raw integer when decimals are unknown instead of assuming 18', async () => {
    vi.mocked(tokenMeta).mockResolvedValue({ symbol: 'USDC', decimals: undefined })
    const info = await resolveClearSigning('mainnet', supply(HOLDER), args)
    expect(info?.fields.find((f) => f.format === 'tokenAmount')?.value).toBe(`250000000 USDC (${USDC}) (decimals unknown)`)
  })

  it('keeps the address beside an on-chain name', async () => {
    vi.mocked(addressLabel).mockResolvedValue('Vitalik')
    const info = await resolveClearSigning('mainnet', supply(HOLDER), args)
    expect(info?.fields.find((f) => f.address === HOLDER)?.value).toBe(`Vitalik (${HOLDER})`)
  })

  it('does not name an address from another chain’s registry entry', async () => {
    const info = await resolveClearSigning('mainnet', supply(AAVE_OPTIMISM_ONLY), {
      ...args,
      onBehalfOf: AAVE_OPTIMISM_ONLY
    })
    expect(info?.fields.find((f) => f.address === AAVE_OPTIMISM_ONLY)?.value).toBe(AAVE_OPTIMISM_ONLY)
  })
})

describe('buildTxPreview decoding', () => {
  it('flags an unlimited approval, with the token address in the summary', async () => {
    vi.mocked(loadAbi).mockResolvedValue({
      abi: parseAbi(['function approve(address spender, uint256 amount)']),
      source: 'verified'
    })
    const data = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount)']),
      args: [AAVE_V3_POOL, maxUint256]
    })

    const preview = await buildTxPreview('mainnet', { to: USDC, data })
    const amount = preview.decoded?.fields.at(-1)
    expect(amount?.value).toBe('Unlimited USDC')
    expect(amount?.warning).toBe('Unlimited spending approval')
  })

  it('picks the overload the selector names, not the first with that name', async () => {
    const abi = parseAbi(['function deposit(uint256 shares)', 'function deposit(address receiver, uint256 assets)']) as Abi
    vi.mocked(loadAbi).mockResolvedValue({ abi, source: 'verified' })
    const data = encodeFunctionData({ abi, functionName: 'deposit', args: [HOLDER, 5n] })

    const preview = await buildTxPreview('mainnet', { to: PLAIN, data })
    expect(preview.decoded?.signature).toBe('deposit(address receiver, uint256 assets)')
    expect(preview.decoded?.fields.map((f) => f.name)).toEqual(['receiver', 'assets'])
  })

  it('resolves @.from paths to the sender', async () => {
    const abi = parseAbi(['function uniswapV3Swap(uint256 amount, uint256 minReturn, uint256[] pools)'])
    vi.mocked(loadAbi).mockResolvedValue({ abi, source: 'verified' })
    const data = encodeFunctionData({ abi, args: [1000n, 900n, [1n]] })

    const preview = await buildTxPreview('mainnet', { to: ONEINCH_V5, data }, HOLDER)
    expect(preview.decoded?.protocol).toBe('1inch')
    const beneficiary = preview.decoded?.fields.find((f) => f.name === 'Beneficiary')
    expect(beneficiary).toMatchObject({ value: HOLDER, address: HOLDER })
  })
})
