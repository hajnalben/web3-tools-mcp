import { randomBytes } from 'node:crypto'
import { type AbiFunction, type Address, encodeFunctionData, isAddress, parseAbiItem, parseUnits, toHex } from 'viem'
import { z } from 'zod'
import { tokenMeta } from '../../chain-meta.js'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import { log } from '../../log.js'
import { buildTxPreview, type RawTx, type TxPreview } from '../../preview.js'
import { type SigningProgress, type SigningRequest, signingCall } from '../../signing-requests.js'
import type { ChainName } from '../../types.js'
import { convertArgumentsToTypes, createTool, formatResponse } from '../../utils.js'
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

/** The phone's wallet reaches chains through its own RPC, which cannot see this machine's node. */
function requireReachable(chain: ChainName, signWith: SignWith) {
  if (chain === 'localhost' && signWith === 'phone') {
    throw new Error('A phone wallet cannot sign on localhost: it has no route to this machine\'s node. Use signWith "browser".')
  }
}

/**
 * The token's own decimals. A caller-supplied figure is only a cross-check: trusting a wrong
 * one moves orders of magnitude more or less than was asked for.
 */
async function tokenDecimals(chain: ChainName, token: Address, claimed?: number): Promise<number> {
  const onChain = (await tokenMeta(chain, token).catch(() => undefined))?.decimals
  if (onChain === undefined) {
    if (claimed === undefined) {
      throw new Error(
        `Could not read decimals() from ${token} on ${chain}. Check it is an ERC20 token on this chain, or pass "decimals" explicitly.`
      )
    }
    return claimed
  }
  if (claimed !== undefined && claimed !== onChain) {
    throw new Error(`"decimals" was ${claimed}, but ${token} reports ${onChain} on ${chain}. Nothing was sent.`)
  }
  return onChain
}

/** Long enough for a congested chain, short enough that a stuck one is reported rather than hung on. */
const RECEIPT_TIMEOUT = 180_000

/**
 * Wait for the transaction to actually be mined.
 *
 * A hash means broadcast, nothing more. Reporting that as success is how a reverted
 * transaction — gas spent, nothing done — gets read back as if it had worked.
 */
async function confirm(chain: ChainName, txHash: unknown) {
  try {
    const receipt = await getClientManager()
      .getClient(chain)
      .waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: RECEIPT_TIMEOUT })

    return {
      status: receipt.status === 'success' ? ('mined' as const) : ('reverted' as const),
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString()
    }
  } catch (error) {
    // Still out there — it simply has not been mined yet. Not a failure, and saying so beats
    // claiming either outcome.
    log('warning', 'Transaction', `No receipt for ${txHash} yet: ${(error as Error).message}`)
    return { status: 'broadcast' as const }
  }
}

async function signOnPhone(
  chain: ChainName,
  tx: RawTx & { data?: string },
  identity: string,
  account: string | undefined,
  progress: SigningProgress
) {
  const { phone, from } = await requirePhoneSession(identity, account)
  const preview = await buildTxPreview(chain, tx, from)

  const txHash = await phone.request(
    chain,
    'eth_sendTransaction',
    [{ from, to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) }],
    { identity, account, onWaiting: progress.waiting }
  )

  progress.mining(String(txHash))
  return { txHash, preview, signedWith: 'phone' as const, receipt: await confirm(chain, txHash) }
}

/**
 * `onWaiting` is what decides whether the tool call waits.
 *
 * The browser signer never calls it: the tab is opened and the title flashes, so somebody is
 * looking within seconds and the grace period is worth spending. A phone is only as loud as
 * the wallet, and the two people actually use push nothing at all — so that path hands back
 * a request id as soon as the wallet has it, rather than spending the grace on silence.
 */
async function requestSignature(
  chain: ChainName,
  tx: RawTx & { data?: string },
  signWith: SignWith,
  identity: string,
  account: string | undefined,
  progress: SigningProgress
) {
  log('info', 'Transaction', `${chain} → ${tx.to}, signing with ${signWith}`)
  requireReachable(chain, signWith)
  if (signWith === 'phone') return signOnPhone(chain, tx, identity, account, progress)

  const wallet = getWalletClient(identity)
  await wallet.waitForSigner()

  const preview = await buildTxPreview(chain, tx, wallet.getAddress())

  const txHash = await wallet.request({
    id: generateRequestId(),
    type: 'send_transaction',
    chain,
    data: { to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) },
    preview
  })

  progress.mining(String(txHash))
  return { txHash, preview, signedWith: 'browser' as const, receipt: await confirm(chain, txHash) }
}

/**
 * What to tell the agent when nobody has approved yet.
 *
 * Emphatically not a failure: the request is in front of a wallet right now. Calling the
 * signing tool again would put a second, separately approvable request there — so the way
 * back is the id, and this says so plainly enough that an agent does not retry instead.
 */
function awaitingApproval(request: SigningRequest) {
  return formatResponse({
    success: true,
    status: 'awaiting_approval',
    requestId: request.id,
    signedWith: request.signer,
    what: request.summary,
    nextStep: `Tell the user to approve it${request.signer === 'phone' ? ' in their phone wallet — some wallets do not notify, so they may need to open the app themselves' : ' in the signing page'}, then call check_signing_request with requestId "${request.id}". Do not call this tool again: that would ask for a second signature.`,
    message: 'Sent to the wallet. Nothing has been signed or broadcast yet.'
  })
}

