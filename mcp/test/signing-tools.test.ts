import { encodeFunctionData, parseAbiItem, toHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tokenMeta } from '../src/chain-meta.js'
import { getClientManager } from '../src/client.js'
import tools from '../src/tools/sign/transactions.js'

vi.mock('../src/chain-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chain-meta.js')>()),
  tokenMeta: vi.fn()
}))
vi.mock('../src/preview.js', () => ({
  buildTxPreview: vi.fn(async (chain: string, tx: { to: string }) => ({ chain, to: tx.to }))
}))

const browser = vi.hoisted(() => ({
  waitForSigner: async () => {},
  getAddress: () => '0x28C6c06298d514Db089934071355E5743bf21d60',
  request: vi.fn()
}))
vi.mock('../src/wallet-client.js', () => ({ getWalletClient: () => browser }))

const phone = vi.hoisted(() => ({
  session: async () => ({ topic: 't', accounts: ['0x28C6c06298d514Db089934071355E5743bf21d60'], chains: [8453] }),
  sessions: async () => [],
  request: vi.fn()
}))
vi.mock('../src/walletconnect.js', () => ({ getPhoneSigner: () => phone }))

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TO = '0x000000000000000000000000000000000000dEaD'

function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text)
}

beforeEach(() => {
  browser.request.mockResolvedValue('0xhash')
  phone.request.mockResolvedValue('0xhash')
  vi.spyOn(getClientManager(), 'getClient').mockReturnValue({
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 21000n })
  } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  browser.request.mockReset()
  phone.request.mockReset()
})

describe('send_erc20_token decimals', () => {
  const send = (decimals?: number) =>
    tools.send_erc20_token.handler(
      { chain: 'mainnet', tokenAddress: TOKEN, to: TO, amount: '1', decimals, signWith: 'browser' },
      'test'
    )

  it('uses the decimals the token reports', async () => {
    vi.mocked(tokenMeta).mockResolvedValue({ symbol: 'USDC', decimals: 6 })
    await send()
    const expected = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
      args: [TO, 1_000_000n]
    })
    expect(browser.request.mock.calls[0]?.[0].data.data).toBe(expected)
  })

  it('refuses a caller-supplied figure that disagrees with the token', async () => {
    vi.mocked(tokenMeta).mockResolvedValue({ symbol: 'USDC', decimals: 6 })
    const result = body(await send(18))
    expect(result.success).toBe(false)
    expect(result.error).toContain('reports 6')
    expect(browser.request).not.toHaveBeenCalled()
  })

  it('refuses to guess when decimals cannot be read and none were given', async () => {
    vi.mocked(tokenMeta).mockResolvedValue({ symbol: undefined, decimals: undefined })
    const result = body(await send())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Could not read decimals()')
    expect(browser.request).not.toHaveBeenCalled()
  })
})

describe('write_contract arguments', () => {
  const functionAbi = 'function set(uint256 amount, bool flag)'

  it('rejects a JSON number too large to be exact', () => {
    const parsed = tools.write_contract.schema.safeParse({
      chain: 'mainnet',
      contractAddress: TO,
      functionAbi,
      args: [2 ** 53 + 2, true],
      signWith: 'browser'
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('as strings')
  })

  it('coerces string arguments to their ABI types', async () => {
    await tools.write_contract.handler(
      {
        chain: 'mainnet',
        contractAddress: TO,
        functionAbi,
        args: ['123456789012345678901234567890', 'true'],
        signWith: 'browser'
      },
      'test'
    )
    const expected = encodeFunctionData({ abi: [parseAbiItem(functionAbi)], args: [123456789012345678901234567890n, true] })
    expect(browser.request.mock.calls[0]?.[0].data.data).toBe(expected)
  })
})

describe('sign_message', () => {
  // Looks like hex, which a wallet given the raw string would sign as 4 bytes, not 10 characters.
  const message = '0xdeadbeef'

  it('sends the same hex-encoded bytes to either signer', async () => {
    await tools.sign_message.handler({ message, signWith: 'browser' }, 'test')
    await tools.sign_message.handler({ message, signWith: 'phone' }, 'test')

    expect(browser.request.mock.calls[0]?.[0].data.message).toBe(toHex(message))
    expect(phone.request.mock.calls[0]?.[2]?.[0]).toBe(toHex(message))
  })

  it('asks the phone on a chain its session approved', async () => {
    await tools.sign_message.handler({ message, signWith: 'phone' }, 'test')
    expect(phone.request.mock.calls[0]?.[0]).toBe('base')
  })
})

describe('localhost', () => {
  it('is refused on a phone before anything reaches the wallet', async () => {
    const result = body(
      await tools.send_native_token.handler({ chain: 'localhost', to: TO, amount: '1', signWith: 'phone' }, 'test')
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('localhost')
    expect(phone.request).not.toHaveBeenCalled()
  })
})
