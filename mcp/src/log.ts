import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

type Level = 'debug' | 'info' | 'warning' | 'error'

let server: McpServer | undefined

/**
 * Forward logs to the MCP client as well as stderr. Only stdio attaches: it has one server
 * for the life of the process, while HTTP builds one per request and answers in plain JSON,
 * with no stream to push a notification down.
 */
export function attachLogServer(mcp: McpServer): void {
  server = mcp
}

/**
 * Always stderr, so a host's log capture sees it; stdout is the JSON-RPC stream in stdio
 * mode and must carry nothing else. Also sent to the client as `notifications/message`,
 * because some clients keep a server's messages but not its stderr.
 */
export function log(level: Level, logger: string, message: string): void {
  console.error(`[${logger}] ${message}`)
  // Before the client has initialised there is nothing to send to; losing those is fine.
  server?.sendLoggingMessage({ level, logger, data: message }).catch(() => {})
}
