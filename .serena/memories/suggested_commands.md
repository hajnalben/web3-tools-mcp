# Development Commands

## Build & Watch
```bash
npm run build      # Clean and compile TypeScript
npm run watch      # Watch mode compilation
npm run clean      # Remove dist folder
```

## Testing
```bash
npm test           # Run all tests (vitest)
npm run test:watch # Watch mode
npm run test:ui    # Vitest UI
```

## Running
```bash
# Development (after build)
node dist/index.js

# With npx
npx web3-tools-mcp

# With API keys
npx web3-tools-mcp --etherscan-api-key KEY --hypersync-api-key KEY
```
