import { type Address, isAddress, namehash } from "viem";
import { normalize } from "viem/ens";
import { z } from "zod";
import type { ChainName } from "../types.js";
import { getClientManager, SUPPORTED_CHAINS } from "../client.js";
import { createTool, formatResponse } from "../utils.js";

// Base ENS Contract Addresses
const BASE_ENS_CONTRACTS = {
  registry: "0xb94704422c2a1e396835a571837aa5ae53285a95" as Address,
  reverseRegistrar: "0x79ea96012eea67a83431f1701b3dff7e37f9e282" as Address,
  l2Resolver: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as Address,
};

// Helper function for Base ENS reverse resolution
async function reverseResolveBase(address: Address): Promise<string | null> {
  const clientManager = getClientManager();
  const client = clientManager.getClient("base");

  try {
    // Get the reverse node from ReverseRegistrar
    const reverseNode = await client.readContract({
      address: BASE_ENS_CONTRACTS.reverseRegistrar,
      abi: [
        {
          name: "node",
          type: "function",
          stateMutability: "pure",
          inputs: [{ name: "addr", type: "address" }],
          outputs: [{ name: "", type: "bytes32" }],
        },
      ],
      functionName: "node",
      args: [address],
    });

    // Query the L2Resolver for the name
    const name = await client.readContract({
      address: BASE_ENS_CONTRACTS.l2Resolver,
      abi: [
        {
          name: "name",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "node", type: "bytes32" }],
          outputs: [{ name: "", type: "string" }],
        },
      ],
      functionName: "name",
      args: [reverseNode as `0x${string}`],
    });

    return name || null;
  } catch (error) {
    return null;
  }
}

// Helper function for Base ENS forward resolution
async function resolveNameBase(name: string): Promise<Address | null> {
  const clientManager = getClientManager();
  const client = clientManager.getClient("base");

  try {
    const node = namehash(name);

    // Get resolver from registry
    const resolver = await client.readContract({
      address: BASE_ENS_CONTRACTS.registry,
      abi: [
        {
          name: "resolver",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "node", type: "bytes32" }],
          outputs: [{ name: "", type: "address" }],
        },
      ],
      functionName: "resolver",
      args: [node],
    });

    if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    // Get address from resolver
    const address = await client.readContract({
      address: resolver as Address,
      abi: [
        {
          name: "addr",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "node", type: "bytes32" }],
          outputs: [{ name: "", type: "address" }],
        },
      ],
      functionName: "addr",
      args: [node],
    });

    return address as Address | null;
  } catch (error) {
    return null;
  }
}

// Helper function for Base ENS text records
async function getTextRecordBase(name: string, key: string): Promise<string | null> {
  const clientManager = getClientManager();
  const client = clientManager.getClient("base");

  try {
    const node = namehash(name);

    // Get resolver from registry
    const resolver = await client.readContract({
      address: BASE_ENS_CONTRACTS.registry,
      abi: [
        {
          name: "resolver",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "node", type: "bytes32" }],
          outputs: [{ name: "", type: "address" }],
        },
      ],
      functionName: "resolver",
      args: [node],
    });

    if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    // Get text record from resolver
    const textRecord = await client.readContract({
      address: resolver as Address,
      abi: [
        {
          name: "text",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "node", type: "bytes32" },
            { name: "key", type: "string" },
          ],
          outputs: [{ name: "", type: "string" }],
        },
      ],
      functionName: "text",
      args: [node, key],
    });

    return textRecord || null;
  } catch (error) {
    return null;
  }
}

const EnsResolveSchema = z.object({
  chain: z
    .enum(SUPPORTED_CHAINS)
    .default("mainnet")
    .describe("Blockchain network (defaults to mainnet, as ENS is primarily on Ethereum)"),
  name: z
    .string()
    .describe("ENS name to resolve to an address (e.g., 'vitalik.eth', 'example.eth')"),
  universalResolver: z
    .boolean()
    .optional()
    .describe("Use universal resolver for cross-chain resolution (defaults to true)"),
});

