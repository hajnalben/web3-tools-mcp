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
import { convertEventArgsToTypes, createTool, formatResponse, rpcReason } from '../../utils.js'

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

/** More than this is cut short, with the block to resume from. */
export const MAX_LOGS = 1000

interface DecodedLog {
  address: Address
  blockHash: Hex | null
  blockNumber: bigint | null
  data: Hex
  logIndex: number | null | undefined
  topics: readonly Hex[]
  transactionHash: Hex | null
  transactionIndex: number | null | undefined
  eventName: string
  args: unknown
}

function serializeLog(log: DecodedLog) {
  return {
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber?.toString(),
    data: log.data,
    logIndex: log.logIndex,
    topics: log.topics,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    decoded: { eventName: log.eventName, args: log.args }
  }
}

/** Resuming from `nextBlock` may repeat logs of that block already returned. */
export function capLogs(logs: DecodedLog[]) {
  if (logs.length <= MAX_LOGS) return { logs: logs.map(serializeLog) }
  return {
    logs: logs.slice(0, MAX_LOGS).map(serializeLog),
    truncated: true,
    nextBlock: logs[MAX_LOGS]?.blockNumber?.toString()
  }
}

/**
 * The same range eth_getLogs would scan — each end defaults to the latest block — in
 * Hypersync's terms, where `toBlock` is exclusive.
 */
export function hypersyncRange(fromBlock: string | undefined, toBlock: string | undefined, latest: number) {
  return {
    fromBlock: fromBlock ? Number(BigInt(fromBlock)) : latest,
    toBlock: (toBlock ? Number(BigInt(toBlock)) : latest) + 1
  }
}

/** One topic, or a list of alternatives for an OR filter. */
export function toTopics(value: unknown): Hex | Hex[] {
  return Array.isArray(value) ? value.map(toTopic) : toTopic(value)
}

