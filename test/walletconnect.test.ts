import { describe, it, expect } from 'vitest'
import { PhoneSigner } from '../src/walletconnect.js'
import { getClientManager } from '../src/client.js'

const projectId = process.env.WALLETCONNECT_PROJECT_ID

describe.skipIf(!projectId)('WalletConnect phone signing', () => {
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
})

describe('configuration', () => {
  it('stays off unless a project id is configured', async () => {
    const { getPhoneSigner } = await import('../src/walletconnect.js')
    const configured = Boolean(getClientManager().getConfig().walletConnectProjectId)
    expect(getPhoneSigner() === null).toBe(!configured)
  })
})
