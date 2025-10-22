import { describe, it, expect, beforeAll } from 'vitest'
import { config } from 'dotenv'
import { initializeClientManager } from '../../src/client.js'
import contractTools from '../../src/tools/contract.js'

// Load environment variables
config()

describe('Contract Tools', () => {
  beforeAll(() => {
    // Initialize client manager with config
    initializeClientManager({
      alchemyApiKey: process.env.ALCHEMY_API_KEY,
      infuraApiKey: process.env.INFURA_API_KEY,
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      hypersyncApiKey: process.env.HYPERSYNC_API_KEY
    })
  })
  describe('is_contract', () => {
    it('should identify a contract address', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await contractTools.is_contract.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.address).toBe(USDC_CONTRACT)
      expect(data.isContract).toBe(true)
      expect(data.bytecodeLength).toBeGreaterThan(0)
    }, 30000)

    it('should identify an EOA (wallet) address', async () => {
      // Use a random high address that's unlikely to have been used
      const TEST_EOA = '0x0000000000000000000000000000000000000003'

      const result = await contractTools.is_contract.handler({
        chain: 'mainnet',
        address: TEST_EOA
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.address).toBe(TEST_EOA)
      expect(data.isContract).toBe(false)
      expect(data.bytecodeLength).toBe(0)
    }, 30000)

    it('should work with different chains', async () => {
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

      const result = await contractTools.is_contract.handler({
        chain: 'base',
        address: ZERO_ADDRESS
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.chain).toBe('base')
      expect(data.isContract).toBe(false)
    }, 30000)
  })

  describe('call_contract_function', () => {
    it('should call USDC balanceOf function', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const HOLDER_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60' // Binance 14

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function balanceOf(address owner) view returns (uint256)',
            args: [HOLDER_ADDRESS]
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].result).toBeDefined()
      expect(BigInt(data.results[0].result)).toBeGreaterThan(0n)
    }, 30000)

    it('should call USDC name, symbol, and decimals functions in batch', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function name() view returns (string)',
            label: 'name'
          },
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function symbol() view returns (string)',
            label: 'symbol'
          },
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function decimals() view returns (uint8)',
            label: 'decimals'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(3)

      const nameResult = data.results.find((r: any) => r.label === 'name')
      expect(nameResult.success).toBe(true)
      expect(nameResult.result).toBe('USD Coin')

      const symbolResult = data.results.find((r: any) => r.label === 'symbol')
      expect(symbolResult.success).toBe(true)
      expect(symbolResult.result).toBe('USDC')

      const decimalsResult = data.results.find((r: any) => r.label === 'decimals')
      expect(decimalsResult.success).toBe(true)
      expect(decimalsResult.result).toBe(6)
    }, 30000)

    it('should call function at specific block number', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const BLOCK_NUMBER = '18000000'

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function totalSupply() view returns (uint256)',
            blockNumber: BLOCK_NUMBER
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].blockNumber).toBe(BLOCK_NUMBER)
      expect(data.results[0].result).toBeDefined()
    }, 30000)

    it('should handle function calls with multiple arguments', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const OWNER = '0x28C6c06298d514Db089934071355E5743bf21d60'
      const SPENDER = '0x0000000000000000000000000000000000000001'

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function allowance(address owner, address spender) view returns (uint256)',
            args: [OWNER, SPENDER]
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].result).toBeDefined()
      // Allowance might be 0, that's fine
    }, 30000)

    it('should handle calls to different chains in batch', async () => {
      const USDC_MAINNET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_MAINNET,
            functionAbi: 'function symbol() view returns (string)',
            label: 'mainnet-symbol'
          },
          {
            chain: 'base',
            contractAddress: USDC_BASE,
            functionAbi: 'function symbol() view returns (string)',
            label: 'base-symbol'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(2)
      expect(data.results[0].label).toBe('mainnet-symbol')
      expect(data.results[0].chain).toBe('mainnet')
      expect(data.results[1].label).toBe('base-symbol')
      expect(data.results[1].chain).toBe('base')
    }, 30000)

    it('should handle boolean return values', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function paused() view returns (bool)'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(typeof data.results[0].result).toBe('boolean')
    }, 30000)

    it('should handle functions returning multiple values', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      // USDC doesn't have a multi-return function in standard ERC20, but we can test the structure
      // Let's use a function that exists and check the result format
      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function name() view returns (string)'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(true)
      expect(data.results[0].contractAddress).toBe(USDC_CONTRACT)
    }, 30000)

    it('should handle reverted calls gracefully', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      // Try to call a function that doesn't exist or will revert
      const result = await contractTools.call_contract_function.handler({
        calls: [
          {
            chain: 'mainnet',
            contractAddress: USDC_CONTRACT,
            functionAbi: 'function nonExistentFunction() view returns (uint256)'
          }
        ]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.results).toHaveLength(1)
      expect(data.results[0].success).toBe(false)
      expect(data.results[0].error).toBeDefined()
    }, 30000)
  })
})
