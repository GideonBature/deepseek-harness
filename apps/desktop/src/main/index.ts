/**
 * dsh-desktop main process.
 *
 * Spawns the embedded harness server (`dsh web`) as an ELECTRON_RUN_AS_NODE
 * child on an OS-assigned loopback port, waits for the stdout readiness line
 * (`dsh web: http://127.0.0.1:<port>`), then loads the assembled web app in a
 * BrowserWindow. The child's data home is the app's own userData directory,
 * and stderr is teed into userData/server.log. See PLAN.md for the lifecycle
 * and packaging contracts.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

/** The readiness line the server prints once every route is mounted. */
const READINESS_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/
/** Upper bound on waiting for the readiness line. */
const BOOT_DEADLINE_MS = 60_000
/** Grace window after SIGTERM before SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 5_000
/** Tail of child stderr kept for the failure dialog. */
const STDERR_TAIL_BYTES = 8_000

let server: ChildProcess | undefined
let serverUrl: string | undefined
let serverStderr = ''
let mainWindow: BrowserWindow | undefined
let quitting = false

/** Absolute path of the staged dsh bin: build/server in dev, resourcesPath/server when packaged. */
function serverBinPath(): string {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const prefix = app.isPackaged ? 'server' : join('build', 'server')
  return join(root, prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** Spawn the harness server, teeing stderr into a log file under the app home.
 * The harness home is a subdirectory of userData: Electron's own runtime files
 * (SingletonSocket, storage, caches) must stay out of the watched harness home. */
function startServer(): ChildProcess {
  const home = app.getPath('userData')
  const harnessHome = join(home, 'dsh-home')
  mkdirSync(harnessHome, { recursive: true })
  serverStderr = ''
  const child = spawn(process.execPath, ['--expose-internals', serverBinPath(), 'web', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: harnessHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    serverStderr = (serverStderr + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })
  const log = createWriteStream(join(home, 'server.log'), { flags: 'a' })
  child.stderr?.pipe(log)
  return child
}

/** Wait for the readiness URL line or the child's exit, whichever comes first. */
async function waitForReadiness(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`no readiness URL within ${BOOT_DEADLINE_MS} ms`))
    }, BOOT_DEADLINE_MS)
    // The interface stays open for the child's lifetime: closing it would close
    // the child's stdout pipe and crash the server with EPIPE on its next log.
    const lines = createInterface({ input: child.stdout ?? process.stdout })
    lines.on('line', (line) => {
      const match = READINESS_RE.exec(line)
      if (match === null) return
      const url = match[1]
      if (url === undefined) return
      clearTimeout(deadline)
      resolve(url)
    })
    child.once('exit', (code) => {
      clearTimeout(deadline)
      reject(new Error(`server exited with code ${String(code)} before readiness`))
    })
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
  })
}

/** Offer Quit/Retry on a server failure, showing the kept stderr tail. */
function showServerFailure(detail: string): void {
  if (quitting) {
    app.quit()
    return
  }
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'DeepSeek Harness',
    message: 'The harness server failed to start.',
    detail: `${detail}\n\n${serverStderr === '' ? '(no server output)' : serverStderr}`,
    buttons: ['Quit', 'Retry'],
    defaultId: 1,
    cancelId: 0,
  })
  if (choice === 1) void startApp()
  else app.quit()
}

/** Spawn the server, wait for readiness, and open the window on the ready URL. */
async function startApp(): Promise<void> {
  if (serverUrl !== undefined && mainWindow !== undefined) return
  server = startServer()
  let url: string
  try {
    url = await waitForReadiness(server)
  } catch (error) {
    server = undefined
    showServerFailure(error instanceof Error ? error.message : String(error))
    return
  }
  serverUrl = url
  console.log(`[dsh-desktop] server ready at ${url}`)
  createWindow().loadURL(url)
}

/** Create the app window with the renderer locked down and external links handed to the OS browser. */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (serverUrl !== undefined && url.startsWith(serverUrl)) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
  })
  win.on('closed', () => {
    mainWindow = undefined
  })
  mainWindow = win
  return win
}

/** SIGTERM the server and wait the grace window; SIGKILL after it lapses. */
async function stopServer(): Promise<void> {
  const child = server
  server = undefined
  if (child === undefined || child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, SHUTDOWN_DEADLINE_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void app.whenReady().then(startApp)
  app.on('activate', () => {
    if (mainWindow === undefined && serverUrl !== undefined) createWindow().loadURL(serverUrl)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopServer().finally(() => app.quit())
  })
}
