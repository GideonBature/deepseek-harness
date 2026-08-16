# DeepSeek Harness Desktop (Electron) — Plan

This directory is **fork-owned**. The upstream repository does not have `apps/desktop`, and the
goal is that it never needs to: the desktop app is maintained only here, while the harness itself
keeps syncing from upstream with near-zero conflict surface.

## 1. How the harness works today (facts this plan builds on)

- The browser UI is a static React SPA (`@deepseek-ai/dsh-web-frontend`, `apps/web`) built by Vite.
- `dsh web` (= `dsh --profile web`) boots the full harness and serves that dist over a loopback
  `node:http` server (default `127.0.0.1:3080`). It injects `window.__DSH_BOOT__` into `index.html`.
- The renderer is transport-agnostic: it talks to its own origin via JSON-RPC `POST /api/<method>`
  plus two WebSockets (`/api/events.mux`, `/api/events.host`). Base URL comes from `location.origin`.
- `--port 0` requests an OS-assigned port; readiness is announced on stdout as
  `dsh web: http://127.0.0.1:<port>` after Loader settlement.
- All user data lives under `$DSH_HOME` (default `~/.dsh`): sessions, `settings.yaml`,
  `.credentials.yaml` (written by the web Models page), profiles.
- Profiles auto-initialize offline: `healProfilesModuleFallback` symlinks the CLI installation's
  entire dependency closure into `$DSH_HOME/profiles/node_modules`, so a flat, symlink-free
  `node_modules` closure of `@deepseek-ai/dsh` is everything the server needs to boot.
- `scripts/build-exe-for-python-sdk.ts` already materializes exactly such a closure via
  `pnpm ... deploy --legacy --prod --config.node-linker=hoisted ...` plus link-materialization.
- Python is not a runtime dependency. Native modules in the closure: `node-pty` and
  `node-addon-require-builtin` (both need an Electron-ABI rebuild); Landlock ships as prebuilt
  static binaries; SQLite is `node:sqlite`; ripgrep ships as platform binaries.

## 2. Architecture decision

**Phase-1 architecture: a thin Electron shell over the real server.**

```mermaid
flowchart LR
    M[Electron main process] -->|utilityProcess / ELECTRON_RUN_AS_NODE| S[dsh web --port 0]
    S -->|stdout: dsh web: http://127.0.0.1:PORT| M
    M -->|loadURL loopback origin| W[BrowserWindow]
    W -->|fetch + 2 WebSockets, same-origin| S
    S --> D[DSH_HOME = app userData: sessions, settings, credentials]
```

- The Electron main process spawns the packaged `dsh` server (`web` profile) on `127.0.0.1` with
  `--port 0`, parses the readiness URL line, then loads a `BrowserWindow` pointed at that origin.
- The renderer runs the **unmodified** web app: no `file://`, no IPC carrier, no `__DSH_BOOT__`
  reimplementation, no changes to `packages/`. This is what makes upstream sync painless.
- Electron's own binary provides Node for end users (`ELECTRON_RUN_AS_NODE=1 process.execPath
  <staging>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0`) — no system Node required.
- The loopback trust fence already accepts `Host: 127.0.0.1:<port>`; privileged RPCs are
  loopback-pinned. Security posture equals the browser product.

The repo's docs sketch a future IPC carrier (`doFetch` swap on `AbstractApiClient`); that is a
later optimization only if we want `file://` loading. It is not needed for v1 and would require
harness changes that conflict with the sync goal.

## 3. Repository layout and upstream-sync model

```
apps/desktop/                 # fork-owned, new, never touched by upstream
  PLAN.md                     # this file
  package.json                # private; NOT @deepseek-ai/-scoped (bypasses app-package gates)
  electron-builder.yml        # or builder config in package.json
  .gitignore                  # local outputs (build/, out/, dist/)
  src/
    main/                     # main process: spawn, readiness, windows, lifecycle, menu, tray
    preload/                  # minimal bridge (shell.openExternal etc.), contextIsolation on
    shared/                   # port/readiness protocol constants
  resources/                  # icons, entitlements (macOS)
  server-deploy/package.json  # deploy root: dependency manifest for the harness closure
  scripts/
    stage-server.mjs          # pnpm deploy + materialize links + electron-rebuild
    dev.mjs                   # dev mode: spawn from workspace build, watch
  tests/                      # smoke tests: server boot, readiness parse, window load
```

Shared-file footprint in the fork (everything else upstream owns and we never edit):

- Zero edits to `pnpm-workspace.yaml` or root `package.json`: `apps/*` is already a workspace glob.
- One optional fork-local line in `knip.json`: add `"apps/desktop"` to `ignoreWorkspaces` (the
  established pattern for non-conforming workspaces like `python/sdk-runtime`). This is the only
  upstream-owned file we touch; a merge conflict here is a one-line fix.
- `apps/desktop/package.json` is `"private": true` and uses an unscoped or personal-scoped name
  (e.g. `dsh-desktop`) so `check-workspace-constraints` and the app-package-files policy skip it.
- New CI workflow `.github/workflows/desktop-release.yml` is additive; name it so it cannot
  collide with upstream workflow names.

Branch model:

- `upstream` remote = `github.com/deepseek-ai/deepseek-harness`; add it now (missing today).
- The existing fork branch `apps` is the fork-only desktop maintenance branch:
  `apps = upstream/master + apps/desktop/** + the knip one-liner`.
