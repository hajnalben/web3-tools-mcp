import { readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Cards an MCP Apps host draws in place of a tool's JSON.
 *
 * The signing card shows what is being signed and follows it until it is mined; the pairing
 * card shows a scannable QR and follows it until a wallet approves. They show and follow,
 * never sign: a host's sandbox has no wallet, and the wallet's own confirmation screen is the
 * one a person should be trusting anyway. A host without MCP Apps ignores all of this and the
 * tool's text result is the whole answer.
 */
export const SIGNING_UI = 'ui://web3-tools/signing-request'
export const PAIRING_UI = 'ui://web3-tools/pair-wallet'
const MIME_TYPE = 'text/html;profile=mcp-app'

/** `_meta.ui` for every tool that has a card, or exists only for one. */
export const TOOL_UI: Record<string, { resourceUri?: string; visibility?: Array<'model' | 'app'> }> = {
  send_native_token: { resourceUri: SIGNING_UI },
  send_erc20_token: { resourceUri: SIGNING_UI },
  write_contract: { resourceUri: SIGNING_UI },
  pair_phone_wallet: { resourceUri: PAIRING_UI },
  wait_for_pairing: { visibility: ['app'] }
}

const CARDS = [
  { name: 'signing_request_card', title: 'Signing request', uri: SIGNING_UI, file: 'signing-request.html', ui: {} },
  // Copying the pairing link is the one way to pair that works in every wallet.
  {
    name: 'pair_wallet_card',
    title: 'Pair a phone wallet',
    uri: PAIRING_UI,
    file: 'pair-wallet.html',
    ui: { permissions: { clipboardWrite: {} } }
  }
]

export function registerCards(server: McpServer) {
  for (const card of CARDS) {
    server.registerResource(card.name, card.uri, { title: card.title, mimeType: MIME_TYPE }, async () => ({
      contents: [
        {
          uri: card.uri,
          mimeType: MIME_TYPE,
          // Copied beside this file by the build, as the clear-signing index is.
          text: readFileSync(new URL(`./${card.file}`, import.meta.url), 'utf8'),
          _meta: { ui: { prefersBorder: true, ...card.ui } }
        }
      ]
    }))
  }
}
