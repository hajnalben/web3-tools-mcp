import { type AbiFunction, type Address, decodeFunctionData, formatEther, formatUnits, toFunctionSelector } from 'viem'
import { simulateBlocks } from 'viem/actions'
import { addressLabel, loadAbi, tokenMeta, UNLIMITED_THRESHOLD } from './chain-meta.js'
import { lookupContract, protocolLabel, resolveClearSigning } from './clear-signing.js'
import { getClientManager } from './client.js'
import type { ChainName } from './types.js'

export interface PreviewField {
  name: string
  type: string
  value: string
  warning?: string
  /** Set when the value is an address, so the UI can link and label it. */
  address?: string
  label?: string
}

export interface AssetChange {
  token: string
  symbol?: string
  decimals?: number
  from: string
  to: string
  amount: string
  humanAmount?: string
  /** Set for an ERC-721 transfer, which moves this one token rather than an amount. */
  tokenId?: string
}

export interface TxPreview {
  chain: string
  to: string
  /** Token symbol or verified contract name for `to`, when we can resolve one. */
  toLabel?: string
  /** Block explorer base URL, for linking addresses and tokens. */
  explorer?: string
  value?: string
  valueFormatted?: string
  decoded?: {
    functionName: string
    signature: string
    fields: PreviewField[]
    /** From the ERC-7730 registry: what this call means, and whose contract it is. */
    intent?: string
    protocol?: string
    /** 'verified' = ABI from Sourcify/Etherscan, 'guessed' = selector lookup on bytecode */
    source: 'verified' | 'guessed'
    proxy?: string
  }
  simulation?: {
    success: boolean
    gasEstimate?: string
    error?: string
    assetChanges: AssetChange[]
  }
}

export interface RawTx {
  to: string
  data?: string
  value?: string
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Selectors whose amount argument is denominated in the token at tx.to.
const ERC20_AMOUNT_ARGS: Record<string, { arg: string; approval?: boolean }> = {
  [toFunctionSelector('function approve(address,uint256)')]: { arg: 'amount', approval: true },
  [toFunctionSelector('function transfer(address,uint256)')]: { arg: 'amount' },
  [toFunctionSelector('function transferFrom(address,address,uint256)')]: { arg: 'amount' }
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(stringify).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}: ${stringify(v)}`)
      .join(', ')}}`
  }
  return String(value)
}

/**
 * Decode calldata into labelled fields (clear signing). Token amounts on the standard
 * ERC20 selectors are formatted with on-chain decimals and unlimited approvals flagged.
 */
async function decodeCalldata(chain: ChainName, tx: RawTx, from?: string): Promise<TxPreview['decoded']> {
  if (!tx.data || tx.data === '0x') return undefined

  const { abi, source, proxy } = await loadAbi(chain, tx.to)
  const { functionName, args } = decodeFunctionData({ abi, data: tx.data as `0x${string}` })

  // By selector, not name: an overloaded name would otherwise pick the wrong inputs.
  const selector = tx.data.slice(0, 10).toLowerCase()
  const abiItem = abi.find((item): item is AbiFunction => item.type === 'function' && toFunctionSelector(item) === selector)
  const inputs = abiItem?.inputs ?? []
  const erc20 = ERC20_AMOUNT_ARGS[selector]
  const meta = erc20 ? await tokenMeta(chain, tx.to).catch(() => ({ symbol: undefined, decimals: undefined })) : undefined

  const fields: PreviewField[] = (args ?? []).map((value, i) => {
    const input = inputs[i]
    const name = input?.name || `arg${i}`
    const field: PreviewField = { name, type: input?.type ?? 'unknown', value: stringify(value) }

    if (input?.type === 'address' && typeof value === 'string') field.address = value

    // Amount argument is positionally last on all three ERC20 selectors.
    if (erc20 && i === (args as readonly unknown[]).length - 1 && typeof value === 'bigint') {
      if (meta?.decimals !== undefined) {
        field.value = `${formatUnits(value, meta.decimals)}${meta.symbol ? ` ${meta.symbol}` : ''}`
      }
      if (erc20.approval && value > UNLIMITED_THRESHOLD) {
        field.value = `Unlimited${meta?.symbol ? ` ${meta.symbol}` : ''}`
        field.warning = 'Unlimited spending approval'
      }
    }
    return field
  })

  // Label every address argument at once rather than serially per field.
  await Promise.all(
    fields
      .filter((field) => field.address)
      .map(async (field) => {
        field.label = await addressLabel(chain, field.address as string)
      })
  )

  const signature = abiItem
    ? `${functionName}(${inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ''}`).join(', ')})`
    : functionName

  // Map positional args to their parameter names so registry field paths resolve.
  const named: Record<string, unknown> = {}
  inputs.forEach((input, i) => {
    if (input.name) named[input.name] = (args ?? [])[i]
  })

  // A registry descriptor says what the call means and how the protocol wants each field
  // labelled, which beats raw ABI argument names. Fall back to those when it has none.
  const clearSigning = await resolveClearSigning(chain, { ...tx, from }, named).catch(() => null)
  if (clearSigning) {
    return {
      functionName,
      signature,
      source,
      proxy,
      intent: clearSigning.intent,
      protocol: clearSigning.protocol,
      fields: clearSigning.fields.map((field) => ({
        name: field.label,
        type: field.format,
        value: field.value,
        ...(field.address && { address: field.address }),
        ...(field.name && { label: field.name }),
        ...(field.value.startsWith('Unlimited') && { warning: 'Unlimited spending approval' })
      }))
    }
  }

  return { functionName, signature, fields, source, proxy }
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`
}

