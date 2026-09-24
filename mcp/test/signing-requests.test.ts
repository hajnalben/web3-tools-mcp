import { describe, expect, it } from 'vitest'
import { collectSigningRequest, pendingSigningRequests, signingCall } from '../src/signing-requests.js'

/**
 * Approving happens on a human's schedule, which routinely outlives whatever timeout the MCP
 * client applies — and a phone wallet that sends no notification makes that the normal case
 * rather than the exception. What must not happen is the agent being told a request failed
 * while it sits, perfectly alive, in somebody's wallet.
 */

const ALICE = '0xalice'
const BOB = '0xbob'

/** A signature that never arrives, standing in for a wallet nobody has looked at. */
function never<T>(): { promise: Promise<T>; approve: (value: T) => void; reject: (error: Error) => void } {
  let approve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolve, fail) => {
    approve = resolve
    reject = fail
  })
  return { promise, approve, reject }
}

const fast = { identity: ALICE, summary: 'Send 1 ETH', signer: 'phone' as const, graceMs: 50 }

describe('a signature that outlives its tool call', () => {
  it('answers inline when the wallet is quick, which is the browser case', async () => {
    const outcome = await signingCall(fast, async () => '0xhash')
    expect(outcome).toEqual({ done: true, result: '0xhash' })
  })

  it('hands back an id rather than waiting for a wallet nobody is watching', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)

    expect(outcome.done).toBe(false)
    if (outcome.done) throw new Error('unreachable')
    expect(outcome.request.id).toMatch(/^[0-9a-f]{32}$/)
    expect(outcome.request.state).toBe('pending')

    wallet.approve('0xlate')
  })

  it('still delivers the signature when it is approved long after the call returned', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    // The human finally opens their wallet.
    wallet.approve('0xapproved')

    const collected = await collectSigningRequest(outcome.request.id, ALICE, 50)
    expect(collected.state).toBe('done')
    expect(collected.result).toBe('0xapproved')
  })

  it('reports a rejection that arrives late as a rejection, not a timeout', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    wallet.reject(new Error('User rejected transaction'))

    const collected = await collectSigningRequest(outcome.request.id, ALICE, 50)
    expect(collected.state).toBe('failed')
    expect(collected.error).toBe('User rejected transaction')
  })

  it('throws for a wallet that refuses within the grace, so a quick rejection still reads as one', async () => {
    await expect(
      signingCall(fast, async () => {
        throw new Error('User rejected transaction')
      })
    ).rejects.toThrow('User rejected transaction')
  })

  it('keeps waiting when the collection grace runs out too', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    const collected = await collectSigningRequest(outcome.request.id, ALICE, 20)
    expect(collected.state).toBe('pending')

    wallet.approve('0xeventually')
  })

  it('lists what is still in front of a wallet, so nothing is lost between calls', async () => {
    const wallet = never<string>()
    const outcome = await signingCall({ ...fast, summary: 'Sign the terms' }, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    const waiting = pendingSigningRequests(ALICE)
    expect(waiting.some((request) => request.id === outcome.request.id && request.summary === 'Sign the terms')).toBe(true)

    wallet.approve('0xdone')
  })
})

describe('one person cannot collect another′s signature', () => {
  it('refuses an id belonging to somebody else', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    await expect(collectSigningRequest(outcome.request.id, BOB, 20)).rejects.toThrow(/No signing request/)

    // And it is still there for the person it belongs to.
    wallet.approve('0xmine')
    expect((await collectSigningRequest(outcome.request.id, ALICE, 50)).result).toBe('0xmine')
  })

  it('never lists one identity′s requests under another', async () => {
    const wallet = never<string>()
    const outcome = await signingCall(fast, () => wallet.promise)
    if (outcome.done) throw new Error('should not have settled')

    expect(pendingSigningRequests(BOB).some((request) => request.id === outcome.request.id)).toBe(false)

    wallet.approve('0xdone')
  })
})

describe('several signatures at once', () => {
  it('keeps them apart, so approving one does not answer another', async () => {
    const first = never<string>()
    const second = never<string>()

    const a = await signingCall({ ...fast, summary: 'First' }, () => first.promise)
    const b = await signingCall({ ...fast, summary: 'Second' }, () => second.promise)
    if (a.done || b.done) throw new Error('neither should have settled')

    expect(a.request.id).not.toBe(b.request.id)

    second.approve('0xsecond')

    expect((await collectSigningRequest(b.request.id, ALICE, 50)).result).toBe('0xsecond')
    expect((await collectSigningRequest(a.request.id, ALICE, 20)).state).toBe('pending')

    first.approve('0xfirst')
  })
})
