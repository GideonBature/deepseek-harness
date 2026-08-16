#!/usr/bin/env node
/**
 * Stage the embedded harness server closure for the desktop app.
 *
 * Materializes a flat, symlink-free production node_modules under
 * apps/desktop/build/server from apps/desktop/server-deploy, using the same
 * pnpm deploy pipeline that scripts/build-exe-for-python-sdk.ts proves:
 * legacy hoisted deploy, then restore of legacy-hoist omissions, then
 * materialization of any remaining package links.
 *
 * The desktop package consumes only build/server/node_modules at packaging
 * time (electron-builder extraResources); nothing here runs at app runtime.
 *
 * Usage: node apps/desktop/scripts/stage-server.mjs
 */
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRoot = resolve(desktopDir, '../..')
const deployRoot = join(desktopDir, 'server-deploy')
const staging = join(desktopDir, 'build', 'server')
const pnpmStore = join(desktopDir, 'build', 'pnpm-store')

/** Files the deploy target never needs. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/** Entry files whose presence proves the closure is complete and built. */
const REQUIRED_ENTRIES = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
]

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/** Run a repo script through tsx's ESM hook (avoids the pnpm exec fetch). */
function runTs(scriptRel, args) {
  run(process.execPath, ['--import', 'tsx/esm', scriptRel, ...args])
}

/** Clear and deploy the runtime closure into the staging directory. */
async function deploy() {
  if (staging === repoRoot || repoRoot.startsWith(staging + sep)) {
    throw new Error(`stage-server: refusing to clear staging dir ${staging}: it contains the repo root.`)
  }
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  run(pnpmBin(), [
    '--filter', 'dsh-desktop-server-deploy',
    'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    '--config.store-dir=' + pnpmStore,
    staging,
  ])
  await restoreLegacyHoists()
  await materializeStagedLinks()
  await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(staging, name), { force: true })))
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target.
 */
async function restoreLegacyHoists() {
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort()
  const sourceNodeModules = join(deployRoot, 'node_modules')
  const restored = []
  for (const dependency of dependencies) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `stage-server: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  const stillMissing = dependencies.filter(dependency => !existsSync(join(staging, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`stage-server: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  if (restored.length > 0) {
    console.log(`stage-server: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
}

/** Replace deploy-time package links with files and reject any remaining link. */
async function materializeStagedLinks() {
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Verify the staged closure holds every entry the server boot needs. */
async function verifyEntries() {
  for (const rel of REQUIRED_ENTRIES) {
    const path = join(staging, rel)
    if (!existsSync(path)) {
      throw new Error(`stage-server: ${path} missing — run pnpm run build at the repository root first.`)
    }
  }
  console.log(`stage-server: staged server closure verified at ${staging}`)
}

/**
 * Gate the deploy manifest against workspace-peer drift: with peer
 * auto-install disabled, a manifest missing a required workspace peer fails
 * here before any boot attempt.
 */
function verifyManifestClosure() {
  const relManifest = join('apps', 'desktop', 'server-deploy', 'package.json')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/verify-runtime-closure.ts', '--manifest', relManifest], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('stage-server: run `node apps/desktop/scripts/gen-server-deploy-manifest.mjs` to regenerate the deploy manifest, then stage again.')
    process.exit(result.status ?? 1)
  }
}

await deploy()
await verifyEntries()
verifyManifestClosure()