async function getLogsWithHypersync(
  chainName: ChainName,
  abiItem: AbiEvent,
  hypersyncApiKey?: string,
  address?: string,
  fromBlock?: string,
  toBlock?: string,
  eventArgs?: Record<string, unknown>
): Promise<DecodedLog[]> {
  const hypersyncUrl = getClientManager().getHypersyncUrl(chainName)
  if (!hypersyncUrl) {
    throw new Error(`Hypersync not supported for chain: ${chainName}`)
  }

  const client = HypersyncClient.new({
    url: hypersyncUrl,
    bearerToken: hypersyncApiKey
  })

  const topic0 = keccak256(toBytes(toEventSignature(abiItem)))

  // Build topics array for filtering
  const topics: (Hex | Hex[] | null)[] = [topic0]

  // Add indexed parameter filtering if eventArgs provided
  if (eventArgs) {
    const indexedInputs = abiItem.inputs.filter((input) => input.indexed)

    for (let i = 0; i < indexedInputs.length && i < 3; i++) {
      const input = indexedInputs[i]
      const argValue = input?.name ? eventArgs[input.name] : undefined

      topics.push(argValue === undefined ? null : toTopics(argValue))
    }
  }

  const latest = fromBlock && toBlock ? 0 : await client.getHeight()
  const range = hypersyncRange(fromBlock, toBlock, latest)

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
    ...range,
    logs: [
      {
        address: address ? [address] : undefined,
        // An unfiltered position is an empty list, not a dropped entry: removing it would
        // slide every later filter up a slot and match on the wrong parameter.
        topics: topics.map((t) => (t === null ? [] : Array.isArray(t) ? t : [t]))
      }
    ]
  }

  // One response covers only part of a long range; `nextBlock` says where it stopped.
  const logs: Log[] = []
  for (let from = range.fromBlock; from < range.toBlock && logs.length <= MAX_LOGS; ) {
    const res = await client.get({ ...query, fromBlock: from })
    logs.push(...res.data.logs)
    if (res.nextBlock <= from) break
    from = res.nextBlock
  }

  return logs
    .map((log: Log): DecodedLog | null => {
      const topics = log.topics.filter((topic): topic is string => Boolean(topic)) as [Hex, ...Hex[]]
      const data = (log.data ?? '0x') as Hex

      try {
        const { args } = decodeEventLog({ abi: [abiItem], data, topics })
        return {
          address: log.address as Address,
          blockHash: log.blockHash as Hex,
          blockNumber: log.blockNumber !== undefined ? BigInt(log.blockNumber) : null,
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
    .filter((log): log is DecodedLog => log !== null)
}

export default {
  get_logs: createTool(
    'Query Contract Events',
    `Search and decode contract events with filtering. Uses viem with hypersync fallback. Specify address and block ranges for best performance. Returns at most ${MAX_LOGS} logs; past that, truncated is true and nextBlock says where to resume.`,
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      eventAbi: z
        .string()
        .describe('Event ABI definition (e.g., "event Transfer(address indexed from, address indexed to, uint256 value)")'),
      address: z.string().optional().describe('Contract address (RECOMMENDED for performance)'),
      fromBlock: z.string().optional().describe('Start block (defaults to the latest block)'),
      toBlock: z.string().optional().describe('End block, inclusive (defaults to the latest block)'),
      eventArgs: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
        .optional()
        .describe(
          'Filter by indexed parameters: {"from": "0x123...", "to": "0x456..."}. A list matches any of its values: {"to": ["0x1...", "0x2..."]}'
        )
    }),
    async (args) => {
      const clientManager = getClientManager()
      const chain = args.chain as ChainName
      const abiItem = parseAbiItem(args.eventAbi) as AbiEvent

      if (args.address && !isAddress(args.address)) {
        throw new Error(`Invalid contract address: ${args.address}`)
      }

      const eventArgs =
        args.eventArgs && Object.keys(args.eventArgs).length > 0
          ? convertEventArgsToTypes(args.eventArgs, abiItem.inputs)
          : undefined
      const fromBlockNum = args.fromBlock ? BigInt(args.fromBlock) : undefined
      const toBlockNum = args.toBlock ? BigInt(args.toBlock) : undefined

      const respond = (logs: DecodedLog[], dataSource: 'viem' | 'hypersync') => {
        const capped = capLogs(logs)
        return formatResponse({
          ...capped,
          eventSignature: toEventSignature(abiItem),
          chain: args.chain,
          fromBlock: fromBlockNum?.toString() || 'latest',
          toBlock: toBlockNum?.toString() || 'latest',
          count: capped.logs.length,
          dataSource,
          filters: {
            address: args.address || null,
            eventArgs: args.eventArgs || null
          }
        })
      }

      try {
        const logs = await clientManager.getClient(chain).getLogs({
          address: args.address as Address | undefined,
          event: abiItem,
          args: eventArgs,
          fromBlock: fromBlockNum,
          toBlock: toBlockNum
        })
        return respond(logs as DecodedLog[], 'viem')
      } catch (viemError) {
        if (!clientManager.getHypersyncUrl(chain)) {
          throw new Error(`Failed to get logs with viem (hypersync not available for ${args.chain}): ${rpcReason(viemError)}`)
        }
        console.warn(`Viem getLogs failed for ${args.chain}, trying hypersync fallback: ${rpcReason(viemError)}`)

        try {
          const logs = await getLogsWithHypersync(
            chain,
            abiItem,
            clientManager.getConfig().hypersyncApiKey,
            args.address,
            args.fromBlock,
            args.toBlock,
            eventArgs
          )
          return respond(logs, 'hypersync')
        } catch (hypersyncError) {
          throw new Error(
            `Both viem and hypersync failed. Viem error: ${rpcReason(viemError)}. Hypersync error: ${rpcReason(hypersyncError)}`
          )
        }
      }
    }
  )
}
