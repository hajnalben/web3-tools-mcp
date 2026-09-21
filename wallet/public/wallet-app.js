// State Management
const state = {
  account: null,
  provider: null,
  ws: null,
  currentRequest: null,
  chainId: null,
  chainName: null,
  balance: null
}

// Chain configurations (wallet providers will use their default RPCs)
const CHAIN_CONFIGS = {
  mainnet: { chainId: '0x1', name: 'Ethereum', explorer: 'https://etherscan.io' },
  arbitrum: { chainId: '0xa4b1', name: 'Arbitrum', explorer: 'https://arbiscan.io' },
  avalanche: { chainId: '0xa86a', name: 'Avalanche', explorer: 'https://snowtrace.io' },
  base: { chainId: '0x2105', name: 'Base', explorer: 'https://basescan.org' },
  bnb: { chainId: '0x38', name: 'BNB Chain', explorer: 'https://bscscan.com' },
  gnosis: { chainId: '0x64', name: 'Gnosis', explorer: 'https://gnosisscan.io' },
  sonic: { chainId: '0x92', name: 'Sonic', explorer: 'https://sonicscan.org' },
  optimism: { chainId: '0xa', name: 'Optimism', explorer: 'https://optimistic.etherscan.io' },
  polygon: { chainId: '0x89', name: 'Polygon', explorer: 'https://polygonscan.com' },
  zksync: { chainId: '0x144', name: 'zkSync Era', explorer: 'https://explorer.zksync.io' },
  linea: { chainId: '0xe708', name: 'Linea', explorer: 'https://lineascan.build' },
  unichain: { chainId: '0x82', name: 'Unichain', explorer: 'https://unichain.org' }
}

