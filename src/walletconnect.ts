import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getClientManager } from './client.js'
import { getKeyValueStorage } from './kv-storage.js'
import type { ChainName } from './types.js'

/**
 * Signing from a phone, with no page to load and nothing to host: the MCP server acts as
 * the dApp, the wallet app is the signer, and WalletConnect's relay carries the (end-to-end
 * encrypted) messages between them. Pair once by scanning a QR; the session is stored on
 * disk, so it survives restarts.
 */

type SignClientType = Awaited<ReturnType<typeof importSignClient>>['prototype']

async function importSignClient() {
  // Imported lazily: several MB of SDK that is pointless to load without a project ID.
  const { SignClient } = await import('@walletconnect/sign-client')
  return SignClient
}

interface Session {
  topic: string
  accounts: string[]
  chains: number[]
  peer?: string
}

const METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']
const EVENTS = ['chainChanged', 'accountsChanged']
const APPROVAL_TIMEOUT = 300_000

function storePath(): string {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'web3-tools-mcp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'walletconnect.db')
}

export class PhoneSigner {
  private client: SignClientType | undefined
  private starting: Promise<void> | undefined
  private pairing: { uri: string; expiresAt: number } | undefined

  constructor(private projectId: string) {}

  private async start(): Promise<void> {
    if (this.client) return
    if (this.starting) return this.starting

    this.starting = (async () => {
      const SignClient = await importSignClient()
      // Redis when hosted (a free-tier filesystem is ephemeral, and losing the store means
      // re-pairing by QR after every sleep); a file next to the other config locally.
      const storage = getKeyValueStorage()
      this.client = (await SignClient.init({
        projectId: this.projectId,
        ...(storage ? { storage } : { storageOptions: { database: storePath() } }),
        metadata: {
          name: 'web3-tools-mcp',
          description: 'Blockchain tools for AI agents',
          url: 'https://github.com/hajnalben/web3-tools-mcp',
          icons: []
        }
      })) as SignClientType
    })().finally(() => {
      this.starting = undefined
    })

    return this.starting
  }

  /** The most recent still-valid session, if the phone is already paired. */
  async session(): Promise<Session | undefined> {
    await this.start()
    const sessions = this.client?.session.getAll() ?? []
    const live = sessions.filter((s) => s.expiry * 1000 > Date.now())
    const session = live[live.length - 1]
    if (!session) return undefined

    const accounts = session.namespaces.eip155?.accounts ?? []
    return {
      topic: session.topic,
      // "eip155:8453:0xabc…" → address / chain id
      accounts: [...new Set(accounts.map((a) => a.split(':')[2] as string))],
      chains: [...new Set(accounts.map((a) => Number(a.split(':')[1])))],
      peer: session.peer?.metadata?.name
    }
  }

  async isPaired(): Promise<boolean> {
    return Boolean(await this.session())
  }

  /**
   * Start a pairing and return its URI immediately, resolving the wallet's approval in the
   * background — a tool result only reaches the user once it returns, so blocking here
   * would hide the QR they are supposed to scan.
   */
  async pair(chains: ChainName[]): Promise<string> {
    await this.start()
    if (!this.client) throw new Error('WalletConnect failed to start')

    const clientManager = getClientManager()
    const eip155 = chains.map((chain) => `eip155:${clientManager.getChainId(chain)}`)

    const { uri, approval } = await this.client.connect({
      // Optional rather than required: wallets reject a session outright when they cannot
      // serve every required chain, and few support all thirteen.
      optionalNamespaces: { eip155: { chains: eip155, methods: METHODS, events: EVENTS } }
    })

    if (!uri) throw new Error('WalletConnect did not return a pairing URI')
    this.pairing = { uri, expiresAt: Date.now() + APPROVAL_TIMEOUT }

    approval()
      .then((session) => console.error(`[WalletConnect] Paired with ${session.peer?.metadata?.name ?? 'a wallet'}`))
      .catch((error) => console.error('[WalletConnect] Pairing was not completed:', error.message))

    return uri
  }

