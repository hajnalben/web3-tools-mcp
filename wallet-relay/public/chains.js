// @ts-check
import { state } from './state.js'
import { log, parseError, showStatus } from './ui.js'
import { updateWalletInfo } from './wallet.js'

/** The chains this page can put a wallet on, and everything about getting it there. */

// Chain configurations (wallet providers will use their default RPCs)
export const CHAIN_CONFIGS = {
  mainnet: { chainId: '0x1', name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
  arbitrum: { chainId: '0xa4b1', name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbiscan.io' },
  avalanche: { chainId: '0xa86a', name: 'Avalanche', symbol: 'AVAX', explorer: 'https://snowtrace.io' },
  base: { chainId: '0x2105', name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
  bnb: { chainId: '0x38', name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
  gnosis: { chainId: '0x64', name: 'Gnosis', symbol: 'xDAI', explorer: 'https://gnosisscan.io' },
  sonic: { chainId: '0x92', name: 'Sonic', symbol: 'S', explorer: 'https://sonicscan.org' },
  optimism: { chainId: '0xa', name: 'Optimism', symbol: 'ETH', explorer: 'https://optimistic.etherscan.io' },
  polygon: { chainId: '0x89', name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
  zksync: { chainId: '0x144', name: 'zkSync Era', symbol: 'ETH', explorer: 'https://explorer.zksync.io' },
  linea: { chainId: '0xe708', name: 'Linea', symbol: 'ETH', explorer: 'https://lineascan.build' },
  unichain: { chainId: '0x82', name: 'Unichain', symbol: 'ETH', explorer: 'https://uniscan.xyz' },
  // A wallet has no default RPC for a local node, so adding it needs one.
  localhost: { chainId: '0x7a69', name: 'Localhost', symbol: 'ETH', rpc: 'http://127.0.0.1:8545' }
}

export function updateChainBadge(connected = false, chainName = 'Not Connected') {
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

export function toggleChainDropdown(event) {
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

export function populateChainDropdown() {
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

export async function selectChain(chainName) {
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

// Chain Switching
export async function switchToChain(chainName) {
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
              chainName: targetChain.name,
              nativeCurrency: { name: targetChain.symbol, symbol: targetChain.symbol, decimals: 18 },
              // Otherwise let the wallet use its default RPC
              ...(targetChain.rpc && { rpcUrls: [targetChain.rpc] })
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

// Transaction Actions
/** Put the wallet on the chain a request names, and refuse to sign if it will not go. */
export async function requireChain(chainName) {
  const target = CHAIN_CONFIGS[chainName]
  if (!target) throw new Error(`This page does not know the chain "${chainName}", so it cannot check the wallet is on it.`)

  if ((await window.ethereum.request({ method: 'eth_chainId' })) === target.chainId) return

  log(`Switching to ${target.name}...`, 'info')
  await switchToChain(chainName)

  // Trust the wallet's answer, not the switch call resolving: some wallets resolve early.
  if ((await window.ethereum.request({ method: 'eth_chainId' })) !== target.chainId) {
    throw new Error(`Wallet is not on ${target.name}. Switch to it and approve again.`)
  }
}
