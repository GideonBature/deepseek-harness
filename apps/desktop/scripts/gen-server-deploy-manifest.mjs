#!/usr/bin/env node
/**
 * Regenerate apps/desktop/server-deploy/package.json dependencies from the
 * dsh CLI's workspace closure.
 *
 * `pnpm deploy` stages the server with auto peer installation disabled, so
 * every required workspace peer must be a direct dependency of the deploy
 * root. This script walks the CLI manifest through workspace dependencies,
 * optional dependencies, and required peers (vendor/* included, so the
 * rescoped cosmokit/schemastery enter the manifest), and rewrites the sorted
 * dependency map. scripts/verify-runtime-closure.ts is the gate that proves
 * the result is closed; the staging script runs it.
 *
 * Re-run this after an upstream sync that adds or renames workspace packages,
 * then stage and smoke-boot again.
 *
 * Usage: node apps/desktop/scripts/gen-server-deploy-manifest.mjs
 */
import { globSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '../..')
const manifestPath = join(desktopDir, 'server-deploy', 'package.json')

const cliManifest = JSON.parse(await readFile(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'))

/** name -> manifest for every workspace package the verifier also knows. */
const workspace = new Map()
for (const rel of [
  ...globSync('packages/*/*/package.json', { cwd: repoRoot }),
  ...globSync('vendor/*/package.json', { cwd: repoRoot }),
]) {
  const manifest = JSON.parse(await readFile(join(repoRoot, rel), 'utf8'))
  if (typeof manifest.name === 'string') workspace.set(manifest.name, manifest)
}

/** name -> spec for the deploy-root dependencies being written. */
const output = new Map()

for (const [name, spec] of Object.entries(cliManifest.dependencies ?? {})) {
  output.set(name, workspace.has(name) ? 'workspace:^' : spec)
}
// The staged server entry itself.
output.set('@deepseek-ai/dsh', 'workspace:^')

const queue = [...output.keys()].filter(name => workspace.has(name))
const seen = new Set(queue)
while (queue.length > 0) {
  const name = queue.shift()
  const manifest = workspace.get(name)
  if (manifest === undefined) continue
  const declared = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  for (const dependency of Object.keys(declared)) {
    if (!workspace.has(dependency)) continue
    if (manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
    if (!output.has(dependency)) output.set(dependency, 'workspace:^')
    if (!seen.has(dependency)) {
      seen.add(dependency)
      queue.push(dependency)
    }
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.dependencies = Object.fromEntries([...output.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`gen-server-deploy-manifest: wrote ${output.size} dependencies to ${manifestPath}`)
