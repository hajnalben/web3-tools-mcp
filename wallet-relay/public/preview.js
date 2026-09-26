// @ts-check
import { CHAIN_CONFIGS } from './chains.js'
import { html } from './html.js'
import { state } from './state.js'

/** The read-only half: components only, so what is rendered can be reasoned about alone. */

// Transaction Preview
//
// Built as components rather than concatenated HTML. Everything on this screen — contract
// labels, decoded field names, revert strings — arrives from whoever asked for the
// signature, and a single missed escape would be script injection into the page holding the
// keys. Interpolating a value here makes it text; there is no way to spell it that doesn't.

export function Param({ name, children, extra }) {
  return html`<div class="tx-param">
    <span class="tx-param-name">${name}:</span>
    <span class="tx-param-value">${children}</span>${extra}
  </div>`
}

export function shortAddress(address) {
  return `${address.substring(0, 6)}…${address.substring(address.length - 4)}`
}

/**
 * Address as an explorer link, prefixed with its token symbol or contract name if known.
 * The address stays in full: a truncated one can be forged with a vanity address, and this
 * is the last screen before signing. `short` is for secondary rows where space is tight.
 */
export function AddressLink({ address, label, explorer, short }) {
  const shown = short ? shortAddress(address) : address
  const text = label ? html`<span class="tx-label">${label}</span> ${shown}` : shown
  if (!explorer) return text

  return html`<a class="tx-link" href=${`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title=${address}>
    ${text}
  </a>`
}

export function AssetChange({ change, explorer }) {
  const account = (state.account || '').toLowerCase()
  const amount = change.tokenId !== undefined ? `#${change.tokenId}` : (change.humanAmount ?? change.amount)
  const outgoing = change.from.toLowerCase() === account
  const incoming = change.to.toLowerCase() === account
  const direction = outgoing ? 'out' : incoming ? 'in' : 'other'
  const sign = outgoing ? '−' : incoming ? '+' : '↔'
  const other = outgoing ? change.to : change.from
  const symbol = change.symbol ?? shortAddress(change.token)

  const token = explorer
    ? html`<a class="tx-link" href=${`${explorer}/token/${change.token}`} target="_blank" rel="noreferrer" title=${change.token}>
        ${symbol}
      </a>`
    : symbol

  return html`<div class=${`tx-asset tx-asset-${direction}`}>
    <span class="tx-asset-amount">${sign} ${amount} ${token}</span>
    <span class="tx-asset-party">
      ${outgoing ? 'to' : 'from'} <${AddressLink} address=${other} explorer=${explorer} short />
    </span>
  </div>`
}

export function Simulation({ simulation, explorer }) {
  if (!simulation) {
    return html`<div class="tx-sim tx-sim-unknown">Not simulated — approve only if you know what this does.</div>`
  }

  if (!simulation.success) {
    return html`<div class="tx-sim tx-sim-fail">
      <strong>Simulation reverted</strong>
      <div>${simulation.error || 'execution reverted'}</div>
      <div>This transaction will very likely fail and still cost gas.</div>
    </div>`
  }

  return html`<div class="tx-sim tx-sim-ok">
    <strong>Simulation succeeded</strong>${simulation.gasEstimate ? ` · ${simulation.gasEstimate} gas` : ''}
    ${
      simulation.assetChanges?.length
        ? html`<div class="tx-assets">
            ${simulation.assetChanges.map((change) => html`<${AssetChange} change=${change} explorer=${explorer} />`)}
          </div>`
        : html`<div class="tx-sim-note">No token transfers detected.</div>`
    }
  </div>`
}

/**
 * Exact native amount from the transaction's own value, in wei.
 *
 * Never taken from the preview: that is supplied by whoever sent the request, and the
 * amount is the one field a hostile requester would most want to misstate.
 */