// Transaction History Manager
class TransactionHistory {
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

const txHistory = new TransactionHistory()

// Error Message Parser
function parseError(error) {
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
const PAGE_TITLE = document.title

/**
 * Pull attention to a pending request. The tab title always works; the desktop
 * notification only if the user granted permission, and clicking it focuses this tab.
 * The MCP server also raises the browser window, which covers the case where neither helps.
 */
function announceRequest(request) {
  document.title = '\u26a0 Transaction request'

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
 * The MCP server no longer raises the browser window (that could only be done by opening a
 * URL, which spawns a stray tab), so a desktop notification is how a backgrounded tab gets
 * noticed. Offered as a button because browsers only grant permission on a real click.
 */
function enableNotifications() {
  if (typeof Notification === 'undefined') return

  Notification.requestPermission()
    .then((permission) => {
      updateNotifyButton()
      if (permission === 'granted') showStatus('Notifications on', 'You will be alerted about transaction requests.', 'success')
      else showStatus('Notifications blocked', 'Requests will still flash in the tab title.', 'warning')
    })
    .catch(() => {})
}

function updateNotifyButton() {
  const button = document.getElementById('notifyBtn')
  if (!button) return
  const askable = typeof Notification !== 'undefined' && Notification.permission === 'default'
  button.classList.toggle('hidden', !askable)
}

function clearRequestNotice() {
  document.title = PAGE_TITLE
}

function showStatus(title, message, type = 'info') {
  const statusEl = document.getElementById('statusMessage')
  statusEl.className = `status ${type}`
  statusEl.innerHTML = `<strong>${title}:</strong> ${message}`
  statusEl.classList.remove('hidden')

  if (type === 'success' || type === 'info') {
    setTimeout(() => statusEl.classList.add('hidden'), 5000)
  }
}

function updateChainBadge(connected = false, chainName = 'Not Connected') {
  const badge = document.getElementById('chainBadge')
  const indicator = badge.querySelector('.chain-indicator')
  const nameSpan = document.getElementById('chainName')

  if (connected) {
    badge.classList.add('connected')
    indicator.classList.add('active')
    nameSpan.textContent = chainName
  } else {
    badge.classList.remove('connected')
    indicator.classList.remove('active')
    nameSpan.textContent = chainName
  }
}

function toggleChainDropdown(event) {
  event.stopPropagation()

  if (!state.account) {
    showStatus('Connect Wallet', 'Please connect your wallet first.', 'warning')
    return
  }

  const badge = document.getElementById('chainBadge')
  const dropdown = document.getElementById('chainDropdown')

  badge.classList.toggle('open')
  dropdown.classList.toggle('show')

  // Populate dropdown if empty
  if (dropdown.children.length === 0) {
    populateChainDropdown()
  }
}

function populateChainDropdown() {
  const dropdown = document.getElementById('chainDropdown')
  dropdown.innerHTML = ''

  Object.entries(CHAIN_CONFIGS).forEach(([key, config]) => {
    const option = document.createElement('div')
    option.className = 'chain-option'
    option.textContent = config.name
    option.onclick = () => selectChain(key)

    // Mark current chain as active
    if (state.chainId === config.chainId) {
      option.classList.add('active')
    }

    dropdown.appendChild(option)
  })
}

async function selectChain(chainName) {
  const dropdown = document.getElementById('chainDropdown')
  const badge = document.getElementById('chainBadge')

  dropdown.classList.remove('show')
  badge.classList.remove('open')

  if (chainName === Object.keys(CHAIN_CONFIGS).find((k) => CHAIN_CONFIGS[k].chainId === state.chainId)) {
    return // Already on this chain
  }

  await switchToChain(chainName)
}

// Close dropdown when clicking outside
document.addEventListener('click', () => {
  const dropdown = document.getElementById('chainDropdown')
  const badge = document.getElementById('chainBadge')
  if (dropdown?.classList.contains('show')) {
    dropdown.classList.remove('show')
    badge.classList.remove('open')
  }
})

function log(message, type = 'info') {
  const logEl = document.getElementById('log')
  const entry = document.createElement('div')
  entry.className = `log-entry ${type}`
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
  logEl.appendChild(entry)
  logEl.scrollTop = logEl.scrollHeight
}

// Wallet Functions

function toggleDarkMode() {
  document.body.classList.toggle('dark-mode')
  localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? 'true' : 'false')
}

// Load dark mode preference on startup
// Priority: localStorage > system preference
const savedDarkMode = localStorage.getItem('darkMode')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const shouldUseDarkMode = savedDarkMode !== null ? savedDarkMode === 'true' : prefersDark

if (shouldUseDarkMode) {
  document.body.classList.add('dark-mode')
  // Save the initial preference if not already saved
  if (savedDarkMode === null) {
    localStorage.setItem('darkMode', 'true')
  }
}

function resolveProvider() {
  // Prioritize Rabby over MetaMask
  if (window.rabby) return { provider: window.rabby, name: 'Rabby' }
  if (!window.ethereum) return null
  if (window.ethereum.isRabby) return { provider: window.ethereum, name: 'Rabby' }
  if (window.ethereum.isMetaMask) return { provider: window.ethereum, name: 'MetaMask' }
  return { provider: window.ethereum, name: 'Web3 Wallet' }
}

// Extensions sometimes inject after `load` fires, so give them a moment before deciding
// that no wallet is installed.
function waitForProvider(timeout = 2000) {
  const found = resolveProvider()
  if (found) return Promise.resolve(found)

  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const provider = resolveProvider()
      if (!provider) return
      clearInterval(poll)
      clearTimeout(giveUp)
      resolve(provider)
    }, 100)

    const giveUp = setTimeout(() => {
      clearInterval(poll)
      resolve(null)
    }, timeout)
  })
}

async function establishConnection({ provider, name }, accounts) {
  state.account = accounts[0]
  state.provider = provider

  if (!window.ethereum) {
    window.ethereum = provider
  }

  log(`Connected to ${name}: ${state.account}`, 'success')

  // Remember the connection so the next page load can restore it without a prompt.
  localStorage.setItem('walletConnected', 'true')
  localStorage.setItem('walletAddress', state.account)

  document.getElementById('connectBtn').classList.add('hidden')

  await updateWalletInfo()
  connectWebSocket()
  txHistory.render()

  if (state.listenersBound) return
  state.listenersBound = true

  provider.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) {
      log('Wallet disconnected', 'error')
      localStorage.removeItem('walletConnected')
      localStorage.removeItem('walletAddress')
      location.reload()
    } else {
      state.account = accounts[0]
      localStorage.setItem('walletAddress', state.account)
      updateWalletInfo()
    }
  })

  provider.on('chainChanged', () => {
    log('Chain changed, reloading...', 'info')
    location.reload()
  })
}

