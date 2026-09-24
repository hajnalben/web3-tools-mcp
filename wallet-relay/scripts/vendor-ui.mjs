import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copy preact and htm into public/vendor, where the signing page loads them from.
 *
 * The page is served as the files it is written as, with no bundler in between, so these
 * have to sit next to it rather than in node_modules. Their versions are pinned by the
 * devDependencies this resolves them through.
 */

const require = createRequire(import.meta.url)
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor')
mkdirSync(out, { recursive: true })

for (const [pkg, file] of [
  ['preact', 'dist/preact.module.js'],
  ['htm', 'dist/htm.module.js']
]) {
  // From the resolved entry point rather than a subpath: preact's `exports` hides its dist
  // files, htm's hides its package.json, and this needs neither.
  const entry = require.resolve(pkg)
  const marker = `node_modules/${pkg}/`
  const root = entry.slice(0, entry.lastIndexOf(marker) + marker.length)
  const name = file.split('/').pop()
  // The maps are not published alongside, so the comment would only produce a 404.
  const source = readFileSync(join(root, file), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '')
  writeFileSync(join(out, name), source)
  console.log(`vendored ${name} from ${pkg}@${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`)
}
