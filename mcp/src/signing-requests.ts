import { randomBytes } from 'node:crypto'
import { log } from './log.js'

/**
 * A signature that outlives the tool call that asked for it.
 *
 * Approving happens on a human's schedule. A browser signer is told to come — the tab opens
 * and the badge flashes — but a phone wallet is only as loud as the wallet itself, and some
 * send no notification at all. So the wait routinely outlives whatever timeout the MCP
 * client applies, and the agent is left holding a tool call that never returns while the
 * request is still perfectly alive in the wallet.
 *
 * Each request gets an id and outlives its call. Settling quickly still returns inline, so
 * the common case — a browser tab that pops up and is approved in seconds — is unchanged.
 * Past that the call hands back the id and the agent collects the result later.
 *
 * Held in memory on purpose: a request is only meaningful while the socket or WalletConnect
 * session that carries it is alive, and both die with the process anyway.
 */

/**
 * How long to wait on a signer that has been told to come — the browser page, whose tab
 * opens and whose title flashes. Comfortably under any MCP client's tool timeout.
 *
 * A signer that cannot raise the alarm does not use this at all: it calls `waiting()` the
 * moment the request is with the wallet, and the call returns then. Waiting on a phone that
 * never buzzed is dead time either way.
 */
export const GRACE_MS = 25_000

/** How long a finished result stays collectable. */
const RESULT_TTL = 15 * 60_000

export type SigningState = 'pending' | 'done' | 'failed'

export interface SigningRequest {
  id: string
  identity: string
  /** What is being asked for, in a line, so a later check can say what it was. */
  summary: string
  signer: 'browser' | 'phone'
  /** Waiting on a person, or on the chain. They deserve different things said about them. */
  stage: 'approval' | 'mining'
  /** Known once approved, so a request can be followed on an explorer before it settles. */
  txHash?: string
  startedAt: number
  state: SigningState
  settledAt?: number
  result?: unknown
  error?: string
}

/** How a signing job says where it has got to. */
export interface SigningProgress {
  /**
   * The request is with the wallet and only a human is left. Everything that fails quickly —
   * no session, an unapproved chain, a reverted simulation — has already thrown.
   */
  waiting: () => void
  /** Approved and broadcast. Nothing is settled until it is mined. */
  mining: (txHash: string) => void
}

interface Tracked extends SigningRequest {
  /** Already has a catch attached, so awaiting it again can never be unhandled. */
  settled: Promise<void>
}

const requests = new Map<string, Tracked>()

function sweep(): void {
  const now = Date.now()
  for (const [id, request] of requests) {
    if (request.settledAt && now - request.settledAt > RESULT_TTL) requests.delete(id)
  }
}

function view(request: Tracked): SigningRequest {
  const { settled: _settled, ...rest } = request
  return rest
}

/** Resolves when the request settles, or when the grace runs out — whichever comes first. */
function race(request: Tracked, graceMs: number, handoff?: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs)
    // A request nobody is waiting for must not keep a stdio server alive after its client
    // has gone; shutdown is what ends it.
    timer.unref?.()

    const done = () => {
      clearTimeout(timer)
      resolve()
    }

    request.settled.then(done)
    handoff?.then(done)
  })
}

/**
 * Run a signing request, waiting only as long as a tool call reasonably can.
 *
 * The work starts here either way — returning `done: false` means nobody has approved yet,
 * never that nothing was asked.
 */
export async function signingCall<T>(
  context: { identity: string; summary: string; signer: 'browser' | 'phone'; graceMs?: number },
  run: (progress: SigningProgress) => Promise<T>
): Promise<{ done: true; result: T } | { done: false; request: SigningRequest }> {
  sweep()

  const id = randomBytes(16).toString('hex')

  // Ends the wait: until it is called, a failure is a real error the caller should see
  // rather than something to be collected later.
  let handedOff: () => void
  const handoff = new Promise<void>((resolve) => {
    handedOff = resolve
  })

  // Built before `run` starts, because a signer is free to report progress synchronously.
  const request: Tracked = {
    id,
    identity: context.identity,
    summary: context.summary,
    signer: context.signer,
    stage: 'approval',
    startedAt: Date.now(),
    state: 'pending',
    settled: Promise.resolve()
  }

  // Broadcasting does not end the wait. On a fast chain the receipt is seconds away, and a
  // caller still inside its grace would rather have the mined result than a request id.
  const started = run({
    waiting: () => handedOff(),
    mining: (txHash) => {
      request.stage = 'mining'
      request.txHash = txHash
    }
  })

  request.settled = started.then(
    (result) => {
      request.state = 'done'
      request.result = result
      request.settledAt = Date.now()
    },
    (error: unknown) => {
      request.state = 'failed'
      request.error = error instanceof Error ? error.message : String(error)
      request.settledAt = Date.now()
    }
  )

  requests.set(id, request)
  await race(request, context.graceMs ?? GRACE_MS, handoff)

  if (request.state === 'done') {
    requests.delete(id)
    return { done: true, result: request.result as T }
  }
  if (request.state === 'failed') {
    requests.delete(id)
    throw new Error(request.error)
  }

  log('info', 'Signing', `${context.summary} is still waiting for approval — handed back as ${id.slice(0, 8)}`)
  return { done: false, request: view(request) }
}

/**
 * Collect a request handed back earlier, waiting out another grace period if it is still
 * pending — so an agent that checks in a loop paces itself rather than spinning.
 *
 * Scoped to the caller: an id is unguessable, but on a server carrying several people that
 * is not the reason one of them cannot read another's signature.
 */
export async function collectSigningRequest(id: string, identity: string, graceMs = GRACE_MS): Promise<SigningRequest> {
  sweep()

  const request = requests.get(id)
  if (!request || request.identity !== identity) {
    throw new Error(`No signing request ${id} is waiting. It may have been collected already, or it expired.`)
  }

  if (request.state === 'pending') await race(request, graceMs)
  if (request.state !== 'pending') requests.delete(id)

  return view(request)
}

/** Everything this identity still has in front of a wallet. */
export function pendingSigningRequests(identity: string): SigningRequest[] {
  sweep()
  return [...requests.values()].filter((request) => request.identity === identity && request.state === 'pending').map(view)
}
