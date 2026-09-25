import {
  type AbiFunction,
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  type Hex,
  isAddress,
  parseAbiItem,
  toHex
} from 'viem'
import { simulateBlocks } from 'viem/actions'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import { enrichTransfers } from '../../preview.js'
import type { ChainName } from '../../types.js'
import { convertArgumentsToTypes, createTool, formatResponse } from '../../utils.js'

/** Alchemy's bundle method takes at most this many transactions. */
const ALCHEMY_BUNDLE_LIMIT = 3
/** One tool call is one quota unit, so an unbounded bundle would be a way around the quota. */
const MAX_BUNDLE = 25
/** Where eth_simulateV1's traced native transfers say they come from. */
const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

const argsSchema = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))

interface BundleCall {
  from?: Address
  to: Address
  data?: Hex
  value?: bigint
  abi?: AbiFunction
}

interface AssetChange {
  assetType: string
  token?: string
  symbol?: string
  tokenId?: string
  from: string
  to: string
  amount?: string
  rawAmount: string
}

interface CallOutcome {
  status: 'success' | 'failure'
  gasUsed?: string
  error?: string
  result?: unknown
  assetChanges: AssetChange[]
}

interface AlchemyOutcome {
  changes: {
    assetType: string
    contractAddress?: string
    symbol?: string
    tokenId?: string
    from: string
    to: string
    amount?: string
    rawAmount: string
  }[]
  gasUsed?: Hex
  error?: { message: string }
}

/**
 * Why an RPC call failed, without the request URL — viem puts it in `message`, and with a
 * provider key configured that URL carries the key.
 */
function rpcReason(error: unknown): string {
  const { details, shortMessage } = error as { details?: string; shortMessage?: string }
  return details || shortMessage || 'The RPC request failed'
}

function bundleCall(
  call: { to: string; functionAbi?: string; args?: z.infer<typeof argsSchema>; data?: string; value?: string; from?: string },
  from: string | undefined,
  index: number
): BundleCall {
  const sender = call.from ?? from
  if (!isAddress(call.to)) throw new Error(`Call ${index}: invalid to address ${call.to}`)
  if (sender && !isAddress(sender)) throw new Error(`Call ${index}: invalid from address ${sender}`)
  if (call.functionAbi && call.data) throw new Error(`Call ${index}: give functionAbi and args, or data — not both`)

  const abi = call.functionAbi ? (parseAbiItem(call.functionAbi) as AbiFunction) : undefined
  const data = abi
    ? encodeFunctionData({ abi: [abi], functionName: abi.name, args: convertArgumentsToTypes(call.args ?? [], abi.inputs) })
    : (call.data as Hex | undefined)

  return { from: sender as Address | undefined, to: call.to, data, value: call.value ? BigInt(call.value) : undefined, abi }
}

/** Native, ERC20, ERC721 and ERC1155 changes with token metadata — on Alchemy's paid plans only. */
async function viaAlchemy(chain: ChainName, calls: BundleCall[], blockNumber?: bigint): Promise<CallOutcome[]> {
  const client = getClientManager().getClient(chain)
  const transactions = calls.map((call) => ({
    from: call.from,
    to: call.to,
    data: call.data,
    value: call.value !== undefined ? toHex(call.value) : undefined
  }))
  const params = blockNumber === undefined ? [transactions] : [transactions, toHex(blockNumber)]

  const outcomes = (await client.request({ method: 'alchemy_simulateAssetChangesBundle', params } as never)) as AlchemyOutcome[]
  return outcomes.map((outcome) => ({
    status: outcome.error ? 'failure' : 'success',
    gasUsed: outcome.gasUsed ? BigInt(outcome.gasUsed).toString() : undefined,
    error: outcome.error?.message,
    assetChanges: outcome.changes.map((change) => ({
      assetType: change.assetType,
      token: change.contractAddress,
      symbol: change.symbol,
      tokenId: change.tokenId,
      from: change.from,
      to: change.to,
      amount: change.amount,
      rawAmount: change.rawAmount
    }))
  }))
}

