// @ts-check
import { requireChain } from './chains.js'
import { txHistory } from './history.js'
import { html, render } from './html.js'
import { Request } from './preview.js'
import { requestQueue } from './request-queue.js'
import { state } from './state.js'
import { clearRequestNotice, log, parseError, showStatus } from './ui.js'

/** Everything waiting for approval, and what happens when one is answered. */

export const queue = requestQueue()

/**
 * Everything waiting for approval, newest last.
 *
 * A list rather than one at a time: an agent can have several signatures outstanding, and
 * a single slot meant the second silently replaced the first, which was then never answered
 * at all. Each block owns its request id, and they can be dealt with in any order.
 */
export function renderRequests() {
  const panel = document.getElementById('txPreview')
  const count = document.getElementById('txCount')

  panel.classList.toggle('hidden', queue.size === 0)
  count.textContent = queue.size > 1 ? `${queue.size} awaiting approval` : 'Awaiting approval'
  render(
    html`${queue.list().map((request) => html`<${Request} key=${request.id} request=${request} onApprove=${approveTx} onReject=${rejectTx} />`)}`,
    document.getElementById('txRequests')
  )
}

/** The alert belongs to the list, not to any one request: quiet it only when none are left. */
export function settleNotice() {
  if (queue.size === 0) clearRequestNotice()
}

/**
 * A history row for a request, or nothing at all.
 *
 * Only a transaction belongs there. A signed message moves nothing and has no contract, so
 * recording one produced a row reading as a transfer to nowhere — which is what narrowing
 * this properly turned up.
 *
 * @param {import('../src/protocol.js').TransactionRequest} request
 * @param {'success' | 'failed'} status
 * @param {string} [hash]
 */
function historyEntry(request, status, hash) {
  if (request.type !== 'send_transaction') return null

  return {
    ...(hash && { hash }),
    chain: request.chain,
    function: request.data.data ? 'Contract Call' : 'Transfer',
    contract: request.data.to,
    status
  }
}

/** @param {string} id */
export async function approveTx(id) {
  const request = queue.claim(id)
  renderRequests()
  if (!request) return

  try {
    // Ensure we have account
    if (!state.account) {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' })
      state.account = accounts[0]
    }

    if (!state.account) {
      throw new Error('No account available. Please connect your wallet first.')
    }

    log('Sending transaction...', 'info')
    let result

    if (request.type === 'send_transaction') {
      // eth_sendTransaction carries no chain id: the wallet signs on whatever chain is
      // selected. Without this a transaction previewed for one chain could be broadcast on
      // another, to the same address, where that address is some other contract entirely.
      await requireChain(request.chain)

      const txData = {
        ...request.data,
        from: state.account
      }

      result = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [txData]
      })
    } else if (request.type === 'sign_message') {
      result = await window.ethereum.request({
        method: 'personal_sign',
        params: [request.data.message, state.account]
      })
    } else if (request.type === 'sign_typed_data') {
      result = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [state.account, JSON.stringify(request.data)]
      })
    }

    log(`Transaction successful: ${result}`, 'success')
    showStatus('Success', 'Transaction submitted successfully', 'success')

    const done = historyEntry(request, 'success', result)
    if (done) txHistory.add(done)

    state.ws.send(
      JSON.stringify({
        id: request.id,
        success: true,
        result
      })
    )

    settleNotice()
  } catch (error) {
    const err = parseError(error)
    log(`Transaction failed: ${err.message}`, 'error')
    showStatus(err.title, err.message, err.type)

    // Not a user rejection: that is a decision, not a failure worth recording.
    const rejected = error.message.includes('User rejected') || error.message.includes('User denied')
    const failed = rejected ? null : historyEntry(request, 'failed')
    if (failed) txHistory.add(failed)

    state.ws.send(
      JSON.stringify({
        id: request.id,
        success: false,
        error: error.message
      })
    )

    settleNotice()
  }
}

/** @param {string} id */
export function rejectTx(id) {
  const request = queue.claim(id)
  renderRequests()
  if (!request) return

  log('Transaction rejected by user', 'info')
  showStatus('Rejected', 'Transaction rejected', 'warning')

  // Don't add rejected transactions to history

  state.ws.send(
    JSON.stringify({
      id: request.id,
      success: false,
      error: 'User rejected transaction'
    })
  )

  settleNotice()
}
