import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getClientManager } from './client.js'
import { DEFAULT_IDENTITY } from './context.js'
import { getKeyValueStorage } from './kv-storage.js'
import { log } from './log.js'
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

/** Sessions do not record who paired them, so the mapping is kept alongside in the same store. */
const BINDINGS_KEY = 'web3-tools-mcp:session-identities'

/**
 * The sessions an identity may sign with.
 *
 * Matched by the binding recorded when the session was approved, never by the accounts it
 * reports — a wallet states its own account list, so trusting that would let a peer claim
 * someone else's address and be handed their signing requests.
 *
 * An unbound session is one paired before bindings existed. It counts only for the shared
 * identity, which is a server with a single user; under a real identity it belongs to
 * nobody rather than to whoever asks first.
 */
export function ownedSessions<T extends { topic: string }>(live: T[], bindings: Record<string, string>, identity: string): T[] {
  return live.filter((s) => bindings[s.topic] === identity || (identity === DEFAULT_IDENTITY && !bindings[s.topic]))
}

/**
 * Bindings with no session behind them any more.
 *
 * An empty session list yields nothing: a store that has not hydrated looks exactly like one
 * with no sessions, and clearing every binding would strand wallets that are still paired.
 */
export function orphanedBindings(live: { topic: string }[], bindings: Record<string, string>): string[] {
  if (live.length === 0) return []
  const known = new Set(live.map((session) => session.topic))
  return Object.keys(bindings).filter((topic) => !known.has(topic))
}

/** What was paired before and is not paired now — a wallet that ended its own session. */
export function droppedSessions<T extends { topic: string }>(before: T[], after: { topic: string }[]): T[] {
  const live = new Set(after.map((session) => session.topic))
  return before.filter((session) => !live.has(session.topic))
}

const METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']
const EVENTS = ['chainChanged', 'accountsChanged']
const APPROVAL_TIMEOUT = 300_000

/**
 * Where this server lives, as shown to the wallet. A hosted server knows its public URL;
 * a local one is only reachable from the machine it runs on, and says so.
 */
function serverUrl(): string {
  return process.env.MCP_PUBLIC_URL?.replace(/\/$/, '') ?? 'http://localhost'
}

function storePath(): string {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'web3-tools-mcp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'walletconnect.db')
}

