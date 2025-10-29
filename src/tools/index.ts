import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import advancedTools from './advanced.js'
import balanceTools from './balance.js'
import contractTools from './contract.js'
import contractInfoTools from './contract-info.js'
import ensTools from './ens.js'
import gasTools from './gas.js'
import logTools from './logs.js'
import signatureTools from './signatures.js'

const allToolDefinitions = {
  ...signatureTools,
  ...contractTools,
  ...contractInfoTools,
  ...balanceTools,
  ...logTools,
  ...advancedTools,
  ...ensTools,
  ...gasTools
} as const

// Register all tools with the MCP server
export function registerAllTools(server: McpServer) {
  Object.entries(allToolDefinitions).forEach(([name, tool]) => {
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema.shape
      },
      async (args: any, _extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        return await tool.handler(args)
      }
    )
  })
}
