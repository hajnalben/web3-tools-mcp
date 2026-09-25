import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getClientManager } from '../src/client.js'
import { droppedSessions, orphanedBindings, PhoneSigner, qrSvg } from '../src/walletconnect.js'

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

/**
 * A wallet that keeps one session per site ends its own earlier pairing when a second is
 * approved in the same app. The session disappears from WalletConnect's store and only the
 * binding is left, pointing at nothing — which is how a paired wallet went missing from
 * wallet_status with no error anywhere.
 */
describe('a wallet that replaces its own session', () => {
  const rabbyA = { topic: 'aaa', accounts: ['0xA'], peer: 'Rabby' }
  const rabbyB = { topic: 'bbb', accounts: ['0xB'], peer: 'Rabby' }
  const metamask = { topic: 'ccc', accounts: ['0xC'], peer: 'MetaMask' }

  it('spots the pairing the wallet ended', () => {
    expect(droppedSessions([rabbyA], [rabbyB])).toEqual([rabbyA])
  })

  it('stays quiet when the wallet kept both', () => {
    expect(droppedSessions([rabbyA], [rabbyA, metamask])).toEqual([])
  })

  it('reports nothing on a first pairing, when there was nothing to lose', () => {
    expect(droppedSessions([], [rabbyA])).toEqual([])
  })
})

describe('bindings left behind by a session that is gone', () => {
  const bindings = { aaa: '0x1111', bbb: '0x1111', ccc: '0x2222' }

  it('names the ones with nothing behind them', () => {
    expect(orphanedBindings([{ topic: 'bbb' }, { topic: 'ccc' }], bindings)).toEqual(['aaa'])
  })

  it('leaves a fully populated store alone', () => {
    expect(orphanedBindings([{ topic: 'aaa' }, { topic: 'bbb' }, { topic: 'ccc' }], bindings)).toEqual([])
  })

  /**
   * The guard that matters. A client that has not hydrated yet reports no sessions, which is
   * indistinguishable from having none — and sweeping then would unbind every wallet still
   * paired, causing exactly the disappearance this code exists to stop.
   */
  it('refuses to sweep anything when the store looks empty', () => {
    expect(orphanedBindings([], bindings)).toEqual([])
  })
})

describe('a pairing URI drawn as an SVG QR', () => {
  it('is a version 1 code inside a four-module quiet zone', () => {
    const svg = qrSvg('hello')
    // 21 modules, plus four either side.
    expect(svg).toContain('viewBox="0 0 29 29"')
    // The top-left finder pattern's corner, just past the quiet zone.
    expect(svg).toContain('M4 4h1v1h-1z')
  })

  it('grows with the data, as a WalletConnect URI needs', () => {
    const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`
    const size = Number(qrSvg(uri).match(/viewBox="0 0 (\d+)/)?.[1])
    expect(size).toBeGreaterThan(29)
  })
})
