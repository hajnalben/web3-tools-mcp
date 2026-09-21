import { type Address, decodeAbiParameters, isAddress, parseAbiParameters } from 'viem'
import { z } from 'zod'
import { isAnvilInstalled, simulateCallWithTrace, traceTransactionWithAnvil } from '../anvil.js'
import { getClientManager, SUPPORTED_CHAINS } from '../client.js'
import type { ChainName } from '../types.js'
import { createTool, formatResponse, summarizeTrace } from '../utils.js'

export default {
  get_storage_at: createTool(
    'Read Contract Storage',
    '⚠️ ADVANCED: Direct storage slot access with type decoding. Use for low-level contract inspection.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      address: z.string().describe('The contract address to inspect'),
      slot: z.string().describe('Storage slot (hex string, e.g., "0x0")'),
      abiType: z.string().describe('ABI type for decoding (e.g., "uint256", "address", "bool", "bytes32")'),
      blockNumber: z.string().optional().describe('Block number (optional, defaults to latest)')
    }),
    async (args) => {
      if (!isAddress(args.address)) {
        throw new Error('Invalid address format')
      }

      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)
      const blockTag = args.blockNumber ? BigInt(args.blockNumber) : 'latest'

      const storageValue = await client.getStorageAt({
        address: args.address as Address,
        slot: args.slot as `0x${string}`,
        blockNumber: blockTag === 'latest' ? undefined : blockTag
      })

      if (!storageValue) {
        throw new Error('No storage value found')
      }

      // Decode based on ABI type
      let decodedValue: unknown
      let formattedValue: string

      try {
        switch (args.abiType.toLowerCase()) {
          case 'uint256':
          case 'uint': {
            decodedValue = BigInt(storageValue)
            formattedValue = (decodedValue as bigint).toString()
            break
          }
          case 'int256':
          case 'int': {
            // Handle two's complement for negative numbers
            const uint256Value = BigInt(storageValue)
            const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
            decodedValue = uint256Value > maxUint256 / 2n ? uint256Value - maxUint256 - 1n : uint256Value
            formattedValue = (decodedValue as bigint).toString()
            break
          }
          case 'address': {
            decodedValue = `0x${storageValue.slice(-40)}`
            formattedValue = decodedValue as string
            break
          }
          case 'bool': {
            decodedValue = BigInt(storageValue) !== 0n
            formattedValue = String(decodedValue)
            break
          }
          case 'bytes32': {
            decodedValue = storageValue
            formattedValue = storageValue
            break
          }
          default: {
            // Try to decode as ABI parameters
            try {
              const parsedTypes = parseAbiParameters([args.abiType])
              if (parsedTypes.length > 0) {
                const decoded = decodeAbiParameters(parsedTypes, storageValue) as readonly unknown[]
                decodedValue = decoded.length > 0 ? decoded[0] : null
                formattedValue = decodedValue ? String(decodedValue) : 'No data'
              } else {
                decodedValue = null
                formattedValue = 'Invalid ABI type'
              }
            } catch {
              decodedValue = null
              formattedValue = 'Failed to decode with custom ABI type'
            }
            break
          }
        }
      } catch {
        decodedValue = null
        formattedValue = 'Failed to decode'
      }

      return formatResponse({
        rawValue: storageValue,
        decodedValue,
        formattedValue,
        abiType: args.abiType,
        slot: args.slot,
        address: args.address,
        chain: args.chain,
        blockNumber: blockTag === 'latest' ? 'latest' : blockTag.toString()
      })
    }
  ),

  get_block_info: createTool(
    'Get Block Information',
    'Retrieve block data including timestamps, hashes, and dates. Use for time-based analysis.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      blockNumber: z.string().optional().describe('Block number (optional, defaults to latest)')
    }),
    async (args) => {
      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)
      const blockTag = args.blockNumber ? BigInt(args.blockNumber) : 'latest'

      const block = await client.getBlock({
        blockNumber: blockTag === 'latest' ? undefined : blockTag,
        includeTransactions: false
      })

      const timestamp = Number(block.timestamp)
      const date = new Date(timestamp * 1000)

      return formatResponse({
        blockNumber: block.number,
        timestamp: block.timestamp,
        timestampMs: timestamp * 1000,
        dateIso: date.toISOString(),
        dateReadable: date.toLocaleString(),
        hash: block.hash,
        parentHash: block.parentHash,
        chain: args.chain
      })
    }
  ),

  trace_transaction: createTool(
    'Trace Transaction',
    '⚠️ INTENSIVE: Detailed transaction analysis including call traces and state changes. Use sparingly.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      transactionHash: z.string().describe('Transaction hash to trace (0x prefixed)'),
      traceType: z
        .enum(['trace', 'vmTrace', 'stateDiff'])
        .optional()
        .describe('Trace type: "trace" (call tree, recommended), "vmTrace" (VM execution), "stateDiff" (state changes)')
        .default('trace'),
      useAnvil: z
        .boolean()
        .optional()
        .describe('Force using Anvil for tracing (requires Foundry installed). Auto-used as fallback when RPC tracing fails.')
        .default(false),
      summarize: z
        .boolean()
        .optional()
        .describe('Return a compact summary instead of full trace. Truncates hex data and flattens nested calls.')
        .default(false)
    }),
    async (args) => {
      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)

      // First get the transaction receipt to make sure it exists
      const transaction = await client.getTransaction({ hash: args.transactionHash as `0x${string}` })
      const receipt = await client.getTransactionReceipt({ hash: args.transactionHash as `0x${string}` })

      let traceResult: unknown = null
      let usedAnvil = false

      // Map trace type to tracer name
      const tracerMap: Record<string, 'callTracer' | 'prestateTracer' | 'stateDiffTracer'> = {
        trace: 'callTracer',
        vmTrace: 'prestateTracer',
        stateDiff: 'stateDiffTracer'
      }
      const tracer = tracerMap[args.traceType ?? 'trace'] ?? 'callTracer'

      // Try RPC tracing first (unless forceAnvil is true)
      if (!args.useAnvil) {
        try {
          traceResult = await client.request({
            method: 'debug_traceTransaction',
            params: [args.transactionHash, { tracer }]
          })
        } catch (rpcError) {
          // RPC tracing failed, will try Anvil fallback
          const errorMessage = (rpcError as Error).message
          if (
            errorMessage.includes('not supported') ||
            errorMessage.includes('not available') ||
            errorMessage.includes('method not found') ||
            errorMessage.includes('does not exist')
          ) {
            // This is an expected error for public RPCs, try Anvil
            traceResult = null
          } else {
            // Other error, store it but still try Anvil
            traceResult = { rpcError: errorMessage }
          }
        }
      }

      // Fallback to Anvil if RPC tracing failed or was skipped
      if (
        traceResult === null ||
        (traceResult && typeof traceResult === 'object' && 'rpcError' in traceResult) ||
        args.useAnvil
      ) {
        const anvilAvailable = await isAnvilInstalled()
        if (anvilAvailable) {
          usedAnvil = true // Mark as used before attempting (even if it fails)
          try {
            const forkUrl = clientManager.getRpcUrl(args.chain as ChainName)
            const blockNumber = transaction.blockNumber ?? 0n

            traceResult = await traceTransactionWithAnvil(forkUrl, args.transactionHash, blockNumber, tracer, args.chain)
          } catch (anvilError) {
            // Anvil tracing also failed
            traceResult = {
              error: `Anvil tracing failed: ${(anvilError as Error).message}`,
              rpcError:
                traceResult && typeof traceResult === 'object' && 'rpcError' in traceResult
                  ? (traceResult as { rpcError: string }).rpcError
                  : 'RPC does not support debug_traceTransaction'
            }
          }
        } else if (!traceResult || (typeof traceResult === 'object' && 'rpcError' in traceResult)) {
          // Anvil not available and RPC failed
          traceResult = {
            error:
              'Tracing not available. Install Foundry (anvil) for local tracing: https://book.getfoundry.sh/getting-started/installation',
            rpcError:
              traceResult && typeof traceResult === 'object' && 'rpcError' in traceResult
                ? (traceResult as { rpcError: string }).rpcError
                : 'RPC does not support debug_traceTransaction'
          }
        }
      }

      // Apply summarization if requested - focused on finding reverts
      // Skip summarization only if traceResult is a plain error object (not a call trace with an error field)
      const isPlainError =
        traceResult &&
        typeof traceResult === 'object' &&
        'error' in traceResult &&
        !('type' in traceResult) &&
        !('calls' in traceResult)
      const traceSummary =
        args.summarize && traceResult && typeof traceResult === 'object' && !isPlainError ? summarizeTrace(traceResult) : null

      const result =
        args.summarize && traceSummary
          ? {
              chain: args.chain,
              transactionHash: args.transactionHash,
              status: receipt.status,
              gasUsed: receipt.gasUsed?.toString(),
              ...traceSummary // { hasError, errorPath, summary }
            }
          : {
              success: true,
              chain: args.chain,
              transactionHash: args.transactionHash,
              traceType: args.traceType,
              usedAnvil,
              transaction: {
                blockNumber: transaction.blockNumber?.toString(),
                from: transaction.from,
                to: transaction.to,
                value: transaction.value?.toString() || '0',
                gas: transaction.gas?.toString() || '0',
                gasPrice: transaction.gasPrice?.toString() || '0',
                nonce: transaction.nonce?.toString() || '0',
                input: transaction.input
              },
              receipt: {
                status: receipt.status,
                gasUsed: receipt.gasUsed?.toString() || '0',
                effectiveGasPrice: receipt.effectiveGasPrice?.toString() || '0',
                logs: receipt.logs.map((log) => ({
                  address: log.address,
                  topics: log.topics,
                  data: log.data
                }))
              },
              trace: traceResult
            }

      return formatResponse(result)
    }
  ),

  debug_call: createTool(
    'Debug Contract Call',
    'Simulate a contract call with full trace output. Requires Foundry (anvil) installed. Useful for debugging reverts and understanding call execution.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to fork'),
      to: z.string().describe('Contract address to call'),
      data: z.string().optional().describe('Calldata (hex encoded). Either provide this or functionAbi + args.'),
      functionAbi: z
        .string()
        .optional()
        .describe('Function ABI signature (e.g., "function transfer(address to, uint256 amount)"). Use with args parameter.'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Function arguments (when using functionAbi)'),
      from: z.string().optional().describe('Sender address (defaults to zero address)'),
      value: z.string().optional().describe('ETH value to send (in wei)'),
      blockNumber: z.string().optional().describe('Block number to fork from (defaults to latest)'),
      traceType: z
        .enum(['callTracer', 'prestateTracer'])
        .optional()
        .default('callTracer')
        .describe('Trace type: callTracer (call tree) or prestateTracer (state before execution)'),
      summarize: z
        .boolean()
        .optional()
        .describe('Return a compact summary instead of full trace. Truncates hex data and flattens nested calls.')
        .default(false)
    }),
    async (args) => {
      // Check if Anvil is installed
      const anvilAvailable = await isAnvilInstalled()
      if (!anvilAvailable) {
        throw new Error('Anvil is not installed. Please install Foundry: https://book.getfoundry.sh/getting-started/installation')
      }

      const clientManager = getClientManager()
      const forkUrl = clientManager.getRpcUrl(args.chain as ChainName)

      // Encode calldata if functionAbi is provided
      let calldata = args.data
      if (args.functionAbi && !calldata) {
        try {
          const { encodeFunctionData, parseAbiItem } = await import('viem')
          const abiItem = parseAbiItem(args.functionAbi)
          if (abiItem.type !== 'function') {
            throw new Error('ABI must be a function signature')
          }
          calldata = encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: (args.args ?? []) as readonly unknown[]
          })
        } catch (encodeError) {
          throw new Error(`Failed to encode function call: ${(encodeError as Error).message}`)
        }
      }

      const blockNumber = args.blockNumber ? BigInt(args.blockNumber) : undefined
      const value = args.value ? BigInt(args.value) : undefined

      const traceResult = await simulateCallWithTrace(
        forkUrl,
        {
          to: args.to,
          data: calldata,
          from: args.from,
          value
        },
        blockNumber,
        args.traceType
      )

      // Apply summarization if requested - focused on finding reverts
      // Skip summarization only if trace is a plain error object (not a call trace with an error field)
      const isPlainTraceError =
        traceResult.trace &&
        typeof traceResult.trace === 'object' &&
        'error' in traceResult.trace &&
        !('type' in traceResult.trace) &&
        !('calls' in traceResult.trace)
      const traceSummary =
        args.summarize && traceResult.trace && typeof traceResult.trace === 'object' && !isPlainTraceError
          ? summarizeTrace(traceResult.trace)
          : null

      const result =
        args.summarize && traceSummary
          ? {
              chain: args.chain,
              to: args.to,
              success: traceResult.success,
              gasUsed: traceResult.gasUsed.toString(),
              revertReason: traceResult.revertReason,
              ...traceSummary // { hasError, errorPath, summary }
            }
          : {
              success: traceResult.success,
              chain: args.chain,
              to: args.to,
              from: args.from ?? '0x0000000000000000000000000000000000000000',
              data: calldata,
              value: value?.toString() ?? '0',
              blockNumber: blockNumber?.toString() ?? 'latest',
              result: traceResult.result,
              gasUsed: traceResult.gasUsed.toString(),
              revertReason: traceResult.revertReason,
              trace: traceResult.trace
            }

      return formatResponse(result)
    }
  )
}
