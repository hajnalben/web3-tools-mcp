import { z } from 'zod'
import { getWalletClient } from '../wallet-client.js'
import { getClientManager, SUPPORTED_CHAINS } from '../client.js'
import { encodeFunctionData, isAddress, parseAbiItem, parseUnits, toHex, type AbiFunction, type Address } from 'viem'
import { randomBytes } from 'node:crypto'
import type { ChainName } from '../types.js'
import { buildTxPreview, type RawTx, type TxPreview } from '../preview.js'
import { getPhoneSigner, pairingLinks } from '../walletconnect.js'
import { createTool, formatResponse } from '../utils.js'
import qrcode from 'qrcode-terminal'

/** Render a pairing URI as an ASCII QR, so it can be scanned straight from the chat. */
function qrFor(uri: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
}

function generateRequestId(): string {
  return randomBytes(16).toString('hex')
}

function requireAddress(label: string, address: string): Address {
  if (!isAddress(address)) throw new Error(`Invalid ${label}: ${address}`)
  return address
}

function explorerTxUrl(chain: ChainName, txHash: unknown): string {
  return `https://${getClientManager().getEtherscanDomain(chain)}/tx/${txHash}`
}

/**
 * Send a transaction for signing.
 *
 * A paired phone wins over the browser page: it was set up deliberately and is the only
 * option when there is no browser to open. Either way the transaction is decoded and
 * simulated first — the phone wallet shows its own summary, so the preview is returned to
 * the caller as well, where it can be read before the prompt is approved.
 */
async function requestSignature(chain: ChainName, tx: RawTx & { data?: string }) {
  const phone = getPhoneSigner()

  if (await phone?.isPaired()) {
    const session = await phone!.session()
    const from = session?.accounts[0]
    const preview = await buildTxPreview(chain, tx, from)

    const txHash = await phone!.request(chain, 'eth_sendTransaction', [
      { from, to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) }
    ])

    return { txHash, preview, signedWith: 'phone' as const }
  }

  const wallet = getWalletClient()
  await wallet.waitForSigner()

  const preview = await buildTxPreview(chain, tx, wallet.getAddress())

  return {
    txHash: await wallet.request({
      id: generateRequestId(),
      type: 'send_transaction',
      chain,
      data: { to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) },
      preview
    }),
    preview,
    signedWith: 'browser' as const
  }
}

/** What the caller should see about a transaction before it is approved. */
function previewSummary(preview: TxPreview) {
  return {
    action: preview.decoded?.intent ?? preview.decoded?.functionName,
    protocol: preview.decoded?.protocol ?? preview.toLabel,
    details: preview.decoded?.fields.map((f) => `${f.name}: ${f.value}${f.warning ? ` (${f.warning})` : ''}`),
    simulation: preview.simulation
  }
}