function decodeResult(abi: AbiFunction | undefined, data: Hex): unknown {
  if (!abi?.outputs.length) return data
  try {
    return decodeFunctionResult({ abi: [abi], functionName: abi.name, data })
  } catch {
    return data
  }
}

/**
 * Any RPC with eth_simulateV1: decoded return values, and native and ERC20 transfers.
 *
 * ponytail: an ERC721 transfer shares ERC20's Transfer topic, so it shows up here as an
 * ERC20 transfer of 0. Tell them apart by topic count if NFT bundles matter on free keys.
 */
async function viaSimulateV1(chain: ChainName, calls: BundleCall[], blockNumber?: bigint): Promise<CallOutcome[]> {
  const client = getClientManager().getClient(chain)
  const [block] = await simulateBlocks(client, {
    blocks: [{ calls: calls.map((call) => ({ account: call.from, to: call.to, data: call.data, value: call.value })) }],
    traceTransfers: true,
    validation: false,
    ...(blockNumber !== undefined && { blockNumber })
  })
  if (!block) throw new Error('The RPC returned no simulated block')

  const nativeSymbol = client.chain?.nativeCurrency.symbol
  return Promise.all(
    block.calls.map(async (call, index): Promise<CallOutcome> => {
      const error = call.error as { shortMessage?: string; message?: string } | undefined
      const transfers = await enrichTransfers(chain, (call.logs ?? []) as never)

      return {
        status: call.status,
        gasUsed: call.gasUsed.toString(),
        error: call.status === 'success' ? undefined : (error?.shortMessage ?? error?.message ?? 'execution reverted'),
        result: call.status === 'success' ? decodeResult(calls[index]?.abi, call.data) : undefined,
        assetChanges: transfers.map((transfer) => {
          const native = transfer.token.toLowerCase() === NATIVE_TOKEN
          return {
            assetType: native ? 'NATIVE' : 'ERC20',
            token: native ? undefined : transfer.token,
            symbol: native ? nativeSymbol : transfer.symbol,
            from: transfer.from,
            to: transfer.to,
            amount: native ? formatEther(BigInt(transfer.amount)) : transfer.humanAmount,
            rawAmount: transfer.amount
          }
        })
      }
    })
  )
}

