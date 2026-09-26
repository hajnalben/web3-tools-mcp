/**
 * What travels between the MCP server and the signing page.
 *
 * Its own module so both ends can name the same types. The server imports them through the
 * package; the page, which is plain JavaScript served as written, references them from
 * JSDoc and is checked against them without being compiled.
 *
 * The relay itself never looks inside `data` — it routes by room and forwards bytes. These
 * shapes are an agreement between the two ends, not something it enforces.
 */

export interface SendTransactionData {
  to: string
  value?: string
  data?: string
  from?: string
}

export interface SignMessageData {
  message: string
}

/** Decoded and simulated by the server; the page renders it but never trusts it over `data`. */
export type TxPreview = {
  decoded?: {
    intent?: string
    functionName?: string
    protocol?: string
    source?: string
    proxy?: string
    fields: { name: string; value?: string; address?: string; label?: string; warning?: string }[]
  }
  simulation?: {
    success: boolean
    error?: string
    gasEstimate?: string
    assetChanges?: {
      token: string
      symbol?: string
      amount: string
      humanAmount?: string
      tokenId?: string
      from: string
      to: string
    }[]
  }
  explorer?: string
  toLabel?: string
}

interface BaseRequest {
  id: string
  chain: string
  preview?: TxPreview
  /**
   * Epoch ms after which the requester has stopped waiting. Stamped by the client when it
   * sends; a page must not sign past it, since nobody would receive the answer and a retry
   * could sign the same thing twice.
   */
  expiresAt?: number
}

/**
 * Discriminated on `type`, so a page that reads `data.to` has to have established it is
 * looking at a transaction first — the mistake being guarded against is reading one shape's
 * fields off another's payload.
 */
export type TransactionRequest =
  | (BaseRequest & { type: 'send_transaction'; data: SendTransactionData })
  | (BaseRequest & { type: 'sign_message'; data: SignMessageData })
  | (BaseRequest & { type: 'sign_typed_data'; data: unknown })

export interface TransactionResponse {
  id: string
  success: boolean
  result?: unknown
  error?: string
}

/**
 * The requester has given up on a request: sent by the requester when it times out, and by
 * the relay to the signer whenever it drops a route. The page must stop offering it.
 */
export interface CancelMessage {
  type: 'cancel'
  id: string
}

/** Sent to a signer once its handshake is accepted, before any request arrives. */
export interface ReadyMessage {
  type: 'ready'
}
