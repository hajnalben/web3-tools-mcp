import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { beforeAll } from 'vitest'
import { isDebugNodeAvailable } from '../src/anvil.js'
import { initializeClientManager } from '../src/client.js'

// One .env for the whole repo; vitest runs from this package, so resolve it from here.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true })

/**
 * These tests hit live chains, and a public RPC only serves recent state. Historical
 * state, logs over a past range and tracing all need a provider key; Hypersync needs its
 * own token; tracing also needs a node serving debug_traceCall at ANVIL_RPC_URL. Tests
 * that cannot work without one skip instead of failing, so a checkout with no credentials
 * still gives a meaningful run.
 *
 * Set them in .env locally, or as repository secrets for CI.
 */
export const hasProviderRpc = Boolean(process.env.ALCHEMY_API_KEY || process.env.INFURA_API_KEY || process.env.CUSTOM_RPC)
export const hasHypersync = Boolean(process.env.HYPERSYNC_API_KEY)
export const hasAnvil = await isDebugNodeAvailable()

beforeAll(() => {
  initializeClientManager({
    alchemyApiKey: process.env.ALCHEMY_API_KEY,
    infuraApiKey: process.env.INFURA_API_KEY,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY,
    hypersyncApiKey: process.env.HYPERSYNC_API_KEY,
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID,
    customRpcUrls: process.env.CUSTOM_RPC ? JSON.parse(process.env.CUSTOM_RPC) : undefined
  })
})
