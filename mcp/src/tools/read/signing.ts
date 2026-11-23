import { z } from 'zod'
import { collectSigningRequest, GRACE_MS } from '../../signing-requests.js'
import { createTool, formatResponse } from '../../utils.js'
import { getPhoneSigner } from '../../walletconnect.js'
import { failure } from '../sign/errors.js'

/**
 * Collecting a signature that was not given within the tool call that asked for it.
 *
 * A read rather than a signing tool on purpose: the signature was requested — and charged
 * for — once already, and a host metering signing should not bill an agent again for asking
 * whether the human has got round to it yet.
 */
export default {
  check_signing_request: createTool(
    'Check Signing Request',
    'Collect the result of a signing request that was still waiting for approval. Waits a while for the user to approve, then reports back. Call this instead of asking for the signature again — repeating the original tool would put a second request in front of the wallet.',
    z.object({
      requestId: z.string().describe('The requestId returned when the signing tool said it was awaiting approval')
    }),
    async (args, identity) => {
      try {
        const request = await collectSigningRequest(args.requestId, identity)

        const waitedFor = `${Math.round((Date.now() - request.startedAt) / 1000)}s`

        if (request.state === 'pending') {
          // Approved already and waiting on the chain is a different thing to report: there
          // is nothing left for the user to do, and nothing to chase them about.
          if (request.stage === 'mining') {
            return formatResponse({
              success: true,
              status: 'mining',
              requestId: request.id,
              what: request.summary,
              transactionHash: request.txHash,
              waitingFor: waitedFor,
              nextStep: 'Approved and broadcast. Call this again with the same requestId to get the mined result.',
              message: 'Signed and sent. Waiting for it to be mined.'
            })
          }

          return formatResponse({
            success: true,
            status: 'awaiting_approval',
            requestId: request.id,
            what: request.summary,
            waitingFor: waitedFor,
            nextStep:
              'Still not approved. Ask the user to check their wallet and approve or reject it, then call this again with the same requestId.',
            message: 'Nothing has been signed yet.'
          })
        }

        if (request.state === 'failed') {
          // Only an explicit rejection proves nothing was signed. A timeout or a dropped
          // connection can land after the wallet signed and broadcast.
          const rejected = request.stage === 'approval' && /rejected|denied/i.test(request.error ?? '')
          return formatResponse({
            success: false,
            status: rejected ? 'rejected' : 'outcome_unknown',
            what: request.summary,
            error: request.error,
            ...(request.txHash && { transactionHash: request.txHash }),
            message: rejected
              ? 'The wallet rejected it. Nothing was signed.'
              : 'It did not complete here, but it may still have been signed or broadcast. Do not retry until the wallet or a block explorer shows it did not go through.'
          })
        }

        // A transaction carries how it ended on the chain; a message signature is just the
        // signature, with nothing to mine.
        const settled = request.result as { receipt?: { status: string; blockNumber?: string; gasUsed?: string } } | undefined
        const reverted = settled?.receipt?.status === 'reverted'

        return formatResponse({
          success: !reverted,
          status: settled?.receipt?.status ?? 'signed',
          what: request.summary,
          signedWith: request.signer,
          result: request.result,
          message: reverted
            ? 'Mined, but it reverted. The gas was spent and nothing else changed.'
            : settled?.receipt?.status === 'broadcast'
              ? 'Approved and broadcast, but not mined yet.'
              : 'Approved and done.'
        })
      } catch (error) {
        return failure(error, 'Could not check that signing request')
      }
    }
  ),

  // A read for the same reason as above, and hidden from the agent on hosts that draw cards:
  // the pairing card follows its own QR with this, and an agent has wallet_status.
  wait_for_pairing: createTool(
    'Wait For Pairing',
    'Follow a pair_phone_wallet QR until a wallet approves it, waiting a while before reporting back. Used by the pairing card; agents should call wallet_status instead.',
    z.object({
      uri: z.string().describe('The uri pair_phone_wallet returned')
    }),
    async (args, identity) => {
      const phone = getPhoneSigner()
      const topic = /^wc:([0-9a-f]+)@/.exec(args.uri)?.[1]
      if (!phone || !topic) return formatResponse({ status: 'unavailable' })

      const expiry = Number(new URL(args.uri).searchParams.get('expiryTimestamp')) * 1000 || Number.POSITIVE_INFINITY
      const deadline = Date.now() + GRACE_MS
      // ponytail: polls the session store each second; subscribe to the client's session events if it ever shows up in a profile.
      while (Date.now() < deadline) {
        const session = (await phone.sessions(identity)).find((s) => s.pairingTopic === topic)
        if (session) {
          return formatResponse({
            status: 'paired',
            address: session.accounts[0],
            wallet: session.peer,
            chains: session.chains.length
          })
        }
        if (Date.now() > expiry) return formatResponse({ status: 'expired' })
        await new Promise<void>((resolve) => setTimeout(resolve, 1000).unref())
      }
      return formatResponse({ status: 'waiting' })
    }
  )
}
