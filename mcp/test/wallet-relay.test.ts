import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { roomToken, WalletRelay } from 'web3-wallet-relay'
import { WebSocket, WebSocketServer } from 'ws'
import { WalletClient } from '../src/wallet-client.js'

const TOKEN = 'test-token'
const SIGNER_TOKEN = roomToken(TOKEN, 'default', 'signer')
const REQUESTER_TOKEN = roomToken(TOKEN, 'default', 'requester')

function connect(port: number, hello: Record<string, unknown>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('error', reject)
    ws.once('open', () => {
      ws.send(JSON.stringify(hello))
      resolve(ws)
    })
  })
}

function nextMessage(ws: WebSocket, predicate: (msg: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const message = JSON.parse(data.toString())
      if (!predicate(message)) return
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

describe('WalletRelay', () => {
  const relays: WalletRelay[] = []
  const sockets: WebSocket[] = []
  const blockers: Server[] = []

  afterEach(async () => {
    for (const ws of sockets) ws.close()
    sockets.length = 0
    for (const relay of relays) await relay.stop()
    relays.length = 0
    for (const server of blockers) await new Promise((resolve) => server.close(resolve))
    blockers.length = 0
  })

  async function startRelay(port: number) {
    const relay = new WalletRelay({ port, token: TOKEN })
    relays.push(relay)
    await relay.start()
    return relay
  }

  it('routes a request to the signer and the response back to the requester', async () => {
    const relay = await startRelay(4100)

    const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(signer, requester)

    // The requester learns about the signer before sending anything.
    const status = await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)
    expect(status.address).toBe('0xabc')

    const incoming = nextMessage(signer, (m) => m.id === 'req-1')
    requester.send(JSON.stringify({ id: 'req-1', type: 'send_transaction', chain: 'mainnet', data: { to: '0xdef' } }))
    expect((await incoming).data.to).toBe('0xdef')

    const response = nextMessage(requester, (m) => m.id === 'req-1')
    signer.send(JSON.stringify({ id: 'req-1', success: true, result: '0xhash' }))
    expect(await response).toMatchObject({ success: true, result: '0xhash' })
  })

  it('drops a frame that is valid JSON but not an object, and keeps running', async () => {
    const relay = await startRelay(4100)

    const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(signer, requester)
    await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)

    // Both roles, and a request with no usable id: none of these may reach `.type` or `.id`.
    signer.send('null')
    requester.send('null')
    requester.send(JSON.stringify({ type: 'send_transaction', chain: 'mainnet', data: {} }))

    const incoming = nextMessage(signer, (m) => m.id === 'req-1')
    requester.send(JSON.stringify({ id: 'req-1', type: 'send_transaction', chain: 'mainnet', data: { to: '0xdef' } }))
    expect((await incoming).data.to).toBe('0xdef')
  })

  /**
   * With several people sharing one relay, the room is the boundary: a transaction reaches
   * only pages in the same room, and no page can answer another room's request by guessing
   * its id.
   */
  it('keeps rooms from seeing each other', async () => {
    const relay = new WalletRelay({ port: 4115, rooms: (token) => (token.startsWith('tok-') ? token.slice(4) : null) })
    relays.push(relay)
    await relay.start()
    const port = relay.getPort()

    // B joins first on purpose: it is the one an unfiltered "any open page" lookup finds.
    const signerB = await connect(port, { token: 'tok-b', role: 'signer', address: '0xbbb' })
    const signerA = await connect(port, { token: 'tok-a', role: 'signer', address: '0xaaa' })
    const requesterA = await connect(port, { token: 'tok-a', role: 'requester' })
    sockets.push(signerA, signerB, requesterA)

    // A hears about its own room's wallet, and only that one.
    const status = await nextMessage(requesterA, (m) => m.type === 'status' && m.signers === 1)
    expect(status).toMatchObject({ address: '0xaaa', pages: 1 })

    const offeredTo = new Promise<string>((resolve) => {
      signerA.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-a' && resolve('A'))
      signerB.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-a' && resolve('B'))
    })
    requesterA.send(JSON.stringify({ id: 'req-a', type: 'send_transaction', chain: 'mainnet', data: { to: '0xdef' } }))
    expect(await offeredTo).toBe('A')

    // B answers first, so a relay that accepted it would resolve with the hijacked result.
    const answer = nextMessage(requesterA, (m) => m.id === 'req-a')
    signerB.send(JSON.stringify({ id: 'req-a', success: true, result: '0xhijacked' }))
    signerA.send(JSON.stringify({ id: 'req-a', success: true, result: '0xreal' }))
    expect(await answer).toMatchObject({ result: '0xreal' })
  })

  /**
   * A peer can send its first request in the same read as the handshake. Resolving a room
   * may go to storage, and a message emitted during that gap would otherwise reach no
   * listener and be lost silently.
   */
  it('holds a request that arrives with the handshake', async () => {
    const relay = new WalletRelay({
      port: 4116,
      token: TOKEN,
      // A resolver that goes to storage, so the gap between handshake and role is real.
      rooms: async (token) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return token === REQUESTER_TOKEN ? 'default' : null
      }
    })
    relays.push(relay)
    await relay.start()

    const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
    sockets.push(ws)
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))

    ws.send(JSON.stringify({ token: REQUESTER_TOKEN, role: 'requester' }))
    ws.send(JSON.stringify({ id: 'req-early', type: 'send_transaction', chain: 'mainnet', data: {} }))

    const answered = nextMessage(ws, (m) => m.id === 'req-early')
    const dropped = new Promise((resolve) => setTimeout(() => resolve('dropped'), 1000))
    expect(await Promise.race([answered, dropped])).toMatchObject({ success: false, error: 'No wallet connected' })
  })

  it('rejects connections with a wrong token', async () => {
    const relay = await startRelay(4101)

    const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
    sockets.push(ws)
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    ws.once('open', () => ws.send(JSON.stringify({ token: 'wrong', role: 'signer' })))

    expect(await closed).toBe(4001)
  })

  /**
   * Rooms are only a boundary if two people actually land in different ones. The tokens
   * carry their room and are signed by the relay's secret, so the server mints a pair per
   * identity and the relay needs no record of anybody.
   */
  it('puts two identities in different rooms, and refuses a forged one', async () => {
    const relay = await startRelay(4119)
    const port = relay.getPort()

    const alicePage = await connect(port, { token: roomToken(TOKEN, '0xalice', 'signer'), role: 'signer', address: '0xaaa' })
    const bobPage = await connect(port, { token: roomToken(TOKEN, '0xbob', 'signer'), role: 'signer', address: '0xbbb' })
    const bob = await connect(port, { token: roomToken(TOKEN, '0xbob', 'requester'), role: 'requester' })
    sockets.push(alicePage, bobPage, bob)

    // Bob's agent only ever hears about Bob's page.
    expect(await nextMessage(bob, (m) => m.type === 'status' && m.signers === 1)).toMatchObject({
      address: '0xbbb',
      pages: 1
    })

    const offeredTo = new Promise<string>((resolve) => {
      alicePage.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-b' && resolve('alice'))
      bobPage.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-b' && resolve('bob'))
    })
    bob.send(JSON.stringify({ id: 'req-b', type: 'send_transaction', chain: 'mainnet', data: { to: '0xdef' } }))
    expect(await offeredTo).toBe('bob')

    // Naming a room is not enough — the signature is what admits you to it.
    const forged = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(forged)
    const closed = new Promise<number>((resolve) => forged.once('close', resolve))
    forged.once('open', () => forged.send(JSON.stringify({ token: '0xalice.deadbeef', role: 'requester' })))
    expect(await closed).toBe(4001)
  })

  /**
   * One room must not be able to exhaust the relay for every other room, so a room holds a
   * bounded number of connections and frames are capped well below what ws would accept.
   */
  it('bounds what one room can take', async () => {
    const relay = await startRelay(4120)
    const port = relay.getPort()
    const mine = roomToken(TOKEN, '0xgreedy', 'signer')

    // Fill the room, then prove the next one in is refused rather than served.
    const accepted: number[] = []
    for (let i = 0; i < 17; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(ws)
      const outcome = await new Promise<number>((resolve) => {
        ws.once('open', () => ws.send(JSON.stringify({ token: mine, role: 'signer' })))
        ws.once('message', () => resolve(0))
        ws.once('close', (code) => resolve(code))
      })
      accepted.push(outcome)
    }

    expect(accepted.filter((code) => code === 0)).toHaveLength(16)
    expect(accepted[16]).toBe(4008)

    // A different room is unaffected by the greedy one.
    const other = await connect(port, { token: roomToken(TOKEN, '0xquiet', 'signer'), role: 'signer' })
    sockets.push(other)
    expect(await nextMessage(other)).toMatchObject({ type: 'ready' })
  })

  it('refuses a frame larger than the payload cap', async () => {
    const relay = await startRelay(4121)

    const ws = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(ws)
    await nextMessage(ws, (m) => m.type === 'ready')

    const closed = new Promise<number | string>((resolve) => ws.once('close', resolve))
    const accepted = new Promise<string>((resolve) => setTimeout(() => resolve('accepted'), 1000))
    ws.send(JSON.stringify({ id: 'huge', type: 'send_transaction', chain: 'mainnet', data: { to: 'x'.repeat(600_000) } }))

    // 1009 is the protocol's own "message too big".
    expect(await Promise.race([closed, accepted])).toBe(1009)
  })

  /**
   * The page's token rides in a URL the user opens, keeps in history and shares on screen.
   * A requester can propose transactions and supplies much of what the page displays about
   * them, so whoever holds the exposed token must not be able to take that role.
   */
  it('will not let the page token act as a requester', async () => {
    const relay = await startRelay(4118)

    function join(hello: unknown) {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
      sockets.push(ws)
      return new Promise<{ closed?: number; accepted?: boolean }>((resolve) => {
        ws.once('open', () => ws.send(JSON.stringify(hello)))
        ws.once('message', () => resolve({ accepted: true }))
        ws.once('close', (code) => resolve({ closed: code }))
      })
    }

    expect(await join({ token: SIGNER_TOKEN, role: 'requester' })).toEqual({ closed: 4001 })
    expect(await join({ token: SIGNER_TOKEN, role: 'signer' })).toEqual({ accepted: true })

    // And the reverse, so the server's token never ends up pasted into a browser.
    expect(await join({ token: TOKEN, role: 'signer' })).toEqual({ closed: 4001 })
    expect(await join({ token: REQUESTER_TOKEN, role: 'requester' })).toEqual({ accepted: true })
  })

  /**
   * Nothing enforces the handshake's shape — the page is plain JS and anything can open a
   * socket — so a resolver, which will use the token as a lookup key, must only ever be
   * handed a string of sane length.
   */
  it('never hands a malformed token to the resolver', async () => {
    const seen: unknown[] = []
    const relay = new WalletRelay({
      port: 4117,
      token: TOKEN,
      rooms: (token) => {
        seen.push(token)
        return token === TOKEN ? 'default' : null
      }
    })
    relays.push(relay)
    await relay.start()

    for (const token of [{ toString: 'gotcha' }, ['a'], 42, null, 'x'.repeat(4096), TOKEN]) {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
      sockets.push(ws)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      ws.send(JSON.stringify({ token, role: 'signer' }))
      await new Promise<void>((resolve) => ws.once('message', () => resolve()).once('close', () => resolve()))
    }

    expect(seen).toEqual([TOKEN])
  })

  /**
   * WebSockets ignore the same-origin policy and the local port is predictable, so without
   * this any page you have open could reach the relay — pushing a transaction at your wallet
   * or registering as a signer to intercept one. The token alone would not stop it.
   */
  describe('origin', () => {
    function handshake(port: number, origin: string | undefined, hello: Record<string, unknown>) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {})
      sockets.push(ws)
      return new Promise<{ closed?: number; accepted?: boolean }>((resolve) => {
        ws.once('open', () => ws.send(JSON.stringify(hello)))
        ws.once('message', () => resolve({ accepted: true }))
        ws.once('close', (code) => resolve({ closed: code }))
      })
    }

    it('refuses a browser on another origin, even with a valid token', async () => {
      const relay = await startRelay(4110)

      const asSigner = await handshake(relay.getPort(), 'https://evil.example', { token: SIGNER_TOKEN, role: 'signer' })
      expect(asSigner).toEqual({ closed: 4003 })

      // The dangerous direction: a page that could push a proposal into your wallet.
      const asRequester = await handshake(relay.getPort(), 'https://evil.example', { token: REQUESTER_TOKEN, role: 'requester' })
      expect(asRequester).toEqual({ closed: 4003 })
    })

    it('accepts the page it serves itself', async () => {
      const relay = await startRelay(4111)
      const result = await handshake(relay.getPort(), `http://127.0.0.1:${relay.getPort()}`, {
        token: SIGNER_TOKEN,
        role: 'signer'
      })
      expect(result).toEqual({ accepted: true })
    })

    it('accepts a non-browser client, which sends no origin', async () => {
      const relay = await startRelay(4112)
      const result = await handshake(relay.getPort(), undefined, { token: REQUESTER_TOKEN, role: 'requester' })
      expect(result).toEqual({ accepted: true })
    })

    it('still checks the token once the origin passes', async () => {
      const relay = await startRelay(4113)
      const result = await handshake(relay.getPort(), `http://127.0.0.1:${relay.getPort()}`, { token: 'wrong', role: 'signer' })
      expect(result).toEqual({ closed: 4001 })
    })
  })

  it('serves the signing page on a server it does not own', async () => {
    const app = (await import('express')).default()
    app.get('/mcp', (_req, res) => res.json({ mine: true }))

    const server = createServer(app)
    blockers.push(server)
    await new Promise<void>((resolve) => server.listen(4114, '127.0.0.1', resolve))

    const relay = new WalletRelay({ token: TOKEN, publicUrl: 'http://127.0.0.1:4114' })
    relays.push(relay)
    relay.attach(server, (relayApp) => app.use(relayApp))

    // The host's own routes keep their paths; the relay takes what is left.
    const mcp = await fetch('http://127.0.0.1:4114/mcp')
    expect(await mcp.json()).toEqual({ mine: true })
    expect((await fetch('http://127.0.0.1:4114/')).status).toBe(200)

    // And the socket rides the same server, so a page served here can sign.
    const ws = new WebSocket('ws://127.0.0.1:4114', { origin: 'http://127.0.0.1:4114' })
    sockets.push(ws)
    const ready = new Promise((resolve) => ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))))
    ws.once('open', () => ws.send(JSON.stringify({ token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })))
    expect(await ready).toMatchObject({ type: 'ready' })
  })

  it('fails the request when no signer is connected', async () => {
    const relay = await startRelay(4102)

    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(requester)

    const response = nextMessage(requester, (m) => m.id === 'req-2')
    requester.send(JSON.stringify({ id: 'req-2', type: 'send_transaction', chain: 'mainnet', data: {} }))
    expect(await response).toMatchObject({ success: false, error: 'No wallet connected' })
  })

  it('fails in-flight requests when the signer disconnects', async () => {
    const relay = await startRelay(4103)

    const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(requester)

    await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)

    const delivered = nextMessage(signer, (m) => m.id === 'req-3')
    requester.send(JSON.stringify({ id: 'req-3', type: 'send_transaction', chain: 'mainnet', data: {} }))
    await delivered

    const response = nextMessage(requester, (m) => m.id === 'req-3')
    signer.close()
    expect(await response).toMatchObject({ success: false })
  })

  it('opens a tab only when no wallet page is connected', async () => {
    const relay = await startRelay(4112)
    const client = new WalletClient('default', { port: 4112, token: TOKEN })
    client.signerWaitTimeout = 200
    const opened: string[] = []
    client.open = (url: string) => {
      opened.push(url)
    }
    await client.connect()

    // A page is open but has no wallet yet: it gets told over its socket, not by the OS.
    const page = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', url: 'http://127.0.0.1:4112/#t=x' })
    sockets.push(page)
    while (client.pages === 0) await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(client.waitForSigner()).rejects.toThrow(/No wallet connected/)
    expect(opened).toEqual([])

    // Raising the browser must never go through a URL — that is what spawned stray tabs.
    const activated: string[] = []
    client.activateApp = (app: string) => {
      activated.push(app)
    }
    client.pageAgent = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
    client.focusBrowser()
    expect(opened).toEqual([])
    expect(activated).toEqual(process.platform === 'darwin' ? ['Google Chrome'] : [])

    // An unrecognised browser is left alone rather than guessed at.
    activated.length = 0
    client.pageAgent = 'some-unknown-client/1.0'
    client.focusBrowser()
    expect(activated).toEqual([])

    // With nothing connected at all, open the pairing URL — token included.
    page.close()
    while (client.pages > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(client.waitForSigner()).rejects.toThrow(/No wallet connected/)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('#t=')

    await client.stop()
  })

  it('hands only http urls to the OS opener', () => {
    const client = new WalletClient('default', { port: 4113, token: TOKEN })

    // Nothing but http(s) should ever reach the shell-free opener.
    expect(() => client.open('file:///etc/passwd')).not.toThrow()
    expect(() => client.open('not a url')).not.toThrow()
  })

  it('counts a page with no wallet connected as a page, not a signer', async () => {
    const relay = await startRelay(4111)

    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(requester)

    // A tab that is open but has no account yet, reporting the URL it is showing.
    const page = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', url: 'http://127.0.0.1:4111/' })
    sockets.push(page)
    expect(await nextMessage(requester, (m) => m.type === 'status' && m.pages === 1)).toMatchObject({
      signers: 0,
      pageUrl: 'http://127.0.0.1:4111/'
    })

    // Once it reports an account it counts as a signer.
    page.send(JSON.stringify({ type: 'status', address: '0xabc' }))
    expect(await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)).toMatchObject({ pages: 1 })
  })

  it('round-trips a request from the MCP client through an embedded relay', async () => {
    const client = new WalletClient('default', { port: 4106, token: TOKEN })
    await client.connect()

    const signer = await connect(4106, { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
    sockets.push(signer)

    // Wait for the client to see the signer, so it doesn't try to open a browser.
    while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))

    signer.on('message', (data: Buffer) => {
      const request = JSON.parse(data.toString())
      if (request.type === 'ready') return
      signer.send(JSON.stringify({ id: request.id, success: true, result: '0xhash' }))
    })

    const result = await client.request({ id: 'req-4', type: 'send_transaction', chain: 'mainnet', data: {} })
    expect(result).toBe('0xhash')
    expect(client.getAddress()).toBe('0xabc')

    await client.stop()
  })

  it('joins a relay another session already owns instead of starting a second one', async () => {
    const relay = await startRelay(4108)

    const client = new WalletClient('default', { port: 4108, token: TOKEN })
    await client.connect()

    expect(client.relay).toBeNull()
    expect(client.getUrl()).toBe(`http://127.0.0.1:4108/#t=${SIGNER_TOKEN}`)

    // Prove it is really attached to that relay: its signer count reaches the client.
    const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
    sockets.push(signer)
    while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.getAddress()).toBe('0xabc')

    await client.stop()
  })

  it('does not join a server that never acks the handshake', async () => {
    // Stands in for a stale pre-handshake build squatting on the port.
    const foreign = new WebSocketServer({ port: 4109 })
    const client = new WalletClient('default', { port: 4109, token: TOKEN })

    try {
      await client.connect()

      // It refused to attach to the silent server and owns a relay of its own instead.
      expect(client.relay).not.toBeNull()

      // And that relay works: a signer on it reaches the client.
      const signer = await connect(client.relay!.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xdef' })
      sockets.push(signer)
      while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(client.getAddress()).toBe('0xdef')
    } finally {
      await client.stop()
      await new Promise((resolve) => foreign.close(resolve))
    }
  })

  it('retries until a hosted relay finishes waking up', async () => {
    process.env.WALLET_SERVER_URL = 'http://127.0.0.1:4107'
    process.env.WALLET_TOKEN = TOKEN

    try {
      const client = new WalletClient('default')
      const connected = client.connect()

      // Relay comes up after the first attempt has already failed.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await startRelay(4107)

      await connected
      await client.stop()
    } finally {
      delete process.env.WALLET_SERVER_URL
      delete process.env.WALLET_TOKEN
    }
  })

  it('moves to the next port when the default one is taken', async () => {
    const taken = createServer()
    blockers.push(taken)
    await new Promise<void>((resolve) => taken.listen(4104, '127.0.0.1', resolve))

    const relay = await startRelay(4104)
    expect(relay.getPort()).toBe(4105)
  })

  /**
   * A request the requester has given up on must not stay approvable: the answer would reach
   * nobody, the agent would retry, and the user could end up signing the same thing twice.
   */
  describe('withdrawn requests', () => {
    it('tells the page when the requester goes away', async () => {
      const relay = await startRelay(4130)
      const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
      const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
      sockets.push(signer, requester)
      await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)

      const delivered = nextMessage(signer, (m) => m.id === 'req-gone')
      requester.send(JSON.stringify({ id: 'req-gone', type: 'send_transaction', chain: 'mainnet', data: {} }))
      await delivered

      const cancelled = nextMessage(signer, (m) => m.type === 'cancel')
      requester.close()
      expect(await cancelled).toEqual({ type: 'cancel', id: 'req-gone' })
    })

    it('only lets the requester that sent a request cancel it', async () => {
      const relay = await startRelay(4131)
      const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
      const owner = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
      const other = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
      sockets.push(signer, owner, other)
      await nextMessage(owner, (m) => m.type === 'status' && m.signers === 1)

      const delivered = nextMessage(signer, (m) => m.id === 'req-own')
      owner.send(JSON.stringify({ id: 'req-own', type: 'send_transaction', chain: 'mainnet', data: {} }))
      await delivered

      const seen: unknown[] = []
      signer.on('message', (d: Buffer) => seen.push(JSON.parse(d.toString())))
      other.send(JSON.stringify({ type: 'cancel', id: 'req-own' }))

      const answer = nextMessage(owner, (m) => m.id === 'req-own')
      signer.send(JSON.stringify({ id: 'req-own', success: true, result: '0xhash' }))
      expect(await answer).toMatchObject({ result: '0xhash' })
      expect(seen).toEqual([])
    })

    it('stamps an expiry, and cancels at the page when the client times out', async () => {
      const client = new WalletClient('default', { port: 4132, token: TOKEN })
      client.requestTimeout = 200
      await client.connect()

      const signer = await connect(4132, { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
      sockets.push(signer)
      while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))

      const delivered = nextMessage(signer, (m) => m.id === 'req-slow')
      const cancelled = nextMessage(signer, (m) => m.type === 'cancel')
      const before = Date.now()
      const outcome = client.request({ id: 'req-slow', type: 'send_transaction', chain: 'mainnet', data: { to: '0xdef' } })

      const request = await delivered
      expect(request.expiresAt).toBeGreaterThanOrEqual(before + 200)
      expect(request.expiresAt).toBeLessThanOrEqual(Date.now() + 200)

      // Timing out is not a rejection: the agent must not be told nothing was signed.
      await expect(outcome).rejects.toThrow(/outcome is unknown/)
      expect(await cancelled).toEqual({ type: 'cancel', id: 'req-slow' })

      await client.stop()
    })

    it('fails in-flight requests as unknown when the relay connection drops', async () => {
      const relay = await startRelay(4133)
      const client = new WalletClient('default', { port: 4133, token: TOKEN })
      await client.connect()

      const signer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xabc' })
      sockets.push(signer)
      while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))

      const delivered = nextMessage(signer, (m) => m.id === 'req-drop')
      const outcome = client.request({ id: 'req-drop', type: 'send_transaction', chain: 'mainnet', data: {} })
      await delivered

      client.ws.close()
      await expect(outcome).rejects.toThrow(/outcome is unknown/)

      await client.stop()
    })
  })

  it('routes to the newest page with an account, not a forgotten older one', async () => {
    const relay = await startRelay(4134)
    const older = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xold' })
    const newer = await connect(relay.getPort(), { token: SIGNER_TOKEN, role: 'signer', address: '0xnew' })
    const requester = await connect(relay.getPort(), { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(older, newer, requester)

    expect(await nextMessage(requester, (m) => m.type === 'status' && m.signers === 2)).toMatchObject({ address: '0xnew' })

    const offeredTo = new Promise<string>((resolve) => {
      older.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-n' && resolve('older'))
      newer.on('message', (d: Buffer) => JSON.parse(d.toString()).id === 'req-n' && resolve('newer'))
    })
    requester.send(JSON.stringify({ id: 'req-n', type: 'send_transaction', chain: 'mainnet', data: {} }))
    expect(await offeredTo).toBe('newer')
  })

  it('drops a page that stops answering pings, failing what was routed to it', async () => {
    const relay = new WalletRelay({ port: 4135, token: TOKEN })
    relay.heartbeatInterval = 50
    relays.push(relay)
    await relay.start()

    // A laptop gone to sleep: the socket stays open but nothing answers.
    const asleep = new WebSocket('ws://127.0.0.1:4135', { autoPong: false })
    sockets.push(asleep)
    await new Promise<void>((resolve) => asleep.once('open', () => resolve()))
    asleep.send(JSON.stringify({ token: SIGNER_TOKEN, role: 'signer', address: '0xabc' }))

    const requester = await connect(4135, { token: REQUESTER_TOKEN, role: 'requester' })
    sockets.push(requester)
    await nextMessage(requester, (m) => m.type === 'status' && m.signers === 1)

    const answer = nextMessage(requester, (m) => m.id === 'req-dead')
    const gone = nextMessage(requester, (m) => m.type === 'status' && m.pages === 0)
    requester.send(JSON.stringify({ id: 'req-dead', type: 'send_transaction', chain: 'mainnet', data: {} }))
    expect(await answer).toMatchObject({ success: false, error: expect.stringMatching(/outcome is unknown/) })
    await gone
  })

  it('closes connections past the process-wide cap', async () => {
    const relay = await startRelay(4136)
    relay.maxSockets = 2

    const open = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
      sockets.push(ws)
      return ws
    }
    // Never handshaken, so no room counts them — only the cap does.
    await Promise.all([open(), open()].map((ws) => new Promise((resolve) => ws.once('open', resolve))))

    const third = open()
    expect(await new Promise((resolve) => third.once('close', resolve))).toBe(1013)
  })

  it('serves the page with a CSP that forbids inline script and framing', async () => {
    const relay = await startRelay(4137)
    const page = await fetch(`http://127.0.0.1:${relay.getPort()}/`)

    const csp = page.headers.get('content-security-policy')
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(await page.text()).not.toMatch(/\son\w+=/)

    // Same-origin page, so nothing else needs CORS.
    const health = await fetch(`http://127.0.0.1:${relay.getPort()}/health`)
    expect(health.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('accepts its own page on a server it was attached to, and nothing else', async () => {
    const app = (await import('express')).default()
    const server = createServer(app)
    blockers.push(server)
    await new Promise<void>((resolve) => server.listen(4138, '127.0.0.1', resolve))

    // No publicUrl: the page's origin is the host server's port, not the relay's default.
    const relay = new WalletRelay({ token: TOKEN })
    relays.push(relay)
    relay.attach(server, (relayApp) => app.use(relayApp))

    const page = await fetch('http://127.0.0.1:4138/')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const handshake = (origin: string) => {
      const ws = new WebSocket('ws://127.0.0.1:4138', { origin })
      sockets.push(ws)
      return new Promise((resolve) => {
        ws.once('open', () => ws.send(JSON.stringify({ token: SIGNER_TOKEN, role: 'signer' })))
        ws.once('message', () => resolve('accepted'))
        ws.once('close', (code) => resolve(code))
      })
    }
    expect(await handshake('http://127.0.0.1:4138')).toBe('accepted')
    expect(await handshake('https://evil.example')).toBe(4003)
  })
})