export default {
  simulate_contract: createTool(
    'Simulate Contract Call',
    'Simulate a contract call (including state-changing functions) without broadcasting. Returns simulation result and estimated gas.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network to simulate on'),
      contractAddress: z.string().describe('Contract address to call'),
      functionAbi: z
        .string()
        .describe('Function ABI signature (e.g., "function transfer(address to, uint256 amount)"). Can be any function type.'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Function arguments in order matching the ABI signature'),
      from: z.string().optional().describe('Sender address (defaults to zero address)'),
      value: z.string().optional().describe('ETH value to send with the transaction (in wei as string)'),
      blockNumber: z.string().optional().describe('Block number for simulation (defaults to latest)')
    }),
    async (args) => {
      if (!isAddress(args.contractAddress)) {
        throw new Error(`Invalid contract address: ${args.contractAddress}`)
      }

      if (args.from && !isAddress(args.from)) {
        throw new Error(`Invalid from address: ${args.from}`)
      }

      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)

      try {
        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction
        const convertedArgs = convertArgumentsToTypes(args.args || [], abiItem.inputs)

        const blockTag = args.blockNumber ? BigInt(args.blockNumber) : undefined

        // Simulate the call
        const result = await client.call({
          to: args.contractAddress as Address,
          data: encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: convertedArgs
          }),
          account: args.from ? (args.from as Address) : undefined,
          value: args.value ? BigInt(args.value) : undefined,
          blockNumber: blockTag
        })

        // Also estimate gas
        const gasEstimate = await client.estimateGas({
          to: args.contractAddress as Address,
          data: encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: convertedArgs
          }),
          account: args.from ? (args.from as Address) : undefined,
          value: args.value ? BigInt(args.value) : undefined,
          blockNumber: blockTag
        })

        // Decode the result if the function has outputs
        let decodedResult: unknown = result.data
        if (abiItem.outputs && abiItem.outputs.length > 0 && result.data) {
          decodedResult = decodeFunctionResult({
            abi: [abiItem],
            functionName: abiItem.name,
            data: result.data
          })
        }

        return formatResponse({
          success: true,
          chain: args.chain,
          contractAddress: args.contractAddress,
          functionName: abiItem.name,
          result: decodedResult,
          rawData: result.data,
          gasEstimate: gasEstimate.toString(),
          blockNumber: args.blockNumber || 'latest'
        })
      } catch (error) {
        // Check if it's a revert error
        const errorMessage = error instanceof Error ? error.message : String(error)

        return formatResponse({
          success: false,
          chain: args.chain,
          contractAddress: args.contractAddress,
          error: errorMessage,
          reverted: errorMessage.includes('revert') || errorMessage.includes('execution reverted')
        })
      }
    }
  ),

  simulate_bundle: createTool(
    'Simulate Transaction Bundle',
    'Simulate several transactions in order, in one block, each seeing the state the previous ones left — e.g. ' +
      'approve then swap, or deposit then borrow. Nothing is broadcast. Returns per transaction whether it ' +
      'succeeded, gas used, the revert reason, and the assets that moved. Up to 3 transactions go through ' +
      "Alchemy's asset-change simulation (native, ERC20, ERC721, ERC1155, with symbols) where the plan allows it; " +
      'otherwise eth_simulateV1, which adds decoded return values but reports only native and ERC20 transfers.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network to simulate on'),
      from: z.string().optional().describe('Sender for every transaction that does not name its own'),
      calls: z
        .array(
          z.object({
            to: z.string().describe('Contract or recipient address'),
            functionAbi: z
              .string()
              .optional()
              .describe('Function signature to encode the call, e.g. "function approve(address spender, uint256 amount)"'),
            args: argsSchema.optional().describe('Arguments for functionAbi, in order'),
            data: z.string().optional().describe('Raw calldata, instead of functionAbi and args'),
            value: z.string().optional().describe('Native value to send, in wei'),
            from: z.string().optional().describe('Sender of this transaction, if not the bundle-wide from')
          })
        )
        .min(1)
        .max(MAX_BUNDLE)
        .describe('Transactions to run, in order'),
      blockNumber: z.string().optional().describe('Block to simulate on top of (defaults to latest)')
    }),
    async (args) => {
      const chain = args.chain as ChainName
      const calls = args.calls.map((call, index) => bundleCall(call, args.from, index))
      const blockNumber = args.blockNumber ? BigInt(args.blockNumber) : undefined

      let outcomes: CallOutcome[] | undefined
      let via = 'alchemy_simulateAssetChangesBundle'
      let fallbackReason: string | undefined

      if (calls.length <= ALCHEMY_BUNDLE_LIMIT) {
        try {
          outcomes = await viaAlchemy(chain, calls, blockNumber)
        } catch (error) {
          // A free plan, a chain Alchemy does not simulate on, or a custom RPC that is not Alchemy.
          fallbackReason = rpcReason(error)
        }
      } else {
        fallbackReason = `Alchemy simulates at most ${ALCHEMY_BUNDLE_LIMIT} transactions per bundle`
      }

      if (!outcomes) {
        via = 'eth_simulateV1'
        try {
          outcomes = await viaSimulateV1(chain, calls, blockNumber)
        } catch (error) {
          return formatResponse({ success: false, chain, error: rpcReason(error), alchemyBundleError: fallbackReason })
        }
      }

      return formatResponse({
        success: outcomes.every((outcome) => outcome.status === 'success'),
        chain,
        via,
        ...(fallbackReason && { fallbackReason }),
        totalGasUsed: outcomes.reduce((sum, outcome) => sum + BigInt(outcome.gasUsed ?? 0), 0n),
        calls: outcomes.map((outcome, index) => ({
          index,
          to: calls[index]?.to,
          ...(calls[index]?.abi && { functionName: calls[index].abi.name }),
          ...outcome
        }))
      })
    },
    // Offered only where a provider RPC backs it: public endpoints rarely serve eth_simulateV1.
    () => Boolean(getClientManager().getConfig().alchemyApiKey)
  ),

  estimate_gas: createTool(
    'Estimate Gas',
    'Estimate gas required for a transaction. Supports contract calls, transfers, and deployments.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().optional().describe('Recipient address (omit for contract deployment)'),
      from: z.string().optional().describe('Sender address (optional)'),
      value: z.string().optional().describe('ETH value to send (in wei as string)'),
      data: z.string().optional().describe('Transaction data (hex string for contract calls or deployment bytecode)'),
      functionAbi: z.string().optional().describe('Optional: Function ABI signature to encode call data automatically'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Optional: Function arguments (only used with functionAbi)')
    }),
    async (args) => {
      if (args.to && !isAddress(args.to)) {
        throw new Error(`Invalid to address: ${args.to}`)
      }

      if (args.from && !isAddress(args.from)) {
        throw new Error(`Invalid from address: ${args.from}`)
      }

      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)

      let callData = args.data

      // If functionAbi is provided, encode the call data
      if (args.functionAbi) {
        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction
        const convertedArgs = convertArgumentsToTypes(args.args || [], abiItem.inputs)
        callData = encodeFunctionData({
          abi: [abiItem],
          functionName: abiItem.name,
          args: convertedArgs
        })
      }

      const gasEstimate = await client.estimateGas({
        to: args.to ? (args.to as Address) : undefined,
        account: args.from ? (args.from as Address) : undefined,
        value: args.value ? BigInt(args.value) : undefined,
        data: callData as `0x${string}` | undefined
      })

      return formatResponse({
        success: true,
        chain: args.chain,
        gasEstimate: gasEstimate.toString(),
        to: args.to,
        from: args.from,
        value: args.value
      })
    }
  ),

  get_gas_price: createTool(
    'Get Gas Price',
    'Get current gas prices for a chain. Returns both legacy gasPrice and EIP-1559 fees (maxFeePerGas, maxPriorityFeePerGas).',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      formatted: z.boolean().optional().default(true).describe('Return prices in Gwei (default: true). If false, returns wei.')
    }),
    async (args) => {
      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)

      // Get both legacy and EIP-1559 gas prices
      const [gasPrice, feeData] = await Promise.all([
        client.getGasPrice(),
        client.estimateFeesPerGas().catch(() => null) // Some chains don't support EIP-1559
      ])

      const formatPrice = (wei: bigint): string => {
        if (args.formatted) {
          // Convert to Gwei (1 Gwei = 1e9 wei)
          const gwei = Number(wei) / 1e9
          return `${gwei.toFixed(2)} Gwei`
        }
        return wei.toString()
      }

      const response: any = {
        chain: args.chain,
        timestamp: new Date().toISOString(),
        legacy: {
          gasPrice: args.formatted ? formatPrice(gasPrice) : gasPrice.toString(),
          gasPriceWei: gasPrice.toString()
        }
      }

      // Add EIP-1559 data if available
      if (feeData) {
        response.eip1559 = {
          maxFeePerGas: args.formatted ? formatPrice(feeData.maxFeePerGas) : feeData.maxFeePerGas.toString(),
          maxPriorityFeePerGas: args.formatted
            ? formatPrice(feeData.maxPriorityFeePerGas)
            : feeData.maxPriorityFeePerGas.toString(),
          maxFeePerGasWei: feeData.maxFeePerGas.toString(),
          maxPriorityFeePerGasWei: feeData.maxPriorityFeePerGas.toString()
        }

        // Calculate estimated total cost for a standard 21000 gas transaction
        const standardGasLimit = 21000n
        const estimatedCost = feeData.maxFeePerGas * standardGasLimit
        response.eip1559.estimatedCostFor21kGas = args.formatted
          ? `${(Number(estimatedCost) / 1e18).toFixed(6)} ETH`
          : estimatedCost.toString()
      }

      return formatResponse(response)
    }
  )
}