/**
 * WalletConnect rejects with a plain `{ code, message }` rather than an Error, which
 * String() renders as "[object Object]" — the reason a wallet gave for refusing is the
 * whole point of the message, so dig it out.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const { message, code, reason } = error as { message?: string; code?: number; reason?: string }
    const text = message ?? reason
    if (text) return code === undefined ? text : `${text} (code ${code})`
    return JSON.stringify(error)
  }
  return String(error)
}

function failure(error: unknown, message: string) {
  console.error('[Transaction]', message, '—', describeError(error))
  return formatResponse({
    success: false,
    error: describeError(error),
    message
  })
}

export default {
  send_native_token: createTool(
    'Send Native Token',
    'Send native tokens (ETH, MATIC, BNB, etc.) to an address. Simulates the transaction, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in native token (e.g., "0.1" for 0.1 ETH)'),
      data: z.string().optional().describe('Optional hex-encoded data to include with transaction')
    }),
    async (args) => {
      try {
        const to = requireAddress('recipient address', args.to)
        const value = `0x${parseUnits(args.amount, 18).toString(16)}`

        const { txHash, preview, signedWith } = await requestSignature(args.chain as ChainName, { to, value, data: args.data })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          to,
          amount: args.amount,
          signedWith,
          preview: previewSummary(preview),
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Transaction failed or was rejected')
      }
    }
  ),

  send_erc20_token: createTool(
    'Send ERC20 Token',
    'Send ERC20 tokens to an address. Simulates the transfer, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      tokenAddress: z.string().describe('ERC20 token contract address'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in token units (e.g., "100" for 100 USDC)'),
      decimals: z.number().optional().default(18).describe('Token decimals (default: 18)')
    }),
    async (args) => {
      try {
        const tokenAddress = requireAddress('token address', args.tokenAddress)
        const to = requireAddress('recipient address', args.to)

        const data = encodeFunctionData({
          abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
          args: [to, parseUnits(args.amount, args.decimals ?? 18)]
        })

        const { txHash, preview, signedWith } = await requestSignature(args.chain as ChainName, { to: tokenAddress, data, value: '0x0' })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          tokenAddress,
          to,
          amount: args.amount,
          signedWith,
          preview: previewSummary(preview),
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Token transfer failed or was rejected')
      }
    }
  ),

  call_contract_write: createTool(
    'Call Contract (Write)',
    'Call a state-changing contract function. Simulates the call, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      contractAddress: z.string().describe('Contract address'),
      functionAbi: z.string().describe('Function ABI definition (e.g., "function transfer(address to, uint256 amount)")'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Function arguments in order matching the ABI signature'),
      value: z.string().optional().describe('Optional native value to send with transaction (in ETH units, e.g., "0.1")')
    }),
    async (args) => {
      try {
        const contractAddress = requireAddress('contract address', args.contractAddress)
        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction

        const data = encodeFunctionData({
          abi: [abiItem],
          functionName: abiItem.name,
          args: (args.args || []) as readonly unknown[]
        })
        const value = args.value ? `0x${parseUnits(args.value, 18).toString(16)}` : '0x0'

        const { txHash, preview, signedWith } = await requestSignature(args.chain as ChainName, { to: contractAddress, data, value })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          contractAddress,
          functionName: abiItem.name,
          signedWith,
          preview: previewSummary(preview),
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Contract call failed or was rejected')
      }
    }
  ),

  sign_message: createTool(
    'Sign Message',
    'Sign a message with the connected wallet — a paired phone if there is one, otherwise the browser wallet.',
    z.object({
      message: z.string().describe('Message to sign')
    }),
    async (args) => {
      try {
        // Same precedence as transactions: a hosted server has no browser to fall back on.
        const phone = getPhoneSigner()
        const session = await phone?.session()

        const signature = session
          ? await phone!.request('mainnet', 'personal_sign', [toHex(args.message), session.accounts[0]])
          : await getWalletClient().request({
              id: generateRequestId(),
              type: 'sign_message',
              chain: 'any',
              data: { message: args.message }
            })

        return formatResponse({
          success: true,
          message: args.message,
          signature,
          signedWith: session ? 'phone' : 'browser',
          signatureType: 'personal_sign'
        })
      } catch (error) {
        return failure(error, 'Message signing failed or was rejected')
      }
    }
  ),

  pair_phone_wallet: createTool(
    'Pair Phone Wallet',
    'Pair a phone wallet over WalletConnect, so transactions are signed on the phone instead of in a browser. Returns a QR code to scan. Requires a WalletConnect project id.',
    z.object({
      chains: z
        .array(z.enum(SUPPORTED_CHAINS))
        .optional()
        .describe('Chains to request access to (defaults to every supported network)'),
      wallet: z
        .string()
        .optional()
        .describe('Name of the wallet to open, e.g. "rabby" — omit to list the common ones'),
      agent: z
        .string()
        .optional()
        .describe(
          'Who is asking, shown in the wallet approval dialog, e.g. "Claude Code". Say who you actually are — ' +
            'the user reads this when deciding whether to grant signing access.'
        )
    }),
    async (args) => {
      const phone = getPhoneSigner()
      if (!phone) {
        return formatResponse({
          success: false,
          message:
            'No WalletConnect project id configured. Get a free one at https://dashboard.reown.com and pass --walletconnect-project-id or set WALLETCONNECT_PROJECT_ID.'
        })
      }

      try {
        const existing = await phone.session()
        if (existing) {
          return formatResponse({
            alreadyPaired: true,
            address: existing.accounts[0],
            wallet: existing.peer,
            message: 'A phone wallet is already paired. Transactions will be sent to it.'
          })
        }

        const chains = (args.chains ?? SUPPORTED_CHAINS.filter((c) => c !== 'localhost')) as ChainName[]
        const uri = await phone.pair(chains, args.agent)
        const projectId = getClientManager().getConfig().walletConnectProjectId as string

        return formatResponse({
          qr: await qrFor(uri),
          uri,
          // For an agent running on the phone itself there is nothing to scan, so hand over
          // links that open the wallet directly. `wallet` narrows the list to one.
          openOnThisDevice: await pairingLinks(projectId, uri, args.wallet),
          // Approving grants an agent standing permission to request signatures, so the
          // wallet dialog names the agent rather than implying a website is connecting.
          shownInWallet: args.agent ? `${args.agent} via web3-tools-mcp` : 'web3-tools-mcp (AI agent)',
          message:
            'On another device: scan the QR with your wallet. On this device: tap one of the openOnThisDevice ' +
            'links, or copy the uri and paste it into your wallet under WalletConnect — every wallet supports ' +
            'that, and it is the one that always works. Then run wallet_status to confirm.'
        })
      } catch (error) {
        return failure(error, 'Could not start WalletConnect pairing')
      }
    }
  ),

  disconnect_phone_wallet: createTool(
    'Disconnect Phone Wallet',
    'End every WalletConnect session and drop the pairings underneath them. Use before pairing a different wallet, or to clear out attempts that were never approved.',
    z.object({}),
    async () => {
      const phone = getPhoneSigner()
      if (!phone) {
        return formatResponse({ success: false, message: 'No WalletConnect project id configured — nothing to disconnect.' })
      }

      try {
        const before = await phone.sessions()
        const removed = await phone.disconnectAll()

        return formatResponse({
          success: true,
          disconnectedSessions: removed.sessions,
          droppedPairings: removed.pairings,
          wallets: before.map((session) => `${session.peer ?? 'unknown wallet'} (${session.accounts[0]})`),
          message:
            removed.sessions || removed.pairings
              ? 'Disconnected. Transactions fall back to the browser wallet until a phone is paired again.'
              : 'Nothing was connected.'
        })
      } catch (error) {
        return failure(error, 'Could not disconnect the phone wallet')
      }
    }
  ),

  wallet_status: createTool(
    'Wallet Status',
    'Check if a wallet is connected to the browser interface',
    z.object({}),
    async () => {
      // A paired phone is the signer of record, so look there first. Connecting to the
      // browser relay before checking would start one on a hosted server, which has no
      // browser to open it in.
      const phone = getPhoneSigner()
      const phoneSession = await phone?.session().catch(() => undefined)
      if (phoneSession) {
        return formatResponse({
          connected: true,
          signer: 'phone',
          address: phoneSession.accounts[0],
          wallet: phoneSession.peer,
          chains: phoneSession.chains,
          message: 'A phone wallet is paired over WalletConnect. Transactions are sent there for signing.'
        })
      }

      // Served over HTTP means there is no browser on this machine, so the relay must not
      // be started at all — it would bind a port nobody can reach and advertise a localhost
      // URL that means nothing to whoever is asking.
      if (process.env.MCP_HTTP_PORT) {
        return formatResponse({
          connected: false,
          signer: 'none',
          hosted: true,
          message: phone
            ? 'No phone wallet paired. Run pair_phone_wallet — WalletConnect is the only way a hosted server can sign.'
            : 'This server is hosted and has no WalletConnect project id, so it cannot sign anything. Set WALLETCONNECT_PROJECT_ID.'
        })
      }

      const wallet = getWalletClient()
      try {
        await wallet.connect()
      } catch (error) {
        return failure(error, 'Wallet relay unavailable')
      }

      if (!wallet.isConnected()) wallet.openBrowser()

      return formatResponse({
        connected: wallet.isConnected(),
        signer: 'browser',
        phonePairing: phone ? 'Not paired — run pair_phone_wallet to sign from a phone.' : undefined,
        address: wallet.getAddress(),
        walletUrl: wallet.getUrl(),
        openTab: wallet.getPageUrl(),
        hosted: wallet.isRemote,
        message: wallet.isConnected()
          ? 'Wallet is connected and ready to sign transactions'
          : `No wallet connected. Open ${wallet.getUrl()} and connect your wallet.`
      })
    }
  )
}
