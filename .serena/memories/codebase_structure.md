# Codebase Structure

## Source (src/)
- `index.ts` - Entry point, MCP server setup
- `client.ts` - Chain client manager (viem clients, RPC configuration)
- `types.ts` - TypeScript types (ChainName, Config, ToolResult)
- `utils.ts` - Utilities (createTool helper, argument conversion, CLI parsing)
- `wallet-server.ts` - Express server for browser wallet integration
- `anvil.ts` - Anvil/local network utilities

### Tools (src/tools/)
- `index.ts` - Tool registration
- `contract.ts` - Contract function calls (uses multicall)
- `contract-info.ts` - ABI retrieval, source code, is_contract check
- `balance.ts` - Native and ERC20 balance queries
- `ens.ts` - ENS resolution tools
- `logs.ts` - Event log queries (viem + Hypersync)
- `signatures.ts` - Function/event/error signature generation
- `advanced.ts` - Storage reads, block info, transaction tracing
- `gas.ts` - Gas estimation and price tools
- `transactions.ts` - Send tokens, sign messages

## Tests (test/)
- `setup.ts` - Test configuration
- `rpc-connectivity.test.ts` - RPC connection tests
- `wallet-server.test.ts` - Wallet server tests
- `tools/*.test.ts` - Tool-specific tests
