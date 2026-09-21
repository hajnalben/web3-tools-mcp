import { z } from 'zod'
import { getWalletClient } from '../wallet-client.js'
import { getClientManager, SUPPORTED_CHAINS } from '../client.js'
import { encodeFunctionData, isAddress, parseAbiItem, parseUnits, type AbiFunction, type Address } from 'viem'
import { randomBytes } from 'node:crypto'
import type { ChainName } from '../types.js'
import { buildTxPreview, type RawTx } from '../preview.js'
import { createTool, formatResponse } from '../utils.js'

function generateRequestId(): string {
  return randomBytes(16).toString('hex')
}

function requireAddress(label: string, address: string): Address {
  if (!isAddress(address)) throw new Error(`Invalid ${label}: ${address}`)
  return address
}

function explorerTxUrl(chain: ChainName, txHash: unknown): string {
  return `https://${getClientManager().getEtherscanDomain(chain)}/tx/${txHash}`
}

/**
 * Send a transaction for signing, with a decoded + simulated preview attached so the
 * wallet page can show what it actually does instead of raw calldata.
 */
async function requestSignature(chain: ChainName, tx: RawTx & { data?: string }) {
  const wallet = getWalletClient()
  await wallet.waitForSigner()

  const preview = await buildTxPreview(chain, tx, wallet.getAddress())

  return {
    txHash: await wallet.request({
      id: generateRequestId(),
      type: 'send_transaction',
      chain,
      data: { to: tx.to, value: tx.value ?? '0x0', ...(tx.data && { data: tx.data }) },
      preview
    }),
    preview
  }
}

function failure(error: unknown, message: string) {
  return formatResponse({
    success: false,
    error: error instanceof Error ? error.message : String(error),
    message
  })
}

export default {
  send_native_token: createTool(
    'Send Native Token',
    'Send native tokens (ETH, MATIC, BNB, etc.) to an address. Simulates the transaction, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in native token (e.g., "0.1" for 0.1 ETH)'),
      data: z.string().optional().describe('Optional hex-encoded data to include with transaction')
    }),
    async (args) => {
      try {
        const to = requireAddress('recipient address', args.to)
        const value = `0x${parseUnits(args.amount, 18).toString(16)}`

        const { txHash, preview } = await requestSignature(args.chain as ChainName, { to, value, data: args.data })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          to,
          amount: args.amount,
          simulation: preview.simulation,
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Transaction failed or was rejected')
      }
    }
  ),

  send_erc20_token: createTool(
    'Send ERC20 Token',
    'Send ERC20 tokens to an address. Simulates the transfer, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      tokenAddress: z.string().describe('ERC20 token contract address'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in token units (e.g., "100" for 100 USDC)'),
      decimals: z.number().optional().default(18).describe('Token decimals (default: 18)')
    }),
    async (args) => {
      try {
        const tokenAddress = requireAddress('token address', args.tokenAddress)
        const to = requireAddress('recipient address', args.to)

        const data = encodeFunctionData({
          abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
          args: [to, parseUnits(args.amount, args.decimals ?? 18)]
        })

        const { txHash, preview } = await requestSignature(args.chain as ChainName, { to: tokenAddress, data, value: '0x0' })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          tokenAddress,
          to,
          amount: args.amount,
          simulation: preview.simulation,
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Token transfer failed or was rejected')
      }
    }
  ),

  call_contract_write: createTool(
    'Call Contract (Write)',
    'Call a state-changing contract function. Simulates the call, then opens the browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      contractAddress: z.string().describe('Contract address'),
      functionAbi: z.string().describe('Function ABI definition (e.g., "function transfer(address to, uint256 amount)")'),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Function arguments in order matching the ABI signature'),
      value: z.string().optional().describe('Optional native value to send with transaction (in ETH units, e.g., "0.1")')
    }),
    async (args) => {
      try {
        const contractAddress = requireAddress('contract address', args.contractAddress)
        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction

        const data = encodeFunctionData({
          abi: [abiItem],
          functionName: abiItem.name,
          args: (args.args || []) as readonly unknown[]
        })
        const value = args.value ? `0x${parseUnits(args.value, 18).toString(16)}` : '0x0'

        const { txHash, preview } = await requestSignature(args.chain as ChainName, { to: contractAddress, data, value })

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          contractAddress,
          functionName: abiItem.name,
          simulation: preview.simulation,
          explorerUrl: explorerTxUrl(args.chain as ChainName, txHash)
        })
      } catch (error) {
        return failure(error, 'Contract call failed or was rejected')
      }
    }
  ),

  sign_message: createTool(
    'Sign Message',
    'Sign a message with the connected wallet. Opens browser wallet for approval.',
    z.object({
      message: z.string().describe('Message to sign')
    }),
    async (args) => {
      try {
        const signature = await getWalletClient().request({
          id: generateRequestId(),
          type: 'sign_message',
          chain: 'any',
          data: { message: args.message }
        })

        return formatResponse({
          success: true,
          message: args.message,
          signature,
          signatureType: 'personal_sign'
        })
      } catch (error) {
        return failure(error, 'Message signing failed or was rejected')
      }
    }
  ),

  wallet_status: createTool(
    'Wallet Status',
    'Check if a wallet is connected to the browser interface',
    z.object({}),
    async () => {
      const wallet = getWalletClient()

      try {
        await wallet.connect()
      } catch (error) {
        return failure(error, 'Wallet relay unavailable')
      }

      if (!wallet.isConnected()) wallet.openBrowser()

      return formatResponse({
        connected: wallet.isConnected(),
        address: wallet.getAddress(),
        walletUrl: wallet.getUrl(),
        openTab: wallet.getPageUrl(),
        hosted: wallet.isRemote,
        message: wallet.isConnected()
          ? 'Wallet is connected and ready to sign transactions'
          : `No wallet connected. Open ${wallet.getUrl()} and connect your wallet.`
      })
    }
  )
}
