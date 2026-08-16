#!/usr/bin/env node
/**
 * Bundle the Electron main and preload sources with esbuild.
 *
 * main  → out/main/index.js    (ESM; the package is "type": "module")
 * preload → out/preload/index.cjs (CJS; sandboxed preloads cannot be ESM)
 *
 * `electron` stays external for both. Usage: node apps/desktop/scripts/build-app.mjs
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: [resolve(desktopDir, 'src/main/index.ts')],
  outfile: resolve(desktopDir, 'out/main/index.js'),
  format: 'esm',
})
await build({
  ...common,
  entryPoints: [resolve(desktopDir, 'src/preload/index.ts')],
  outfile: resolve(desktopDir, 'out/preload/index.cjs'),
  format: 'cjs',
})
console.log('build-app: main and preload bundles written to out/')