export async function enrichTransfers(
  chain: ChainName,
  logs: readonly { address: string; topics: readonly string[]; data: string }[]
) {
  const transfers = logs.filter((log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length >= 3)

  return Promise.all(
    transfers.map(async (log): Promise<AssetChange> => {
      const meta = await tokenMeta(chain, log.address).catch(() => ({ symbol: undefined, decimals: undefined }))

      // ERC-721 shares ERC-20's Transfer topic but indexes the token id as a fourth topic,
      // leaving the data empty — read as ERC-20, a mint looks like a transfer of nothing.
      if (log.topics.length === 4) {
        return {
          token: log.address,
          symbol: meta.symbol,
          from: topicToAddress(log.topics[1]!),
          to: topicToAddress(log.topics[2]!),
          amount: '1',
          tokenId: BigInt(log.topics[3]!).toString()
        }
      }

      const amount = log.data && log.data !== '0x' ? BigInt(log.data).toString() : '0'
      return {
        token: log.address,
        symbol: meta.symbol,
        decimals: meta.decimals,
        from: topicToAddress(log.topics[1]!),
        to: topicToAddress(log.topics[2]!),
        amount,
        humanAmount: meta.decimals !== undefined ? formatUnits(BigInt(amount), meta.decimals) : undefined
      }
    })
  )
}

/**
 * Simulate a transaction without broadcasting.
 *
 * Prefers eth_simulateV1 (viem `simulateBlocks`) for the ERC20 transfer logs it returns,
 * falling back to eth_call + estimateGas on RPCs that don't implement it.
 */
async function simulate(chain: ChainName, tx: RawTx, from: Address): Promise<TxPreview['simulation']> {
  const client = getClientManager().getClient(chain)
  const call = {
    account: from,
    to: tx.to as Address,
    ...(tx.data && { data: tx.data as `0x${string}` }),
    ...(tx.value && BigInt(tx.value) > 0n && { value: BigInt(tx.value) })
  }

  try {
    const blocks = await simulateBlocks(client, { blocks: [{ calls: [call] }], traceTransfers: true, validation: false })
    const result = blocks?.[0]?.calls?.[0]
    if (result) {
      const error = result.error as { shortMessage?: string; message?: string } | undefined
      return {
        success: result.status === 'success',
        gasEstimate: result.gasUsed?.toString(),
        error: result.status === 'success' ? undefined : (error?.shortMessage ?? error?.message ?? 'execution reverted'),
        assetChanges: await enrichTransfers(chain, (result.logs ?? []) as never)
      }
    }
  } catch {
    // RPC lacks eth_simulateV1 — fall through
  }

  try {
    await client.call(call)
    const gas = await client.estimateGas(call)
    return { success: true, gasEstimate: gas.toString(), assetChanges: [] }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      assetChanges: []
    }
  }
}

/**
 * Build the human-readable preview shown in the wallet before signing: decoded calldata
 * plus a simulation of the outcome. Never throws — a preview that cannot be built is
 * reported as missing rather than blocking the transaction.
 */
export async function buildTxPreview(chain: ChainName, tx: RawTx, from?: string): Promise<TxPreview> {
  const value = tx.value ? BigInt(tx.value).toString() : undefined

  const [decoded, simulation, toLabel] = await Promise.all([
    // A preview that cannot be built must not block the transaction, but swallowing the
    // reason makes "no details shown" impossible to diagnose.
    decodeCalldata(chain, tx, from).catch((error) => {
      console.error('[Preview] Could not decode calldata:', error instanceof Error ? error.message : error)
      return undefined
    }),
    from
      ? simulate(chain, tx, from as Address).catch((error) => {
          console.error('[Preview] Could not simulate:', error instanceof Error ? error.message : error)
          return undefined
        })
      : Promise.resolve(undefined),
    // The registry's protocol name beats anything on-chain: "Aave", not a proxy's class name.
    Promise.resolve(lookupContract(chain, tx.to))
      .then((entry) => (entry ? protocolLabel(entry.protocol) : addressLabel(chain, tx.to)))
      .catch(() => undefined)
  ])

  return {
    chain,
    to: tx.to,
    toLabel,
    explorer: getClientManager().explorerUrl(chain),
    value,
    valueFormatted: value && value !== '0' ? formatEther(BigInt(value)) : undefined,
    decoded,
    simulation
  }
}
