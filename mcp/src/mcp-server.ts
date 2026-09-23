import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import packageJson from '../package.json' with { type: 'json' }
import { registerAllTools, type ToolMiddleware } from './tools/index.js'

/**
 * A server with every tool registered, ready to be connected to a transport.
 *
 * Exists so a host does not have to construct one itself. Reaching for the MCP SDK from
 * outside would mean a second copy of it, and two copies of the same class are two
 * unrelated types as far as a compiler is concerned — the error arrives at the seam rather
 * than where the mistake was made.
 */
export function createMcpServer(middleware?: ToolMiddleware): McpServer {
  const server = new McpServer({ name: 'web3-tools-mcp', version: packageJson.version }, { capabilities: { logging: {} } })
  registerAllTools(server, middleware)
  return server
}
