import { HypersyncClient, type Log, LogField } from '@envio-dev/hypersync-client'
import {
  type AbiEvent,
  type Address,
  decodeEventLog,
  type Hex,
  isAddress,
  keccak256,
  numberToHex,
  padHex,
  parseAbiItem,
  toBytes,
  toEventSignature
} from 'viem'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import type { ChainName } from '../../types.js'
import { convertEventArgsToTypes, createTool, formatResponse } from '../../utils.js'

/**
 * A topic is always 32 bytes, so an address, a number or a short hex value has to be
 * left-padded to fit. Passing one through unpadded is rejected outright by Hypersync.
 */
function toTopic(value: unknown): Hex {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return padHex(numberToHex(value), { size: 32 })
  }
  if (typeof value === 'boolean') {
    return padHex(value ? '0x01' : '0x00', { size: 32 })
  }
  if (typeof value === 'string' && (isAddress(value) || value.startsWith('0x'))) {
    return padHex(value.toLowerCase() as Hex, { size: 32 })
  }
  throw new Error(`Cannot filter on indexed value ${JSON.stringify(value)} — expected an address, number or hex string`)
}

async function getLogsWithHypersync(
  chainName: ChainName,
  eventAbi: string,
  hypersyncApiKey?: string,
  address?: string,
  fromBlock?: string,
  toBlock?: string,
  eventArgs?: Record<string, unknown>
) {
  const hypersyncUrl = getClientManager().getHypersyncUrl(chainName)
  if (!hypersyncUrl) {
    throw new Error(`Hypersync not supported for chain: ${chainName}`)
  }

  const client = HypersyncClient.new({
    url: hypersyncUrl,
    bearerToken: hypersyncApiKey
  })

  const abiItem = parseAbiItem(eventAbi) as AbiEvent
  const eventSignature = toEventSignature(abiItem)
  const topic0 = keccak256(toBytes(eventSignature))

  // Build topics array for filtering
  const topics: (string | string[] | null)[] = [topic0]

  // Add indexed parameter filtering if eventArgs provided
  if (eventArgs && Object.keys(eventArgs).length > 0) {
    const indexedInputs = abiItem.inputs.filter((input) => input.indexed)

    for (let i = 0; i < indexedInputs.length && i < 3; i++) {
      const input = indexedInputs[i]
      const argValue = input?.name ? eventArgs[input.name] : undefined

      topics.push(argValue === undefined ? null : toTopic(argValue))
    }
  }

  const query = {
    fieldSelection: {
      log: [
        LogField.Address,
        LogField.Topic0,
        LogField.Topic1,
        LogField.Topic2,
        LogField.Topic3,
        LogField.Data,
        LogField.BlockNumber,
        LogField.BlockHash,
        LogField.TransactionHash,
        LogField.TransactionIndex,
        LogField.LogIndex
      ]
    },
    fromBlock: fromBlock ? Number.parseInt(fromBlock, 10) : 0,
    toBlock: toBlock ? Number.parseInt(toBlock, 10) : undefined,
    logs: [
      {
        address: address ? [address] : undefined,
        // An unfiltered position is an empty list, not a dropped entry: removing it would
        // slide every later filter up a slot and match on the wrong parameter.
        topics: topics.map((t) => (t === null ? [] : Array.isArray(t) ? t : [t]))
      }
    ]
  }

  const res = await client.get(query)

  // Convert hypersync logs to viem-compatible format
  const decodedLogs = res.data.logs
    .map((log: Log) => {
      const topics = log.topics.filter((topic): topic is string => Boolean(topic)) as [Hex, ...Hex[]]
      const data = (log.data ?? '0x') as Hex

      try {
        const { args } = decodeEventLog({ abi: [abiItem], data, topics })
        return {
          address: log.address as Address,
          blockHash: log.blockHash as Hex,
          blockNumber: log.blockNumber ? BigInt(log.blockNumber) : 0n,
          data,
          logIndex: log.logIndex,
          topics,
          transactionHash: log.transactionHash as Hex,
          transactionIndex: log.transactionIndex,
          eventName: abiItem.name,
          args: args ?? {}
        }
      } catch (error) {
        console.warn('Failed to decode log:', error)
        return null
      }
    })
    .filter((log): log is NonNullable<typeof log> => log !== null)

  return decodedLogs
}