export class PhoneSigner {
  private client: SignClientType | undefined
  private starting: Promise<void> | undefined
  private pairing: { uri: string; expiresAt: number } | undefined
  /** Label shown in the wallet; whoever is driving this server says who they are. */
  private agent: string | undefined
  /** The last edit of the bindings key; the next one queues behind it. */
  private bindingsEdit: Promise<unknown> = Promise.resolve()

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
        // What the wallet shows when asking you to approve. Approving does not connect a
        // website — it lets an agent request signatures for as long as the session lives,
        // so the dialog says that. The name is self-reported and proves nothing; the URL
        // is what distinguishes this server from any other.
        metadata: {
          name: this.agent ? `${this.agent} via web3-tools-mcp` : 'web3-tools-mcp (AI agent)',
          description: 'An AI agent uses this server to request transactions. You approve each one here.',
          url: serverUrl(),
          icons: []
        }
      })) as SignClientType
    })().finally(() => {
      this.starting = undefined
    })

    return this.starting
  }

  /**
   * Who each session belongs to, kept in the client's own store so it lands in the file or
   * in Redis exactly as the sessions themselves do.
   */
  private async bindings(): Promise<Record<string, string>> {
    return (await this.client?.core.storage.getItem<Record<string, string>>(BINDINGS_KEY)) ?? {}
  }

  /**
   * All bindings live under one key, so an edit is a read-modify-write — and two approvals
   * settling together would each read the same map and the second would erase the first.
   * Edits queue behind each other instead.
   *
   * ponytail: serialised per process only. Several server processes on one Redis still
   * race; one key per topic would end that.
   */
  private updateBindings(edit: (bindings: Record<string, string>) => void): Promise<void> {
    const next = this.bindingsEdit.then(async () => {
      const bindings = await this.bindings()
      edit(bindings)
      await this.client?.core.storage.setItem(BINDINGS_KEY, bindings)
    })
    this.bindingsEdit = next.catch(() => {})
    return next
  }

  private bind(topic: string, identity: string): Promise<void> {
    return this.updateBindings((bindings) => {
      bindings[topic] = identity
    })
  }

  /**
   * Some wallets keep one session per site, so approving a second pairing in the same app
   * ends the first — the session vanishes from the store and the binding is left pointing at
   * nothing. Worth saying out loud: `pair_phone_wallet` has just listed that wallet as still
   * paired, and the next `wallet_status` will quietly show one fewer.
   */
  private async reportReplaced(identity: string, before: Session[]): Promise<void> {
    const dropped = droppedSessions(before, await this.sessions(identity))
    if (dropped.length === 0) return

    for (const session of dropped) {
      log(
        'warning',
        'WalletConnect',
        `${session.peer ?? 'A wallet'} ended its earlier pairing for ${session.accounts[0] ?? 'an account'} when this one was approved — ` +
          'it keeps one session per site. Pair a different wallet app to hold both at once.'
      )
    }

    await this.sweepBindings()
  }

  /**
   * Bindings outlive the sessions they point at, so they accumulate. Swept here rather than
   * on every read: a pairing has just settled, which is the one moment the session store is
   * known to be populated.
   */
  private async sweepBindings(): Promise<void> {
    const orphans = orphanedBindings(this.client?.session.getAll() ?? [], await this.bindings())
    if (orphans.length === 0) return

    await this.updateBindings((bindings) => {
      for (const topic of orphans) delete bindings[topic]
    })
    log('info', 'WalletConnect', `Cleared ${orphans.length} binding(s) whose session is gone`)
  }

  /** Every session this identity owns, live or not — what disconnecting should sweep. */
  private async owned(identity: string) {
    await this.start()
    return ownedSessions(this.client?.session.getAll() ?? [], await this.bindings(), identity)
  }

  /**
   * One of this identity's paired wallets.
   *
   * `account` picks between them when more than one is paired; without it the most recent
   * wins, which is the only one most people have. Selecting by address is safe here in a
   * way that *identifying* by address would not be: the candidates are already narrowed to
   * sessions this identity was bound to when they were approved, so a wallet claiming an
   * address it does not hold can only reach its own owner.
   */
  async session(identity: string = DEFAULT_IDENTITY, account?: string): Promise<Session | undefined> {
    const paired = await this.sessions(identity)
    if (!account) return paired[paired.length - 1]

    const wanted = account.toLowerCase()
    return paired.find((session) => session.accounts.some((a) => a.toLowerCase() === wanted))
  }

  async isPaired(identity?: string): Promise<boolean> {
    return Boolean(await this.session(identity))
  }

  /**
   * Start a pairing and return its URI immediately, resolving the wallet's approval in the
   * background — a tool result only reaches the user once it returns, so blocking here
   * would hide the QR they are supposed to scan.
   */
  /**
   * Name who is asking, for the wallet's approval dialog. Takes effect only before the
   * client starts, because WalletConnect fixes metadata at init — call it first.
   *
   * There is deliberately no way to relabel a running client. Replacing it leaves the old
   * one's engine alive, and its heartbeat sweeps "orphaned" subscriptions against its own,
   * empty session list — unsubscribing the new session's topic two seconds after it
   * settles, so every reply the wallet sends goes to a topic nobody is listening on. A
   * stale name in the dialog is a far smaller cost than signing that silently hangs.
   */
  nameAgent(agent?: string): void {
    if (agent && !this.client) this.agent = agent
  }

  async pair(chains: ChainName[], identity: string = DEFAULT_IDENTITY): Promise<string> {
    await this.start()
    log('info', 'WalletConnect', `Pairing as "${this.agent ?? 'default name'}" for ${chains.length} chain(s)`)
    if (!this.client) throw new Error('WalletConnect failed to start')

    // What this identity had before, so the approval can tell whether the wallet kept it.
    const before = await this.sessions(identity)

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
      .then(async (session) => {
        // Recorded as the session settles: whoever asked for this pairing owns it.
        await this.bind(session.topic, identity)
        log('info', 'WalletConnect', `Paired with ${session.peer?.metadata?.name ?? 'a wallet'}`)
        await this.reportReplaced(identity, before)
      })
      .catch((error) => log('warning', 'WalletConnect', `Pairing was not completed: ${error.message}`))

    return uri
  }

  /** Send a request to one of this identity's wallets. Throws if the chain is outside the session. */
  async request(
    chain: ChainName,
    method: string,
    params: unknown[],
    target: { identity?: string; account?: string } = {}
  ): Promise<unknown> {
    const session = await this.session(target.identity, target.account)
    if (!session || !this.client) {
      throw new Error(target.account ? `No phone wallet paired for account ${target.account}` : 'No phone wallet paired')
    }

    const chainId = getClientManager().getChainId(chain)
    if (!session.chains.includes(chainId)) {
      throw new Error(
        `The paired wallet did not approve ${chain} (chain ${chainId}). It approved: ${session.chains.join(', ')}. Re-pair to add it.`
      )
    }

    const started = Date.now()
    log(
      'info',
      'WalletConnect',
      `→ ${method} on ${chain}, session ${session.topic.slice(0, 8)}, waiting for ${session.peer ?? 'wallet'}`
    )
    try {
      const result = await this.client.request({
        topic: session.topic,
        chainId: `eip155:${chainId}`,
        request: { method, params }
      })
      log('info', 'WalletConnect', `← ${method} answered in ${Date.now() - started}ms`)
      return result
    } catch (error) {
      const reason = (error as { message?: string })?.message ?? String(error)
      log('warning', 'WalletConnect', `← ${method} failed after ${Date.now() - started}ms: ${reason}`)
      throw error
    }
  }

  /** Every wallet this identity can currently sign with, oldest pairing first. */
  async sessions(identity: string = DEFAULT_IDENTITY): Promise<Session[]> {
    const live = (await this.owned(identity)).filter((session) => session.expiry * 1000 > Date.now())
    return live.map((session) => {
      // "eip155:8453:0xabc…" → address / chain id
      const accounts = session.namespaces.eip155?.accounts ?? []
      return {
        topic: session.topic,
        accounts: [...new Set(accounts.map((a) => a.split(':')[2] as string))],
        chains: [...new Set(accounts.map((a) => Number(a.split(':')[1])))],
        peer: session.peer?.metadata?.name
      }
    })
  }

  /**
   * Disconnect one of this identity's wallets, or all of them when no account is named.
   *
   * Pairings underneath are swept only once no session is left at all. Each pairing attempt
   * leaves one behind whether or not a wallet ever approved it, so they accumulate quietly —
   * but a pairing does not record who made it, so dropping them while anyone still has a
   * session could take somebody else's with it.
   */
  async disconnect(identity: string = DEFAULT_IDENTITY, account?: string): Promise<{ sessions: number; pairings: number }> {
    await this.start()
    if (!this.client) return { sessions: 0, pairings: 0 }

    let topics: Set<string>
    if (account) {
      // Same rule that picks a wallet to sign with, so you can drop exactly what you chose.
      const match = await this.session(identity, account)
      if (!match) throw new Error(`No paired wallet holds ${account}`)
      topics = new Set([match.topic])
    } else {
      // Expired sessions included: they are still this identity's to clean up.
      topics = new Set((await this.owned(identity)).map((session) => session.topic))
    }

    for (const topic of topics) {
      await this.client
        .disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } })
        .catch((error) => log('warning', 'WalletConnect', `Could not disconnect a session: ${error.message}`))
    }

    await this.updateBindings((bindings) => {
      for (const topic of topics) delete bindings[topic]
    })

    const remaining = this.client.session.getAll().length
    if (remaining > 0) return { sessions: topics.size, pairings: 0 }

    const pairings = this.client.core.pairing.getPairings()
    for (const pairing of pairings) {
      await this.client.core.pairing
        .disconnect({ topic: pairing.topic })
        .catch((error) => log('warning', 'WalletConnect', `Could not drop a pairing: ${error.message}`))
    }

    return { sessions: topics.size, pairings: pairings.length }
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
    const listings =
      ((await response.json()) as { listings?: Record<string, { name: string; mobile?: WalletEntry }> }).listings ?? {}

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
