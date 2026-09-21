# Code Style & Conventions

## TypeScript
- Strict mode enabled
- ES2022 target with NodeNext modules
- Use `.js` extensions in imports (NodeNext requirement)
- Explicit types preferred, especially for function signatures

## Tool Pattern
Tools are created using the `createTool` helper from `utils.ts`:
```typescript
createTool(
  server,
  "tool_name",
  "Tool description",
  z.object({ /* zod schema */ }),
  async (args) => { /* implementation */ }
)
```

## Naming
- camelCase for functions and variables
- PascalCase for types and interfaces
- SCREAMING_SNAKE_CASE for constants
- Chain names are lowercase strings: "mainnet", "base", etc.

## Error Handling
- Return structured ToolResult objects
- Use try/catch in tool implementations
- Log errors to stderr (console.error)
