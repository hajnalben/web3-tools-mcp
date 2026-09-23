import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

/**
 * Who a tool call is acting for.
 *
 * A hosted server can carry several people, and signing must never cross between them: a
 * transaction belongs to the person whose agent asked for it and reaches only their wallet.
 *
 * Passed explicitly from the tool wrapper down to whatever looks up a signer. Ambient
 * storage would read better at the call sites and fail worse: a context lost across some
 * later boundary would silently fall back to the shared identity, which is the same
 * cross-tenant delivery the room boundary exists to prevent — and it would not show up in
 * a test, because tests run inside the context.
 */

/** Every self-hosted run, and every call arriving without an authenticated identity. */
export const DEFAULT_IDENTITY = 'default'

/**
 * The identity an authenticated request belongs to. Hosted multi-tenancy is what fills
 * this in; a single-credential server authenticates the deployment, not a person, so
 * everyone on it is the same user.
 */
export function identityFrom(authInfo?: AuthInfo): string {
  const address = authInfo?.extra?.address
  return typeof address === 'string' && address ? address : DEFAULT_IDENTITY
}
