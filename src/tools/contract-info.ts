import { isAddress } from 'viem'
import { z } from 'zod'
import type { ChainName } from '../types.js'
import { CHAINS, getClientManager, SUPPORTED_CHAINS } from '../client.js'
import { createTool, formatResponse } from '../utils.js'

// Type for raw Etherscan contract info
interface EtherscanContractInfo {
  SourceCode: string
  ABI: string
  ContractName: string
  CompilerVersion: string
  OptimizationUsed: string
  Runs: string
  ConstructorArguments: string
  EVMVersion: string
  Library: string
  LicenseType: string
  Proxy: string
  Implementation: string
  SwarmSource: string
}

// Cache for contract source code and ABIs
interface CachedContract {
  rawInfo: EtherscanContractInfo // Cache the raw Etherscan response
  sourceFiles: Record<string, string>
  abi?: any[]
  metadata: {
    contractName: string
    compilerVersion: string
    isProxy: boolean
    implementationAddress?: string
  }
  timestamp: number
}

const contractCache = new Map<string, CachedContract>()
// No TTL - contracts are immutable, cache never expires

// Helper to generate cache key
function getCacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

// Shared helper to fetch contract info from Etherscan (with caching)
async function fetchContractInfo(
  chainId: number,
  address: string,
  etherscanApiKey: string
): Promise<EtherscanContractInfo> {
  // Check cache first
  const cacheKey = getCacheKey(chainId, address)
  const cached = contractCache.get(cacheKey)

  if (cached?.rawInfo) {
    return cached.rawInfo
  }

  // Fetch from Etherscan API
  const sourceUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${etherscanApiKey}`

  const sourceResponse = await fetch(sourceUrl)
  const sourceData = (await sourceResponse.json()) as {
    status: string
    message?: string
    result: Array<EtherscanContractInfo>
  }

  if (sourceData.status !== '1' || !sourceData.result || sourceData.result.length === 0) {
    throw new Error(`Etherscan API error: ${sourceData.message || 'No contract source found'}`)
  }

  const contractInfo = sourceData.result[0]

  // Cache the raw info immediately
  const isProxy = contractInfo.Proxy === '1'
  contractCache.set(cacheKey, {
    rawInfo: contractInfo,
    sourceFiles: {},
    metadata: {
      contractName: contractInfo.ContractName,
      compilerVersion: contractInfo.CompilerVersion,
      isProxy,
      implementationAddress: isProxy ? contractInfo.Implementation : undefined
    },
    timestamp: Date.now()
  })

  return contractInfo
}

export default {
  get_contract_abi: createTool(
    'Get Contract ABI',
    'Retrieve contract ABI, proxy info, and verification status from Etherscan. Use for contract analysis.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      address: z.string().describe('The contract address to get ABI for'),
      include: z
        .array(
          z.enum(['abi', 'implementationAbi', 'metadata', 'compilation', 'creation', 'stats'])
        )
        .optional()
        .describe(
          'Optional: specify which data to include. Options: "abi" (contract ABI), "implementationAbi" (proxy implementation ABI), "metadata" (name, verification), "compilation" (compiler, optimization), "creation" (creator, tx), "stats" (function/event counts). Defaults to ["abi", "metadata"] for minimal context usage.'
        )
    }),
    async (args) => {
      const clientManager = getClientManager()
      const config = (clientManager as any).config

      if (!config.etherscanApiKey) {
        throw new Error(
          'Etherscan API key is required for contract information retrieval. Use --etherscan-api-key or set ETHERSCAN_API_KEY environment variable.'
        )
      }

      if (!isAddress(args.address)) {
        throw new Error('Invalid contract address')
      }

      // Default to minimal data if not specified
      const include = args.include || ['abi', 'metadata']
      const includeSet = new Set(include)

      const chains = CHAINS(config)
      const chainId = chains[args.chain as ChainName].chain.id

      // Use shared helper to fetch contract info
      const contractInfo = await fetchContractInfo(chainId, args.address, config.etherscanApiKey)

      // Parse ABI if requested
      let abi: Array<{ type: string; [key: string]: unknown }> = []
      if (includeSet.has('abi') || includeSet.has('stats')) {
        if (contractInfo.ABI && contractInfo.ABI !== 'Contract source code not verified') {
          try {
            abi = JSON.parse(contractInfo.ABI)
          } catch {
            // ABI parsing failed, continue without it
          }
        }
      }

      // Parse the source information
      const isProxy = contractInfo.Proxy === '1'
      const hasSourceCode = contractInfo.SourceCode !== ''
      const isVerified = hasSourceCode

      // Build base result
      const abiResult: Record<string, unknown> = {
        success: true,
        chain: args.chain,
        chainId,
        address: args.address,
        etherscanUrl: `https://${clientManager.getEtherscanDomain(args.chain as ChainName)}/address/${args.address}`
      }

      // Add metadata if requested
      if (includeSet.has('metadata')) {
        abiResult.isVerified = isVerified
        abiResult.contractName = contractInfo.ContractName
        abiResult.hasSourceCode = hasSourceCode
        abiResult.licenseType = contractInfo.LicenseType
        if (isProxy) {
          abiResult.isProxy = isProxy
          if (contractInfo.Implementation) {
            abiResult.implementationAddress = contractInfo.Implementation
          }
        }
      }

      // Add compilation info if requested
      if (includeSet.has('compilation')) {
        abiResult.compilerVersion = contractInfo.CompilerVersion
        abiResult.optimizationUsed = contractInfo.OptimizationUsed === '1'
        abiResult.optimizationRuns = contractInfo.Runs
        abiResult.evmVersion = contractInfo.EVMVersion
        abiResult.constructorArguments = contractInfo.ConstructorArguments
      }

      // Add ABI if requested
      if (includeSet.has('abi')) {
        abiResult.abi = abi
      }

      // Add stats if requested
      if (includeSet.has('stats')) {
        abiResult.abiSize = abi.length
        abiResult.functions = abi.filter((item: { type: string }) => item.type === 'function').length
        abiResult.events = abi.filter((item: { type: string }) => item.type === 'event').length
        abiResult.errors = abi.filter((item: { type: string }) => item.type === 'error').length
        abiResult.constructors = abi.filter((item: { type: string }) => item.type === 'constructor').length
      }

      // Try to get creation info if requested
      if (includeSet.has('creation')) {
        try {
          const creationUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${args.address}&apikey=${config.etherscanApiKey}`
          const creationResponse = await fetch(creationUrl)
          const creationData = (await creationResponse.json()) as {
            status: string
            result?: Array<{ contractCreator: string; txHash: string }>
          }
          if (creationData.status === '1' && creationData.result && creationData.result.length > 0) {
            const result = creationData.result[0]
            if (result) {
              abiResult.creationInfo = {
                creator: result.contractCreator,
                transactionHash: result.txHash
              }
            }
          }
        } catch {
          // Creation info is optional
        }
      }

      // If it's a proxy and implementation ABI is requested, try to get it
      if (
        includeSet.has('implementationAbi') &&
        isProxy &&
        contractInfo.Implementation &&
        isAddress(contractInfo.Implementation)
      ) {
        try {
          const implContractInfo = await fetchContractInfo(chainId, contractInfo.Implementation, config.etherscanApiKey)

          if (implContractInfo?.ABI && implContractInfo.ABI !== 'Contract source code not verified') {
            try {
              const implementationAbi = JSON.parse(implContractInfo.ABI)
              abiResult.implementationAbi = implementationAbi

              // Add implementation stats if stats are requested
              if (includeSet.has('stats')) {
                abiResult.implementationAbiSize = implementationAbi.length
                abiResult.implementationFunctions = implementationAbi.filter(
                  (item: { type: string }) => item.type === 'function'
                ).length
                abiResult.implementationEvents = implementationAbi.filter(
                  (item: { type: string }) => item.type === 'event'
                ).length
                abiResult.implementationErrors = implementationAbi.filter(
                  (item: { type: string }) => item.type === 'error'
                ).length
                abiResult.implementationConstructors = implementationAbi.filter(
                  (item: { type: string }) => item.type === 'constructor'
                ).length
              }
            } catch {
              // Implementation ABI parsing failed, continue without it
            }
          }
        } catch {
          // Implementation ABI fetch failed, continue without it
        }
      }

      // Update cache with ABI (rawInfo already cached by fetchContractInfo)
      const cacheKey = getCacheKey(chainId, args.address)
      const existing = contractCache.get(cacheKey)!
      contractCache.set(cacheKey, {
        ...existing,
        abi
      })

      return formatResponse(abiResult)
    }
  ),

  get_contract_source_code: createTool(
    'Get Contract Source Code',
    'Retrieve verified contract source code from Etherscan. PROXY AWARE - automatically fetches implementation source for proxies.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      address: z.string().describe('The contract address to get source code for'),
      includeImplementation: z
        .boolean()
        .optional()
        .default(true)
        .describe('For proxy contracts, also fetch implementation source code (default: true)'),
      includeSource: z
        .enum(['full', 'summary', 'none'])
        .optional()
        .default('summary')
        .describe(
          'Source code inclusion level: "full" (complete source), "summary" (file list with stats only), "none" (metadata only). Default: summary'
        )
    }),
    async (args) => {
      const clientManager = getClientManager()
      const config = (clientManager as any).config

      if (!config.etherscanApiKey) {
        throw new Error(
          'Etherscan API key is required. Use --etherscan-api-key or set ETHERSCAN_API_KEY environment variable.'
        )
      }

      if (!isAddress(args.address)) {
        throw new Error('Invalid contract address')
      }

      const chains = CHAINS(config)
      const chainId = chains[args.chain as ChainName].chain.id

      try {
        // Fetch main contract source using shared helper
        const contractInfo = await fetchContractInfo(chainId, args.address, config.etherscanApiKey)

        if (!contractInfo) {
          throw new Error('No contract information found')
        }

        const isVerified = contractInfo.SourceCode !== ''
        const isProxy = contractInfo.Proxy === '1'

        if (!isVerified) {
          return formatResponse({
            success: false,
            chain: args.chain,
            chainId,
            address: args.address,
            isVerified: false,
            message: 'Contract source code is not verified on Etherscan',
            etherscanUrl: `https://${clientManager.getEtherscanDomain(args.chain as ChainName)}/address/${args.address}`
          })
        }

        // Parse source code
        let sourceFiles: Record<string, string> = {}
        let sourceCodeString = contractInfo.SourceCode

        // Handle multi-file sources (wrapped in {{ }} or [ ])
        if (sourceCodeString.startsWith('{{') || sourceCodeString.startsWith('[')) {
          try {
            // Remove outer braces/brackets if present
            if (sourceCodeString.startsWith('{{')) {
              sourceCodeString = sourceCodeString.slice(1, -1)
            }
            const parsed = JSON.parse(sourceCodeString)

            if (parsed.sources) {
              // Standard JSON format
              sourceFiles = Object.fromEntries(
                Object.entries(parsed.sources).map(([path, data]: [string, any]) => [path, data.content || ''])
              )
            } else if (typeof parsed === 'object') {
              // Simple object format
              sourceFiles = parsed
            }
          } catch {
            // If parsing fails, treat as single file
            sourceFiles = { [contractInfo.ContractName + '.sol']: sourceCodeString }
          }
        } else {
          // Single file source
          sourceFiles = { [contractInfo.ContractName + '.sol']: sourceCodeString }
        }

        // Calculate file stats for summary mode
        const fileStats = Object.entries(sourceFiles).map(([path, content]) => ({
          path,
          lines: (content as string).split('\n').length,
          size: (content as string).length
        }))

        const result: Record<string, unknown> = {
          success: true,
          chain: args.chain,
          chainId,
          address: args.address,
          isVerified: true,
          isProxy,
          contractName: contractInfo.ContractName,
          compilerVersion: contractInfo.CompilerVersion,
          optimizationUsed: contractInfo.OptimizationUsed === '1',
          optimizationRuns: parseInt(contractInfo.Runs) || 0,
          evmVersion: contractInfo.EVMVersion,
          licenseType: contractInfo.LicenseType,
          constructorArguments: contractInfo.ConstructorArguments,
          fileCount: Object.keys(sourceFiles).length,
          totalLines: fileStats.reduce((sum, stat) => sum + stat.lines, 0),
          etherscanUrl: `https://${clientManager.getEtherscanDomain(args.chain as ChainName)}/address/${args.address}#code`
        }

        // Add source based on includeSource parameter
        if (args.includeSource === 'full') {
          result.sourceFiles = sourceFiles
        } else if (args.includeSource === 'summary') {
          result.files = fileStats
        }
        // 'none' mode: no source files added

        // If proxy and implementation requested, fetch implementation source
        if (
          isProxy &&
          args.includeImplementation &&
          contractInfo.Implementation &&
          isAddress(contractInfo.Implementation)
        ) {
          try {
            const implInfo = await fetchContractInfo(chainId, contractInfo.Implementation, config.etherscanApiKey)

            if (implInfo && implInfo.SourceCode !== '') {
              // Parse implementation source code
              let implSourceFiles: Record<string, string> = {}
              let implSourceCodeString = implInfo.SourceCode

              if (implSourceCodeString.startsWith('{{') || implSourceCodeString.startsWith('[')) {
                try {
                  if (implSourceCodeString.startsWith('{{')) {
                    implSourceCodeString = implSourceCodeString.slice(1, -1)
                  }
                  const parsed = JSON.parse(implSourceCodeString)

                  if (parsed.sources) {
                    implSourceFiles = Object.fromEntries(
                      Object.entries(parsed.sources).map(([path, data]: [string, any]) => [path, data.content || ''])
                    )
                  } else if (typeof parsed === 'object') {
                    implSourceFiles = parsed
                  }
                } catch {
                  implSourceFiles = { [implInfo.ContractName + '.sol']: implSourceCodeString }
                }
              } else {
                implSourceFiles = { [implInfo.ContractName + '.sol']: implSourceCodeString }
              }

              // Calculate implementation file stats
              const implFileStats = Object.entries(implSourceFiles).map(([path, content]) => ({
                path,
                lines: (content as string).split('\n').length,
                size: (content as string).length
              }))

              const implResult: Record<string, unknown> = {
                address: contractInfo.Implementation,
                contractName: implInfo.ContractName,
                compilerVersion: implInfo.CompilerVersion,
                optimizationUsed: implInfo.OptimizationUsed === '1',
                optimizationRuns: parseInt(implInfo.Runs) || 0,
                evmVersion: implInfo.EVMVersion,
                licenseType: implInfo.LicenseType,
                fileCount: Object.keys(implSourceFiles).length,
                totalLines: implFileStats.reduce((sum, stat) => sum + stat.lines, 0),
                etherscanUrl: `https://${clientManager.getEtherscanDomain(args.chain as ChainName)}/address/${contractInfo.Implementation}#code`
              }

              // Add implementation source based on includeSource parameter
              if (args.includeSource === 'full') {
                implResult.sourceFiles = implSourceFiles
              } else if (args.includeSource === 'summary') {
                implResult.files = implFileStats
              }

              result.implementation = implResult

              // Update cache with implementation source (rawInfo already cached by fetchContractInfo)
              if (contractInfo.Implementation) {
                const implCacheKey = getCacheKey(chainId, contractInfo.Implementation)
                const existingImpl = contractCache.get(implCacheKey)!
                contractCache.set(implCacheKey, {
                  ...existingImpl,
                  sourceFiles: implSourceFiles
                })
              }
            }
          } catch (error) {
            // Implementation fetch failed, continue without it
            result.implementationError = error instanceof Error ? error.message : 'Failed to fetch implementation source'
          }
        } else if (isProxy && contractInfo.Implementation) {
          result.implementationAddress = contractInfo.Implementation
        }

        // Update cache with main contract source (rawInfo already cached by fetchContractInfo)
        const cacheKey = getCacheKey(chainId, args.address)
        const existing = contractCache.get(cacheKey)!
        contractCache.set(cacheKey, {
          ...existing,
          sourceFiles
        })

        return formatResponse(result)
      } catch (error) {
        throw new Error(`Failed to fetch source code: ${error}`)
      }
    }
  ),

  get_contract_source_file: createTool(
    'Get Specific Contract Source File',
    'Retrieve a specific source file from a cached contract. Use get_contract_source_code first to cache the contract.',
    z.object({
      chain: z.enum(SUPPORTED_CHAINS).describe('The blockchain network to use'),
      address: z.string().describe('The contract address'),
      filePath: z.string().optional().describe('Specific file path to retrieve. If omitted, returns list of available files.'),
      useImplementation: z
        .boolean()
        .optional()
        .default(false)
        .describe('For proxy contracts, get file from implementation instead (default: false)')
    }),
    async (args) => {
      const clientManager = getClientManager()
      const chains = CHAINS((clientManager as any).config)
      const chainId = chains[args.chain as ChainName].chain.id

      if (!isAddress(args.address)) {
        throw new Error('Invalid contract address')
      }

      // Check cache
      let cacheKey = getCacheKey(chainId, args.address)
      let cached = contractCache.get(cacheKey)

      // If useImplementation is true and we have implementation address, use that instead
      if (args.useImplementation && cached?.metadata.implementationAddress) {
        cacheKey = getCacheKey(chainId, cached.metadata.implementationAddress)
        cached = contractCache.get(cacheKey)
      }

      if (!cached) {
        return formatResponse({
          success: false,
          chain: args.chain,
          chainId,
          address: args.address,
          message:
            'Contract not in cache. Use get_contract_source_code with includeSource="full" first to cache the contract.'
        })
      }

      // If no filePath specified, return list of available files
      if (!args.filePath) {
        const fileList = Object.keys(cached.sourceFiles).map((path) => ({
          path,
          lines: cached.sourceFiles[path].split('\n').length,
          size: cached.sourceFiles[path].length
        }))

        return formatResponse({
          success: true,
          chain: args.chain,
          chainId,
          address: args.address,
          contractName: cached.metadata.contractName,
          fileCount: fileList.length,
          files: fileList
        })
      }

      // Return specific file
      const fileContent = cached.sourceFiles[args.filePath]
      if (!fileContent) {
        const availableFiles = Object.keys(cached.sourceFiles)
        return formatResponse({
          success: false,
          chain: args.chain,
          chainId,
          address: args.address,
          message: `File "${args.filePath}" not found in cached source`,
          availableFiles
        })
      }

      return formatResponse({
        success: true,
        chain: args.chain,
        chainId,
        address: args.address,
        contractName: cached.metadata.contractName,
        filePath: args.filePath,
        content: fileContent,
        lines: fileContent.split('\n').length,
        size: fileContent.length
      })
    }
  )
}
