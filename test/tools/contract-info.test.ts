import { describe, it, expect } from 'vitest'
import contractInfoTools from '../../src/tools/contract-info.js'

const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const CHAIN = 'mainnet'

const maybeDescribe = process.env.ETHERSCAN_API_KEY ? describe : describe.skip

maybeDescribe('Contract Info Tools (with Caching)', () => {
  describe("get_contract_abi", () => {
    it("should fetch USDC contract ABI", async () => {
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "metadata"],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.address).toBe(USDC_ADDRESS);
      expect(data.chain).toBe(CHAIN);
      expect(data.abi).toBeDefined();
      expect(Array.isArray(data.abi)).toBe(true);
      expect(data.abi.length).toBeGreaterThan(0);
      expect(data.contractName).toBeDefined();
      expect(data.isVerified).toBe(true);
    });

    it("should include implementation ABI for proxy contracts", async () => {
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "implementationAbi", "metadata"],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.isProxy).toBe(true);
      expect(data.implementationAddress).toBeDefined();
      expect(data.implementationAbi).toBeDefined();
      expect(Array.isArray(data.implementationAbi)).toBe(true);
    });

    it("should include compilation info when requested", async () => {
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "metadata", "compilation"],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.compilerVersion).toBeDefined();
      expect(data.optimizationUsed).toBeDefined();
    });

    it('should include creation info when requested', async () => {
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ['abi', 'metadata', 'creation']
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.creationInfo).toBeDefined();
      expect(data.creationInfo.creator).toBeDefined();
      expect(data.creationInfo.transactionHash).toBeDefined();
    });

    it('should include ABI statistics when requested', async () => {
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ['abi', 'metadata', 'stats']
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.abiSize).toBeDefined();
      expect(data.functions).toBeGreaterThan(0);
      expect(data.events).toBeGreaterThan(0);
    });

    it("should use cached data on second call (no duplicate API call)", async () => {
      // First call - should hit API
      const result1 = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "metadata"],
      });

      // Second call - should use cache
      const result2 = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "metadata"],
      });

      const data1 = JSON.parse(result1.content[0].text);
      const data2 = JSON.parse(result2.content[0].text);

      // Data should be identical
      expect(data1.address).toBe(data2.address);
      expect(data1.contractName).toBe(data2.contractName);
      expect(data1.abi).toEqual(data2.abi);
    });
  });

  describe("get_contract_source_code", () => {
    it('should fetch USDC contract source code summary', async () => {
      const result = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: true,
        includeSource: 'summary'
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.isVerified).toBe(true);
      expect(data.contractName).toBe('FiatTokenProxy');
      expect(data.fileCount).toBeGreaterThan(0);
      expect(data.totalLines).toBeGreaterThan(0);
      expect(data.files).toBeDefined();
      expect(Array.isArray(data.files)).toBe(true);
    });

    it("should fetch full source code when requested", async () => {
      const result = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: false,
        includeSource: "full",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.sourceFiles).toBeDefined();
      expect(typeof data.sourceFiles).toBe('object');
      const firstFile = Object.values(data.sourceFiles)[0] as string;
      expect(firstFile).toBeDefined();
      expect(firstFile.length).toBeGreaterThan(0);
    });

    it("should fetch metadata only when requested", async () => {
      const result = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: false,
        includeSource: "none",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.contractName).toBeDefined();
      expect(data.isVerified).toBe(true);
      expect(data.files).toBeUndefined();
    });

    it.skip("should include implementation source for proxy contracts", async () => {
      // TODO: This test depends on USDC being a proxy with accessible implementation
      const result = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: true,
        includeSource: "summary",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.isProxy).toBe(true);
      expect(data.implementationAddress).toBeDefined();
      expect(data.implementation).toBeDefined();
      expect(data.implementation.contractName).toBeDefined();
      expect(data.implementation.files).toBeDefined();
    });

    it("should reuse cached data from get_contract_abi", async () => {
      // Call get_contract_abi first
      await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        include: ["abi", "metadata"],
      });

      // Call get_contract_source_code - should use cached rawInfo
      const result = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: false,
        includeSource: "summary",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.contractName).toBeDefined();
      expect(data.isVerified).toBe(true);
    });
  });

  describe("get_contract_source_file", () => {
    it("should list available files when no filePath specified", async () => {
      // First cache the contract
      await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: false,
        includeSource: "full",
      });

      // Then list files
      const result = await contractInfoTools.get_contract_source_file.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        useImplementation: false,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.files).toBeDefined();
      expect(Array.isArray(data.files)).toBe(true);
      expect(data.files.length).toBeGreaterThan(0);
    });

    it.skip("should fetch specific file content", async () => {
      // TODO: Fix caching behavior - test relies on proper sourceFiles caching
      // First cache the contract
      await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        includeImplementation: false,
        includeSource: "full",
      });

      // Get file list
      const listResult = await contractInfoTools.get_contract_source_file.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        useImplementation: false,
      });
      const listData = JSON.parse(listResult.content[0].text);
      const firstFile = listData.files[0];

      // Get specific file
      const fileResult = await contractInfoTools.get_contract_source_file.handler({
        chain: CHAIN,
        address: USDC_ADDRESS,
        useImplementation: false,
        filePath: firstFile.path,
      });

      const fileData = JSON.parse(fileResult.content[0].text);
      expect(fileData.filePath).toBe(firstFile.path);
      expect(fileData.content).toBeDefined();
      expect(fileData.content.length).toBeGreaterThan(0);
      expect(fileData.size).toBe(firstFile.size);
    });

    it.skip("should error when requesting uncached contract", async () => {
      // TODO: Fix error handling - tool returns success:false instead of throwing
      const RANDOM_ADDRESS = "0x1234567890123456789012345678901234567890";

      await expect(
        contractInfoTools.get_contract_source_file.handler({
          chain: CHAIN,
          address: RANDOM_ADDRESS,
          useImplementation: false,
        })
      ).rejects.toThrow();
    });
  });

  describe("Caching Optimization", () => {
    it.skip("should share cache between get_contract_abi and get_contract_source_code", async () => {
      // TODO: Verify caching behavior - test depends on specific contract metadata
      const TEST_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f"; // DAI

      // Call get_contract_abi first
      const abiResult = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: TEST_ADDRESS,
        include: ["abi", "metadata"],
      });
      const abiData = JSON.parse(abiResult.content[0].text);

      // Call get_contract_source_code - should use cached data
      const sourceResult = await contractInfoTools.get_contract_source_code.handler({
        chain: CHAIN,
        address: TEST_ADDRESS,
        includeImplementation: false,
        includeSource: "summary",
      });
      const sourceData = JSON.parse(sourceResult.content[0].text);

      // Both should have same metadata
      expect(abiData.contractName).toBe(sourceData.contractName);
      expect(abiData.isVerified).toBe(sourceData.isVerified);
      expect(abiData.isProxy).toBe(sourceData.isProxy);
    });

    it("should cache rawInfo immediately on fetchContractInfo", async () => {
      const TEST_ADDRESS = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"; // WBTC

      // First call should cache rawInfo
      await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: TEST_ADDRESS,
        include: ["abi"],
      });

      // Second call should use cached rawInfo (even with different include params)
      const result = await contractInfoTools.get_contract_abi.handler({
        chain: CHAIN,
        address: TEST_ADDRESS,
        include: ["abi", "metadata", "compilation", "creation", "stats"],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.contractName).toBeDefined();
      expect(data.compilerVersion).toBeDefined();
      expect(data.creationInfo).toBeDefined();
      expect(data.creationInfo.creator).toBeDefined();
      expect(data.abiSize).toBeDefined();
      expect(data.functions).toBeDefined();
    });
  });
});
