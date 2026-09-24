import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain browser module, served to the signing page as-is
import { requestQueue } from '../../wallet-relay/public/request-queue.js'

/**
 * Which request a click answers is the highest-stakes question this project asks: get it
 * wrong and somebody signs a transaction they were not looking at. The page used to hold a
 * single request, so a second one overwrote the first and the first was never answered —
 * the agent waited forever on a signature that had silently ceased to exist.
 */

const transfer = { id: 'aaa', type: 'send_transaction', chain: 'base' }
const swap = { id: 'bbb', type: 'send_transaction', chain: 'mainnet' }
const message = { id: 'ccc', type: 'sign_message', chain: 'any' }

describe('the requests waiting for approval', () => {
  it('keeps every one that arrives, in the order they came', () => {
    const queue = requestQueue()
    queue.add(transfer)
    queue.add(swap)
    queue.add(message)

    expect(queue.size).toBe(3)
    expect(queue.list().map((request: { id: string }) => request.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('answers the one that was clicked, not the newest or the oldest', () => {
    const queue = requestQueue()
    queue.add(transfer)
    queue.add(swap)
    queue.add(message)

    expect(queue.claim('bbb')).toBe(swap)
    expect(queue.list().map((request: { id: string }) => request.id)).toEqual(['aaa', 'ccc'])
  })

  it('refuses to answer the same request twice, however fast the second click is', () => {
    const queue = requestQueue()
    queue.add(transfer)

    expect(queue.claim('aaa')).toBe(transfer)
    expect(queue.claim('aaa')).toBeNull()
    expect(queue.size).toBe(0)
  })

  it('knows nothing of an id it was never given', () => {
    const queue = requestQueue()
    queue.add(transfer)

    expect(queue.claim('not-a-request')).toBeNull()
    expect(queue.size).toBe(1)
  })

  it('never loses the first request when a second arrives, which is the bug it exists for', () => {
    const queue = requestQueue()
    queue.add(transfer)
    queue.add(swap)

    expect(queue.claim('aaa')).toBe(transfer)
    expect(queue.claim('bbb')).toBe(swap)
  })

  it('hands back a list that cannot be edited from outside', () => {
    const queue = requestQueue()
    queue.add(transfer)

    queue.list().push(swap)
    expect(queue.size).toBe(1)
  })
})