  /** Send a request to the paired wallet. Throws if the chain is outside the session. */
  async request(chain: ChainName, method: string, params: unknown[]): Promise<unknown> {
    const session = await this.session()
    if (!session || !this.client) throw new Error('No phone wallet paired')

    const chainId = getClientManager().getChainId(chain)
    if (!session.chains.includes(chainId)) {
      throw new Error(
        `The paired wallet did not approve ${chain} (chain ${chainId}). It approved: ${session.chains.join(', ')}. Re-pair to add it.`
      )
    }

    return this.client.request({
      topic: session.topic,
      chainId: `eip155:${chainId}`,
      request: { method, params }
    })
  }

  /** Every live session, not just the one that would be used for signing. */
  async sessions(): Promise<Session[]> {
    await this.start()
    return (this.client?.session.getAll() ?? []).map((session) => ({
      topic: session.topic,
      accounts: [...new Set((session.namespaces.eip155?.accounts ?? []).map((a) => a.split(':')[2] as string))],
      chains: [...new Set((session.namespaces.eip155?.accounts ?? []).map((a) => Number(a.split(':')[1])))],
      peer: session.peer?.metadata?.name
    }))
  }

  /**
   * Disconnect everything: sessions, and the pairings underneath them. Each pairing
   * attempt leaves one behind whether or not a wallet ever approved it, so they
   * accumulate quietly in the store.
   */
  async disconnectAll(): Promise<{ sessions: number; pairings: number }> {
    await this.start()
    if (!this.client) return { sessions: 0, pairings: 0 }

    const sessions = this.client.session.getAll()
    for (const session of sessions) {
      await this.client
        .disconnect({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } })
        .catch((error) => console.error('[WalletConnect] Could not disconnect a session:', error.message))
    }

    const pairings = this.client.core.pairing.getPairings()
    for (const pairing of pairings) {
      await this.client.core.pairing
        .disconnect({ topic: pairing.topic })
        .catch((error) => console.error('[WalletConnect] Could not drop a pairing:', error.message))
    }

    return { sessions: sessions.length, pairings: pairings.length }
  }

  async unpair(): Promise<void> {
    await this.disconnectAll()
  }
}

interface WalletEntry {
  name: string
  native?: string
  universal?: string
}

let wallets: WalletEntry[] | undefined

/**
 * Wallets from WalletConnect's registry, so the links we hand out are the schemes each
 * wallet actually registered rather than ones we invented. Fetched once per process; a
 * failure is not fatal, it just means no ready-made links.
 */
async function walletRegistry(projectId: string): Promise<WalletEntry[]> {
  if (wallets) return wallets

  try {
    const response = await fetch(`https://explorer-api.walletconnect.com/v3/wallets?projectId=${projectId}&entries=100&page=1`)
    const listings = ((await response.json()) as { listings?: Record<string, { name: string; mobile?: WalletEntry }> }).listings ?? {}

    wallets = Object.values(listings)
      .map(({ name, mobile }) => ({ name, native: mobile?.native || undefined, universal: mobile?.universal || undefined }))
      .filter((wallet) => wallet.native || wallet.universal)
  } catch {
    wallets = []
  }

  return wallets
}

/**
 * Links that open a wallet straight onto this pairing, for when the agent is running on
 * the phone itself and there is no second screen to scan from.
 *
 * Native schemes are preferred over universal links: chat apps are documented to mishandle
 * the latter, opening the wallet with no prompt or diverting to an app store.
 */
export async function pairingLinks(projectId: string, uri: string, search?: string): Promise<Record<string, string>> {
  const registry = await walletRegistry(projectId)
  const encoded = encodeURIComponent(uri)

  const matches = search
    ? registry.filter((wallet) => wallet.name.toLowerCase().includes(search.toLowerCase()))
    : registry.slice(0, 12)

  return Object.fromEntries(
    matches.map((wallet) => {
      const base = wallet.native ?? `${wallet.universal?.replace(/\/$/, '')}/`
      return [wallet.name, `${base}wc?uri=${encoded}`]
    })
  )
}

let signer: PhoneSigner | null = null

/** Configured only when a WalletConnect project id is present. */
export function getPhoneSigner(): PhoneSigner | null {
  const projectId = getClientManager().getConfig().walletConnectProjectId
  if (!projectId) return null
  if (!signer) signer = new PhoneSigner(projectId)
  return signer
}