export default {
  get_logs: createTool(
    'Query Contract Events',
    'Search and decode contract events with filtering. Uses viem with hypersync fallback. Specify address and block ranges for best performance.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      eventAbi: z
        .string()
        .describe('Event ABI definition (e.g., "event Transfer(address indexed from, address indexed to, uint256 value)")'),
      address: z.string().optional().describe('Contract address (RECOMMENDED for performance)'),
      fromBlock: z.string().optional().describe('Start block (defaults to latest-1000)'),
      toBlock: z.string().optional().describe('End block (defaults to latest)'),
      eventArgs: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
        .optional()
        .describe('Filter by indexed parameters: {"from": "0x123...", "to": "0x456..."}')
    }),
    async (args) => {
      const clientManager = getClientManager()
      const config = (clientManager as any).config

      // First try with regular viem client
      try {
        const client = clientManager.getClient(args.chain as ChainName)
        const abiItem = parseAbiItem(args.eventAbi) as AbiEvent

        // Determine block range
        const fromBlockNum = args.fromBlock ? BigInt(args.fromBlock) : undefined
        const toBlockNum = args.toBlock ? BigInt(args.toBlock) : undefined

        // Prepare getLogs parameters
        const getLogsParams: {
          address?: Address
          event: AbiEvent
          fromBlock?: bigint
          toBlock?: bigint
          args?: Record<string, unknown>
        } = {
          event: abiItem,
          fromBlock: fromBlockNum,
          toBlock: toBlockNum
        }

        // Add address filter if provided
        if (args.address && isAddress(args.address)) {
          getLogsParams.address = args.address as Address
        }

        // Add event argument filters if provided
        if (args.eventArgs && Object.keys(args.eventArgs).length > 0) {
          // Convert event arguments to proper types based on ABI
          const convertedEventArgs = convertEventArgsToTypes(args.eventArgs, abiItem.inputs)
          getLogsParams.args = convertedEventArgs
        }

        // Use client.getLogs with proper typing
        const logs = await client.getLogs(getLogsParams)

        // Convert logs to serializable format
        const serializedLogs = logs.map((log) => {
          const baseLogData = {
            address: log.address,
            blockHash: log.blockHash,
            blockNumber: log.blockNumber?.toString(),
            data: log.data,
            logIndex: log.logIndex,
            topics: log.topics,
            transactionHash: log.transactionHash,
            transactionIndex: log.transactionIndex
          }

          return {
            ...baseLogData,
            decoded: {
              eventName: log.eventName,
              args: log.args
            }
          }
        })

        return formatResponse({
          logs: serializedLogs,
          eventSignature: toEventSignature(abiItem),
          chain: args.chain,
          fromBlock: fromBlockNum?.toString() || 'latest',
          toBlock: toBlockNum?.toString() || 'latest',
          count: logs.length,
          dataSource: 'viem',
          filters: {
            address: args.address || null,
            eventArgs: args.eventArgs || null
          }
        })
      } catch (viemError) {
        // If viem fails and we have hypersync support for this chain, try hypersync as fallback
        if (clientManager.getHypersyncUrl(args.chain as ChainName)) {
          console.warn(`Viem getLogs failed for ${args.chain}, trying hypersync fallback:`, viemError)

          try {
            const hypersyncLogs = await getLogsWithHypersync(
              args.chain as ChainName,
              args.eventAbi,
              config.hypersyncApiKey,
              args.address,
              args.fromBlock,
              args.toBlock,
              args.eventArgs
            )

            const abiItem = parseAbiItem(args.eventAbi) as AbiEvent
            const fromBlockNum = args.fromBlock ? BigInt(args.fromBlock) : undefined
            const toBlockNum = args.toBlock ? BigInt(args.toBlock) : undefined

            // Convert hypersync logs to the same format as viem logs
            const serializedLogs = hypersyncLogs.map((log) => {
              const baseLogData = {
                address: log.address,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber?.toString(),
                data: log.data,
                logIndex: log.logIndex,
                topics: log.topics,
                transactionHash: log.transactionHash,
                transactionIndex: log.transactionIndex
              }

              return {
                ...baseLogData,
                decoded: {
                  eventName: log.eventName,
                  args: log.args
                }
              }
            })

            return formatResponse({
              logs: serializedLogs,
              eventSignature: toEventSignature(abiItem),
              chain: args.chain,
              fromBlock: fromBlockNum?.toString() || 'latest',
              toBlock: toBlockNum?.toString() || 'latest',
              count: hypersyncLogs.length,
              dataSource: 'hypersync',
              filters: {
                address: args.address || null,
                eventArgs: args.eventArgs || null
              }
            })
          } catch (hypersyncError) {
            throw new Error(`Both viem and hypersync failed. Viem error: ${viemError}. Hypersync error: ${hypersyncError}`)
          }
        } else {
          // No hypersync fallback available for this chain
          throw new Error(`Failed to get logs with viem (hypersync not available for ${args.chain}): ${viemError}`)
        }
      }
    }
  )
}
