import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getClientManager } from '../src/client.js'
import { PhoneSigner } from '../src/walletconnect.js'

const projectId = process.env.WALLETCONNECT_PROJECT_ID

describe.skipIf(!projectId)('WalletConnect phone signing', () => {
  // The store path comes from XDG_CONFIG_HOME, so without this a test run writes into the
  // developer's own WalletConnect store and can disturb a pairing they are using.
  const previousHome = process.env.XDG_CONFIG_HOME

  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'wc-test-'))
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousHome
  })

  it('starts a pairing and reports no session until a wallet approves', async () => {
    const signer = new PhoneSigner(projectId as string)

    expect(await signer.isPaired()).toBe(false)

    const uri = await signer.pair(['mainnet', 'base'])
    expect(uri).toMatch(/^wc:/)
    // Nothing has scanned it, so there is still nothing to sign with.
    expect(await signer.session()).toBeUndefined()
  }, 60000)

  it('refuses to send to a chain the session never approved', async () => {
    const signer = new PhoneSigner(projectId as string)
    await expect(signer.request('polygon', 'eth_sendTransaction', [])).rejects.toThrow(/No phone wallet paired/)
  }, 60000)

  /**
   * Relabelling used to replace the client, and the old one's heartbeat then swept the new
   * session's topic as orphaned two seconds after it settled — every reply from the wallet
   * went nowhere and signing hung. So the name is taken before the client starts, and a
   * running client is never replaced.
   */
  it('pairs with one client, named before it starts', async () => {
    type Inspectable = { client?: { metadata: { name: string } } }
    const signer = new PhoneSigner(projectId as string)

    signer.nameAgent('Agent Under Test')
    await signer.isPaired()
    const only = (signer as unknown as Inspectable).client
    expect(only?.metadata.name).toContain('Agent Under Test')

    await signer.pair(['mainnet'])
    expect((signer as unknown as Inspectable).client).toBe(only)
  }, 60000)

  it('ignores a name given after the client has started', async () => {
    type Inspectable = { client?: { metadata: { name: string } } }
    const signer = new PhoneSigner(projectId as string)
    await signer.isPaired()

    signer.nameAgent('Too Late')
    await signer.pair(['mainnet'])

    const client = (signer as unknown as Inspectable).client
    expect(client?.metadata.name).not.toContain('Too Late')
  }, 60000)
})

describe('configuration', () => {
  it('stays off unless a project id is configured', async () => {
    const { getPhoneSigner } = await import('../src/walletconnect.js')
    const configured = Boolean(getClientManager().getConfig().walletConnectProjectId)
    expect(getPhoneSigner() === null).toBe(!configured)
  })
})