async function connectWallet() {
  const found = await waitForProvider()
  if (!found) {
    showStatus('No Wallet Found', 'Please install Rabby or MetaMask wallet.', 'error')
    return
  }

  try {
    log(`Requesting ${found.name} connection...`, 'info')
    const accounts = await found.provider.request({ method: 'eth_requestAccounts' })
    await establishConnection(found, accounts)
    showStatus('Connected', 'Wallet connected successfully', 'success')

    // Asked here because this is a real user gesture; browsers reject it otherwise.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
        .then(updateNotifyButton)
        .catch(() => {})
    }
  } catch (error) {
    const err = parseError(error)
    log(`Connection failed: ${err.message}`, 'error')
    showStatus(err.title, err.message, err.type)
  }
}

/**
 * Restore a previous connection without prompting. eth_accounts only returns accounts the
 * wallet has already authorised for this origin, so this is silent when the wallet is
 * unlocked and says nothing when it isn't.
 */
async function restoreConnection() {
  const found = await waitForProvider()
  if (!found) return

  try {
    const accounts = await found.provider.request({ method: 'eth_accounts' })

    if (accounts.length > 0) {
      log('Restoring saved wallet connection...', 'info')
      await establishConnection(found, accounts)
      return
    }

    if (localStorage.getItem('walletConnected') === 'true') {
      showStatus('Wallet locked', 'Unlock your wallet, or press Connect wallet.', 'warning')
    }
  } catch (error) {
    log(`Could not restore connection: ${error.message}`, 'error')
  }
}

async function updateWalletInfo() {
  try {
    state.chainId = await window.ethereum.request({ method: 'eth_chainId' })
    const balance = await window.ethereum.request({
      method: 'eth_getBalance',
      params: [state.account, 'latest']
    })

    state.balance = parseInt(balance, 16) / 1e18

    // Find chain name
    state.chainName =
      Object.entries(CHAIN_CONFIGS).find(([_, config]) => config.chainId === state.chainId)?.[1]?.name ||
      `Chain ${parseInt(state.chainId, 16)}`

    // Update UI
    document.getElementById('address').textContent =
      `${state.account.substring(0, 6)}...${state.account.substring(state.account.length - 4)}`
    document.getElementById('networkName').textContent = `${state.chainName} (${parseInt(state.chainId, 16)})`
    document.getElementById('balance').textContent = `${state.balance.toFixed(4)} ETH`
    document.getElementById('walletInfo').classList.remove('hidden')

    updateChainBadge(true, state.chainName)
    reportAccount()
  } catch (error) {
    log(`Failed to update wallet info: ${error.message}`, 'error')
  }
}

// Chain Switching
async function switchToChain(chainName) {
  try {
    const currentChainId = await window.ethereum.request({ method: 'eth_chainId' })
    const targetChain = CHAIN_CONFIGS[chainName]

    if (!targetChain) {
      log(`Unknown chain: ${chainName}`, 'error')
      return
    }

    if (currentChainId === targetChain.chainId) {
      log(`Already on ${targetChain.name}`, 'info')
      return
    }

    log(`Switching to ${targetChain.name}...`, 'info')

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChain.chainId }]
      })
      log(`Switched to ${targetChain.name}`, 'success')
    } catch (switchError) {
      if (switchError.code === 4902) {
        log(`Adding ${targetChain.name} to wallet...`, 'info')
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: targetChain.chainId,
              chainName: targetChain.name
              // Let wallet use its default RPC
            }
          ]
        })
        log(`Added ${targetChain.name}`, 'success')
      } else {
        throw switchError
      }
    }

    await updateWalletInfo()
  } catch (error) {
    const err = parseError(error)
    log(`Failed to switch chain: ${err.message}`, 'error')
    showStatus(err.title, err.message, err.type)
    throw error
  }
}

// Transaction Preview
function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c]
  )
}

function param(name, value, extra = '') {
  return paramHtml(name, esc(value), extra)
}

/** Same row, but the value is already-built HTML (a link). Callers must escape it. */
function paramHtml(name, valueHtml, extra = '') {
  return `<div class="tx-param">
        <span class="tx-param-name">${esc(name)}:</span>
        <span class="tx-param-value">${valueHtml}</span>${extra}
    </div>`
}

