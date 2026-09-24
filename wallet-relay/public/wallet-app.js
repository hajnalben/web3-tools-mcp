// @ts-check
import { toggleChainDropdown } from './chains.js'
import { txHistory } from './history.js'
import { connectWebSocket } from './relay.js'
import { enableNotifications, refreshFavicon, updateNotifyButton } from './ui.js'
import { connectWallet, restoreConnection, toggleDarkMode } from './wallet.js'

/**
 * The wiring. Everything else is a module of its own, so this file is only the order things
 * happen in and the handful of names the page's onclick attributes reach for.
 */

// A module has no globals, and the page wires these four from onclick attributes.
Object.assign(window, { connectWallet, enableNotifications, toggleChainDropdown, toggleDarkMode })

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