export function nativeAmount(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return String(value)
  const wei = BigInt(value)
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${wei / 10n ** 18n}.${fraction}` : `${wei / 10n ** 18n}`
}

/**
 * The message as personal_sign takes it: 0x-hex of its bytes. A server older than that
 * convention sends plain text, which is encoded here rather than left to each wallet's guess.
 *
 * @param {string} message
 */
export function messageHex(message) {
  if (/^0x([0-9a-fA-F]{2})*$/.test(message)) return message
  return `0x${[...new TextEncoder().encode(message)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * What the user reads before signing: the text the bytes spell, or the hex itself when they
 * are not UTF-8, so nothing unreadable is dressed up as something readable.
 *
 * @param {string} message
 */
export function messageText(message) {
  const hex = messageHex(message)
  const bytes = new Uint8Array((hex.length - 2) / 2).map((_, i) => parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return hex
  }
}

export function Request({ request, onApprove, onReject }) {
  const failed = request.preview?.simulation && !request.preview.simulation.success

  return html`<article class="tx-request">
    <div class="tx-details"><${RequestDetails} request=${request} /></div>
    <div class="tx-actions">
      <button type="button" class=${`btn-approve${failed ? ' btn-danger' : ''}`} onClick=${() => onApprove(request.id)}>
        ${failed ? '⚠ Approve anyway' : '✓ Approve & sign'}
      </button>
      <button type="button" class="btn-reject" onClick=${() => onReject(request.id)}>Reject</button>
    </div>
  </article>`
}

export function RequestDetails({ request }) {
  const data = request.data
  const preview = request.preview
  // From this page, never the request: an explorer the requester names could be any URL.
  const chain = CHAIN_CONFIGS[request.chain]

  if (request.type === 'sign_message') return html`<${Param} name="Message">${messageText(data.message)}<//>`
  if (request.type !== 'send_transaction') return null

  const decoded = preview?.decoded
  const explorer = chain?.explorer

  return html`
    <${Param} name="Chain">${chain?.name ?? request.chain}<//>

    ${
      decoded &&
      // The registry says what the call means ("Supply"); the function name is the detail.
      html`<div class="tx-intent">
        ${decoded.intent || decoded.functionName}
        ${decoded.protocol && html`<span class="tx-protocol">${decoded.protocol}</span>`}
        <span class=${`tx-source tx-source-${decoded.source}`}>
          ${decoded.source === 'verified' ? 'verified ABI' : 'ABI guessed from bytecode'}
        </span>
        ${decoded.intent && html`<span class="tx-fn">${decoded.functionName}()</span>`}
      </div>`
    }

    <${Param} name="Contract">
      <${AddressLink} address=${data.to} label=${preview?.toLabel} explorer=${explorer} />
    <//>

    ${
      decoded?.proxy &&
      html`<${Param} name="Implementation">
        <${AddressLink} address=${decoded.proxy} explorer=${explorer} />
      <//>`
    }

    ${
      data.value &&
      data.value !== '0x0' &&
      html`<${Param} name="Value">${nativeAmount(data.value)} ${chain?.symbol ?? 'native'}<//>`
    }

    ${(decoded?.fields ?? []).map(
      (field) => html`
        <${Param} name=${field.name} extra=${field.warning && html`<span class="tx-warning">⚠ ${field.warning}</span>`}>
          ${field.address ? html`<${AddressLink} address=${field.address} label=${field.label} explorer=${explorer} />` : field.value}
        <//>`
    )}

    ${
      // Shown even when decoded: the decoding above describes the call, but it arrives with
      // the request rather than being derived here, so the bytes that will actually be signed
      // stay on screen beside it. The first four bytes are the selector.
      data.data &&
      data.data !== '0x' &&
      html`<${Param} name="Calldata">${data.data.substring(0, 66)}${data.data.length > 66 ? '…' : ''}<//>`
    }

    <${Simulation} simulation=${preview?.simulation} explorer=${explorer} />
  `
}