function shortAddress(address) {
  return `${address.substring(0, 6)}…${address.substring(address.length - 4)}`
}

/**
 * Address as an explorer link, prefixed with its token symbol or contract name if known.
 * The address stays in full: a truncated one can be forged with a vanity address, and this
 * is the last screen before signing. `short` is for secondary rows where space is tight.
 */
function addressLink(address, label, explorer, short = false) {
  const shown = esc(short ? shortAddress(address) : address)
  const text = label ? `<span class="tx-label">${esc(label)}</span> ${shown}` : shown
  if (!explorer) return text
  return `<a class="tx-link" href="${esc(explorer)}/address/${esc(address)}" target="_blank" rel="noreferrer" title="${esc(address)}">${text}</a>`
}

function renderAssetChanges(changes, explorer) {
  const account = (state.account || '').toLowerCase()

  return changes
    .map((change) => {
      const amount = change.humanAmount ?? change.amount
      const outgoing = change.from.toLowerCase() === account
      const incoming = change.to.toLowerCase() === account
      const direction = outgoing ? 'out' : incoming ? 'in' : 'other'
      const sign = outgoing ? '−' : incoming ? '+' : '↔'
      const other = outgoing ? change.to : change.from

      const token = explorer
        ? `<a class="tx-link" href="${esc(explorer)}/token/${esc(change.token)}" target="_blank" rel="noreferrer" title="${esc(change.token)}">${esc(change.symbol ?? shortAddress(change.token))}</a>`
        : esc(change.symbol ?? shortAddress(change.token))

      return `<div class="tx-asset tx-asset-${direction}">
            <span class="tx-asset-amount">${sign} ${esc(amount)} ${token}</span>
            <span class="tx-asset-party">${outgoing ? 'to' : 'from'} ${addressLink(other, undefined, explorer, true)}</span>
        </div>`
    })
    .join('')
}

function renderSimulation(simulation, explorer) {
  if (!simulation) {
    return `<div class="tx-sim tx-sim-unknown">Not simulated — approve only if you know what this does.</div>`
  }

  if (!simulation.success) {
    return `<div class="tx-sim tx-sim-fail">
            <strong>Simulation reverted</strong>
            <div>${esc(simulation.error || 'execution reverted')}</div>
            <div>This transaction will very likely fail and still cost gas.</div>
        </div>`
  }

  const changes = simulation.assetChanges?.length
    ? `<div class="tx-assets">${renderAssetChanges(simulation.assetChanges, explorer)}</div>`
    : `<div class="tx-sim-note">No token transfers detected.</div>`

  return `<div class="tx-sim tx-sim-ok">
        <strong>Simulation succeeded</strong>${simulation.gasEstimate ? ` · ${esc(simulation.gasEstimate)} gas` : ''}
        ${changes}
    </div>`
}

function renderTransactionPreview(request) {
  const details = document.getElementById('txDetails')
  const approveBtn = document.getElementById('approveBtn')
  const data = request.data
  const preview = request.preview

  let html = ''

  if (request.type === 'send_transaction') {
    const decoded = preview?.decoded

    if (decoded) {
      // The registry says what the call means ("Supply"); the function name is the detail.
      const headline = decoded.intent || decoded.functionName
      const detail = decoded.intent ? decoded.functionName : ''

      html += `<div class="tx-intent">${esc(headline)}
                ${decoded.protocol ? `<span class="tx-protocol">${esc(decoded.protocol)}</span>` : ''}
                <span class="tx-source tx-source-${esc(decoded.source)}">${decoded.source === 'verified' ? 'verified ABI' : 'ABI guessed from bytecode'}</span>
                ${detail ? `<span class="tx-fn">${esc(detail)}()</span>` : ''}
            </div>`
    }

    const explorer = preview?.explorer

    html += paramHtml('Contract', addressLink(data.to, preview?.toLabel, explorer))
    if (decoded?.proxy) html += paramHtml('Implementation', addressLink(decoded.proxy, undefined, explorer))

    if (data.value && data.value !== '0x0') {
      html += param('Value', `${preview?.valueFormatted ?? parseInt(data.value, 16) / 1e18} ${state.chainName || 'native'}`)
    }

    if (decoded) {
      for (const field of decoded.fields) {
        const warning = field.warning ? `<span class="tx-warning">⚠ ${esc(field.warning)}</span>` : ''
        html += field.address
          ? paramHtml(field.name, addressLink(field.address, field.label, explorer), warning)
          : param(field.name, field.value, warning)
      }
    } else if (data.data && data.data !== '0x') {
      html += param('Data', `${data.data.substring(0, 66)}${data.data.length > 66 ? '…' : ''}`)
    }

    html += renderSimulation(preview?.simulation, explorer)

    const failed = preview?.simulation && !preview.simulation.success
    approveBtn.textContent = failed ? '⚠ Approve anyway' : '✓ Approve & Sign'
    approveBtn.classList.toggle('btn-danger', Boolean(failed))
  } else if (request.type === 'sign_message') {
    html += param('Message', data.message)
    approveBtn.textContent = '✓ Approve & Sign'
    approveBtn.classList.remove('btn-danger')
  }

  details.innerHTML = html
}

