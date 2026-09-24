// @ts-check
import { html, render } from './html.js'

/**
 * Telling the user something, and getting their attention when it matters.
 *
 * Nothing here can rely on the server: hosted, it is on another machine and cannot raise
 * your window. So the page does what it can by itself.
 */

// Error Message Parser
export function parseError(error) {
  const message = error.message || String(error)

  // User rejected
  if (message.includes('User rejected') || message.includes('User denied')) {
    return {
      title: 'Transaction Rejected',
      message: 'You rejected the transaction in your wallet.',
      type: 'warning'
    }
  }

  // Insufficient funds
  if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
    return {
      title: 'Insufficient Balance',
      message: 'Your wallet does not have enough funds to complete this transaction. Please add funds and try again.',
      type: 'error'
    }
  }

  // Gas estimation failed
  if (message.includes('gas') && message.includes('estimation')) {
    return {
      title: 'Gas Estimation Failed',
      message: 'Unable to estimate gas for this transaction. The transaction may fail or the contract may have restrictions.',
      type: 'error'
    }
  }

  // Network error
  if (message.includes('network') || message.includes('connection')) {
    return {
      title: 'Network Error',
      message: 'Failed to connect to the network. Please check your internet connection and try again.',
      type: 'error'
    }
  }

  // Chain mismatch
  if (message.includes('chain')) {
    return {
      title: 'Wrong Network',
      message: 'Please switch to the correct network in your wallet.',
      type: 'warning'
    }
  }

  // Default
  return {
    title: 'Transaction Failed',
    message: message.length > 100 ? `${message.substring(0, 100)}...` : message,
    type: 'error'
  }
}

// UI Functions
export const PAGE_TITLE = document.title

export const ALERT_TITLE = '\u26a0 Transaction request'
export const favicon = (fill) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${fill}"/></svg>`)}`

// Two real icons rather than one that gets removed: taking the <link> away leaves whatever
// was last drawn sitting in the tab, so the badge outlived the request it announced.
export const IDLE_FAVICON = favicon('#3856d6')
export const ALERT_FAVICON = favicon('#e8a33d')

export let flashTimer = null

export function setFavicon(href) {
  let link = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel="icon"]'))
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = href
}

/**
 * A title that merely changes is easy to miss in a strip of tabs, so it alternates until
 * the request is dealt with. Flashing stops once the tab is actually looked at — the badge
 * stays, since the request is still pending.
 */
export function startFlashing() {
  stopFlashing()
  let showing = false
  flashTimer = setInterval(() => {
    showing = !showing
    // Both phases read as pending on purpose. A hidden tab has its timers throttled — to
    // once a minute after a while — so a cycle that dipped back to the idle title could
    // park there, advertising nothing at the moment it matters most.
    document.title = showing ? ALERT_TITLE : `\u25cf ${PAGE_TITLE}`
  }, 900)
}

export function stopFlashing() {
  if (flashTimer) clearInterval(flashTimer)
  flashTimer = null
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !flashTimer) return
  stopFlashing()
  document.title = ALERT_TITLE
})

/**
 * Pull attention to a pending request.
 *
 * Nothing here can rely on the server: hosted, it is on another machine and cannot raise
 * your window. So the page does what it can by itself — a flashing title and a badged
 * favicon, which need no permission — and a desktop notification when one was granted.
 */
export function announceRequest(request) {
  document.title = ALERT_TITLE
  startFlashing()
  setFavicon(ALERT_FAVICON)
  navigator.vibrate?.([200, 100, 200])

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

  const decoded = request.preview?.decoded
  const body = decoded ? `${decoded.functionName} on ${request.chain}` : `${request.type.replace(/_/g, ' ')} on ${request.chain}`

  try {
    const notification = new Notification('Transaction request', { body, tag: 'web3-tools-tx' })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch (error) {
    console.error('Notification failed:', error)
  }
}

/**
 * The only cue that survives a minimised window. Offered as a button because browsers grant
 * the permission on a real click, and it matters most against a hosted server, which has no
 * way to reach your desktop at all.
 */
export function enableNotifications() {
  if (typeof Notification === 'undefined') return

  Notification.requestPermission()
    .then((permission) => {
      updateNotifyButton()
      if (permission === 'granted') showStatus('Notifications on', 'You will be alerted about transaction requests.', 'success')
      else showStatus('Notifications blocked', 'Requests will still flash in the tab title.', 'warning')
    })
    .catch(() => {})
}

export function updateNotifyButton() {
  const button = document.getElementById('notifyBtn')
  if (!button) return
  const askable = typeof Notification !== 'undefined' && Notification.permission === 'default'
  button.classList.toggle('hidden', !askable)
}

export function clearRequestNotice() {
  stopFlashing()
  setFavicon(IDLE_FAVICON)
  document.title = PAGE_TITLE
}

export function showStatus(title, message, type = 'info') {
  const statusEl = document.getElementById('statusMessage')
  statusEl.className = `status ${type}`
  // Rendered, not concatenated: `message` is often a wallet or RPC error, and a revert
  // string is chosen by the contract being called.
  render(html`<strong>${title}:</strong> ${message}`, statusEl)
  statusEl.classList.remove('hidden')

  if (type === 'success' || type === 'info') {
    setTimeout(() => statusEl.classList.add('hidden'), 5000)
  }
}

export function log(message, type = 'info') {
  const logEl = document.getElementById('log')
  const entry = document.createElement('div')
  entry.className = `log-entry ${type}`
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
  logEl.appendChild(entry)
  logEl.scrollTop = logEl.scrollHeight
}
