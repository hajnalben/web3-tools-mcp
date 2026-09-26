import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { encodeFunctionData, HttpRequestError, parseAbiItem } from 'viem'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tokenMeta } from '../src/chain-meta.js'
import { getClientManager, initializeClientManager } from '../src/client.js'
import { registerAllTools } from '../src/tools/index.js'
import advancedTools from '../src/tools/read/advanced.js'
import contractInfoTools from '../src/tools/read/contract-info.js'
import gasTools from '../src/tools/read/gas.js'
import logTools, { capLogs, hypersyncRange, MAX_LOGS, toTopics } from '../src/tools/read/logs.js'
import signatureTools from '../src/tools/read/signatures.js'
import { convertEventArgsToTypes, redactSecrets, rpcReason, TtlCache } from '../src/utils.js'

/**
 * Offline: every RPC is replaced by a fake client or a stubbed fetch, so these run without
 * keys or network and pin down how tools format, encode and validate.
 */

const SECRETS = {
  alchemyApiKey: 'alchemy-secret-key-123',
  infuraApiKey: 'infura-secret-key-456',
  etherscanApiKey: 'etherscan-secret-key-789',
  hypersyncApiKey: 'hypersync-secret-key-000'
}

beforeAll(() => {
  initializeClientManager(SECRETS)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fakeClient(client: Record<string, unknown>) {
  return vi.spyOn(getClientManager(), 'getClient').mockReturnValue(client as never)
}

const json = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text)

describe('secret redaction', () => {
  it('blanks every configured key out of text', () => {
    const text = `https://eth-mainnet.g.alchemy.com/v2/${SECRETS.alchemyApiKey} and ${SECRETS.etherscanApiKey}`
    expect(redactSecrets(text, SECRETS)).toBe('https://eth-mainnet.g.alchemy.com/v2/[redacted] and [redacted]')
    expect(redactSecrets('nothing here', {})).toBe('nothing here')
  })

  function registered(middleware: Parameters<typeof registerAllTools>[1]) {
    const server = new McpServer({ name: 'test', version: '0' })
    const tools = new Map<string, (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>>()
    server.registerTool = ((name: string, _config: unknown, handler: never) => {
      tools.set(name, handler)
    }) as unknown as typeof server.registerTool
    registerAllTools(server, middleware)
    return tools
  }

  it('redacts keys from what a tool returns', async () => {
    const tools = registered(async () => ({
      content: [{ type: 'text', text: `{"error":"https://x.infura.io/v3/${SECRETS.infuraApiKey}"}` }]
    }))
    const result = await tools.get('get_gas_price')?.({ chain: 'mainnet' }, {})
    expect(result?.content[0].text).toBe('{"error":"https://x.infura.io/v3/[redacted]"}')
  })

  it('redacts keys from what a tool throws', async () => {
    const tools = registered(async () => {
      throw new Error(`request to https://eth-mainnet.g.alchemy.com/v2/${SECRETS.alchemyApiKey} failed`)
    })
    await expect(tools.get('get_gas_price')?.({ chain: 'mainnet' }, {})).rejects.toThrow(
      'request to https://eth-mainnet.g.alchemy.com/v2/[redacted] failed'
    )
  })
})

describe('rpcReason', () => {
  it('gives the reason without the request URL', () => {
    const error = new HttpRequestError({
      url: `https://eth-mainnet.g.alchemy.com/v2/${SECRETS.alchemyApiKey}`,
      status: 401,
      details: 'Unauthorized'
    })
    expect(error.message).toContain(SECRETS.alchemyApiKey)
    expect(rpcReason(error)).toBe('Unauthorized')
  })

  it('keeps the message of an error that is not viem’s', () => {
    expect(rpcReason(new Error('Invalid address format'))).toBe('Invalid address format')
    expect(rpcReason('plain')).toBe('plain')
  })
})

describe('signatures with tuple parameters', () => {
  it('hashes an error with a tuple as Solidity does', async () => {
    const [error] = json(
      await signatureTools.get_error_signature.handler({ items: [{ errorAbi: 'error Bad((uint256,address) x)' }] }, '')
    )
    expect(error.fullSignature).toBe('Bad((uint256,address))')
    expect(error.signature).toBe('0x4e8cae55')
  })

  it('hashes functions and events with tuples', async () => {
    const [fn] = json(
      await signatureTools.get_function_signature.handler({ items: [{ functionAbi: 'function f((uint256,address) x)' }] }, '')
    )
    expect(fn.signature).toBe('0x31e3e7da')

    const [event] = json(
      await signatureTools.get_event_signature.handler({ items: [{ eventAbi: 'event E((uint256,address) x)' }] }, '')
    )
    expect(event.topic0).toBe('0xf1fcfcf183a614f3d7529bde8b3ea2d759de34abb3e3279a93900a47334759a6')
  })
})

describe('encode_function_data', () => {
  it('coerces JSON arguments to their ABI types', async () => {
    const abi = parseAbiItem('function f(uint256 a, bool b)')
    const result = json(
      await signatureTools.encode_function_data.handler(
        { functionAbi: 'function f(uint256 a, bool b)', args: ['1000000000000000000000', 'false'] },
        ''
      )
    )
    expect(result.data).toBe(encodeFunctionData({ abi: [abi], functionName: 'f', args: [10n ** 21n, false] }))
  })
})

describe('get_logs arguments', () => {
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
  const a = '0x1111111111111111111111111111111111111111'
  const b = '0x2222222222222222222222222222222222222222'

  it('coerces each value of a list, for an OR filter', () => {
    expect(convertEventArgsToTypes({ to: [a, b], value: [1, '2'] }, transfer.inputs)).toEqual({ to: [a, b], value: [1n, 2n] })
  })

  it('turns a list into alternative topics', () => {
    expect(toTopics([a, 5n])).toEqual([`0x${'0'.repeat(24)}${a.slice(2)}`, `0x${'0'.repeat(63)}5`])
    expect(toTopics(true)).toBe(`0x${'0'.repeat(63)}1`)
  })

  it('refuses an invalid address instead of dropping the filter', async () => {
    await expect(
      logTools.get_logs.handler(
        {
          chain: 'mainnet',
          eventAbi: 'event Transfer(address indexed from, address indexed to, uint256 value)',
          address: '0xnope'
        },
        ''
      )
    ).rejects.toThrow('Invalid contract address: 0xnope')
  })

  it('asks Hypersync for one block past toBlock, and defaults to the latest block', () => {
    expect(hypersyncRange('100', '200', 999)).toEqual({ fromBlock: 100, toBlock: 201 })
    expect(hypersyncRange('0x10', '0x20', 999)).toEqual({ fromBlock: 16, toBlock: 33 })
    expect(hypersyncRange(undefined, undefined, 500)).toEqual({ fromBlock: 500, toBlock: 501 })
  })

  it('caps the number of logs and says where to resume', () => {
    const logs = Array.from({ length: MAX_LOGS + 5 }, (_, i) => ({
      address: a,
      blockHash: null,
      blockNumber: BigInt(i),
      data: '0x',
      logIndex: 0,
      topics: [],
      transactionHash: null,
      transactionIndex: 0,
      eventName: 'Transfer',
      args: {}
    })) as Parameters<typeof capLogs>[0]

    const capped = capLogs(logs)
    expect(capped.logs).toHaveLength(MAX_LOGS)
    expect(capped.truncated).toBe(true)
    expect(capped.nextBlock).toBe(String(MAX_LOGS))
    expect(capLogs(logs.slice(0, 3))).toEqual({ logs: expect.any(Array) })
  })
})

describe('get_gas_price', () => {
  it('shows sub-gwei L2 prices exactly, with the chain’s own currency', async () => {
    fakeClient({
      chain: { nativeCurrency: { symbol: 'xDAI' } },
      getGasPrice: async () => 1234n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2000n, maxPriorityFeePerGas: 1n })
    })

    const result = json(await gasTools.get_gas_price.handler({ chain: 'gnosis', formatted: true }, ''))
    expect(result.legacy.gasPrice).toBe('0.000001234 Gwei')
    expect(result.eip1559.maxPriorityFeePerGas).toBe('0.000000001 Gwei')
    expect(result.eip1559.estimatedCostFor21kGas).toBe('0.000000000042 xDAI')
  })
})

