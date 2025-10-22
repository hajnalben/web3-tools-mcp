import { describe, it, expect, beforeAll } from 'vitest'
import { config } from 'dotenv'
import { initializeClientManager } from '../../src/client.js'
import balanceTools from '../../src/tools/balance.js'

// Load environment variables
config()

describe('Balance Tools', () => {
  beforeAll(() => {
    // Initialize client manager with config
    initializeClientManager({
      alchemyApiKey: process.env.ALCHEMY_API_KEY,
      infuraApiKey: process.env.INFURA_API_KEY,
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      hypersyncApiKey: process.env.HYPERSYNC_API_KEY
    })
  })
  describe('get_balance', () => {
    it('should fetch native ETH balance for an address', async () => {
      const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: VITALIK_ADDRESS
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].address).toBe(VITALIK_ADDRESS)
      expect(data.results[0].chain).toBe('mainnet')
      expect(data.results[0].balance).toBeDefined()
      expect(data.results[0].balanceFormatted).toBeDefined()
    }, 30000)

    it('should fetch ERC20 token balance (USDC)', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const HOLDER_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60' // Binance 14

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: HOLDER_ADDRESS,
            tokenAddress: USDC_CONTRACT
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].address).toBe(HOLDER_ADDRESS)
      expect(data.results[0].tokenAddress).toBe(USDC_CONTRACT)
      expect(data.results[0].balance).toBeDefined()
      expect(data.results[0].balanceFormatted).toBeDefined()
      expect(data.results[0].decimals).toBe(6)
      expect(BigInt(data.results[0].balance)).toBeGreaterThan(0n)
    }, 30000)

    it('should handle batch queries efficiently', async () => {
      const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: VITALIK_ADDRESS,
            label: 'Vitalik ETH'
          },
          {
            chain: 'mainnet',
            address: VITALIK_ADDRESS,
            tokenAddress: USDC_CONTRACT,
            label: 'Vitalik USDC'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(2)
      expect(data.results[0].label).toBe('Vitalik ETH')
      expect(data.results[1].label).toBe('Vitalik USDC')
      expect(data.results[1].decimals).toBe(6)
    }, 30000)

    it('should fetch balance at specific block number', async () => {
      const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
      const BLOCK_NUMBER = '18000000'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: VITALIK_ADDRESS,
            blockNumber: BLOCK_NUMBER
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].blockNumber).toBe(BLOCK_NUMBER)
      expect(data.results[0].balance).toBeDefined()
    }, 30000)

    it('should handle zero balance addresses', async () => {
      // Use an address that's extremely unlikely to have balance
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000002'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: ZERO_ADDRESS
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      // Balance might be 0 or very small
      expect(data.results[0].balance).toBeDefined()
      expect(data.results[0].balanceFormatted).toBeDefined()
    }, 30000)

    it('should handle invalid token address gracefully', async () => {
      const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
      const INVALID_TOKEN = '0x0000000000000000000000000000000000000001'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: VITALIK_ADDRESS,
            tokenAddress: INVALID_TOKEN
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      // Should either succeed with 0 balance or fail gracefully
      expect(data.results[0]).toHaveProperty('success')
    }, 30000)

    it('should work across different chains', async () => {
      const TEST_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

      const result = await balanceTools.get_balance.handler({
        queries: [
          {
            chain: 'mainnet',
            address: TEST_ADDRESS,
            label: 'Ethereum'
          },
          {
            chain: 'base',
            address: TEST_ADDRESS,
            label: 'Base'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(2)
      expect(data.results[0].chain).toBe('mainnet')
      expect(data.results[0].label).toBe('Ethereum')
      expect(data.results[1].chain).toBe('base')
      expect(data.results[1].label).toBe('Base')
    }, 30000)
  })
})
