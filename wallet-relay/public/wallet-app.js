// @ts-check
import { toggleChainDropdown } from './chains.js'
import { txHistory } from './history.js'
import { connectWebSocket } from './relay.js'
import { enableNotifications, refreshFavicon, updateNotifyButton } from './ui.js'
import { connectWallet, restoreConnection, toggleDarkMode } from './wallet.js'

/**
 * The wiring. Everything else is a module of its own, so this file is only the order things
 * happen in and which button does what.
 */

// Here rather than in onclick attributes: the page's CSP allows no inline script.
document.getElementById('chainBadge').addEventListener('click', toggleChainDropdown)
document.getElementById('chainDropdown').addEventListener('click', (event) => event.stopPropagation())
document.getElementById('notifyBtn').addEventListener('click', enableNotifications)
document.getElementById('themeBtn').addEventListener('click', toggleDarkMode)
document.getElementById('connectBtn').addEventListener('click', connectWallet)

window.addEventListener('load', async () => {
  // Attach before the wallet is connected, so the MCP server knows this tab exists and
  // doesn't open another one.
  connectWebSocket()
  // Give the tab an icon of its own, so the pending badge has something to revert to.
  refreshFavicon()
  updateNotifyButton()
  await restoreConnection()
  txHistory.render()
})
