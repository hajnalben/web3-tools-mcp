import { describe, it, expect } from 'vitest'
import { encodeFunctionData, maxUint256, parseAbiItem, parseUnits } from 'viem'
import { buildTxPreview } from '../src/preview.js'

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WHALE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'

describe('buildTxPreview', () => {
  it('decodes an unlimited approval and flags it', async () => {
    const data = encodeFunctionData({
      abi: [parseAbiItem('function approve(address spender, uint256 amount)')],
      args: ['0x1111111254EEB25477B68fb85Ed929f73A960582', maxUint256]
    })

    const preview = await buildTxPreview('base', { to: USDC_BASE, data }, WHALE)

    expect(preview.decoded?.functionName).toBe('approve')
    const amount = preview.decoded?.fields.at(-1)
    expect(amount?.value).toContain('Unlimited')
    expect(amount?.warning).toBeDefined()
  })

  it('simulates a transfer and reports the asset change', async () => {
    const data = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
      args: ['0x1111111254EEB25477B68fb85Ed929f73A960582', parseUnits('1', 6)]
    })

    const preview = await buildTxPreview('base', { to: USDC_BASE, data }, WHALE)

    expect(preview.decoded?.fields.at(-1)?.value).toBe('1 USDC')
    expect(preview.simulation?.success).toBe(true)
    expect(preview.simulation?.assetChanges[0]).toMatchObject({ symbol: 'USDC', humanAmount: '1' })
  })

  it('reports a revert instead of throwing', async () => {
    const data = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
      args: ['0x1111111254EEB25477B68fb85Ed929f73A960582', parseUnits('1000000000', 6)]
    })

    const preview = await buildTxPreview('base', { to: USDC_BASE, data }, WHALE)

    expect(preview.simulation?.success).toBe(false)
    expect(preview.simulation?.error).toBeTruthy()
  })
})
