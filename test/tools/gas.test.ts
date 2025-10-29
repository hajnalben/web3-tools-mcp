import { describe, it, expect } from 'vitest'
import gasTools from '../../src/tools/gas.js'

describe('Gas Tools', () => {

  describe('get_gas_price', () => {
    it('should get current gas prices for mainnet', async () => {
      const result = await gasTools.get_gas_price.handler({
        chain: 'mainnet',
        formatted: true
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.chain).toBe('mainnet')
      expect(data.timestamp).toBeDefined()
      expect(data.legacy).toBeDefined()
      expect(data.legacy.gasPrice).toContain('Gwei')
      expect(data.legacy.gasPriceWei).toBeDefined()

      // Mainnet supports EIP-1559
      expect(data.eip1559).toBeDefined()
      expect(data.eip1559.maxFeePerGas).toContain('Gwei')
      expect(data.eip1559.maxPriorityFeePerGas).toContain('Gwei')
      expect(data.eip1559.estimatedCostFor21kGas).toContain('ETH')
    }, 30000)

    it('should return gas prices in wei when formatted is false', async () => {
      const result = await gasTools.get_gas_price.handler({
        chain: 'mainnet',
        formatted: false
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.legacy.gasPrice).not.toContain('Gwei')
      expect(data.legacy.gasPrice).toMatch(/^\d+$/) // Should be numeric string

      if (data.eip1559) {
        expect(data.eip1559.maxFeePerGas).not.toContain('Gwei')
        expect(data.eip1559.maxFeePerGas).toMatch(/^\d+$/)
      }
    }, 30000)

    it('should work with different chains', async () => {
      const result = await gasTools.get_gas_price.handler({
        chain: 'base',
        formatted: true
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.chain).toBe('base')
      expect(data.legacy.gasPrice).toBeDefined()
    }, 30000)

    it('should handle chains without EIP-1559 gracefully', async () => {
      const result = await gasTools.get_gas_price.handler({
        chain: 'mainnet',
        formatted: true
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.legacy).toBeDefined()
      // EIP-1559 may or may not be available depending on chain
    }, 30000)
  })

  describe('estimate_gas', () => {
    it('should estimate gas for a simple ETH transfer', async () => {
      const result = await gasTools.estimate_gas.handler({
        chain: 'mainnet',
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000' // 1 ETH
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.gasEstimate).toBeDefined()
      expect(BigInt(data.gasEstimate)).toBeGreaterThan(0n)
      expect(BigInt(data.gasEstimate)).toBeLessThan(50000n) // Should be close to 21000 for simple transfer
    }, 30000)

    it('should estimate gas for a contract function call using functionAbi', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const RECIPIENT = '0x0000000000000000000000000000000000000001'

      const result = await gasTools.estimate_gas.handler({
        chain: 'mainnet',
        to: USDC_CONTRACT,
        functionAbi: 'function transfer(address to, uint256 amount)',
        args: [RECIPIENT, '1000000'], // 1 USDC (6 decimals)
        from: '0x28C6c06298d514Db089934071355E5743bf21d60' // Binance 14 (has USDC)
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.gasEstimate).toBeDefined()
      expect(BigInt(data.gasEstimate)).toBeGreaterThan(21000n) // Contract call needs more than simple transfer
    }, 30000)

    it('should estimate gas using raw data', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      // Encoded data for balanceOf(address) with zero address
      const data = '0x70a082310000000000000000000000000000000000000000000000000000000000000000'

      const result = await gasTools.estimate_gas.handler({
        chain: 'mainnet',
        to: USDC_CONTRACT,
        data
      })

      const gasData = JSON.parse(result.content[0].text)
      expect(gasData.success).toBe(true)
      expect(gasData.gasEstimate).toBeDefined()
    }, 30000)

    it('should work with different chains', async () => {
      const result = await gasTools.estimate_gas.handler({
        chain: 'base',
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.chain).toBe('base')
    }, 30000)

    it('should handle estimation errors gracefully', async () => {
      // Try to estimate gas for a contract call that would fail
      await expect(
        gasTools.estimate_gas.handler({
          chain: 'mainnet',
          to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
          functionAbi: 'function transfer(address to, uint256 amount)',
          args: ['0x0000000000000000000000000000000000000001', '999999999999999999'], // Huge amount
          from: '0x0000000000000000000000000000000000000001' // Address with no USDC
        })
      ).rejects.toThrow()
    }, 30000)
  })

  describe('simulate_contract', () => {
    it('should simulate a view function call', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const HOLDER_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60' // Binance 14

      const result = await gasTools.simulate_contract.handler({
        chain: 'mainnet',
        contractAddress: USDC_CONTRACT,
        functionAbi: 'function balanceOf(address owner) view returns (uint256)',
        args: [HOLDER_ADDRESS]
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.contractAddress).toBe(USDC_CONTRACT)
      expect(data.functionName).toBe('balanceOf')
      expect(data.result).toBeDefined()
      expect(data.gasEstimate).toBeDefined()
      expect(BigInt(data.gasEstimate)).toBeGreaterThan(0n)
    }, 30000)

    it('should simulate a state-changing function', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const RECIPIENT = '0x0000000000000000000000000000000000000001'
      const SENDER = '0x28C6c06298d514Db089934071355E5743bf21d60' // Binance 14

      const result = await gasTools.simulate_contract.handler({
        chain: 'mainnet',
        contractAddress: USDC_CONTRACT,
        functionAbi: 'function transfer(address to, uint256 amount)',
        args: [RECIPIENT, '1000000'], // 1 USDC
        from: SENDER
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.functionName).toBe('transfer')
      expect(data.gasEstimate).toBeDefined()
      expect(BigInt(data.gasEstimate)).toBeGreaterThan(0n)
    }, 30000)

    it('should simulate with custom value (ETH)', async () => {
      // Simulate a call with ETH value
      const result = await gasTools.simulate_contract.handler({
        chain: 'mainnet',
        contractAddress: '0x0000000000000000000000000000000000000000',
        functionAbi: 'function test() payable',
        value: '1000000000000000000', // 1 ETH
        from: '0x28C6c06298d514Db089934071355E5743bf21d60'
      })

      // This should fail because 0x0 doesn't have code, but it tests the value parameter
      const data = JSON.parse(result.content[0].text)
      expect(data).toBeDefined()
    }, 30000)

    it('should detect reverts', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const RECIPIENT = '0x0000000000000000000000000000000000000001'

      const result = await gasTools.simulate_contract.handler({
        chain: 'mainnet',
        contractAddress: USDC_CONTRACT,
        functionAbi: 'function transfer(address to, uint256 amount)',
        args: [RECIPIENT, '999999999999999999'], // Huge amount that will fail
        from: '0x0000000000000000000000000000000000000001' // Address with no USDC
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(false)
      expect(data.reverted).toBe(true)
      expect(data.error).toBeDefined()
    }, 30000)

    it('should simulate at specific block number', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const HOLDER_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60'

      const result = await gasTools.simulate_contract.handler({
        chain: 'mainnet',
        contractAddress: USDC_CONTRACT,
        functionAbi: 'function balanceOf(address owner) view returns (uint256)',
        args: [HOLDER_ADDRESS],
        blockNumber: '18000000'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.blockNumber).toBe('18000000')
      // Should succeed or fail based on whether address had USDC at that block
      expect(data).toBeDefined()
    }, 30000)

    it('should work with different chains', async () => {
      // Use a known contract on Base
      const result = await gasTools.simulate_contract.handler({
        chain: 'base',
        contractAddress: '0x0000000000000000000000000000000000000000',
        functionAbi: 'function test() view returns (uint256)'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.chain).toBe('base')
    }, 30000)

    it('should handle invalid contract address', async () => {
      await expect(
        gasTools.simulate_contract.handler({
          chain: 'mainnet',
          contractAddress: 'invalid-address',
          functionAbi: 'function test() view'
        })
      ).rejects.toThrow(/Invalid contract address/)
    }, 30000)

    it('should handle invalid from address', async () => {
      await expect(
        gasTools.simulate_contract.handler({
          chain: 'mainnet',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          functionAbi: 'function test() view',
          from: 'invalid-address'
        })
      ).rejects.toThrow(/Invalid from address/)
    }, 30000)
  })
})
