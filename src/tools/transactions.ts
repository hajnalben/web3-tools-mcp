import { z } from 'zod'
import { getWalletServer } from '../wallet-server.js'
import { SUPPORTED_CHAINS } from '../client.js'
import { parseUnits, encodeFunctionData, parseAbiItem, type AbiFunction } from 'viem'
import { randomBytes } from 'crypto'
import { createTool, formatResponse } from '../utils.js'

function generateRequestId(): string {
  return randomBytes(16).toString('hex')
}

export default {
  send_native_token: createTool(
    'Send Native Token',
    'Send native tokens (ETH, MATIC, BNB, etc.) to an address. Opens browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in native token (e.g., "0.1" for 0.1 ETH)'),
      data: z.string().optional().describe('Optional hex-encoded data to include with transaction')
    }),
    async (args) => {
      const walletServer = getWalletServer()

      try {
        // Parse amount to wei
        const value = '0x' + parseUnits(args.amount, 18).toString(16)

        const txRequest = {
          id: generateRequestId(),
          type: 'send_transaction' as const,
          chain: args.chain,
          data: {
            to: args.to,
            value,
            ...(args.data && { data: args.data })
          }
        }

        console.error(`[Transaction] Sending ${args.amount} native token to ${args.to} on ${args.chain}`)
        const txHash = await walletServer.sendTransaction(txRequest)

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          to: args.to,
          amount: args.amount,
          message: `Successfully sent ${args.amount} native token`,
          explorerUrl: `https://etherscan.io/tx/${txHash}`
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return formatResponse({
          success: false,
          error: errorMessage,
          message: 'Transaction failed or was rejected'
        })
      }
    }
  ),

  send_erc20_token: createTool(
    'Send ERC20 Token',
    'Send ERC20 tokens to an address. Opens browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      tokenAddress: z.string().describe('ERC20 token contract address'),
      to: z.string().describe('Recipient address'),
      amount: z.string().describe('Amount in token units (e.g., "100" for 100 USDC)'),
      decimals: z.number().optional().default(18).describe('Token decimals (default: 18)')
    }),
    async (args) => {
      const walletServer = getWalletServer()

      try {
        const decimals = args.decimals || 18
        const amountWei = parseUnits(args.amount, decimals)

        // ERC20 transfer(address to, uint256 amount)
        const data = `0xa9059cbb${args.to.slice(2).padStart(64, '0')}${amountWei.toString(16).padStart(64, '0')}`

        const txRequest = {
          id: generateRequestId(),
          type: 'send_transaction' as const,
          chain: args.chain,
          data: {
            to: args.tokenAddress,
            data,
            value: '0x0'
          }
        }

        console.error(`[Transaction] Sending ${args.amount} tokens to ${args.to} on ${args.chain}`)
        const txHash = await walletServer.sendTransaction(txRequest)

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          tokenAddress: args.tokenAddress,
          to: args.to,
          amount: args.amount,
          message: `Successfully sent ${args.amount} tokens`,
          explorerUrl: `https://etherscan.io/tx/${txHash}`
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return formatResponse({
          success: false,
          error: errorMessage,
          message: 'Token transfer failed or was rejected'
        })
      }
    }
  ),

  call_contract_write: createTool(
    'Call Contract (Write)',
    'Call a state-changing contract function (write operation). Opens browser wallet for approval.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('Blockchain network'),
      contractAddress: z.string().describe('Contract address'),
      functionAbi: z.string().describe('Function ABI definition (e.g., "function transfer(address to, uint256 amount)")'),
      args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Function arguments in order matching the ABI signature'),
      value: z.string().optional().describe('Optional ETH value to send with transaction (in ETH units, e.g., "0.1")')
    }),
    async (args) => {
      const walletServer = getWalletServer()

      try {
        // Parse the function ABI and encode the call data
        console.error(`[Transaction] Parsing ABI: ${args.functionAbi}`)
        console.error(`[Transaction] Args: ${JSON.stringify(args.args)}`)

        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction
        console.error(`[Transaction] Parsed function: ${abiItem.name}`)

        const data = encodeFunctionData({
          abi: [abiItem],
          functionName: abiItem.name,
          args: (args.args || []) as readonly unknown[]
        })
        console.error(`[Transaction] Encoded data: ${data}`)

        const valueHex = args.value ? '0x' + parseUnits(args.value, 18).toString(16) : '0x0'

        const txRequest = {
          id: generateRequestId(),
          type: 'send_transaction' as const,
          chain: args.chain,
          data: {
            to: args.contractAddress,
            data,
            value: valueHex
          }
        }

        console.error(`[Transaction] Calling ${abiItem.name}() on ${args.contractAddress} (${args.chain})`)
        const txHash = await walletServer.sendTransaction(txRequest)

        return formatResponse({
          success: true,
          chain: args.chain,
          transactionHash: txHash,
          contractAddress: args.contractAddress,
          functionName: abiItem.name,
          message: `Contract call to ${abiItem.name}() successful`,
          explorerUrl: `https://etherscan.io/tx/${txHash}`
        })
      } catch (error) {
        console.error(`[Transaction] Error:`, error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        return formatResponse({
          success: false,
          error: errorMessage,
          message: 'Contract call failed or was rejected'
        })
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
      const walletServer = getWalletServer()

      try {
        const request = {
          id: generateRequestId(),
          type: 'sign_message' as const,
          chain: 'any',
          data: {
            message: args.message
          }
        }

        console.error(`[Transaction] Signing message`)
        const signature = await walletServer.sendTransaction(request)

        return formatResponse({
          success: true,
          message: args.message,
          signature,
          signatureType: 'personal_sign'
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return formatResponse({
          success: false,
          error: errorMessage,
          message: 'Message signing failed or was rejected'
        })
      }
    }
  ),

  wallet_status: createTool(
    'Wallet Status',
    'Check if a wallet is connected to the browser interface',
    z.object({}),
    async () => {
      const walletServer = getWalletServer()
      const isConnected = walletServer.isConnected()
      const port = walletServer.getPort()

      // Auto-open browser if no wallet connected
      if (!isConnected) {
        walletServer.openBrowser()
      }

      return formatResponse({
        connected: isConnected,
        walletUrl: `http://localhost:${port}`,
        message: isConnected
          ? 'Wallet is connected and ready to sign transactions'
          : `No wallet connected. Opening browser to connect... Visit http://localhost:${port} if it didn't open automatically.`
      })
    }
  )
}

