import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

// The relay handshake carries no protocol version, so the package version is what matches a
// separately hosted relay to its server: both release together, at one number.
it('ships the server and the relay at one version, and pins the relay to it', () => {
  const server = manifest('../package.json')
  const relay = manifest('../../wallet-relay/package.json')

  expect(relay.version).toBe(server.version)
  expect(server.dependencies['web3-wallet-relay']).toBe(server.version)
})
