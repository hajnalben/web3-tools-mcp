import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WalletRelay } from 'web3-wallet-relay'
import { WebSocket, WebSocketServer } from 'ws'
import { WalletClient } from '../src/wallet-client.js'

const TOKEN = 'test-token'

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

    const signer = await connect(relay.getPort(), { token: TOKEN, role: 'signer', address: '0xabc' })
    const requester = await connect(relay.getPort(), { token: TOKEN, role: 'requester' })
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

  it('rejects connections with a wrong token', async () => {
    const relay = await startRelay(4101)

    const ws = new WebSocket(`ws://127.0.0.1:${relay.getPort()}`)
    sockets.push(ws)
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    ws.once('open', () => ws.send(JSON.stringify({ token: 'wrong', role: 'signer' })))

    expect(await closed).toBe(4001)
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

      const asSigner = await handshake(relay.getPort(), 'https://evil.example', { token: TOKEN, role: 'signer' })
      expect(asSigner).toEqual({ closed: 4003 })

      // The dangerous direction: a page that could push a proposal into your wallet.
      const asRequester = await handshake(relay.getPort(), 'https://evil.example', { token: TOKEN, role: 'requester' })
      expect(asRequester).toEqual({ closed: 4003 })
    })

    it('accepts the page it serves itself', async () => {
      const relay = await startRelay(4111)
      const result = await handshake(relay.getPort(), `http://127.0.0.1:${relay.getPort()}`, { token: TOKEN, role: 'signer' })
      expect(result).toEqual({ accepted: true })
    })

    it('accepts a non-browser client, which sends no origin', async () => {
      const relay = await startRelay(4112)
      const result = await handshake(relay.getPort(), undefined, { token: TOKEN, role: 'requester' })
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
    ws.once('open', () => ws.send(JSON.stringify({ token: TOKEN, role: 'signer', address: '0xabc' })))
    expect(await ready).toMatchObject({ type: 'ready' })
  })

  it('fails the request when no signer is connected', async () => {
    const relay = await startRelay(4102)

    const requester = await connect(relay.getPort(), { token: TOKEN, role: 'requester' })
    sockets.push(requester)

    const response = nextMessage(requester, (m) => m.id === 'req-2')
    requester.send(JSON.stringify({ id: 'req-2', type: 'send_transaction', chain: 'mainnet', data: {} }))
    expect(await response).toMatchObject({ success: false, error: 'No wallet connected' })
  })

  it('fails in-flight requests when the signer disconnects', async () => {
    const relay = await startRelay(4103)

    const signer = await connect(relay.getPort(), { token: TOKEN, role: 'signer', address: '0xabc' })
    const requester = await connect(relay.getPort(), { token: TOKEN, role: 'requester' })
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
    const client = new WalletClient({ port: 4112, token: TOKEN })
    client.signerWaitTimeout = 200
    const opened: string[] = []
    client.open = (url: string) => {
      opened.push(url)
    }
    await client.connect()

    // A page is open but has no wallet yet: it gets told over its socket, not by the OS.
    const page = await connect(relay.getPort(), { token: TOKEN, role: 'signer', url: 'http://127.0.0.1:4112/#t=x' })
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
    const client = new WalletClient({ port: 4113, token: TOKEN })

    // Nothing but http(s) should ever reach the shell-free opener.
    expect(() => client.open('file:///etc/passwd')).not.toThrow()
    expect(() => client.open('not a url')).not.toThrow()
  })

  it('counts a page with no wallet connected as a page, not a signer', async () => {
    const relay = await startRelay(4111)

    const requester = await connect(relay.getPort(), { token: TOKEN, role: 'requester' })
    sockets.push(requester)

    // A tab that is open but has no account yet, reporting the URL it is showing.
    const page = await connect(relay.getPort(), { token: TOKEN, role: 'signer', url: 'http://127.0.0.1:4111/' })
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
    const client = new WalletClient({ port: 4106, token: TOKEN })
    await client.connect()

    const signer = await connect(4106, { token: TOKEN, role: 'signer', address: '0xabc' })
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

    const client = new WalletClient({ port: 4108, token: TOKEN })
    await client.connect()

    expect(client.relay).toBeNull()
    expect(client.getUrl()).toBe(`http://127.0.0.1:4108/#t=${TOKEN}`)

    // Prove it is really attached to that relay: its signer count reaches the client.
    const signer = await connect(relay.getPort(), { token: TOKEN, role: 'signer', address: '0xabc' })
    sockets.push(signer)
    while (!client.isConnected()) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.getAddress()).toBe('0xabc')

    await client.stop()
  })

  it('does not join a server that never acks the handshake', async () => {
    // Stands in for a stale pre-handshake build squatting on the port.
    const foreign = new WebSocketServer({ port: 4109 })
    const client = new WalletClient({ port: 4109, token: TOKEN })

    try {
      await client.connect()

      // It refused to attach to the silent server and owns a relay of its own instead.
      expect(client.relay).not.toBeNull()

      // And that relay works: a signer on it reaches the client.
      const signer = await connect(client.relay!.getPort(), { token: TOKEN, role: 'signer', address: '0xdef' })
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
      const client = new WalletClient()
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
})
