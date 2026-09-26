import { isAddress } from 'viem'
import { z } from 'zod'
import { getClientManager, SUPPORTED_CHAINS } from '../../client.js'
import type { ChainName } from '../../types.js'
import { createTool, formatResponse, TtlCache } from '../../utils.js'

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

interface CachedContract {
  rawInfo: EtherscanContractInfo
  sourceFiles: Record<string, string>
  metadata: {
    contractName: string
    compilerVersion: string
    isProxy: boolean
    implementationAddress?: string
  }
}

// Source is immutable, but a proxy's implementation is not; an hour notices an upgrade.
const contractCache = new TtlCache<CachedContract>(100, 60 * 60 * 1000)

// Helper to generate cache key
function getCacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

/** Etherscan's `result` for a query, or why there is none: it answers status "0" with the reason there. */
export async function etherscan<T>(chainId: number, params: string, etherscanApiKey: string): Promise<T> {
  const response = await fetch(`https://api.etherscan.io/v2/api?chainid=${chainId}&${params}&apikey=${etherscanApiKey}`, {
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Etherscan API error: HTTP ${response.status}`)

  const data = (await response.json()) as { status: string; message?: string; result: unknown }
  if (data.status !== '1') {
    throw new Error(`Etherscan API error: ${typeof data.result === 'string' ? data.result : data.message || 'request failed'}`)
  }
  return data.result as T
}

/** Etherscan's SourceCode is one file, a `{{…}}`-wrapped standard JSON input, or a plain map of files. */
function parseSourceFiles(info: EtherscanContractInfo): Record<string, string> {
  const single = { [`${info.ContractName}.sol`]: info.SourceCode }
  if (!info.SourceCode.startsWith('{')) return single

  try {
    const parsed = JSON.parse(info.SourceCode.startsWith('{{') ? info.SourceCode.slice(1, -1) : info.SourceCode)
    const files = (parsed.sources ?? parsed) as Record<string, string | { content?: string }>
    return Object.fromEntries(
      Object.entries(files).map(([path, data]) => [path, typeof data === 'string' ? data : data.content || ''])
    )
  } catch {
    return single
  }
}

function fileStats(sourceFiles: Record<string, string>) {
  return Object.entries(sourceFiles).map(([path, content]) => ({ path, lines: content.split('\n').length, size: content.length }))
}

// Shared helper to fetch contract info from Etherscan (with caching)
async function fetchContractInfo(chainId: number, address: string, etherscanApiKey: string): Promise<EtherscanContractInfo> {
  const cacheKey = getCacheKey(chainId, address)
  const cached = contractCache.get(cacheKey)
  if (cached) return cached.rawInfo

  const result = await etherscan<EtherscanContractInfo[]>(
    chainId,
    `module=contract&action=getsourcecode&address=${address}`,
    etherscanApiKey
  )
  const contractInfo = result[0]
  if (!contractInfo) throw new Error('Etherscan API error: No contract source found')

  const isProxy = contractInfo.Proxy === '1'
  contractCache.set(cacheKey, {
    rawInfo: contractInfo,
    sourceFiles: contractInfo.SourceCode ? parseSourceFiles(contractInfo) : {},
    metadata: {
      contractName: contractInfo.ContractName,
      compilerVersion: contractInfo.CompilerVersion,
      isProxy,
      implementationAddress: isProxy ? contractInfo.Implementation : undefined
    }
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
        .array(z.enum(['abi', 'implementationAbi', 'metadata', 'compilation', 'creation', 'stats']))
        .optional()
        .describe(
          'Optional: specify which data to include. Options: "abi" (contract ABI), "implementationAbi" (proxy implementation ABI), "metadata" (name, verification), "compilation" (compiler, optimization), "creation" (creator, tx), "stats" (function/event counts). Defaults to ["abi", "metadata"] for minimal context usage.'
        )
    }),
    async (args) => {
      const clientManager = getClientManager()
      const config = clientManager.getConfig()

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

      const chainId = getClientManager().getChainId(args.chain as ChainName)

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
        etherscanUrl: clientManager.explorerUrl(args.chain as ChainName, `/address/${args.address}`)
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
          const [creation] = await etherscan<Array<{ contractCreator: string; txHash: string }>>(
            chainId,
            `module=contract&action=getcontractcreation&contractaddresses=${args.address}`,
            config.etherscanApiKey
          )
          if (creation) {
            abiResult.creationInfo = { creator: creation.contractCreator, transactionHash: creation.txHash }
          }
        } catch (error) {
          abiResult.creationError = (error as Error).message
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
      const config = clientManager.getConfig()

      if (!config.etherscanApiKey) {
        throw new Error('Etherscan API key is required. Use --etherscan-api-key or set ETHERSCAN_API_KEY environment variable.')
      }

      if (!isAddress(args.address)) {
        throw new Error('Invalid contract address')
      }

      const chainId = getClientManager().getChainId(args.chain as ChainName)

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
          etherscanUrl: clientManager.explorerUrl(args.chain as ChainName, `/address/${args.address}`)
        })
      }

      const sourceFiles = parseSourceFiles(contractInfo)
      const files = fileStats(sourceFiles)

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
        optimizationRuns: parseInt(contractInfo.Runs, 10) || 0,
        evmVersion: contractInfo.EVMVersion,
        licenseType: contractInfo.LicenseType,
        constructorArguments: contractInfo.ConstructorArguments,
        fileCount: Object.keys(sourceFiles).length,
        totalLines: files.reduce((sum, stat) => sum + stat.lines, 0),
        etherscanUrl: clientManager.explorerUrl(args.chain as ChainName, `/address/${args.address}#code`)
      }

      // Add source based on includeSource parameter
      if (args.includeSource === 'full') {
        result.sourceFiles = sourceFiles
      } else if (args.includeSource === 'summary') {
        result.files = files
      }
      // 'none' mode: no source files added

      // If proxy and implementation requested, fetch implementation source
      if (isProxy && args.includeImplementation && contractInfo.Implementation && isAddress(contractInfo.Implementation)) {
        try {
          const implInfo = await fetchContractInfo(chainId, contractInfo.Implementation, config.etherscanApiKey)

          if (implInfo && implInfo.SourceCode !== '') {
            const implSourceFiles = parseSourceFiles(implInfo)
            const implFileStats = fileStats(implSourceFiles)

            const implResult: Record<string, unknown> = {
              address: contractInfo.Implementation,
              contractName: implInfo.ContractName,
              compilerVersion: implInfo.CompilerVersion,
              optimizationUsed: implInfo.OptimizationUsed === '1',
              optimizationRuns: parseInt(implInfo.Runs, 10) || 0,
              evmVersion: implInfo.EVMVersion,
              licenseType: implInfo.LicenseType,
              fileCount: Object.keys(implSourceFiles).length,
              totalLines: implFileStats.reduce((sum, stat) => sum + stat.lines, 0),
              etherscanUrl: clientManager.explorerUrl(args.chain as ChainName, `/address/${contractInfo.Implementation}#code`)
            }

            // Add implementation source based on includeSource parameter
            if (args.includeSource === 'full') {
              implResult.sourceFiles = implSourceFiles
            } else if (args.includeSource === 'summary') {
              implResult.files = implFileStats
            }

            result.implementation = implResult
          }
        } catch (error) {
          // Implementation fetch failed, continue without it
          result.implementationError = error instanceof Error ? error.message : 'Failed to fetch implementation source'
        }
      } else if (isProxy && contractInfo.Implementation) {
        result.implementationAddress = contractInfo.Implementation
      }

      return formatResponse(result)
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
      const chainId = clientManager.getChainId(args.chain as ChainName)

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
          message: 'Contract not in cache. Use get_contract_source_code with includeSource="full" first to cache the contract.'
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