describe('get_storage_at', () => {
  it('shows a zero value as zero, not as missing', async () => {
    fakeClient({ getStorageAt: async () => `0x${'0'.repeat(64)}` })

    const result = json(
      await advancedTools.get_storage_at.handler(
        { chain: 'mainnet', address: '0x1111111111111111111111111111111111111111', slot: '0x0', abiType: 'uint8' },
        ''
      )
    )
    expect(result.decodedValue).toBe(0)
    expect(result.formattedValue).toBe('0')
  })
})

describe('caches', () => {
  it('forgets entries past their TTL and the oldest past the size bound', () => {
    vi.useFakeTimers()
    const cache = new TtlCache<number>(2, 1000)

    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)

    vi.advanceTimersByTime(1001)
    expect(cache.get('c')).toBeUndefined()
  })

  const token = '0x3333333333333333333333333333333333333333'

  it('does not cache token metadata from a failed call', async () => {
    const multicall = vi.fn(async () => [
      { status: 'failure', error: new Error('flaky') },
      { status: 'success', result: 'TKN' }
    ])
    fakeClient({ multicall })

    expect(await tokenMeta('arbitrum', token)).toEqual({ decimals: undefined, symbol: 'TKN' })
    await tokenMeta('arbitrum', token)
    expect(multicall).toHaveBeenCalledTimes(2)
  })

  it('caches token metadata that loaded, except on a local node', async () => {
    const multicall = vi.fn(async () => [
      { status: 'success', result: 6 },
      { status: 'success', result: 'USDC' }
    ])
    fakeClient({ multicall })

    await tokenMeta('optimism', token)
    await tokenMeta('optimism', token)
    expect(multicall).toHaveBeenCalledTimes(1)

    await tokenMeta('localhost', token)
    await tokenMeta('localhost', token)
    expect(multicall).toHaveBeenCalledTimes(3)
  })
})

describe('Etherscan errors', () => {
  const address = '0x4444444444444444444444444444444444444444'

  it('surfaces the reason Etherscan gives, and does not cache the failure', async () => {
    const fetch = vi.fn(async () => Response.json({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }))
    vi.stubGlobal('fetch', fetch)

    const call = () => contractInfoTools.get_contract_abi.handler({ chain: 'mainnet', address }, '')
    await expect(call()).rejects.toThrow('Etherscan API error: Invalid API Key')
    await expect(call()).rejects.toThrow('Invalid API Key')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports an HTTP failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }))
    await expect(contractInfoTools.get_contract_abi.handler({ chain: 'mainnet', address }, '')).rejects.toThrow(
      'Etherscan API error: HTTP 503'
    )
  })
})
