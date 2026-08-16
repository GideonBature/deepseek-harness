/**
 * Sandboxed preload: exposes a minimal, read-only desktop surface to the
 * renderer. The web app itself needs nothing from the desktop shell; this
 * bridge exists for future app-owned conveniences (window controls, dialogs).
 */
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
})