/**
 * Whether it worked, which is not the same question as whether it was sent.
 *
 * A reverted transaction is mined, costs gas and does nothing. Reporting it as a success
 * because a hash came back is how an agent goes on to build on a state change that never
 * happened.
 */
function minedOutcome(receipt: { status: 'mined' | 'reverted' | 'broadcast'; blockNumber?: string; gasUsed?: string }) {
  if (receipt.status === 'reverted') {
    return {
      success: false,
      status: 'reverted',
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      message: 'Mined, but it reverted. The gas was spent and nothing else changed.'
    }
  }

  if (receipt.status === 'broadcast') {
    return {
      success: true,
      status: 'broadcast',
      message: 'Signed and broadcast, but not mined yet. Check the explorer link before treating it as done.'
    }
  }

  return { success: true, status: 'mined', blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }
}

/** What the caller should see about a transaction before it is approved. */
function previewSummary(preview: TxPreview) {
  return {
    action: preview.decoded?.intent ?? preview.decoded?.functionName,
    protocol: preview.decoded?.protocol ?? preview.toLabel,
    // Labels come from the contracts themselves, so the address they belong to goes too.
    to: preview.to,
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

        const outcome = await signingCall(
          { identity, signer: args.signWith, summary: `Send ${args.amount} on ${args.chain} to ${to}` },
          (progress) =>
            requestSignature(
              args.chain as ChainName,
              { to, value, data: args.data },
              args.signWith,
              identity,
              args.account,
              progress
            )
        )
        if (!outcome.done) return awaitingApproval(outcome.request)
        const { txHash, preview, signedWith, receipt } = outcome.result

        return formatResponse({
          ...minedOutcome(receipt),
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
      decimals: z
        .number()
        .int()
        .optional()
        .describe('Token decimals. Read from the token when omitted; when given, must match what the token reports.'),
      signWith: SignWithSchema,
      account: AccountSchema
    }),
    async (args, identity) => {
      try {
        const tokenAddress = requireAddress('token address', args.tokenAddress)
        const to = requireAddress('recipient address', args.to)
        const decimals = await tokenDecimals(args.chain as ChainName, tokenAddress, args.decimals)

        const data = encodeFunctionData({
          abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
          args: [to, parseUnits(args.amount, decimals)]
        })

        const outcome = await signingCall(
          { identity, signer: args.signWith, summary: `Send ${args.amount} of ${tokenAddress} on ${args.chain} to ${to}` },
          (progress) =>
            requestSignature(
              args.chain as ChainName,
              { to: tokenAddress, data, value: '0x0' },
              args.signWith,
              identity,
              args.account,
              progress
            )
        )
        if (!outcome.done) return awaitingApproval(outcome.request)
        const { txHash, preview, signedWith, receipt } = outcome.result

        return formatResponse({
          ...minedOutcome(receipt),
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
        .array(
          z.union([
            z.string(),
            // JSON numbers past 2^53 arrive already rounded, so signing one would send a different value.
            z.number().refine(Number.isSafeInteger, {
              message:
                'Numbers must be integers within ±2^53-1. Pass large or exact values as strings, e.g. "1000000000000000000".'
            }),
            z.boolean()
          ])
        )
        .optional()
        .describe('Function arguments in order matching the ABI signature. Pass uint/int values as strings.'),
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
          args: convertArgumentsToTypes(args.args || [], abiItem.inputs)
        })
        const value = args.value ? `0x${parseUnits(args.value, 18).toString(16)}` : '0x0'

        const outcome = await signingCall(
          { identity, signer: args.signWith, summary: `${abiItem.name}() on ${contractAddress} (${args.chain})` },
          (progress) =>
            requestSignature(
              args.chain as ChainName,
              { to: contractAddress, data, value },
              args.signWith,
              identity,
              args.account,
              progress
            )
        )
        if (!outcome.done) return awaitingApproval(outcome.request)
        const { txHash, preview, signedWith, receipt } = outcome.result

        return formatResponse({
          ...minedOutcome(receipt),
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
        const sign = async (progress: SigningProgress) => {
          if (args.signWith === 'phone') {
            const { phone, session, from } = await requirePhoneSession(identity, args.account)
            // personal_sign is chain-agnostic, but the request still has to name a chain the session holds.
            const chain = SUPPORTED_CHAINS.find((c) => session.chains.includes(getClientManager().getChainId(c)))
            if (!chain) throw new Error(`The paired wallet approved no chain this server knows: ${session.chains.join(', ')}.`)
            return phone.request(chain, 'personal_sign', [toHex(args.message), from], {
              identity,
              account: args.account,
              onWaiting: progress.waiting
            })
          }

          const wallet = getWalletClient(identity)
          await wallet.waitForSigner()
          return wallet.request({
            id: generateRequestId(),
            type: 'sign_message',
            chain: 'any',
            // Hex on both signers: a wallet reads a raw "0x…" string as bytes, so the same text
            // would otherwise sign differently depending on where it was approved.
            data: { message: toHex(args.message) }
          })
        }

        const outcome = await signingCall(
          { identity, signer: args.signWith, summary: `Sign the message "${args.message.slice(0, 60)}"` },
          sign
        )
        if (!outcome.done) return awaitingApproval(outcome.request)

        return formatResponse({
          success: true,
          message: args.message,
          signature: outcome.result,
          signedWith: args.signWith,
          signatureType: 'personal_sign'
        })
      } catch (error) {
        return failure(error, 'Message signing failed or was rejected')
      }
    }
  )
}
