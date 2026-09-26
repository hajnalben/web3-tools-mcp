// @ts-check
import { CHAIN_CONFIGS } from './chains.js'
import { html, render } from './html.js'

/** What this browser has signed before, kept in localStorage purely to show the user. */

// Transaction History Manager
export class TransactionHistory {
  constructor() {
    this.storageKey = 'web3_tx_history'
    this.maxItems = 20
  }

  getAll() {
    try {
      const data = localStorage.getItem(this.storageKey)
      return data ? JSON.parse(data) : []
    } catch (e) {
      console.error('Failed to load transaction history:', e)
      return []
    }
  }

  add(tx) {
    const history = this.getAll()
    history.unshift({
      ...tx,
      timestamp: Date.now()
    })

    // Keep only recent transactions
    if (history.length > this.maxItems) {
      history.length = this.maxItems
    }

    localStorage.setItem(this.storageKey, JSON.stringify(history))
    this.render()
  }

  render() {
    const history = this.getAll()
    const container = document.getElementById('txHistoryList')
    const historySection = document.getElementById('txHistory')

    if (history.length === 0) {
      historySection.classList.add('hidden')
      return
    }

    historySection.classList.remove('hidden')
    // Rendered as components: every field here came from a signing request, and was kept in
    // storage any other script on this origin could have written to.
    render(html`${history.map((tx) => this.renderItem(tx))}`, container)
  }

  renderItem(tx) {
    const date = new Date(tx.timestamp).toLocaleString()
    const statusClass = tx.status === 'success' || tx.status === 'failed' ? tx.status : 'pending'
    const explorer = CHAIN_CONFIGS[tx.chain]?.explorer

    return html`<div class=${`tx-history-item ${statusClass}`}>
      <div class="tx-history-header">
        <span class="tx-history-function">${tx.function || 'Transaction'}</span>
        <span class=${`tx-history-status ${statusClass}`}>${statusClass.toUpperCase()}</span>
      </div>
      <div class="tx-history-details">
        <div>${tx.chain} • ${date}</div>
        ${typeof tx.contract === 'string' && html`<div>Contract: ${this.formatAddress(tx.contract)}</div>`}
      </div>
      ${
        typeof tx.hash === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(tx.hash) &&
        explorer &&
        html`<a href=${`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer" class="tx-history-link">View on Explorer →</a>`
      }
    </div>`
  }

  formatAddress(addr) {
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`
  }
}

export const txHistory = new TransactionHistory()
