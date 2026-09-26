import { type Address, formatEther, formatUnits, isAddress } from 'viem'
import { z } from 'zod'
import { tokenMeta } from '../../chain-meta.js'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import type { ChainName } from '../../types.js'
import { createTool, formatResponse, MAX_BATCH, rpcReason } from '../../utils.js'

const BalanceQuerySchema = z.object({
  chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
  address: z.string().describe('The address to check balance for'),
  tokenAddress: z.string().optional().describe('Token contract address (optional, if not provided returns native token balance)'),
  blockNumber: z.string().optional().describe('Block number to query (optional, defaults to latest)'),
  label: z.string().optional().describe('Optional label for batch results')
})

export default {
  get_balance: createTool(
    'Get Token Balances',
    'Retrieve native and ERC20 token balances for multiple addresses. BATCH OPTIMIZED - use for portfolio tracking, wallet monitoring.',
    z.object({
      queries: z
        .array(BalanceQuerySchema)
        .max(MAX_BATCH)
        .describe('Array of balance queries. Omit tokenAddress for native balance, include for ERC20.')
    }),
    async (args) => {
      // Group by chain and blockNumber for efficient processing
      const groupedQueries = new Map<string, typeof args.queries>()
      for (const item of args.queries) {
        const key = `${item.chain}:${item.blockNumber || 'latest'}`
        if (!groupedQueries.has(key)) {
          groupedQueries.set(key, [])
        }
        groupedQueries.get(key)!.push(item)
      }

      const allResults: Array<{
        index: number
        label?: string
        address: string
        tokenAddress?: string
        chain: string
        blockNumber: string
        success: boolean
        balance?: unknown
        balanceFormatted?: string
        decimals?: number | null
        error?: string
      }> = []

      // Process each group
      for (const [key, queries] of groupedQueries) {
        const [chain, blockNum] = key.split(':')
        const clientManager = getClientManager()
        const client = clientManager.getClient(chain as ChainName)
        const blockTag = blockNum === 'latest' ? 'latest' : BigInt(blockNum)

        // Process all queries in this group
        const results = await Promise.allSettled(
          queries.map(async (query) => {
            if (!isAddress(query.address)) {
              throw new Error(`Invalid address format: ${query.address}`)
            }

            const originalIndex = args.queries.indexOf(query)

            // Native token balance
            if (!query.tokenAddress) {
              const balance = await client.getBalance({
                address: query.address as Address,
                blockNumber: blockTag === 'latest' ? undefined : blockTag
              })

              return {
                index: originalIndex,
                label: query.label,
                address: query.address,
                chain: query.chain,
                blockNumber: query.blockNumber || 'latest',
                success: true,
                balance,
                balanceFormatted: formatEther(balance)
              }
            }

            // ERC20 token balance
            if (!isAddress(query.tokenAddress)) {
              throw new Error(`Invalid token address format: ${query.tokenAddress}`)
            }

            const [balance, { decimals }] = await Promise.all([
              client.readContract({
                address: query.tokenAddress as Address,
                abi: [
                  {
                    name: 'balanceOf',
                    type: 'function',
                    stateMutability: 'view',
                    inputs: [{ name: 'account', type: 'address' }],
                    outputs: [{ name: '', type: 'uint256' }]
                  }
                ],
                functionName: 'balanceOf',
                args: [query.address as Address],
                blockNumber: blockTag === 'latest' ? undefined : blockTag
              }),
              tokenMeta(chain as ChainName, query.tokenAddress).catch(() => ({ decimals: undefined }))
            ])

            return {
              index: originalIndex,
              label: query.label,
              address: query.address,
              tokenAddress: query.tokenAddress,
              chain: query.chain,
              blockNumber: query.blockNumber || 'latest',
              success: true,
              balance,
              // Unknown decimals leave only the raw balance: guessing 18 could be off by 10^12.
              balanceFormatted: decimals === undefined ? undefined : formatUnits(balance, decimals),
              decimals: decimals ?? null
            }
          })
        )

        // Process results
        results.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            allResults[result.value.index] = result.value
          } else {
            const query = queries[idx]!
            const originalIndex = args.queries.indexOf(query)
            allResults[originalIndex] = {
              index: originalIndex,
              label: query.label,
              address: query.address,
              tokenAddress: query.tokenAddress,
              chain: query.chain,
              blockNumber: query.blockNumber || 'latest',
              success: false,
              error: rpcReason(result.reason)
            }
          }
        })
      }

      return formatResponse({
        success: true,
        totalQueries: args.queries.length,
        successfulQueries: allResults.filter((r) => r.success).length,
        failedQueries: allResults.filter((r) => !r.success).length,
        results: allResults
      })
    }
  )
}
