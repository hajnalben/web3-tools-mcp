import { randomBytes } from 'node:crypto'
import qrcode from 'qrcode-terminal'
import { type AbiFunction, type Address, encodeFunctionData, isAddress, parseAbiItem, parseUnits, toHex } from 'viem'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../client.js'
import { buildTxPreview, type RawTx, type TxPreview } from '../preview.js'
import type { ChainName } from '../types.js'
import { createTool, formatResponse } from '../utils.js'
import { getWalletClient } from '../wallet-client.js'
import { getPhoneSigner, pairingLinks } from '../walletconnect.js'

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

function explorerTxUrl(chain: ChainName, txHash: unknown): string | undefined {
  return getClientManager().explorerUrl(chain, `/tx/${txHash}`)
}

/**
 * Which wallet to send the request to. Deliberately required on every signing tool: both
 * signers can be live at once, and only the person holding the devices knows which one is
 * actually to hand. Guessing strands the request in front of a screen nobody is looking at.
 *
 * Either way the transaction is decoded and simulated first — the wallet shows its own
 * summary, so the preview is returned to the caller too, to be read before approving.
 */
const SignWithSchema = z
  .enum(['phone', 'browser'])
  .describe(
    'Where to approve this: "phone" for a paired WalletConnect wallet, "browser" for the wallet signing page. Ask the user which they want — do not assume, even when only one is connected. Call wallet_status first: it says which signers are ready, and when no signing page is open it returns walletUrl. In that case give the user that link, ask them to open it and connect a wallet, and only call this once they confirm — a signing request cannot reach a page nobody has open.'
  )

type SignWith = z.infer<typeof SignWithSchema>

async function signOnPhone(chain: ChainName, tx: RawTx & { data?: string }) {
  const phone = getPhoneSigner()
  if (!phone) {
    throw new Error(
      'Phone signing is not configured on this server. Set WALLETCONNECT_PROJECT_ID, or sign in the browser instead.'
    )
  }
  if (!(await phone.isPaired())) {
    throw new Error('No phone wallet is paired. Run pair_phone_wallet and scan the QR, or sign in the browser instead.')
  }

  const session = await phone.session()
  const from = session?.accounts[0]
  const preview = await buildTxPreview(chain, tx, from)

  const txHash = await phone.request(chain, 'eth_sendTransaction', [
    { from, to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) }
  ])

  return { txHash, preview, signedWith: 'phone' as const }
}

async function requestSignature(chain: ChainName, tx: RawTx & { data?: string }, signWith: SignWith) {
  if (signWith === 'phone') return signOnPhone(chain, tx)

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
    'Send native tokens (ETH, MATIC, BNB, etc.) to an address. Simulates the transaction, then sends it to the signer you choose for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in native token (e.g., "0.1" for 0.1 ETH)'),
      data: z.string().optional().describe('Optional hex-encoded data to include with transaction'),
      signWith: SignWithSchema
    }),
    async (args) => {
      try {
        const to = requireAddress('recipient address', args.to)
        const value = `0x${parseUnits(args.amount, 18).toString(16)}`

        const { txHash, preview, signedWith } = await requestSignature(
          args.chain as ChainName,
          { to, value, data: args.data },
          args.signWith
        )

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
    'Send ERC20 tokens to an address. Simulates the transfer, then sends it to the signer you choose for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      tokenAddress: z.string().describe('ERC20 token contract address'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in token units (e.g., "100" for 100 USDC)'),
      decimals: z.number().optional().default(18).describe('Token decimals (default: 18)'),
      signWith: SignWithSchema
    }),
    async (args) => {
      try {
        const tokenAddress = requireAddress('token address', args.tokenAddress)
        const to = requireAddress('recipient address', args.to)

        const data = encodeFunctionData({
          abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
          args: [to, parseUnits(args.amount, args.decimals ?? 18)]
        })

        const { txHash, preview, signedWith } = await requestSignature(
          args.chain as ChainName,
          {
            to: tokenAddress,
            data,
            value: '0x0'
          },
          args.signWith
        )

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

  write_contract: createTool(
    'Write Contract',
    'Send a transaction that calls a state-changing contract function. Simulates it first, then asks your wallet to approve. Costs gas.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      contractAddress: z.string().describe('Contract address'),
      functionAbi: z.string().describe('Function ABI definition (e.g., "function transfer(address to, uint256 amount)")'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Function arguments in order matching the ABI signature'),
      value: z.string().optional().describe('Optional native value to send with transaction (in ETH units, e.g., "0.1")'),
      signWith: SignWithSchema
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

        const { txHash, preview, signedWith } = await requestSignature(
          args.chain as ChainName,
          {
            to: contractAddress,
            data,
            value
          },
          args.signWith
        )

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
    'Sign a message with your wallet, on whichever signer you choose.',
    z.object({
      message: z.string().describe('Message to sign'),
      signWith: SignWithSchema
    }),
    async (args) => {
      try {
        let signature: unknown

        if (args.signWith === 'phone') {
          const phone = getPhoneSigner()
          const session = await phone?.session()
          if (!session) {
            throw new Error('No phone wallet is paired. Run pair_phone_wallet and scan the QR, or sign in the browser instead.')
          }
          signature = await phone!.request('mainnet', 'personal_sign', [toHex(args.message), session.accounts[0]])
        } else {
          await getWalletClient().waitForSigner()
          signature = await getWalletClient().request({
            id: generateRequestId(),
            type: 'sign_message',
            chain: 'any',
            data: { message: args.message }
          })
        }

        return formatResponse({
          success: true,
          message: args.message,
          signature,
          signedWith: args.signWith,
          signatureType: 'personal_sign'
        })
      } catch (error) {
        return failure(error, 'Message signing failed or was rejected')
      }
    }
  ),

  pair_phone_wallet: createTool(
    'Pair Phone Wallet',
    'Pair a phone wallet over WalletConnect, so transactions are signed on the phone instead of in a browser. ' +
      'Returns a QR to scan plus links that open a wallet directly — show those to the user as clickable links. ' +
      'Requires a WalletConnect project id.',
    z.object({
      chains: z
        .array(z.enum(SUPPORTED_CHAINS))
        .optional()
        .describe('Chains to request access to (defaults to every supported network)'),
      wallet: z.string().optional().describe('Name of the wallet to open, e.g. "rabby" — omit to list the common ones'),
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
            'No WalletConnect project id configured. Get a free one at https://dashboard.walletconnect.com and pass --walletconnect-project-id or set WALLETCONNECT_PROJECT_ID.'
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
          howToPresent:
            'Render each openOnThisDevice entry as a clickable link labelled with the wallet name, and show the ' +
            'uri as copyable text. On a phone that tap is the whole flow. Show the QR only when the user is on a ' +
            'different device from their wallet — it is unreadable inline on the phone that holds the wallet. ' +
            'If a link does nothing, some clients drop custom schemes like rabby://, so tell them to paste the uri.',
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
      // A paired phone is the signer of record, so look there first — it needs no page
      // open and no tab focused.
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
          : `No signing page is open. Give the user this link, ask them to open it and connect a wallet, then retry: ${wallet.getUrl()}`
      })
    }
  )
}
