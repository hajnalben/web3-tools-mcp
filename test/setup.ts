import { config } from 'dotenv'
import { beforeAll } from 'vitest'
import { initializeClientManager } from '../src/client.js'

// Load environment variables
config({
  quiet: true
})

// Global setup for all tests
beforeAll(() => {
  // Initialize client manager with config
  initializeClientManager({
    alchemyApiKey: process.env.ALCHEMY_API_KEY,
    infuraApiKey: process.env.INFURA_API_KEY,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY,
    hypersyncApiKey: process.env.HYPERSYNC_API_KEY
  })
})
