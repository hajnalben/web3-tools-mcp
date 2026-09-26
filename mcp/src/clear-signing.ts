import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { formatUnits, getAddress, isAddress } from 'viem'
import { addressLabel, tokenMeta, UNLIMITED_THRESHOLD } from './chain-meta.js'
import { getClientManager } from './client.js'
import type { ChainName } from './types.js'

/**
 * Clear signing from the Ledger ERC-7730 registry: for a known contract and selector it
 * says what the transaction *means* ("Swap", "Approve spending") and labels each field the
 * way the protocol intends, instead of showing raw ABI argument names.
 *
 * The index is built from the registry by scripts/build-erc7730-index.mjs.
 */

interface IndexField {
  // A handful of registry descriptors omit these, so nothing here is guaranteed.
  label?: string
  path?: string
  format?: string
  /** tokenAmount: `tokenPath` points at the field holding the token address. */
  params?: { tokenPath?: string; tokenAddress?: string; [k: string]: unknown }
}

interface IndexSelector {
  name: string
  intent: string
  /** Full signature, needed to ABI-decode the calldata these paths address. */
  signature?: string
  fields: IndexField[]
}

interface IndexEntry {
  protocol: string
  chainIds: number[]
  selectors: Record<string, IndexSelector>
}

export interface ClearSigningField {
  label: string
  format: string
  value: string
  address?: string
  name?: string
}

export interface ClearSigningInfo {
  protocol: string
  intent: string
  functionName: string
  fields: ClearSigningField[]
}

// Prettier names for registry directory slugs; unknown ones read fine as-is.
const PROTOCOL_LABELS: Record<string, string> = {
  lifi: 'LI.FI',
  '1inch': '1inch',
  uniswap: 'Uniswap',
  paraswap: 'ParaSwap',
  cowswap: 'CoW Swap',
  '0x': '0x Protocol',
  aave: 'Aave',
  morpho: 'Morpho',
  safe: 'Safe',
  lido: 'Lido',
  eigenlayer: 'EigenLayer',
  ens: 'ENS'
}

const require = createRequire(import.meta.url)
let index: Record<string, IndexEntry> | undefined

/** Loaded on first use: ~1.5MB of JSON, shipped gzipped at ~60KB. */
function registry(): Record<string, IndexEntry> {
  if (!index) {
    try {
      const path = require.resolve('./erc7730-index.json.gz')
      index = JSON.parse(gunzipSync(require('node:fs').readFileSync(path)).toString())
    } catch {
      index = {}
    }
  }
  return index as Record<string, IndexEntry>
}

export function protocolLabel(slug: string): string {
  return PROTOCOL_LABELS[slug] ?? slug
}

/** Resolve a registry path ("params.amountIn", "#.to", "[0].value") against decoded args. */
function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const part of path.replace(/^[#@]\./, '').split('.')) {
    if (current == null) return undefined
    const arrayIndex = part.match(/^\[(\d*)\]$/)
    if (arrayIndex) {
      current = Array.isArray(current) ? current[arrayIndex[1] === '' ? 0 : Number(arrayIndex[1])] : undefined
    } else {
      current = (current as Record<string, unknown>)[part]
    }
  }
  return current
}

interface TxContext {
  to: string
  value?: string
  from?: string
}

function resolvePath(root: unknown, tx: TxContext, path: string): unknown {
  if (path.startsWith('@.')) {
    if (path.slice(2) === 'to') return tx.to
    if (path.slice(2) === 'value') return tx.value
    if (path.slice(2) === 'from') return tx.from
    return undefined
  }
  return getByPath(root, path)
}

async function formatField(chain: ChainName, field: IndexField, root: unknown, tx: TxContext): Promise<ClearSigningField> {
  // A missing format with a token reference still means an amount.
  const format = field.format ?? (field.params?.tokenPath || field.params?.tokenAddress ? 'tokenAmount' : 'raw')
  const label = field.label ?? field.path ?? format
  const raw = field.path ? resolvePath(root, tx, field.path) : undefined
  const out: ClearSigningField = { label, format, value: '' }

  // Unresolved: show the descriptor's path rather than an empty row.
  if (raw == null) {
    out.value = field.path ?? ''
    return out
  }

  switch (format) {
    case 'tokenAmount':
    case 'amount': {
      const amount = typeof raw === 'bigint' ? raw : BigInt(raw as string | number)
      const token =
        field.params?.tokenAddress ?? (field.params?.tokenPath ? resolvePath(root, tx, field.params.tokenPath) : undefined)

      const tokenAddress = typeof token === 'string' && isAddress(token) ? getAddress(token) : undefined
      const meta = tokenAddress
        ? await tokenMeta(chain, tokenAddress).catch(() => ({ symbol: undefined, decimals: undefined }))
        : { symbol: undefined, decimals: undefined }
      // `amount` is the native currency, which always has 18 decimals.
      const decimals = meta.decimals ?? (format === 'amount' && !tokenAddress ? 18 : undefined)

      // symbol() is whatever the token contract says it is, so the address always goes with it.
      const symbol = `${meta.symbol ? ` ${meta.symbol}` : ''}${tokenAddress ? ` (${tokenAddress})` : ''}`
      if (tokenAddress) out.address = tokenAddress
      if (amount > UNLIMITED_THRESHOLD) out.value = `Unlimited${symbol}`
      else if (decimals === undefined) out.value = `${amount}${symbol} (decimals unknown)`
      else out.value = `${formatUnits(amount, decimals)}${symbol}`
      return out
    }

    case 'addressName':
    case 'address':
    case 'tokenName': {
      if (!isAddress(raw as string)) {
        out.value = String(raw)
        return out
      }
      const address = getAddress(raw as string)
      const name = lookupContract(chain, address)?.protocol
      out.address = address
      out.name = name ? protocolLabel(name) : await addressLabel(chain, address).catch(() => undefined)
      out.value = out.name ? `${out.name} (${address})` : address
      return out
    }

    default:
      out.value = typeof raw === 'bigint' ? raw.toString() : String(raw)
      return out
  }
}

/** Registry entry for a contract, if it is listed for this chain. */
export function lookupContract(chain: ChainName, address: string): IndexEntry | undefined {
  const entry = registry()[address.toLowerCase()]
  if (!entry) return undefined
  const chainId = getClientManager().getChainId(chain)
  return entry.chainIds.includes(chainId) ? entry : undefined
}

/**
 * Clear-signing info for a transaction, or null when the contract/selector is unlisted.
 * `decodedArgs` is supplied by the caller, which has already decoded the calldata against
 * the contract's real ABI — the registry's own signature is only a fallback for naming.
 */
export async function resolveClearSigning(
  chain: ChainName,
  tx: TxContext & { data?: string },
  decodedArgs: Record<string, unknown>
): Promise<ClearSigningInfo | null> {
  if (!tx.data || tx.data.length < 10) return null

  const entry = lookupContract(chain, tx.to)
  const format = entry?.selectors[tx.data.slice(0, 10).toLowerCase()]
  if (!entry || !format) return null

  // Fields with neither a path nor a label carry nothing a signer could read.
  const usable = format.fields.filter((field) => field.path || field.label)
  const fields = await Promise.all(usable.map((field) => formatField(chain, field, decodedArgs, tx)))

  return {
    protocol: protocolLabel(entry.protocol),
    intent: format.intent,
    functionName: format.name,
    fields
  }
}
