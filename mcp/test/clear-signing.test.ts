import { encodeFunctionData, maxUint256, parseAbiItem, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'
import { lookupContract, protocolLabel } from '../src/clear-signing.js'
import { buildTxPreview } from '../src/preview.js'

const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const HOLDER = '0x28C6c06298d514Db089934071355E5743bf21d60'

describe('ERC-7730 clear signing', () => {
  it('recognises a registered contract on the right chain only', () => {
    expect(lookupContract('mainnet', AAVE_V3_POOL)?.protocol).toBe('aave')
    // Same address, a chain the descriptor does not list.
    expect(lookupContract('polygon', AAVE_V3_POOL)).toBeUndefined()
    expect(lookupContract('mainnet', HOLDER)).toBeUndefined()
  })

  it('labels a protocol slug for display', () => {
    expect(protocolLabel('lifi')).toBe('LI.FI')
    expect(protocolLabel('somethingnew')).toBe('somethingnew')
  })

  it('describes an Aave supply as the protocol intends', async () => {
    const data = encodeFunctionData({
      abi: [parseAbiItem('function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)')],
      args: [USDC_MAINNET, parseUnits('250', 6), HOLDER, 0]
    })

    const preview = await buildTxPreview('mainnet', { to: AAVE_V3_POOL, data }, HOLDER)

    expect(preview.decoded?.protocol).toBe('Aave')
    expect(preview.decoded?.intent).toBeTruthy()

    // Registry labels replace raw ABI argument names, and amounts carry their token.
    const amount = preview.decoded?.fields.find((f) => f.type === 'tokenAmount')
    expect(amount?.value).toBe('250 USDC')
    expect(amount?.name).not.toBe('amount')
  })

  it('still flags an unlimited approval through registry formatting', async () => {
    const data = encodeFunctionData({
      abi: [parseAbiItem('function approve(address spender, uint256 amount)')],
      args: [AAVE_V3_POOL, maxUint256]
    })

    const preview = await buildTxPreview('mainnet', { to: USDC_MAINNET, data }, HOLDER)
    const amount = preview.decoded?.fields.at(-1)

    expect(amount?.value).toContain('Unlimited')
    expect(amount?.warning).toBeDefined()
  })
})
