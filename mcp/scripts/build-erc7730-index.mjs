#!/usr/bin/env node
/**
 * Build a compact ERC-7730 clear signing index from the Ledger registry.
 *
 * Usage: node build-erc7730-index.mjs <registry-dir> <output-file>
 *
 * The registry keys `display.formats` by full function signature; we derive the
 * 4-byte selector from it and KEEP the signature so the runtime can ABI-decode
 * calldata and resolve each field's value (see packages/engine/src/clear-signing.ts).
 *
 * Output format:
 * {
 *   "0xaddress": {
 *     "protocol": "uniswap",
 *     "chainIds": [1, 8453],
 *     "selectors": {
 *       "0x04e45aaf": {
 *         "name": "exactInputSingle",
 *         "intent": "Swap",
 *         "signature": "exactInputSingle((address,address,...))",
 *         "fields": [
 *           { "label": "Send", "path": "params.amountIn", "format": "tokenAmount",
 *             "params": { "tokenPath": "params.tokenIn" } }
 *         ]
 *       }
 *     }
 *   }
 * }
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { toFunctionSelector } from 'viem'

const [registryDir, outputFile] = process.argv.slice(2)
if (!registryDir || !outputFile) {
  console.error('Usage: node build-erc7730-index.mjs <registry-dir> <output-file>')
  process.exit(1)
}

const index = {}

/** Resolve a "$.a.b.c" reference against the descriptor; pass other values through. */
function deref(value, descriptor) {
  if (typeof value === 'string' && value.startsWith('$.')) {
    return value
      .slice(2)
      .split('.')
      .reduce((o, k) => (o == null ? undefined : o[k]), descriptor)
  }
  if (Array.isArray(value)) return value.map((v) => deref(v, descriptor))
  return value
}

/** Inline a field's $ref (shared definition) and resolve any "$." references in params. */
function resolveField(field, descriptor) {
  let merged = field
  if (field.$ref) {
    const ref = deref(field.$ref, descriptor)
    if (ref) merged = { ...ref, ...field }
  }
  const { $ref, $id, visible, ...rest } = merged
  const out = { label: rest.label, path: rest.path, format: rest.format }
  if (rest.params) {
    const params = {}
    for (const [k, v] of Object.entries(rest.params)) params[k] = deref(v, descriptor)
    out.params = params
  }
  return out
}

// Walk registry directories
for (const dir of readdirSync(registryDir)) {
  const dirPath = join(registryDir, dir)
  if (!statSync(dirPath).isDirectory()) continue

  for (const file of readdirSync(dirPath)) {
    if (!file.startsWith('calldata-') || !file.endsWith('.json')) continue

    try {
      const descriptor = JSON.parse(readFileSync(join(dirPath, file), 'utf-8'))
      const deployments = descriptor.context?.contract?.deployments || []
      const formats = descriptor.display?.formats || {}
      const protocol = dir

      for (const deployment of deployments) {
        const address = deployment.address.toLowerCase()

        if (!index[address]) {
          index[address] = { protocol, chainIds: [], selectors: {} }
        }
        if (!index[address].chainIds.includes(deployment.chainId)) {
          index[address].chainIds.push(deployment.chainId)
        }

        for (const [key, format] of Object.entries(formats)) {
          // Registry keys formats by signature ("fn(uint256,...)"); older ones used
          // a raw 4-byte selector. Derive the selector and keep the signature when present.
          let selector
          let signature
          if (/^0x[0-9a-f]{8}$/i.test(key)) {
            selector = key.toLowerCase()
          } else {
            try {
              selector = toFunctionSelector(`function ${key}`)
            } catch {
              console.warn(`Skipping unparseable signature in ${dir}/${file}: ${key}`)
              continue
            }
            signature = key
          }

          if (index[address].selectors[selector]) continue // don't overwrite

          const fields = (format.fields || []).filter((f) => f.visible !== 'never').map((f) => resolveField(f, descriptor))

          index[address].selectors[selector] = {
            name: format.$id || selector,
            intent: format.intent || format.$id || 'Unknown',
            ...(signature && { signature }),
            fields
          }
        }
      }
    } catch (err) {
      console.warn(`Skipping ${dir}/${file}: ${err.message}`)
    }
  }
}

const contracts = Object.keys(index).length
const selectors = Object.values(index).reduce((sum, e) => sum + Object.keys(e.selectors).length, 0)

// Gzipped: 1.5MB of JSON becomes ~60KB in the package, and gunzip costs ~15ms once.
const json = JSON.stringify(index)
writeFileSync(outputFile, outputFile.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json)
console.log(
  `Built ERC-7730 index: ${contracts} contracts, ${selectors} selectors → ${outputFile} ` +
    `(${(statSync(outputFile).size / 1024).toFixed(0)}KB)`
)
