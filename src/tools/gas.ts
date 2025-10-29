import { type AbiFunction, type Address, isAddress, parseAbiItem, encodeFunctionData, decodeFunctionResult } from "viem";
import { z } from "zod";
import type { ChainName } from "../types.js";
import { getClientManager, SUPPORTED_CHAINS } from "../client.js";
import { convertArgumentsToTypes, createTool, formatResponse } from "../utils.js";

export default {
  simulate_contract: createTool(
    "Simulate Contract Call",
    "Simulate a contract call (including state-changing functions) without broadcasting. Returns simulation result and estimated gas.",
    z.object({
      chain: z
        .enum(SUPPORTED_CHAINS)
        .describe("Blockchain network to simulate on"),
      contractAddress: z
        .string()
        .describe("Contract address to call"),
      functionAbi: z
        .string()
        .describe(
          'Function ABI signature (e.g., "function transfer(address to, uint256 amount)"). Can be any function type.'
        ),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Function arguments in order matching the ABI signature"),
      from: z
        .string()
        .optional()
        .describe("Sender address (defaults to zero address)"),
      value: z
        .string()
        .optional()
        .describe("ETH value to send with the transaction (in wei as string)"),
      blockNumber: z
        .string()
        .optional()
        .describe("Block number for simulation (defaults to latest)"),
    }),
    async (args) => {
      if (!isAddress(args.contractAddress)) {
        throw new Error(`Invalid contract address: ${args.contractAddress}`);
      }

      if (args.from && !isAddress(args.from)) {
        throw new Error(`Invalid from address: ${args.from}`);
      }

      const clientManager = getClientManager();
      const client = clientManager.getClient(args.chain as ChainName);

      try {
        const abiItem = parseAbiItem(args.functionAbi) as AbiFunction;
        const convertedArgs = convertArgumentsToTypes(args.args || [], abiItem.inputs);

        const blockTag = args.blockNumber ? BigInt(args.blockNumber) : undefined;

        // Simulate the call
        const result = await client.call({
          to: args.contractAddress as Address,
          data: encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: convertedArgs,
          }),
          account: args.from ? (args.from as Address) : undefined,
          value: args.value ? BigInt(args.value) : undefined,
          blockNumber: blockTag,
        });

        // Also estimate gas
        const gasEstimate = await client.estimateGas({
          to: args.contractAddress as Address,
          data: encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: convertedArgs,
          }),
          account: args.from ? (args.from as Address) : undefined,
          value: args.value ? BigInt(args.value) : undefined,
          blockNumber: blockTag,
        });

        // Decode the result if the function has outputs
        let decodedResult: unknown = result.data;
        if (abiItem.outputs && abiItem.outputs.length > 0 && result.data) {
          decodedResult = decodeFunctionResult({
            abi: [abiItem],
            functionName: abiItem.name,
            data: result.data,
          });
        }

        return formatResponse({
          success: true,
          chain: args.chain,
          contractAddress: args.contractAddress,
          functionName: abiItem.name,
          result: decodedResult,
          rawData: result.data,
          gasEstimate: gasEstimate.toString(),
          blockNumber: args.blockNumber || "latest",
        });
      } catch (error) {
        // Check if it's a revert error
        const errorMessage = error instanceof Error ? error.message : String(error);

        return formatResponse({
          success: false,
          chain: args.chain,
          contractAddress: args.contractAddress,
          error: errorMessage,
          reverted: errorMessage.includes("revert") || errorMessage.includes("execution reverted"),
        });
      }
    }
  ),

  estimate_gas: createTool(
    "Estimate Gas",
    "Estimate gas required for a transaction. Supports contract calls, transfers, and deployments.",
    z.object({
      chain: z
        .enum(SUPPORTED_CHAINS)
        .describe("Blockchain network"),
      to: z
        .string()
        .optional()
        .describe("Recipient address (omit for contract deployment)"),
      from: z
        .string()
        .optional()
        .describe("Sender address (optional)"),
      value: z
        .string()
        .optional()
        .describe("ETH value to send (in wei as string)"),
      data: z
        .string()
        .optional()
        .describe("Transaction data (hex string for contract calls or deployment bytecode)"),
      functionAbi: z
        .string()
        .optional()
        .describe("Optional: Function ABI signature to encode call data automatically"),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Optional: Function arguments (only used with functionAbi)"),
    }),
    async (args) => {
      if (args.to && !isAddress(args.to)) {
        throw new Error(`Invalid to address: ${args.to}`);
      }

      if (args.from && !isAddress(args.from)) {
        throw new Error(`Invalid from address: ${args.from}`);
      }

      const clientManager = getClientManager();
      const client = clientManager.getClient(args.chain as ChainName);

      try {
        let callData = args.data;

        // If functionAbi is provided, encode the call data
        if (args.functionAbi) {
          const abiItem = parseAbiItem(args.functionAbi) as AbiFunction;
          const convertedArgs = convertArgumentsToTypes(args.args || [], abiItem.inputs);
          callData = encodeFunctionData({
            abi: [abiItem],
            functionName: abiItem.name,
            args: convertedArgs,
          });
        }

        const gasEstimate = await client.estimateGas({
          to: args.to ? (args.to as Address) : undefined,
          account: args.from ? (args.from as Address) : undefined,
          value: args.value ? BigInt(args.value) : undefined,
          data: callData as `0x${string}` | undefined,
        });

        return formatResponse({
          success: true,
          chain: args.chain,
          gasEstimate: gasEstimate.toString(),
          to: args.to,
          from: args.from,
          value: args.value,
        });
      } catch (error) {
        throw new Error(`Gas estimation failed: ${error}`);
      }
    }
  ),

  get_gas_price: createTool(
    "Get Gas Price",
    "Get current gas prices for a chain. Returns both legacy gasPrice and EIP-1559 fees (maxFeePerGas, maxPriorityFeePerGas).",
    z.object({
      chain: z
        .enum(SUPPORTED_CHAINS)
        .describe("Blockchain network"),
      formatted: z
        .boolean()
        .optional()
        .default(true)
        .describe("Return prices in Gwei (default: true). If false, returns wei."),
    }),
    async (args) => {
      const clientManager = getClientManager();
      const client = clientManager.getClient(args.chain as ChainName);

      try {
        // Get both legacy and EIP-1559 gas prices
        const [gasPrice, feeData] = await Promise.all([
          client.getGasPrice(),
          client.estimateFeesPerGas().catch(() => null), // Some chains don't support EIP-1559
        ]);

        const formatPrice = (wei: bigint): string => {
          if (args.formatted) {
            // Convert to Gwei (1 Gwei = 1e9 wei)
            const gwei = Number(wei) / 1e9;
            return `${gwei.toFixed(2)} Gwei`;
          }
          return wei.toString();
        };

        const response: any = {
          chain: args.chain,
          timestamp: new Date().toISOString(),
          legacy: {
            gasPrice: args.formatted ? formatPrice(gasPrice) : gasPrice.toString(),
            gasPriceWei: gasPrice.toString(),
          },
        };

        // Add EIP-1559 data if available
        if (feeData) {
          response.eip1559 = {
            maxFeePerGas: args.formatted
              ? formatPrice(feeData.maxFeePerGas)
              : feeData.maxFeePerGas.toString(),
            maxPriorityFeePerGas: args.formatted
              ? formatPrice(feeData.maxPriorityFeePerGas)
              : feeData.maxPriorityFeePerGas.toString(),
            maxFeePerGasWei: feeData.maxFeePerGas.toString(),
            maxPriorityFeePerGasWei: feeData.maxPriorityFeePerGas.toString(),
          };

          // Calculate estimated total cost for a standard 21000 gas transaction
          const standardGasLimit = 21000n;
          const estimatedCost = feeData.maxFeePerGas * standardGasLimit;
          response.eip1559.estimatedCostFor21kGas = args.formatted
            ? `${(Number(estimatedCost) / 1e18).toFixed(6)} ETH`
            : estimatedCost.toString();
        }

        return formatResponse(response);
      } catch (error) {
        throw new Error(`Failed to get gas price: ${error}`);
      }
    }
  ),
};