const EnsReverseResolveSchema = z.object({
  chain: z
    .enum(SUPPORTED_CHAINS)
    .default("mainnet")
    .describe("Blockchain network (defaults to mainnet)"),
  address: z.string().describe("Ethereum address to resolve to an ENS name"),
  universalResolver: z
    .boolean()
    .optional()
    .describe("Use universal resolver for cross-chain resolution (defaults to true)"),
});

const EnsTextRecordSchema = z.object({
  chain: z
    .enum(SUPPORTED_CHAINS)
    .default("mainnet")
    .describe("Blockchain network (defaults to mainnet)"),
  name: z.string().describe("ENS name to query text records from"),
  key: z
    .string()
    .describe(
      "Text record key (e.g., 'avatar', 'description', 'email', 'url', 'com.twitter', 'com.github')"
    ),
  universalResolver: z
    .boolean()
    .optional()
    .describe("Use universal resolver for cross-chain resolution (defaults to true)"),
});

const EnsBatchResolveSchema = z.object({
  chain: z
    .enum(SUPPORTED_CHAINS)
    .default("mainnet")
    .describe("Blockchain network (defaults to mainnet)"),
  names: z
    .array(z.string())
    .describe("Array of ENS names to resolve to addresses in a single batch"),
  universalResolver: z
    .boolean()
    .optional()
    .describe("Use universal resolver for cross-chain resolution (defaults to true)"),
});