- Sync: `git fetch upstream && git checkout apps && git rebase upstream/master`; conflicts are
  structurally limited to `knip.json` (and never to `apps/desktop`).
- Contributions to the harness itself branch off `upstream/master`, never off `apps`, so upstream
  PR CI never sees the desktop directory.

## 4. Packaging pipeline

1. `pnpm install` after each upstream sync; `pnpm run build` (builds host/client libs + web dist).
2. `apps/desktop/scripts/stage-server.mjs`:
   - `pnpm --filter`-less deploy of `apps/desktop/server-deploy` (a dependency-only manifest whose
     `dependencies` list `@deepseek-ai/dsh` workspace:^, pulling the whole web closure):
     `pnpm --dir apps/desktop/server-deploy deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true apps/desktop/build/server`
     (same flags as the proven exe pipeline; fallback: make `server-deploy` a workspace member).
   - Materialize remaining symlinks and hoists (port the two helpers from
     `scripts/build-exe-for-python-sdk.ts`).
   - `npx @electron/rebuild -p <staging>` against the Electron ABI for `node-pty` and
     `node-addon-require-builtin`.
   - Verify offline boot: `ELECTRON_RUN_AS_NODE=1 <electron> build/server/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0` with a scratch `DSH_HOME`, parse the URL line, curl the origin. This is the phase-0 gate.
3. `electron-builder` packages `apps/desktop` with `extraResources: build/server` (server closure
   stays out of the asar; native modules unpacked). Targets: `dmg`+`zip` (macOS, both arches),
   `nsis` (Windows), `AppImage`+`deb` (Linux).
4. Signing/notarization: ship unsigned for development; add Apple Developer ID + notarization and
   Windows code signing as a phase-3 item (credentials in fork repo secrets).

Electron version constraint: pick the newest stable Electron whose embedded Node satisfies
`^22.19.0 || >=24.0.0` (needed by `node:sqlite` and the harness engines). Verify at selection time:
`ELECTRON_RUN_AS_NODE=1 npx electron -e "console.log(process.versions.node)"`. Pin it in
`apps/desktop/package.json` and bump only deliberately.

## 5. Runtime behavior (main process)

- `app.requestSingleInstanceLock()`; second instance focuses the first window.
- Set `DSH_HOME` to `app.getPath('userData')` (isolated from the CLI's `~/.dsh`); a later setting
  can opt into sharing `~/.dsh`.
- Spawn the server; buffer stdout/stderr; readiness = regex on the `dsh web:` URL line with a
  timeout; on failure show a dialog with the child's diagnostics and a "Retry / Open logs" action.
- `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity` on; `setWindowOpenHandler` routes http(s) to `shell.openExternal`.
- Child lifecycle: on quit send SIGTERM and wait the bounded shutdown window
  (`dsh` has `PROCESS_SHUTDOWN_TIMEOUT_MS`); kill after timeout. Handle unexpected child exit
  (error window, restart button). macOS: `activate` / `window-all-closed` conventions.
- Smoke tests (`apps/desktop/tests`): stage → spawn → parse readiness → fetch `/` and one RPC →
  quit → child exits cleanly. Run in the fork's desktop CI on all three OSes.

## 6. Phased roadmap

- **Phase 0 — sync + proof (days)** Add `upstream` remote; write `apps/desktop/PLAN.md`,
  `server-deploy` manifest, and `stage-server.mjs`; prove the deployed web profile boots offline
  and serves the SPA. Gate: the phase-0 curl smoke passes on macOS and Linux.
- **Phase 1 — dev-mode desktop app** Electron shell spawning the workspace-built server
  (`pnpm dsh web --port 0` equivalent) from a checkout; window, menu, tray, lifecycle, DSH_HOME
  isolation; manual run on macOS/Windows/Linux. No packaging yet.
- **Phase 2 — packaged installers** `electron-builder` for the three OSes; native-ABI rebuild;
  unsigned installers downloadable from fork Releases; smoke-test each artifact in CI.
- **Phase 3 — distribution polish** Icons, code signing + notarization (macOS) and Windows
  signing, auto-update via `electron-updater` against fork Releases, telemetry opt-out toggle
  surfaced in Settings, docs on `apps/desktop/README.md`.

## 7. Risks and decisions

- **Electron-embedded Node < 22.19**: blocks boot. Mitigated by the version-selection gate in §4.
- **`node-pty` ABI**: rebuild against Electron headers at stage time; CI asserts the rebuild ran
  (fail if the staging dir contains a Node-ABI build).
- **Sandbox probing per OS**: `dsh-sandbox-local` probes bwrap / macOS Seatbelt / Windows ACL and
  fails closed. Verify tool execution on each OS in phase 1; if a platform lacks an acceptable
  sandbox, surface it in the app rather than silently changing policy.
- **Loopback API is reachable by local processes**: identical to browser mode today. A shared-secret
  token would need a webserver/connection change in the harness — propose it upstream later if
  desired; not a v1 blocker.
- **`pnpm deploy` from a non-workspace member** may need `server-deploy` added as a workspace
  member (one line in `pnpm-workspace.yaml`) — fallback documented in §4; prefer avoiding it.
- **Upstream file moves/renames** (e.g. `apps/web` → elsewhere) are handled by the usual rebase;
  the desktop app depends only on package names and the stable `dsh web` contract.
