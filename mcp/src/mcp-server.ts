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
/**
 * What a client shows for this server, when it has somewhere to fetch it from.
 *
 * Only when a public URL is known: the icon has to be same-origin with the MCP endpoint and
 * fetchable without credentials, which is true of the signing page's own static files and
 * not true of anything a stdio server could offer. A client that cannot resolve it falls
 * back to a letter, which is what it already does.
 */
function identity() {
  const publicUrl = process.env.MCP_PUBLIC_URL?.replace(/\/$/, '')
  if (!publicUrl) return {}

  return {
    websiteUrl: publicUrl,
    icons: [
      { src: `${publicUrl}/icon.png`, mimeType: 'image/png', sizes: ['512x512'] },
      { src: `${publicUrl}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }
    ]
  }
}

export function createMcpServer(middleware?: ToolMiddleware): McpServer {
  const server = new McpServer(
    {
      name: 'web3-tools-mcp',
      version: packageJson.version,
      title: 'Web3 Tools',
      description: packageJson.description,
      ...identity()
    },
    { capabilities: { logging: {} } }
  )
  registerAllTools(server, middleware)
  return server
}
