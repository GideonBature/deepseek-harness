#!/usr/bin/env node
/**
 * Diagnostic: dump the composed `web` profile config under two runtimes and
 * diff the rows relevant to the electron-vs-node composition divergence.
 *
 * Usage: node apps/desktop/scripts/diagnose-composition.mjs <serverEntry> <runtime>
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const buildDir = join(desktopDir, 'build')
const serverEntry = process.argv[2]
const electron = process.argv[3]

mkdirSync(buildDir, { recursive: true })

function dump(executable, env) {
  return execFileSync(executable, [serverEntry, '--profile', 'web', '--dump-config'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const nodeText = dump('node', { DSH_HOME: join(buildDir, 'dump-home-node') })
const electronText = dump(electron, { DSH_HOME: join(buildDir, 'dump-home-electron'), ELECTRON_RUN_AS_NODE: '1' })

function hmrBlock(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.includes('- id: hmr'))
  if (start === -1) return '(no hmr row)'
  return lines.slice(start, start + 6).join('\n')
}
console.log('--- hmr block in node dump ---')
console.log(hmrBlock(nodeText))
console.log('--- hmr block in electron dump ---')
console.log(hmrBlock(electronText))
