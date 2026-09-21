import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Test the relay workspace from source, so `npm test` doesn't need its build output.
    alias: {
      'web3-wallet-relay': fileURLToPath(new URL('./wallet/src/relay.ts', import.meta.url))
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for network calls
    hookTimeout: 30000,
    setupFiles: ['test/setup.ts'],
  }
})
