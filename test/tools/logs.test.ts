import { describe, it, expect, beforeAll } from 'vitest'
import { config } from 'dotenv'
import { initializeClientManager } from '../../src/client.js'
import logsTools from '../../src/tools/logs.js'

// Load environment variables
config()

describe('Logs Tools', () => {
  beforeAll(() => {
    // Initialize client manager with config
    initializeClientManager({
      alchemyApiKey: process.env.ALCHEMY_API_KEY,
      infuraApiKey: process.env.INFURA_API_KEY,
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      hypersyncApiKey: process.env.HYPERSYNC_API_KEY
    })
  })
  describe('get_logs', () => {
    it('should fetch Transfer events from USDC contract', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        fromBlock: '21000000',
        toBlock: '21000100'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()
      expect(Array.isArray(data.logs)).toBe(true)
      expect(data.chain).toBe('mainnet')
      expect(data.filters.address).toBe(USDC_CONTRACT)
      expect(data.fromBlock).toBe('21000000')
      expect(data.toBlock).toBe('21000100')
    }, 30000)

    it('should filter Transfer events by indexed from parameter', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const BINANCE_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        eventArgs: {
          from: BINANCE_ADDRESS
        },
        fromBlock: '21000000',
        toBlock: '21000100'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()

      // All events should have the specified 'from' address
      if (data.logs.length > 0) {
        data.logs.forEach((event: any) => {
          expect(event.decoded.args.from.toLowerCase()).toBe(BINANCE_ADDRESS.toLowerCase())
        })
      }
    }, 30000)

    it('should filter Transfer events by indexed to parameter', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const RECEIVER_ADDRESS = '0x28C6c06298d514Db089934071355E5743bf21d60'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        eventArgs: {
          to: RECEIVER_ADDRESS
        },
        fromBlock: '21000000',
        toBlock: '21000100'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()

      // All events should have the specified 'to' address
      if (data.logs.length > 0) {
        data.logs.forEach((event: any) => {
          expect(event.decoded.args.to.toLowerCase()).toBe(RECEIVER_ADDRESS.toLowerCase())
        })
      }
    }, 30000)

    it('should decode event arguments correctly', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        fromBlock: '21000000',
        toBlock: '21000010'
      })

      const data = JSON.parse(result.content[0].text)

      if (data.logs.length > 0) {
        const event = data.logs[0]
        expect(event.decoded.args).toBeDefined()
        expect(event.decoded.args.from).toBeDefined()
        expect(event.decoded.args.to).toBeDefined()
        expect(event.decoded.args.value).toBeDefined()
        expect(event.blockNumber).toBeDefined()
        expect(event.transactionHash).toBeDefined()
        expect(event.logIndex).toBeDefined()
      }
    }, 30000)

    it('should fetch Approval events', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Approval(address indexed owner, address indexed spender, uint256 value)',
        fromBlock: '21000000',
        toBlock: '21000100'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()

      if (data.logs.length > 0) {
        const event = data.logs[0]
        expect(event.decoded.args.owner).toBeDefined()
        expect(event.decoded.args.spender).toBeDefined()
        expect(event.decoded.args.value).toBeDefined()
      }
    }, 30000)

    it('should work without address filter (query all contracts)', async () => {
      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        fromBlock: '21000000',
        toBlock: '21000001'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()
      expect(Array.isArray(data.logs)).toBe(true)
    }, 30000)

    it('should handle events with no results', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        eventArgs: {
          from: ZERO_ADDRESS,
          to: ZERO_ADDRESS
        },
        fromBlock: '21000000',
        toBlock: '21000010'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()
      expect(Array.isArray(data.logs)).toBe(true)
      // Might have 0 events, that's valid
    }, 30000)

    it('should work with different chains', async () => {
      const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

      const result = await logsTools.get_logs.handler({
        chain: 'base',
        address: USDC_BASE,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        fromBlock: '10000000',
        toBlock: '10000010'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.chain).toBe('base')
      expect(data.logs).toBeDefined()
    }, 30000)

    it('should include event metadata', async () => {
      const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: USDC_CONTRACT,
        eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        fromBlock: '21000000',
        toBlock: '21000010'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.count).toBeDefined()
      expect(typeof data.count).toBe('number')
      expect(data.eventSignature).toContain('Transfer')
    }, 30000)

    it('should handle custom events with different parameter types', async () => {
      // Using a well-known contract with custom events - Uniswap V2 Pair
      const UNISWAP_PAIR = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc' // USDC-WETH

      const result = await logsTools.get_logs.handler({
        chain: 'mainnet',
        address: UNISWAP_PAIR,
        eventAbi: 'event Sync(uint112 reserve0, uint112 reserve1)',
        fromBlock: '21000000',
        toBlock: '21000010'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.logs).toBeDefined()

      if (data.logs.length > 0) {
        const event = data.logs[0]
        expect(event.decoded.args).toBeDefined()
        expect(event.decoded.args.reserve0).toBeDefined()
        expect(event.decoded.args.reserve1).toBeDefined()
      }
    }, 30000)
  })
})
