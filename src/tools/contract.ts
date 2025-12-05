import { type AbiFunction, type Address, isAddress, parseAbiItem } from "viem";
import { z } from "zod";
import type { ChainName } from "../types.js";
import { getClientManager, SUPPORTED_CHAINS } from "../client.js";
import { convertArgumentsToTypes, createTool, formatResponse } from "../utils.js";

const ContractCallSchema = z.object({
  chain: z
    .enum(SUPPORTED_CHAINS)
    .describe("Blockchain network (mainnet, base, arbitrum, polygon, optimism, celo, localhost)"),
  contractAddress: z
    .string()
    .describe("Contract address to call (must be valid checksummed address)"),
  functionAbi: z
    .string()
    .describe(
      'Function ABI signature string (e.g., "function balanceOf(address owner) view returns (uint256)"). Only view/pure functions allowed.'
    ),
  args: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe(
      "Function arguments in order matching the ABI signature. Automatically type-converted."
    ),
  blockNumber: z
    .string()
    .optional()
    .describe("Block number for historical queries (defaults to latest)"),
  label: z.string().optional().describe("Optional label to identify this call in batch results"),
});

export default {
  call_contract_function: createTool(
    "Call Contract Functions",
    "Execute multiple view/pure contract functions efficiently. BATCH OPTIMIZED - use for reading contract state, token metadata.",
    z.object({
      calls: z
        .array(ContractCallSchema)
        .describe(
          "Array of contract function calls. Automatically batched by chain/block for optimal performance."
        ),
    }),
    async (args) => {
      // Group by chain and blockNumber for efficient multicall
      const groupedCalls = new Map<string, typeof args.calls>();
      for (const item of args.calls) {
        const key = `${item.chain}:${item.blockNumber || "latest"}`;
        if (!groupedCalls.has(key)) {
          groupedCalls.set(key, []);
        }
        groupedCalls.get(key)!.push(item);
      }

      const allResults: Array<{
        index: number;
        label?: string;
        contractAddress: string;
        functionName: string;
        success: boolean;
        result?: unknown;
        error?: string;
        chain: string;
        blockNumber: string;
      }> = [];

      try {
        // Process each group
        for (const [key, calls] of groupedCalls) {
          const [chain, blockNum] = key.split(":");
          const clientManager = getClientManager();
          const client = clientManager.getClient(chain as ChainName);
          const blockTag = blockNum === "latest" ? "latest" : BigInt(blockNum);

          // Prepare multicall contracts
          const multicallContracts = calls.map((call) => {
            if (!isAddress(call.contractAddress)) {
              throw new Error(`Invalid contract address: ${call.contractAddress}`);
            }

            const abiItem = parseAbiItem(call.functionAbi) as AbiFunction;

            if (abiItem.stateMutability !== "view" && abiItem.stateMutability !== "pure") {
              throw new Error(`Only view and pure functions can be called: ${call.functionAbi}`);
            }

            const convertedArgs = convertArgumentsToTypes(call.args || [], abiItem.inputs);

            return {
              address: call.contractAddress as Address,
              abi: [abiItem],
              functionName: abiItem.name,
              args: convertedArgs,
            };
          });

          // Execute multicall
          // Use deployless mode for localhost/anvil since Multicall3 may not be deployed
          const useDeployless = chain === "localhost";
          const multicallResults = await client.multicall({
            contracts: multicallContracts,
            blockNumber: blockTag === "latest" ? undefined : blockTag,
            ...(useDeployless && { deployless: true }),
          });

          // Process results
          multicallResults.forEach((result, idx) => {
            const call = calls[idx]!;
            const abiItem = parseAbiItem(call.functionAbi) as AbiFunction;
            const originalIndex = args.calls.indexOf(call);

            if (result.status === "success") {
              allResults[originalIndex] = {
                index: originalIndex,
                label: call.label,
                contractAddress: call.contractAddress,
                functionName: abiItem.name,
                success: true,
                result: result.result,
                chain: call.chain,
                blockNumber: call.blockNumber || "latest",
              };
            } else {
              allResults[originalIndex] = {
                index: originalIndex,
                label: call.label,
                contractAddress: call.contractAddress,
                functionName: abiItem.name,
                success: false,
                error: result.error instanceof Error ? result.error.message : String(result.error),
                chain: call.chain,
                blockNumber: call.blockNumber || "latest",
              };
            }
          });
        }

        return formatResponse({
          success: true,
          totalCalls: args.calls.length,
          successfulCalls: allResults.filter((r) => r.success).length,
          failedCalls: allResults.filter((r) => !r.success).length,
          results: allResults,
        });
      } catch (error) {
        throw new Error(`Contract call failed: ${error}`);
      }
    }
  ),

  is_contract: createTool(
    "Check Address Type",
    "Determine if address is smart contract or EOA. Returns contract status and bytecode length.",
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe("Blockchain network to query"),
      address: z
        .string()
        .describe("Address to check (returns true if contract, false if EOA/wallet)"),
    }),
    async (args) => {
      if (!isAddress(args.address)) {
        throw new Error("Invalid address format");
      }

      const clientManager = getClientManager();
      const client = clientManager.getClient(args.chain as ChainName);

      try {
        const bytecode = await client.getBytecode({ address: args.address as Address });
        const isContractFlag = bytecode !== undefined && bytecode !== "0x";

        return formatResponse({
          address: args.address,
          isContract: isContractFlag,
          type: isContractFlag ? "contract" : "EOA",
          chain: args.chain,
          bytecodeLength: bytecode ? bytecode.length - 2 : 0, // -2 for '0x' prefix
        });
      } catch (error) {
        throw new Error(`Failed to check address type: ${error}`);
      }
    }
  ),
};
