import {
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  keccak256,
  parseAbiItem,
  toBytes,
  toEventSignature,
  toFunctionSignature
} from 'viem'
import { z } from 'zod'
import type { AbiError } from '../types.js'
import { createTool, formatResponse } from '../utils.js'

const FunctionAbiSchema = z.object({
  functionAbi: z.string().describe('Function ABI definition (e.g., "function transfer(address to, uint256 amount)")')
})

const EventAbiSchema = z.object({
  eventAbi: z
    .string()
    .describe('Event ABI definition (e.g., "event Transfer(address indexed from, address indexed to, uint256 value)")')
})

const ErrorAbiSchema = z.object({
  errorAbi: z
    .string()
    .describe('Error ABI definition (e.g., "error InsufficientBalance(uint256 available, uint256 required)")')
})

export default {
  get_function_signature: createTool(
    'Calculate Function Signatures',
    'Generate 4-byte function selectors from ABI definitions. BATCH OPTIMIZED - use for transaction decoding.',
    z.object({
      items: z
        .array(FunctionAbiSchema)
        .describe('Array of function ABI definitions. Batch multiple functions for efficiency.')
    }),
    async (args) => {
      try {
        const results = args.items.map((item) => {
          const abiItem = parseAbiItem(item.functionAbi) as AbiFunction
          const signature = toFunctionSignature(abiItem)
          const hash = keccak256(toBytes(signature))
          const selector = hash.slice(0, 10)

          return {
            signature: selector,
            fullSignature: signature,
            functionName: abiItem.name,
            inputs: abiItem.inputs,
            outputs: abiItem.outputs || [],
            stateMutability: abiItem.stateMutability,
            originalAbi: item.functionAbi
          }
        })

        return formatResponse(results)
      } catch (error) {
        throw new Error(`Failed to parse function ABI: ${error}`)
      }
    }
  ),

  get_event_signature: createTool(
    'Calculate Event Signatures',
    'Generate event topic0 hashes from ABI definitions. BATCH OPTIMIZED - use for log filtering setup.',
    z.object({
      items: z.array(EventAbiSchema).describe('Array of event ABI definitions. Batch multiple events for optimal performance.')
    }),
    async (args) => {
      try {
        const results = args.items.map((item) => {
          const abiItem = parseAbiItem(item.eventAbi) as AbiEvent
          const signature = toEventSignature(abiItem)
          const hash = keccak256(toBytes(signature))

          return {
            signature: hash,
            topic0: hash,
            fullSignature: signature,
            eventName: abiItem.name,
            inputs: abiItem.inputs,
            anonymous: abiItem.anonymous || false,
            originalAbi: item.eventAbi
          }
        })

        return formatResponse(results)
      } catch (error) {
        throw new Error(`Failed to parse event ABI: ${error}`)
      }
    }
  ),

  get_error_signature: createTool(
    'Calculate Error Signatures',
    'Generate 4-byte error selectors from ABI definitions. BATCH OPTIMIZED - use for revert reason decoding.',
    z.object({
      items: z.array(ErrorAbiSchema).describe('Array of error ABI definitions. Batch related errors for efficiency.')
    }),
    async (args) => {
      try {
        const results = args.items.map((item) => {
          const abiItem = parseAbiItem(item.errorAbi) as AbiError
          const signature = `${abiItem.name}(${abiItem.inputs.map((input: AbiParameter) => input.type).join(',')})`
          const hash = keccak256(toBytes(signature))
          const selector = hash.slice(0, 10)

          return {
            signature: selector,
            fullSignature: signature,
            errorName: abiItem.name,
            inputs: abiItem.inputs,
            originalAbi: item.errorAbi
          }
        })

        return formatResponse(results)
      } catch (error) {
        throw new Error(`Failed to parse error ABI: ${error}`)
      }
    }
  )
}
