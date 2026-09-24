// @ts-check
import { CHAIN_CONFIGS } from './chains.js'

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
    container.innerHTML = history.map((tx) => this.renderItem(tx)).join('')
  }

  renderItem(tx) {
    const date = new Date(tx.timestamp).toLocaleString()
    const statusClass = tx.status || 'pending'
    const explorerUrl = this.getExplorerUrl(tx.chain, tx.hash)

    return `
            <div class="tx-history-item ${statusClass}">
                <div class="tx-history-header">
                    <span class="tx-history-function">${tx.function || 'Transaction'}</span>
                    <span class="tx-history-status ${statusClass}">${statusClass.toUpperCase()}</span>
                </div>
                <div class="tx-history-details">
                    <div>${tx.chain} • ${date}</div>
                    ${tx.contract ? `<div>Contract: ${this.formatAddress(tx.contract)}</div>` : ''}
                </div>
                ${tx.hash ? `<a href="${explorerUrl}" target="_blank" class="tx-history-link">View on Explorer →</a>` : ''}
            </div>
        `
  }

  formatAddress(addr) {
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`
  }

  getExplorerUrl(chainName, txHash) {
    const config = CHAIN_CONFIGS[chainName]
    return config ? `${config.explorer}/tx/${txHash}` : `https://etherscan.io/tx/${txHash}`
  }
}

export const txHistory = new TransactionHistory()
