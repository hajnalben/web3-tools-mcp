import { z } from 'zod'
import { collectSigningRequest } from '../../signing-requests.js'
import { createTool, formatResponse } from '../../utils.js'
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

        if (request.state === 'pending') {
          return formatResponse({
            success: true,
            status: 'awaiting_approval',
            requestId: request.id,
            what: request.summary,
            waitingFor: `${Math.round((Date.now() - request.startedAt) / 1000)}s`,
            nextStep:
              'Still not approved. Ask the user to check their wallet and approve or reject it, then call this again with the same requestId.',
            message: 'Nothing has been signed yet.'
          })
        }

        if (request.state === 'failed') {
          return formatResponse({
            success: false,
            status: 'rejected_or_failed',
            what: request.summary,
            error: request.error,
            message: 'Nothing was signed. The wallet rejected it, or it expired before anybody approved.'
          })
        }

        return formatResponse({
          success: true,
          status: 'signed',
          what: request.summary,
          signedWith: request.signer,
          result: request.result,
          message: 'Approved and sent.'
        })
      } catch (error) {
        return failure(error, 'Could not check that signing request')
      }
    }
  )
}
