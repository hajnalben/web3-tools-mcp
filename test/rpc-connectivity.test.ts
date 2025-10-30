import { describe, it, expect, beforeAll } from 'vitest'
import { initializeClientManager, SUPPORTED_CHAINS } from '../src/client.js'
import type { Config } from '../src/types.js'

describe('RPC Connectivity', () => {
  let clientManager: ReturnType<typeof initializeClientManager>

  beforeAll(() => {
    const config: Config = {
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      alchemyApiKey: process.env.ALCHEMY_API_KEY,
      infuraApiKey: process.env.INFURA_API_KEY,
      hypersyncApiKey: process.env.HYPERSYNC_API_KEY
    }
    clientManager = initializeClientManager(config)
  })

  it('should fetch block number for all default RPCs', async () => {
    const testChains = SUPPORTED_CHAINS.filter(chain => chain !== 'localhost')

    const results = await Promise.allSettled(
      testChains.map(async chainName => {
        const client = clientManager.getClient(chainName)
        const blockNumber = await client.getBlockNumber()
        return { chainName, blockNumber }
      })
    )

    const succeeded = results.filter(r => r.status === 'fulfilled')
    expect(succeeded.length).toBe(testChains.length)
  }, 60000)
})
