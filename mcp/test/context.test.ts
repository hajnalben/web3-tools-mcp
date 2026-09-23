import { describe, expect, it } from 'vitest'
import { DEFAULT_IDENTITY, identityFrom } from '../src/context.js'
import { getWalletClient } from '../src/wallet-client.js'
import { ownedSessions } from '../src/walletconnect.js'

describe('call identity', () => {
  it('comes from the authenticated address, and is shared when there is none', () => {
    expect(identityFrom({ token: 't', clientId: 'c', scopes: [], extra: { address: '0xbob' } })).toBe('0xbob')

    // A single-credential server authenticates the deployment, not a person.
    expect(identityFrom({ token: 't', clientId: 'c', scopes: [] })).toBe(DEFAULT_IDENTITY)
    expect(identityFrom(undefined)).toBe(DEFAULT_IDENTITY)
    expect(identityFrom({ token: 't', clientId: 'c', scopes: [], extra: { address: 42 } })).toBe(DEFAULT_IDENTITY)
  })

  /**
   * The wallet client holds one person's socket, in-flight requests and open page, so two
   * identities must never land on the same one — that is how a transaction would reach
   * somebody else's wallet.
   */
  it('gives each identity its own wallet client', () => {
    const alice = getWalletClient('0xalice')
    const bob = getWalletClient('0xbob')

    expect(alice).not.toBe(bob)
    expect(getWalletClient('0xalice')).toBe(alice)
    expect(getWalletClient(DEFAULT_IDENTITY)).not.toBe(alice)
  })
})

/**
 * Phone sessions all live in one WalletConnect client — a client per person is what caused
 * the heartbeat to sweep a live session's topic — so which session an identity may sign
 * with is decided here, and it is the whole boundary between two people's wallets.
 */
describe('phone session ownership', () => {
  const alice = { topic: 'ta' }
  const bob = { topic: 'tb' }
  const legacy = { topic: 'tl' }
  const bindings = { ta: '0xalice', tb: '0xbob' }

  it('gives each identity only its own sessions', () => {
    expect(ownedSessions([alice, bob], bindings, '0xalice')).toEqual([alice])
    expect(ownedSessions([alice, bob], bindings, '0xbob')).toEqual([bob])
    expect(ownedSessions([alice, bob], bindings, '0xcarol')).toEqual([])
  })

  it('never hands an identity a session bound to somebody else', () => {
    // The dangerous direction: a stranger asking to sign must not reach a paired phone.
    expect(ownedSessions([alice], bindings, '0xmallory')).toEqual([])
    expect(ownedSessions([alice], bindings, DEFAULT_IDENTITY)).toEqual([])
  })

  it('keeps a pairing made before bindings existed working for a single-user server', () => {
    expect(ownedSessions([legacy], bindings, DEFAULT_IDENTITY)).toEqual([legacy])

    // But an unbound session is nobody's once identities are real.
    expect(ownedSessions([legacy], bindings, '0xalice')).toEqual([])
  })
})

/**
 * Several wallets can be bound to one person — a hot wallet and a hardware one, say — so
 * selection among them has to be explicit rather than "the most recent", while staying
 * inside what that person already paired.
 */
describe('several wallets for one identity', () => {
  const hot = { topic: 't1' }
  const cold = { topic: 't2' }
  const bindings = { t1: '0xalice', t2: '0xalice', t3: '0xbob' }

  it('keeps both, in pairing order', () => {
    expect(ownedSessions([hot, cold], bindings, '0xalice')).toEqual([hot, cold])
  })

  it('still excludes another identity, however many are paired', () => {
    expect(ownedSessions([hot, cold, { topic: 't3' }], bindings, '0xalice')).toEqual([hot, cold])
    expect(ownedSessions([hot, cold, { topic: 't3' }], bindings, '0xbob')).toEqual([{ topic: 't3' }])
  })
})
