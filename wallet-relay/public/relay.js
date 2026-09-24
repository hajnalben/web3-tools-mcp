// @ts-check
import { switchToChain } from './chains.js'
import { queue, renderRequests } from './requests.js'
import { state } from './state.js'
import { announceRequest, log, parseError, showStatus } from './ui.js'

/** The socket to the MCP server, over which signing requests arrive. */

// WebSocket Connection
// The pairing token arrives in the URL fragment and stays there on purpose: the MCP server
// raises this tab by asking the OS to open its URL, and the browser only matches a tab by
// its exact URL. Stripping the fragment made every such request open a second, unpaired tab
// (sessionStorage is per-tab, so the new one has no token to fall back on).
export function getRelayToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
  if (fromHash) {
    sessionStorage.setItem('relayToken', fromHash)
    return fromHash
  }
  return sessionStorage.getItem('relayToken')
}

export function reportAccount() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'status', address: state.account, url: location.href }))
  }
}

export function connectWebSocket() {
  const token = getRelayToken()
  if (!token) {
    log('No pairing token in URL', 'error')
    showStatus('Not paired', 'Open the wallet link printed by the MCP server — it carries the pairing token.', 'error')
    return
  }

  // Already attached (or attaching) — reconnecting would only churn the relay's view.
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    reportAccount()
    return
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  state.ws = new WebSocket(`${protocol}//${location.host}`)

  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({ token, role: 'signer', address: state.account, url: location.href }))
    log('WebSocket connected', 'success')
    showStatus('Ready', 'Ready to sign transactions', 'success')
  }

  state.ws.onmessage = async (event) => {
    try {
      /** @type {import('../src/protocol.js').TransactionRequest | import('../src/protocol.js').ReadyMessage} */
      const message = JSON.parse(event.data)
      if (message.type === 'ready') return

      queue.add(message)
      log(`Received ${message.type} request on ${message.chain}`, 'info')

      // Announce before anything that can block. Switching chains opens a wallet popup,
      // and in a background tab nobody sees it — so waiting for it first meant the alert
      // that exists to fetch you never fired until you came back of your own accord.
      renderRequests()
      showStatus('Pending', 'Transaction waiting for approval', 'warning')
      announceRequest(message)

      // Only when it is the one thing waiting. With others on screen the user is choosing
      // which to deal with, and lining the wallet up for an arrival they have not looked at
      // yet would throw a popup over the one they are reading. Approving switches anyway.
      if (queue.size === 1 && message.chain && message.chain !== 'any') {
        await switchToChain(message.chain).catch((error) => {
          log(`Could not switch chain yet: ${parseError(error).message}`, 'warn')
        })
      }
    } catch (error) {
      const err = parseError(error)
      log(`Error handling message: ${err.message}`, 'error')
      showStatus(err.title, err.message, err.type)
    }
  }

  state.ws.onerror = (error) => {
    log('WebSocket error', 'error')
    console.error(error)
  }

  state.ws.onclose = (event) => {
    // 4001 = relay rejected the handshake; retrying with the same token is pointless.
    if (event.code === 4001) {
      sessionStorage.removeItem('relayToken')
      log(`Relay rejected this connection: ${event.reason}`, 'error')
      showStatus('Not paired', 'The pairing token was rejected. Reopen the wallet link from the MCP server.', 'error')
      return
    }

    log('WebSocket disconnected', 'error')
    showStatus('Disconnected', 'Connection to server lost. Reconnecting...', 'error')
    setTimeout(connectWebSocket, 3000)
  }
}
