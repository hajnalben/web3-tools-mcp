import { encodeFunctionData, maxUint256, pad, parseAbiItem, parseUnits, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildTxPreview, enrichTransfers } from '../src/preview.js'
import { hasProviderRpc } from './setup.js'

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

  // eth_simulateV1 is not served by the public endpoints.
  it.skipIf(!hasProviderRpc)('simulates a transfer and reports the asset change', async () => {
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

describe('transfers read from simulation logs', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const ZERO = '0x0000000000000000000000000000000000000000'
  const OWNER = '0xe192d77e0f83e54d2a9a301257682ded62c19f6c'
  const POOL = '0x52aa899454998be5b000ad077a46bbe360f4e497'

  it('reads a four-topic Transfer as an ERC-721 token, not an ERC-20 transfer of nothing', async () => {
    // A Fluid vault minting its position NFT: the token id is the fourth topic, the data empty.
    const [mint] = await enrichTransfers('base', [
      {
        address: '0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d',
        topics: [TRANSFER, pad(ZERO), pad(OWNER), toHex(12639n, { size: 32 })],
        data: '0x'
      }
    ])

    expect(mint).toMatchObject({ tokenId: '12639', amount: '1', from: ZERO, to: OWNER })
    expect(mint?.humanAmount).toBeUndefined()
  })

  it('still reads an ERC-20 amount from the data', async () => {
    const [transfer] = await enrichTransfers('base', [
      {
        address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
        topics: [TRANSFER, pad(OWNER), pad(POOL)],
        data: toHex(29700000000000000n, { size: 32 })
      }
    ])

    expect(transfer).toMatchObject({ amount: '29700000000000000', from: OWNER, to: POOL })
    expect(transfer?.tokenId).toBeUndefined()
  })
})
