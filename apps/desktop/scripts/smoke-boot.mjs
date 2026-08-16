#!/usr/bin/env node
/**
 * Phase-0 proof: boot the staged harness server and verify it serves the
 * assembled web app, then shut it down cleanly.
 *
 * Spawns the deployed `dsh web --port 0`, waits for the stdout readiness line
 * (`dsh web: http://127.0.0.1:<port>`), fetches the index, and asserts the
 * injected `window.__DSH_BOOT__` boot manifest is present.
 *
 * Usage:
 *   node apps/desktop/scripts/smoke-boot.mjs                        # system node
 *   SMOKE_RUNTIME="/Applications/.../Electron" node apps/desktop/scripts/smoke-boot.mjs
 *
 * When SMOKE_RUNTIME names an Electron binary, the child runs it with
 * ELECTRON_RUN_AS_NODE=1 — the exact mode the packaged desktop app uses, so
 * this also proves Electron-embedded-Node execution of the closure.
 */
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const serverEntry = join(desktopDir, 'build/server/node_modules/@deepseek-ai/dsh/lib/bin.js')
const smokeHome = join(desktopDir, 'build/smoke-home')
const runtime = process.env.SMOKE_RUNTIME ?? process.execPath
const READINESS_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/
const BOOT_DEADLINE_MS = 60_000
const EXIT_DEADLINE_MS = 10_000

await rm(smokeHome, { recursive: true, force: true })

const child = spawn(runtime, ['--expose-internals', serverEntry, 'web', '--port', '0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: smokeHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
})

let stderr = ''
let url = undefined
child.stderr.on('data', chunk => { stderr += String(chunk) })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  for (const line of String(chunk).split('\n')) {
    const match = READINESS_RE.exec(line)
    if (match !== null && url === undefined) url = match[1]
  }
})

const urlPromise = new Promise((resolveUrl, reject) => {
  const deadline = setTimeout(() => {
    reject(new Error(`smoke-boot: no readiness URL within ${BOOT_DEADLINE_MS}ms.\n--- stderr ---\n${stderr}`))
  }, BOOT_DEADLINE_MS)
  const poll = () => {
    if (url !== undefined) {
      clearTimeout(deadline)
      resolveUrl(url)
    } else if (child.exitCode !== null) {
      clearTimeout(deadline)
      reject(new Error(`smoke-boot: server exited with code ${child.exitCode} before readiness.\n--- stderr ---\n${stderr}`))
    } else {
      setTimeout(poll, 100)
    }
  }
  poll()
})

let primaryError = undefined
try {
  url = await urlPromise
  const response = await fetch(`${url}/`)
  const html = await response.text()
  if (!response.ok) throw new Error(`smoke-boot: GET / returned ${response.status}`)
  if (!html.includes('__DSH_BOOT__')) throw new Error('smoke-boot: index lacks the injected __DSH_BOOT__ boot manifest')
  if (!html.includes('id="root"')) throw new Error('smoke-boot: index lacks the app root element')
  console.log(`smoke-boot: PASS — ${url} served the assembled web app (runtime: ${runtime})`)
} catch (error) {
  primaryError = error
} finally {
  if (primaryError !== undefined) {
    console.error(`smoke-boot: primary failure: ${primaryError.message}`)
    console.error(`--- server stderr ---\n${stderr}`)
  }
  child.kill('SIGTERM')
  const exited = await new Promise(resolveExit => {
    const deadline = setTimeout(() => resolveExit(false), EXIT_DEADLINE_MS)
    child.once('exit', () => { clearTimeout(deadline); resolveExit(true) })
  })
  if (!exited) {
    child.kill('SIGKILL')
    console.error('smoke-boot: WARNING — server did not exit on SIGTERM within the shutdown window; killed')
  } else {
    console.log(`smoke-boot: server exited cleanly with code ${child.exitCode}`)
  }
}
if (primaryError !== undefined) process.exit(1)
