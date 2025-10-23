import { describe, it, expect, beforeAll } from 'vitest'
import { config } from 'dotenv'
import { initializeClientManager } from '../../src/client.js'
import ensTools from '../../src/tools/ens.js'

// Load environment variables
config()

describe('ENS Tools', () => {
  beforeAll(() => {
    // Initialize client manager with config
    initializeClientManager({
      alchemyApiKey: process.env.ALCHEMY_API_KEY,
      infuraApiKey: process.env.INFURA_API_KEY,
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      hypersyncApiKey: process.env.HYPERSYNC_API_KEY
    })
  })

  describe('resolve_ens_name', () => {
    it('should resolve vitalik.eth to an address', async () => {
      const result = await ensTools.resolve_ens_name.handler({
        chain: 'mainnet',
        name: 'vitalik.eth'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.name).toBe('vitalik.eth')
      expect(data.address).toBeTruthy()
      expect(data.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
    }, 30000)

    it('should return null for non-existent ENS name', async () => {
      const result = await ensTools.resolve_ens_name.handler({
        chain: 'mainnet',
        name: 'this-name-definitely-does-not-exist-12345.eth'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(false)
      expect(data.address).toBeNull()
    }, 30000)
  })

  describe('reverse_resolve_ens', () => {
    it('should reverse resolve vitalik.eth address to name', async () => {
      // First resolve vitalik.eth to get the address
      const resolveResult = await ensTools.resolve_ens_name.handler({
        chain: 'mainnet',
        name: 'vitalik.eth'
      })
      const resolveData = JSON.parse(resolveResult.content[0].text)
      const address = resolveData.address

      // Then reverse resolve
      const result = await ensTools.reverse_resolve_ens.handler({
        chain: 'mainnet',
        address
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.address).toBe(address)
      expect(data.name).toBeTruthy()
    }, 30000)

    it('should return null for address without reverse record', async () => {
      const result = await ensTools.reverse_resolve_ens.handler({
        chain: 'mainnet',
        address: '0x0000000000000000000000000000000000000001'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(false)
      expect(data.name).toBeNull()
    }, 30000)
  })

  describe('get_ens_text_record', () => {
    it('should get text record from ENS name', async () => {
      const result = await ensTools.get_ens_text_record.handler({
        chain: 'mainnet',
        name: 'vitalik.eth',
        key: 'url'
      })

      const data = JSON.parse(result.content[0].text)
      // vitalik.eth may or may not have a url record, so we just check the structure
      expect(data).toHaveProperty('success')
      expect(data.name).toBe('vitalik.eth')
      expect(data.key).toBe('url')
    }, 30000)
  })

  describe('get_ens_avatar', () => {
    it('should get avatar from ENS name with avatar set', async () => {
      const result = await ensTools.get_ens_avatar.handler({
        chain: 'mainnet',
        name: 'vitalik.eth'
      })

      const data = JSON.parse(result.content[0].text)
      expect(data).toHaveProperty('success')
      expect(data.name).toBe('vitalik.eth')
      // Avatar may or may not be set
      if (data.success) {
        expect(data.avatar).toBeTruthy()
      }
    }, 30000)
  })

  describe('batch_resolve_ens_names', () => {
    it('should batch resolve multiple ENS names', async () => {
      const result = await ensTools.batch_resolve_ens_names.handler({
        chain: 'mainnet',
        names: ['vitalik.eth', 'nick.eth', 'nonexistent12345.eth']
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.totalNames).toBe(3)
      expect(data.results).toHaveLength(3)
      expect(data.successfulResolves).toBeGreaterThan(0)

      // Check that vitalik.eth resolved successfully
      const vitalikResult = data.results.find((r: any) => r.name === 'vitalik.eth')
      expect(vitalikResult).toBeTruthy()
      expect(vitalikResult.success).toBe(true)
      expect(vitalikResult.address).toBeTruthy()
    }, 30000)
  })

  // Base ENS Tests
  describe('Base ENS Support', () => {
    const BASE_TEST_NAME = 'ben👾the👾dev.base.eth'
    const BASE_TEST_ADDRESS = '0xc880e213f2aB4BAe36C8bF19a6Df6757152242c0'

    describe('resolve_ens_name on Base', () => {
      it('should resolve Base ENS name to address', async () => {
        const result = await ensTools.resolve_ens_name.handler({
          chain: 'base',
          name: BASE_TEST_NAME
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.name).toBe(BASE_TEST_NAME)
        expect(data.address).toBe(BASE_TEST_ADDRESS)
        expect(data.chain).toBe('base')
      }, 30000)

      it('should return null for non-existent Base ENS name', async () => {
        const result = await ensTools.resolve_ens_name.handler({
          chain: 'base',
          name: 'this-definitely-does-not-exist-12345.base.eth'
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(false)
        expect(data.address).toBeNull()
      }, 30000)
    })

    describe('reverse_resolve_ens on Base', () => {
      it('should reverse resolve Base address to ENS name', async () => {
        const result = await ensTools.reverse_resolve_ens.handler({
          chain: 'base',
          address: BASE_TEST_ADDRESS
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.address).toBe(BASE_TEST_ADDRESS)
        expect(data.name).toBe(BASE_TEST_NAME)
        expect(data.chain).toBe('base')
      }, 30000)

      it('should return null for Base address without reverse record', async () => {
        const result = await ensTools.reverse_resolve_ens.handler({
          chain: 'base',
          address: '0x0000000000000000000000000000000000000001'
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(false)
        expect(data.name).toBeNull()
      }, 30000)
    })

    describe('get_ens_text_record on Base', () => {
      it('should get twitter text record from Base ENS name', async () => {
        const result = await ensTools.get_ens_text_record.handler({
          chain: 'base',
          name: BASE_TEST_NAME,
          key: 'com.twitter'
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.name).toBe(BASE_TEST_NAME)
        expect(data.key).toBe('com.twitter')
        expect(data.value).toBe('hajnalben')
        expect(data.chain).toBe('base')
      }, 30000)

      it('should get location text record from Base ENS name', async () => {
        const result = await ensTools.get_ens_text_record.handler({
          chain: 'base',
          name: BASE_TEST_NAME,
          key: 'location'
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.value).toBe('Budapest, Hungary')
      }, 30000)

      it('should return null for non-existent text record on Base', async () => {
        const result = await ensTools.get_ens_text_record.handler({
          chain: 'base',
          name: BASE_TEST_NAME,
          key: 'nonexistent-key-12345'
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(false)
        expect(data.value).toBeNull()
      }, 30000)
    })

    describe('get_ens_avatar on Base', () => {
      it('should get avatar from Base ENS name', async () => {
        const result = await ensTools.get_ens_avatar.handler({
          chain: 'base',
          name: BASE_TEST_NAME
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.name).toBe(BASE_TEST_NAME)
        expect(data.avatar).toBeTruthy()
        expect(data.avatar).toContain('ipfs://')
        expect(data.chain).toBe('base')
      }, 30000)
    })

    describe('batch_resolve_ens_names on Base', () => {
      it('should batch resolve multiple Base ENS names', async () => {
        const result = await ensTools.batch_resolve_ens_names.handler({
          chain: 'base',
          names: [BASE_TEST_NAME, 'nonexistent12345.base.eth']
        })

        const data = JSON.parse(result.content[0].text)
        expect(data.success).toBe(true)
        expect(data.chain).toBe('base')
        expect(data.totalNames).toBe(2)
        expect(data.results).toHaveLength(2)

        // Check that our test name resolved successfully
        const testResult = data.results.find((r: any) => r.name === BASE_TEST_NAME)
        expect(testResult).toBeTruthy()
        expect(testResult.success).toBe(true)
        expect(testResult.address).toBe(BASE_TEST_ADDRESS)

        // Check that non-existent name failed
        const nonExistentResult = data.results.find((r: any) => r.name === 'nonexistent12345.base.eth')
        expect(nonExistentResult).toBeTruthy()
        expect(nonExistentResult.success).toBe(false)
      }, 30000)
    })
  })
})
