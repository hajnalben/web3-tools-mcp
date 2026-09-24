// @ts-check

/**
 * What this page knows about the wallet it is connected to. Mutated in place; read anywhere.
 *
 * @typedef {object} PageState
 * @property {string | null} account
 * @property {import('../types/eip1193.js').Eip1193Provider | null} provider
 * @property {WebSocket | null} ws
 * @property {string | null} chainId
 * @property {string | null} chainName
 * @property {number | null} balance
 * @property {boolean} [listenersBound]
 */

/** @type {PageState} */
export const state = {
  account: null,
  provider: null,
  ws: null,
  chainId: null,
  chainName: null,
  balance: null
}
