import { randomBytes } from 'node:crypto'
import { type AbiFunction, type Address, encodeFunctionData, isAddress, parseAbiItem, parseUnits, toHex } from 'viem'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import { log } from '../../log.js'
import { buildTxPreview, type RawTx, type TxPreview } from '../../preview.js'
import type { ChainName } from '../../types.js'
import { createTool, formatResponse } from '../../utils.js'
import { getWalletClient } from '../../wallet-client.js'
import { getPhoneSigner } from '../../walletconnect.js'
import { failure } from './errors.js'

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

/** Only meaningful with several wallets paired; wallet_status lists them. */
const AccountSchema = z
  .string()
  .optional()
  .describe(
    'Which paired wallet to ask, by address. Only needed when wallet_status reports more than one — omit it and the most recently paired one is used.'
  )

/** This identity's phone wallet and the address to sign from, or an error saying what to do. */
async function requirePhoneSession(identity: string, account?: string) {
  const phone = getPhoneSigner()
  if (!phone) {
    throw new Error(
      'Phone signing is not configured on this server. Set WALLETCONNECT_PROJECT_ID, or sign in the browser instead.'
    )
  }

  const session = await phone.session(identity, account)
  if (!session) {
    const paired = await phone.sessions(identity)
    throw new Error(
      account
        ? `No paired wallet holds ${account}. Paired: ${paired.flatMap((s) => s.accounts).join(', ') || 'none'}.`
        : 'No phone wallet is paired. Run pair_phone_wallet and scan the QR, or sign in the browser instead.'
    )
  }

  // A session can expose several addresses; the one asked for, spelled as the wallet
  // reported it, or its first when the caller did not choose.
  const wanted = account?.toLowerCase()
  const from = session.accounts.find((a) => a.toLowerCase() === wanted) ?? session.accounts[0]
  return { phone, session, from }
}

async function signOnPhone(chain: ChainName, tx: RawTx & { data?: string }, identity: string, account?: string) {
  const { phone, from } = await requirePhoneSession(identity, account)
  const preview = await buildTxPreview(chain, tx, from)

  const txHash = await phone.request(
    chain,
    'eth_sendTransaction',
    [{ from, to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) }],
    { identity, account }
  )

  return { txHash, preview, signedWith: 'phone' as const }
}

async function requestSignature(
  chain: ChainName,
  tx: RawTx & { data?: string },
  signWith: SignWith,
  identity: string,
  account?: string
) {
  log('info', 'Transaction', `${chain} → ${tx.to}, signing with ${signWith}`)
  if (signWith === 'phone') return signOnPhone(chain, tx, identity, account)

  const wallet = getWalletClient(identity)
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

export default {
  send_native_token: createTool(
    'Send Native Token',
    'Send native tokens (ETH, MATIC, BNB, etc.) to an address. Simulates the transaction, then sends it to the signer you choose for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in native token (e.g., "0.1" for 0.1 ETH)'),
      data: z.string().optional().describe('Optional hex-encoded data to include with transaction'),
      signWith: SignWithSchema,
      account: AccountSchema
    }),
    async (args, identity) => {
      try {
        const to = requireAddress('recipient address', args.to)
        const value = `0x${parseUnits(args.amount, 18).toString(16)}`

        const { txHash, preview, signedWith } = await requestSignature(
          args.chain as ChainName,
          { to, value, data: args.data },
          args.signWith,
          identity,
          args.account
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
      signWith: SignWithSchema,
      account: AccountSchema
    }),
    async (args, identity) => {
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
          args.signWith,
          identity,
          args.account
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
      signWith: SignWithSchema,
      account: AccountSchema
    }),
    async (args, identity) => {
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
          args.signWith,
          identity,
          args.account
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
      signWith: SignWithSchema,
      account: AccountSchema
    }),
    async (args, identity) => {
      try {
        let signature: unknown

        if (args.signWith === 'phone') {
          const { phone, from } = await requirePhoneSession(identity, args.account)
          signature = await phone.request('mainnet', 'personal_sign', [toHex(args.message), from], {
            identity,
            account: args.account
          })
        } else {
          const wallet = getWalletClient(identity)
          await wallet.waitForSigner()
          signature = await wallet.request({
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
  )
}
