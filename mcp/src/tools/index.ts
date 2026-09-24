import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { identityFrom } from '../context.js'
import type { ToolResult } from '../types.js'
import advancedTools from './read/advanced.js'
import balanceTools from './read/balance.js'
import contractTools from './read/contract.js'
import contractInfoTools from './read/contract-info.js'
import ensTools from './read/ens.js'
import gasTools from './read/gas.js'
import logTools from './read/logs.js'
import signatureTools from './read/signatures.js'
import signingRequestTools from './read/signing.js'
import transactionTools from './sign/transactions.js'
import walletTools from './sign/wallet.js'

/**
 * What a tool does with a wallet, which is the line everything else divides along.
 *
 * `read` answers questions about a chain and costs an RPC call. `sign` puts a transaction
 * in front of somebody's wallet, and is the reason identity and rooms exist. A host pricing
 * or rate-limiting tool calls almost always wants this distinction, and taking it from the
 * folder a tool lives in means it cannot drift from a hand-kept list.
 */
export type ToolGroup = 'read' | 'sign'

const readTools = {
  ...signatureTools,
  ...contractTools,
  ...contractInfoTools,
  ...balanceTools,
  ...logTools,
  ...advancedTools,
  ...ensTools,
  ...gasTools,
  // A signature already asked for and paid for; collecting it is not a second request.
  ...signingRequestTools
} as const

const signTools = {
  ...transactionTools,
  ...walletTools
} as const

const allToolDefinitions = { ...readTools, ...signTools } as const

const groups = new Map<string, ToolGroup>([
  ...Object.keys(readTools).map((name) => [name, 'read'] as const),
  ...Object.keys(signTools).map((name) => [name, 'sign'] as const)
])

/** The group a tool belongs to, for a host deciding what it costs or who may call it. */
export function toolGroup(name: string): ToolGroup | undefined {
  return groups.get(name)
}

/**
 * Wraps every tool call, for a host that needs to say who may run what.
 *
 * Deliberately only the tool's name, its group and who is calling: enough to count calls,
 * refuse them past a limit and record what was used, without this package taking a view on
 * any of it. Throwing refuses the call, and the message reaches the agent — so it should
 * say what to do about it. Whatever the returned promise settles as is what the caller
 * sees, so a host can also time a call or meter it once it has succeeded.
 */
export type ToolMiddleware = (
  call: { tool: string; group: ToolGroup; identity: string },
  run: () => Promise<ToolResult>
) => Promise<ToolResult>

export function registerAllTools(server: McpServer, middleware?: ToolMiddleware) {
  Object.entries(allToolDefinitions).forEach(([name, tool]) => {
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema.shape
      },
      async (args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        // Passed to every handler; the ones that reach a signer must say whose it is.
        const identity = identityFrom(extra.authInfo)
        const run = () => tool.handler(args, identity)
        const group = toolGroup(name) as ToolGroup
        return await (middleware ? middleware({ tool: name, group, identity }, run) : run())
      }
    )
  })
}
