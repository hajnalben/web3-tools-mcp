import {
  type Abi,
  type AbiFunction,
  type Address,
  decodeFunctionData,
  formatEther,
  formatUnits,
  parseAbiItem,
  toFunctionSelector
} from 'viem'
import { simulateBlocks } from 'viem/actions'
import { whatsabi } from '@shazow/whatsabi'
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

const ERC20_META_ABI = [
  parseAbiItem('function decimals() view returns (uint8)'),
  parseAbiItem('function symbol() view returns (string)')
]

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MAX_UINT256 = (1n << 256n) - 1n
const UNLIMITED_THRESHOLD = MAX_UINT256 / 2n

// Selectors whose amount argument is denominated in the token at tx.to.
const ERC20_AMOUNT_ARGS: Record<string, { arg: string; approval?: boolean }> = {
  [toFunctionSelector('function approve(address,uint256)')]: { arg: 'amount', approval: true },
  [toFunctionSelector('function transfer(address,uint256)')]: { arg: 'amount' },
  [toFunctionSelector('function transferFrom(address,address,uint256)')]: { arg: 'amount' }
}

const abiCache = new Map<string, { abi: Abi; source: 'verified' | 'guessed'; proxy?: string; name?: string }>()
const labelCache = new Map<string, string | undefined>()
const metaCache = new Map<string, { symbol?: string; decimals?: number }>()

async function loadAbi(chain: ChainName, address: string) {
  const key = `${chain}:${address.toLowerCase()}`
  const cached = abiCache.get(key)
  if (cached) return cached

  const clientManager = getClientManager()
  const client = clientManager.getClient(chain)
  const etherscanApiKey = clientManager.getConfig().etherscanApiKey

  const loaders: whatsabi.loaders.ABILoader[] = [new whatsabi.loaders.SourcifyABILoader({ chainId: clientManager.getChainId(chain) })]
  if (etherscanApiKey) {
    loaders.push(new whatsabi.loaders.EtherscanV2ABILoader({ apiKey: etherscanApiKey, chainId: clientManager.getChainId(chain) }))
  }

  const result = await whatsabi.autoload(address as Address, {
    provider: client,
    abiLoader: new whatsabi.loaders.MultiABILoader(loaders),
    signatureLookup: new whatsabi.loaders.OpenChainSignatureLookup(),
    followProxies: true
  })

  // Bytecode-guessed ABIs carry no argument names; verified ones do.
  const source = result.abi.some((item) => item.type === 'function' && item.inputs?.some((i) => i.name)) ? 'verified' : 'guessed'
  const loaded = {
    abi: result.abi as Abi,
    source: source as 'verified' | 'guessed',
    proxy: result.address !== address ? result.address : undefined,
    name: result.contractResult?.name ?? undefined
  }
  abiCache.set(key, loaded)
  return loaded
}

async function tokenMeta(chain: ChainName, token: string) {
  const key = `${chain}:${token.toLowerCase()}`
  const cached = metaCache.get(key)
  if (cached) return cached

  const client = getClientManager().getClient(chain)
  const [decimals, symbol] = await client.multicall({
    contracts: [
      { address: token as Address, abi: ERC20_META_ABI, functionName: 'decimals' },
      { address: token as Address, abi: ERC20_META_ABI, functionName: 'symbol' }
    ],
    ...(chain === 'localhost' && { deployless: true })
  })

  const meta = {
    decimals: decimals.status === 'success' ? Number(decimals.result) : undefined,
    symbol: symbol.status === 'success' ? (symbol.result as string) : undefined
  }
  metaCache.set(key, meta)
  return meta
}

/**
 * Human label for an address: token symbol first (more recognisable than the contract
 * name — "USDC" beats "FiatTokenProxy"), then the verified contract name. EOAs get none,
 * and the bytecode check keeps us from asking explorers about plain wallets.
 */
async function addressLabel(chain: ChainName, address: string): Promise<string | undefined> {
  const key = `${chain}:${address.toLowerCase()}`
  if (labelCache.has(key)) return labelCache.get(key)

  let label: string | undefined
  try {
    const code = await getClientManager().getClient(chain).getBytecode({ address: address as Address })
    if (code && code !== '0x') {
      label = (await tokenMeta(chain, address).catch(() => ({ symbol: undefined }))).symbol
      if (!label) label = (await loadAbi(chain, address)).name
    }
  } catch {
    // Unknown address — show it bare rather than failing the preview.
  }

  labelCache.set(key, label)
  return label
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
async function decodeCalldata(chain: ChainName, tx: RawTx): Promise<TxPreview['decoded']> {
  if (!tx.data || tx.data === '0x') return undefined

  const { abi, source, proxy } = await loadAbi(chain, tx.to)
  const { functionName, args } = decodeFunctionData({ abi, data: tx.data as `0x${string}` })

  const abiItem = abi.find((item): item is AbiFunction => item.type === 'function' && item.name === functionName)
  const inputs = abiItem?.inputs ?? []
  const erc20 = ERC20_AMOUNT_ARGS[tx.data.slice(0, 10)]
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

  return { functionName, signature, fields, source, proxy }
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`
}

async function enrichTransfers(chain: ChainName, logs: readonly { address: string; topics: readonly string[]; data: string }[]) {
  const transfers = logs.filter((log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length >= 3)

  return Promise.all(
    transfers.map(async (log): Promise<AssetChange> => {
      const amount = log.data && log.data !== '0x' ? BigInt(log.data).toString() : '0'
      const meta = await tokenMeta(chain, log.address).catch(() => ({ symbol: undefined, decimals: undefined }))
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
    decodeCalldata(chain, tx).catch(() => undefined),
    from ? simulate(chain, tx, from as Address).catch(() => undefined) : Promise.resolve(undefined),
    addressLabel(chain, tx.to).catch(() => undefined)
  ])

  return {
    chain,
    to: tx.to,
    toLabel,
    explorer: `https://${getClientManager().getEtherscanDomain(chain)}`,
    value,
    valueFormatted: value && value !== '0' ? formatEther(BigInt(value)) : undefined,
    decoded,
    simulation
  }
}
