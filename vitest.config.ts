import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for network calls
    hookTimeout: 30000,
    setupFiles: ['test/setup.ts'],
  }
})
