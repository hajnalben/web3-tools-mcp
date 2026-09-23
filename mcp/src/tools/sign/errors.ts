import { log } from '../../log.js'
import { formatResponse } from '../../utils.js'

/**
 * WalletConnect rejects with a plain `{ code, message }` rather than an Error, which
 * String() renders as "[object Object]" — the reason a wallet gave for refusing is the
 * whole point of the message, so dig it out.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const { message, code, reason } = error as { message?: string; code?: number; reason?: string }
    const text = message ?? reason
    if (text) return code === undefined ? text : `${text} (code ${code})`
    return JSON.stringify(error)
  }
  return String(error)
}

/** A refused or failed signing attempt, reported to the caller and to the log alike. */
export function failure(error: unknown, message: string) {
  log('warning', 'Transaction', `${message} — ${describeError(error)}`)
  return formatResponse({
    success: false,
    error: describeError(error),
    message
  })
}
