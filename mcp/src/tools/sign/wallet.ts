import qrcode from 'qrcode-terminal'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import type { ChainName } from '../../types.js'
import { createTool, formatResponse } from '../../utils.js'
import { getWalletClient } from '../../wallet-client.js'
import { getPhoneSigner, pairingLinks } from '../../walletconnect.js'
import { describeError, failure } from './errors.js'

/**
 * Connecting a wallet and reporting what is connected — separate from the tools that ask
 * one to sign, because this is the part a user does once and that has nothing to do with
 * any particular transaction.
 */

/** Render a pairing URI as an ASCII QR, so it can be scanned straight from the chat. */
function qrFor(uri: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
}

export default {
  pair_phone_wallet: createTool(
    'Pair Phone Wallet',
    'Pair a phone wallet over WalletConnect, so transactions are signed on the phone instead of in a browser. ' +
      'Returns a QR to scan plus links that open a wallet directly — show those to the user as clickable links. ' +
      'Always pairs: call it when the user wants a wallet connected, and call wallet_status instead to find out ' +
      'whether one already is. Pairing again adds a wallet rather than replacing one, and signing tools then take ' +
      '"account" to choose between them. Requires a WalletConnect project id.',
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
    async (args, identity) => {
      const phone = getPhoneSigner()
      if (!phone) {
        return formatResponse({
          success: false,
          message:
            'No WalletConnect project id configured. Get a free one at https://dashboard.walletconnect.com and pass --walletconnect-project-id or set WALLETCONNECT_PROJECT_ID.'
        })
      }

      try {
        // Before anything starts the client: its name is fixed the moment it does.
        phone.nameAgent(args.agent)
        const paired = await phone.sessions(identity)

        const chains = (args.chains ?? SUPPORTED_CHAINS.filter((c) => c !== 'localhost')) as ChainName[]
        const uri = await phone.pair(chains, identity)
        const projectId = getClientManager().getConfig().walletConnectProjectId as string

        return formatResponse({
          qr: await qrFor(uri),
          uri,
          // Pairing adds rather than replaces, so say what is already there — scanning this
          // leaves the user with both, and signing tools take `account` to pick.
          ...(paired.length > 0 && {
            alreadyPaired: paired.map((session) => ({ address: session.accounts[0], wallet: session.peer }))
          }),
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
    'End WalletConnect sessions and drop the pairings underneath them. Without "account" this disconnects every paired wallet, so name one when the user only wants that wallet gone — wallet_status lists them.',
    z.object({
      account: z
        .string()
        .optional()
        .describe('Address of the one wallet to disconnect. Omit to disconnect every wallet paired here.')
    }),
    async (args, identity) => {
      const phone = getPhoneSigner()
      if (!phone) {
        return formatResponse({ success: false, message: 'No WalletConnect project id configured — nothing to disconnect.' })
      }

      try {
        const before = await phone.sessions(identity)
        const removed = await phone.disconnect(identity, args.account)
        const left = await phone.sessions(identity)

        return formatResponse({
          success: true,
          disconnectedSessions: removed.sessions,
          droppedPairings: removed.pairings,
          wallets: before.map((session) => `${session.peer ?? 'unknown wallet'} (${session.accounts.join(', ')})`),
          stillPaired: left.map((session) => ({ address: session.accounts[0], wallet: session.peer })),
          message:
            removed.sessions || removed.pairings
              ? left.length > 0
                ? `Disconnected. ${left.length} wallet(s) still paired — pass "account" to a signing tool to choose between them.`
                : 'Disconnected. Transactions fall back to the browser wallet until a phone is paired again.'
              : 'Nothing was connected.'
        })
      } catch (error) {
        return failure(error, 'Could not disconnect the phone wallet')
      }
    }
  ),

  wallet_status: createTool(
    'Wallet Status',
    'Report every signer and whether it is ready, so a signing tool can be given the right signWith.',
    z.object({}),
    async (_args, identity) => {
      // Both signers are reported, never just the first one found: signWith makes this a
      // choice the user owns, so the agent has to see everything available.
      const phone = getPhoneSigner()
      const phonesPaired = (await phone?.sessions(identity).catch(() => undefined)) ?? []
      const phoneSession = phonesPaired[phonesPaired.length - 1]

      const wallet = getWalletClient(identity)
      const relayError = await wallet
        .connect()
        .then(() => undefined)
        .catch((error) => describeError(error))

      const browserReady = !relayError && wallet.isConnected()
      // Only raise a tab when there is no other way to sign — a status check should not
      // open a window at someone who is about to use their phone.
      if (!browserReady && !phoneSession && !relayError) wallet.openBrowser()

      const signers = {
        phone: phoneSession
          ? {
              ready: true,
              address: phoneSession.accounts[0],
              // One wallet can expose several addresses; `account` on a signing tool picks.
              ...(phoneSession.accounts.length > 1 && { accounts: phoneSession.accounts }),
              wallet: phoneSession.peer,
              chains: phoneSession.chains,
              // Only when there is a choice to make: pass one of these as `account`.
              ...(phonesPaired.length > 1 && {
                alsoPaired: phonesPaired.slice(0, -1).map((s) => ({ address: s.accounts[0], wallet: s.peer, chains: s.chains }))
              })
            }
          : {
              ready: false,
              reason: phone
                ? 'No phone paired. Run pair_phone_wallet and scan the QR.'
                : 'Phone signing is not configured — set WALLETCONNECT_PROJECT_ID.'
            },
        browser: browserReady
          ? { ready: true, address: wallet.getAddress(), openTab: wallet.getPageUrl() }
          : {
              ready: false,
              reason: relayError ?? 'No signing page is open.',
              walletUrl: relayError ? undefined : wallet.getUrl()
            }
      }

      const ready = [phoneSession ? 'phone' : undefined, browserReady ? 'browser' : undefined].filter(Boolean)
      const message =
        ready.length === 2
          ? 'Both signers are ready. Ask the user which one to use, then pass it as signWith.'
          : ready.length === 1
            ? `Only ${ready[0]} is ready. Confirm with the user before signing there, or set the other one up.`
            : `No signer is ready. For a browser, give the user this link and ask them to open it and connect a wallet: ${signers.browser.walletUrl ?? '(relay unavailable)'}. For a phone, run pair_phone_wallet.`

      return formatResponse({ ready, signers, message })
    }
  )
}