// WebSocket Connection
// The pairing token arrives in the URL fragment and stays there on purpose: the MCP server
// raises this tab by asking the OS to open its URL, and the browser only matches a tab by
// its exact URL. Stripping the fragment made every such request open a second, unpaired tab
// (sessionStorage is per-tab, so the new one has no token to fall back on).
function getRelayToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
  if (fromHash) {
    sessionStorage.setItem('relayToken', fromHash)
    return fromHash
  }
  return sessionStorage.getItem('relayToken')
}

function reportAccount() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'status', address: state.account, url: location.href }))
  }
}

function connectWebSocket() {
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
      const message = JSON.parse(event.data)
      if (message.type === 'ready') return

      state.currentRequest = message
      log(`Received ${state.currentRequest.type} request on ${state.currentRequest.chain}`, 'info')

      // Switch chain if needed
      if (state.currentRequest.chain && state.currentRequest.chain !== 'any') {
        await switchToChain(state.currentRequest.chain)
      }

      // Show transaction preview
      renderTransactionPreview(state.currentRequest)
      document.getElementById('txPreview').classList.remove('hidden')
      showStatus('Pending', 'Transaction waiting for approval', 'warning')
      announceRequest(state.currentRequest)
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

// Transaction Actions
async function approveTx() {
  if (!state.currentRequest) return

  // Prevent double submission - clear current request immediately
  const request = state.currentRequest
  state.currentRequest = null

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

    // Add to history
    txHistory.add({
      hash: result,
      chain: request.chain,
      function: request.data.data ? 'Contract Call' : 'Transfer',
      contract: request.data.to,
      status: 'success'
    })

    state.ws.send(
      JSON.stringify({
        id: request.id,
        success: true,
        result
      })
    )

    document.getElementById('txPreview').classList.add('hidden')
    clearRequestNotice()
  } catch (error) {
    const err = parseError(error)
    log(`Transaction failed: ${err.message}`, 'error')
    showStatus(err.title, err.message, err.type)

    // Add to history as failed (unless it was a user rejection)
    if (!error.message.includes('User rejected') && !error.message.includes('User denied')) {
      txHistory.add({
        chain: request.chain,
        function: request.data.data ? 'Contract Call' : 'Transfer',
        contract: request.data.to,
        status: 'failed'
      })
    }

    state.ws.send(
      JSON.stringify({
        id: request.id,
        success: false,
        error: error.message
      })
    )

    document.getElementById('txPreview').classList.add('hidden')
    clearRequestNotice()
    state.currentRequest = null
  }
}

function rejectTx() {
  if (!state.currentRequest) return

  log('Transaction rejected by user', 'info')
  showStatus('Rejected', 'Transaction rejected', 'warning')

  // Don't add rejected transactions to history

  state.ws.send(
    JSON.stringify({
      id: state.currentRequest.id,
      success: false,
      error: 'User rejected transaction'
    })
  )

  document.getElementById('txPreview').classList.add('hidden')
  clearRequestNotice()
  state.currentRequest = null
}

// Auto-connect on load
window.addEventListener('load', async () => {
  // Attach before the wallet is connected, so the MCP server knows this tab exists and
  // doesn't open another one.
  connectWebSocket()
  updateNotifyButton()
  await restoreConnection()
  txHistory.render()
})