export default {
  resolve_ens_name: createTool(
    "Resolve ENS Name to Address",
    "Resolve an ENS name to its Ethereum address. ENS names are human-readable identifiers (like vitalik.eth) that resolve to Ethereum addresses.",
    EnsResolveSchema,
    async (args) => {
      try {
        // Normalize the ENS name
        const normalizedName = normalize(args.name);

        let address: Address | null = null;

        // Use Base-specific logic for Base chain
        if (args.chain === "base") {
          address = await resolveNameBase(normalizedName);
        } else {
          // Use viem's built-in ENS resolution for other chains
          const clientManager = getClientManager();
          const client = clientManager.getClient(args.chain as ChainName);

          address = await client.getEnsAddress({
            name: normalizedName,
            universalResolverAddress: args.universalResolver !== false ? undefined : undefined,
          });
        }

        if (!address) {
          return formatResponse({
            success: false,
            name: args.name,
            normalizedName,
            address: null,
            chain: args.chain,
            message: "ENS name does not resolve to an address",
          });
        }

        return formatResponse({
          success: true,
          name: args.name,
          normalizedName,
          address,
          chain: args.chain,
        });
      } catch (error) {
        throw new Error(`Failed to resolve ENS name: ${error}`);
      }
    }
  ),

  reverse_resolve_ens: createTool(
    "Reverse Resolve Address to ENS Name",
    "Reverse resolve an Ethereum address to its primary ENS name. Returns the ENS name if the address has set a reverse record.",
    EnsReverseResolveSchema,
    async (args) => {
      if (!isAddress(args.address)) {
        throw new Error(`Invalid Ethereum address: ${args.address}`);
      }

      try {
        let ensName: string | null = null;

        // Use Base-specific logic for Base chain
        if (args.chain === "base") {
          ensName = await reverseResolveBase(args.address as Address);
        } else {
          // Use viem's built-in ENS resolution for other chains
          const clientManager = getClientManager();
          const client = clientManager.getClient(args.chain as ChainName);

          ensName = await client.getEnsName({
            address: args.address as Address,
            universalResolverAddress: args.universalResolver !== false ? undefined : undefined,
          });
        }

        if (!ensName) {
          return formatResponse({
            success: false,
            address: args.address,
            name: null,
            chain: args.chain,
            message: "Address does not have a primary ENS name set",
          });
        }

        return formatResponse({
          success: true,
          address: args.address,
          name: ensName,
          chain: args.chain,
        });
      } catch (error) {
        throw new Error(`Failed to reverse resolve address: ${error}`);
      }
    }
  ),

  get_ens_text_record: createTool(
    "Get ENS Text Record",
    "Retrieve a text record from an ENS name. Common keys include 'avatar', 'description', 'email', 'url', 'com.twitter', 'com.github'.",
    EnsTextRecordSchema,
    async (args) => {
      try {
        // Normalize the ENS name
        const normalizedName = normalize(args.name);

        let textRecord: string | null = null;

        // Use Base-specific logic for Base chain
        if (args.chain === "base") {
          textRecord = await getTextRecordBase(normalizedName, args.key);
        } else {
          // Use viem's built-in ENS resolution for other chains
          const clientManager = getClientManager();
          const client = clientManager.getClient(args.chain as ChainName);

          textRecord = await client.getEnsText({
            name: normalizedName,
            key: args.key,
            universalResolverAddress: args.universalResolver !== false ? undefined : undefined,
          });
        }

        if (!textRecord) {
          return formatResponse({
            success: false,
            name: args.name,
            normalizedName,
            key: args.key,
            value: null,
            chain: args.chain,
            message: `Text record '${args.key}' not found for ${args.name}`,
          });
        }

        return formatResponse({
          success: true,
          name: args.name,
          normalizedName,
          key: args.key,
          value: textRecord,
          chain: args.chain,
        });
      } catch (error) {
        throw new Error(`Failed to get ENS text record: ${error}`);
      }
    }
  ),

  get_ens_avatar: createTool(
    "Get ENS Avatar",
    "Get the avatar URI for an ENS name. Returns the avatar URL if set.",
    z.object({
      chain: z
        .enum(SUPPORTED_CHAINS)
        .default("mainnet")
        .describe("Blockchain network (defaults to mainnet)"),
      name: z.string().describe("ENS name to get avatar from"),
      universalResolver: z
        .boolean()
        .optional()
        .describe("Use universal resolver for cross-chain resolution (defaults to true)"),
    }),
    async (args) => {
      try {
        // Normalize the ENS name
        const normalizedName = normalize(args.name);

        let avatar: string | null = null;

        // Use Base-specific logic for Base chain
        if (args.chain === "base") {
          avatar = await getTextRecordBase(normalizedName, "avatar");
        } else {
          // Use viem's built-in ENS resolution for other chains
          const clientManager = getClientManager();
          const client = clientManager.getClient(args.chain as ChainName);

          avatar = await client.getEnsAvatar({
            name: normalizedName,
            universalResolverAddress: args.universalResolver !== false ? undefined : undefined,
          });
        }

        if (!avatar) {
          return formatResponse({
            success: false,
            name: args.name,
            normalizedName,
            avatar: null,
            chain: args.chain,
            message: `No avatar set for ${args.name}`,
          });
        }

        return formatResponse({
          success: true,
          name: args.name,
          normalizedName,
          avatar,
          chain: args.chain,
        });
      } catch (error) {
        throw new Error(`Failed to get ENS avatar: ${error}`);
      }
    }
  ),

  batch_resolve_ens_names: createTool(
    "Batch Resolve ENS Names",
    "Resolve multiple ENS names to addresses in a single batch for efficiency.",
    EnsBatchResolveSchema,
    async (args) => {
      try {
        // Resolve all ENS names in parallel
        const results = await Promise.allSettled(
          args.names.map(async (name) => {
            const normalizedName = normalize(name);
            let address: Address | null = null;

            // Use Base-specific logic for Base chain
            if (args.chain === "base") {
              address = await resolveNameBase(normalizedName);
            } else {
              // Use viem's built-in ENS resolution for other chains
              const clientManager = getClientManager();
              const client = clientManager.getClient(args.chain as ChainName);

              address = await client.getEnsAddress({
                name: normalizedName,
                universalResolverAddress: args.universalResolver !== false ? undefined : undefined,
              });
            }

            return {
              name,
              normalizedName,
              address,
              success: !!address,
            };
          })
        );

        // Process results
        const resolved = results.map((result, index) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          return {
            name: args.names[index],
            normalizedName: args.names[index],
            address: null,
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        });

        const successCount = resolved.filter((r) => r.success).length;
        const failCount = resolved.filter((r) => !r.success).length;

        return formatResponse({
          success: true,
          chain: args.chain,
          totalNames: args.names.length,
          successfulResolves: successCount,
          failedResolves: failCount,
          results: resolved,
        });
      } catch (error) {
        throw new Error(`Failed to batch resolve ENS names: ${error}`);
      }
    }
  ),
};
