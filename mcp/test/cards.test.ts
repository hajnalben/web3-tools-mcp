import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createMcpServer } from '../src/mcp-server.js'
import { PAIRING_UI, SIGNING_UI } from '../src/ui.js'

/**
 * An MCP Apps host draws a card only if the tool points at it and the resource reads back
 * as an app; any other host sees the tools exactly as before.
 */
async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createMcpServer().connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  return client
}

describe('cards', () => {
  it('are linked from the tools that send transactions and pair wallets, and nothing else', async () => {
    const { tools } = await (await connect()).listTools()
    const meta = (name: string) => tools.find((tool) => tool.name === name)?._meta

    for (const name of ['send_native_token', 'send_erc20_token', 'write_contract']) {
      expect(meta(name)).toEqual({ ui: { resourceUri: SIGNING_UI } })
    }
    expect(meta('pair_phone_wallet')).toEqual({ ui: { resourceUri: PAIRING_UI } })
    expect(meta('sign_message')).toBeUndefined()
    expect(meta('get_gas_price')).toBeUndefined()
  })

  it('keep the pairing card’s own tool away from the agent', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.find((tool) => tool.name === 'wait_for_pairing')?._meta).toEqual({ ui: { visibility: ['app'] } })
  })

  it('read back as MCP Apps that speak the handshake', async () => {
    const client = await connect()
    for (const uri of [SIGNING_UI, PAIRING_UI]) {
      const { contents } = await client.readResource({ uri })
      expect(contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app' })
      expect(contents[0].text).toContain("'ui/initialize'")
    }
  })
})
