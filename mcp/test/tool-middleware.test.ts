import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_IDENTITY } from '../src/context.js'
import { registerAllTools, type ToolMiddleware, toolGroup } from '../src/tools/index.js'

/**
 * The seam a host uses to say who may run what — per-identity rate limits, usage records,
 * paid tiers. This package supplies the hook and no policy, so an unwrapped server behaves
 * exactly as it always did.
 */
function callTool(middleware?: ToolMiddleware) {
  const server = new McpServer({ name: 'test', version: '0' })
  const registered = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>()

  // registerTool is what registerAllTools drives; capture the callbacks it installs.
  server.registerTool = ((name: string, _config: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => {
    registered.set(name, handler)
    return undefined
  }) as unknown as typeof server.registerTool

  registerAllTools(server, middleware)
  return registered
}

describe('tool middleware', () => {
  it('sees the tool and the caller, and can refuse the call', async () => {
    const seen: Array<{ tool: string; group: string; identity: string }> = []

    const tools = callTool(async (call, run) => {
      seen.push(call)
      if (call.tool === 'get_gas_price') throw new Error('Daily limit reached')
      return run()
    })

    await expect(tools.get('get_gas_price')?.({ chain: 'mainnet' }, {})).rejects.toThrow('Daily limit reached')
    expect(seen).toEqual([{ tool: 'get_gas_price', group: 'read', identity: DEFAULT_IDENTITY }])
  })

  /**
   * Whether a tool puts a transaction in front of a wallet is the distinction a host prices
   * or gates on, and it comes from where the tool lives rather than a list to keep in step.
   */
  it('labels each tool read or sign', () => {
    expect(toolGroup('get_balance')).toBe('read')
    expect(toolGroup('trace_transaction')).toBe('read')
    expect(toolGroup('send_native_token')).toBe('sign')
    expect(toolGroup('write_contract')).toBe('sign')
    expect(toolGroup('pair_phone_wallet')).toBe('sign')
    expect(toolGroup('wallet_status')).toBe('sign')
    expect(toolGroup('no_such_tool')).toBeUndefined()
  })

  it('leaves every tool registered and callable when no middleware is given', () => {
    const tools = callTool()

    expect(tools.size).toBeGreaterThan(20)
    expect(tools.has('wallet_status')).toBe(true)
  })
})
