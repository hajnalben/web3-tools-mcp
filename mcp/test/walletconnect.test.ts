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
   * Relabelling replaces the client, because metadata is fixed at init. Dropping the old
   * reference without closing it leaves two clients on one storage directory, and they
   * overwrite each other's subscription record — the loser stops receiving replies, so a
   * request reaches the wallet, gets approved, and the answer goes nowhere.
   */
  it('closes the replaced client when the agent label changes', async () => {
    const signer = new PhoneSigner(projectId as string)
    await signer.isPaired()

    const replaced = (signer as unknown as { client: { core: { relayer: { transportClose: () => Promise<void> } } } }).client
    expect(replaced).toBeTruthy()

    let closed = false
    const original = replaced.core.relayer.transportClose.bind(replaced.core.relayer)
    replaced.core.relayer.transportClose = async () => {
      closed = true
      return original()
    }

    await signer.pair(['mainnet'], 'Agent Under Test')

    expect(closed).toBe(true)
    expect((signer as unknown as { client: unknown }).client).not.toBe(replaced)
  }, 60000)
})

describe('configuration', () => {
  it('stays off unless a project id is configured', async () => {
    const { getPhoneSigner } = await import('../src/walletconnect.js')
    const configured = Boolean(getClientManager().getConfig().walletConnectProjectId)
    expect(getPhoneSigner() === null).toBe(!configured)
  })
})
