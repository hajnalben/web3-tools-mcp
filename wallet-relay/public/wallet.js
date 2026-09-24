// @ts-check
import { CHAIN_CONFIGS, updateChainBadge } from './chains.js'
import { txHistory } from './history.js'
import { connectWebSocket, reportAccount } from './relay.js'
import { state } from './state.js'
import { log, parseError, refreshFavicon, showStatus, updateNotifyButton } from './ui.js'

/** Finding a browser wallet, connecting to it, and keeping what it says up to date. */

// Wallet Functions

export function toggleDarkMode() {
  document.body.classList.toggle('dark-mode')
  localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? 'true' : 'false')
  // The accent differs between themes and the badge is drawn from it.
  refreshFavicon()
}

// Load dark mode preference on startup
// Priority: localStorage > system preference
export const savedDarkMode = localStorage.getItem('darkMode')
export const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
export const shouldUseDarkMode = savedDarkMode !== null ? savedDarkMode === 'true' : prefersDark

if (shouldUseDarkMode) {
  document.body.classList.add('dark-mode')
  // Save the initial preference if not already saved
  if (savedDarkMode === null) {
    localStorage.setItem('darkMode', 'true')
  }
}

export function resolveProvider() {
  // Prioritize Rabby over MetaMask
  if (window.rabby) return { provider: window.rabby, name: 'Rabby' }
  if (!window.ethereum) return null
  if (window.ethereum.isRabby) return { provider: window.ethereum, name: 'Rabby' }
  if (window.ethereum.isMetaMask) return { provider: window.ethereum, name: 'MetaMask' }
  return { provider: window.ethereum, name: 'Web3 Wallet' }
}

// Extensions sometimes inject after `load` fires, so give them a moment before deciding
// that no wallet is installed.
export function waitForProvider(timeout = 2000) {
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

export async function establishConnection({ provider, name }, accounts) {
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
    // Never reload here. This fires in the middle of switching for a request, and a reload
    // drops the relay socket and the pending request with it. updateWalletInfo re-reads
    // everything the chain affects, which is all a reload ever bought.
    log('Chain changed', 'info')
    updateWalletInfo()
  })
}

export async function connectWallet() {
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
export async function restoreConnection() {
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

export async function updateWalletInfo() {
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
