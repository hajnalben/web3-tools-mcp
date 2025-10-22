import { type Address, decodeAbiParameters, isAddress, parseAbiParameters } from 'viem'
import { z } from 'zod'
import type { ChainName } from '../types.js'
import { getClientManager, SUPPORTED_CHAINS } from '../client.js'
import { createTool, formatResponse } from '../utils.js'

export default {
  get_storage_at: createTool(
    'Read Contract Storage',
    '⚠️ ADVANCED: Direct storage slot access with type decoding. Use for low-level contract inspection.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      address: z.string().describe('The contract address to inspect'),
      slot: z.string().describe('Storage slot (hex string, e.g., "0x0")'),
      abiType: z
        .string()
        .describe('ABI type for decoding (e.g., "uint256", "address", "bool", "bytes32")'),
      blockNumber: z.string().optional().describe('Block number (optional, defaults to latest)')
    }),
    async (args) => {
      if (!isAddress(args.address)) {
        throw new Error('Invalid address format')
      }

      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)
      const blockTag = args.blockNumber ? BigInt(args.blockNumber) : 'latest'

      try {
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
      } catch (error) {
        throw new Error(`Failed to get storage: ${error}`)
      }
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

      try {
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
      } catch (error) {
        throw new Error(`Failed to get block time: ${error}`)
      }
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
        .describe(
          'Trace type: "trace" (call tree, recommended), "vmTrace" (VM execution), "stateDiff" (state changes)'
        )
        .default('trace')
    }),
    async (args) => {
      const clientManager = getClientManager()
      const client = clientManager.getClient(args.chain as ChainName)

      try {
        // First get the transaction receipt to make sure it exists
        const transaction = await client.getTransaction({ hash: args.transactionHash as `0x${string}` })
        const receipt = await client.getTransactionReceipt({ hash: args.transactionHash as `0x${string}` })

        let traceResult: unknown = null

        // Perform the requested trace type
        switch (args.traceType) {
          case 'trace':
            try {
              // Use debug_traceTransaction for call trace
              traceResult = await client.request({
                method: 'debug_traceTransaction',
                params: [args.transactionHash, { tracer: 'callTracer' }]
              })
            } catch (e) {
              traceResult = { error: (e as Error).message }
            }
            break

          case 'vmTrace':
            try {
              traceResult = await client.request({
                method: 'debug_traceTransaction',
                params: [args.transactionHash, { tracer: 'prestateTracer' }]
              })
            } catch (e) {
              traceResult = { error: (e as Error).message }
            }
            break

          case 'stateDiff':
            try {
              traceResult = await client.request({
                method: 'debug_traceTransaction',
                params: [args.transactionHash, { tracer: 'stateDiffTracer' }]
              })
            } catch (e) {
              traceResult = { error: (e as Error).message }
            }
            break

          default:
            traceResult = {
              type: 'CALL',
              from: transaction.from,
              to: transaction.to,
              value: transaction.value?.toString() || '0',
              gas: transaction.gas?.toString() || '0',
              gasUsed: receipt.gasUsed?.toString() || '0',
              input: transaction.input,
              output: '0x',
              error: receipt.status === 'success' ? null : 'Transaction failed'
            }
        }

        const result = {
          success: true,
          chain: args.chain,
          transactionHash: args.transactionHash,
          traceType: args.traceType,
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
            logs: receipt.logs.map(log => ({
              address: log.address,
              topics: log.topics,
              data: log.data
            }))
          },
          trace: traceResult
        }

        return formatResponse(result)
      } catch (error) {
        throw new Error(`Transaction trace failed: ${error}`)
      }
    }
  )
}
