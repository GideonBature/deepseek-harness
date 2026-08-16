# dsh-desktop — DeepSeek Harness desktop app (Electron)

Fork-owned directory: upstream `deepseek-ai/deepseek-harness` does not contain `apps/desktop`, and
never needs to. The desktop app is maintained only here, while the harness itself syncs from
upstream with a two-line conflict surface. [PLAN.md](PLAN.md) owns the architecture and the
upstream-sync model; this README owns **how to test it today** and **how to release an installable
macOS build**.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Server closure staging + offline boot proof | **Done** (2026-08-16, verified under system Node 26 and Electron 43.4.0) |
| 1 | Electron shell (main process, BrowserWindow, lifecycle, DSH_HOME isolation) | **Done** (2026-08-17; `pnpm --filter dsh-desktop start`) |
| 2 | Packaging (`electron-builder`: dmg/zip for macOS, nsis for Windows, AppImage/deb for Linux) | Not started |
| 3 | Signing/notarization, auto-update, icons | Not started |

## Layout

```
apps/desktop/
  PLAN.md                         Architecture decisions, phases, risks
  README.md                       This file
  package.json                    dsh-desktop (private, unscoped; Electron devDep)
  tsconfig.json                   Standalone typecheck project
  src/main/                       Electron main process
  src/preload/                    Sandboxed preload bridge
  server-deploy/                  Dependency-only deploy root (workspace member; generated manifest)
  scripts/
    build-app.mjs                   esbuild bundle of main + preload
    gen-server-deploy-manifest.mjs  Regenerates server-deploy dependencies from the CLI closure
    stage-server.mjs                Materializes build/server via pnpm deploy + gates
    smoke-boot.mjs                  Boots the staged server, verifies it serves the app
    diagnose-composition.mjs        Debug helper: diff profile composition across runtimes
    probe-require-builtin.cjs       Debug helper: probe the loader-internals addon
  build/                          All artifacts (gitignored): server/ closure, smoke homes
  out/                            Bundled main + preload (gitignored)
  dist/                           Installer output (gitignored, phase 2)
```

## Testing it today

What exists now is the **server half**: the complete `dsh web` harness closure, staged into a
symlink-free `node_modules`, bootable under system Node or an Electron binary — plus the
**Electron shell** that spawns it and shows the app in a window. Testing from a clean checkout:

```sh
# 1. Build the harness (host + client libs + web dist). From the repository root:
pnpm install
pnpm run build

# 2. Regenerate the deploy manifest if the CLI's workspace closure changed
#    (after an upstream sync — see "Staying in sync" below):
node apps/desktop/scripts/gen-server-deploy-manifest.mjs

# 3. Stage the server closure into apps/desktop/build/server
#    (pnpm deploy + link materialization + closure gate):
node apps/desktop/scripts/stage-server.mjs

# 4. Run the desktop app (bundles main/preload, spawns the server, opens the window):
pnpm --filter dsh-desktop start
```

`start` opens a real window: the main process boots the staged server on an OS-assigned loopback
port, loads the app, and logs `[dsh-desktop] server ready at http://127.0.0.1:<port>`. The
harness's data lives in `dsh-home` under the Electron userData directory
(`~/Library/Application Support/dsh-desktop/dsh-home` on macOS) — a subdirectory on purpose, so
Electron's own runtime files never mix with the watched harness home. The server's stderr is teed
into `server.log` in the userData directory. Close the window and press Cmd+Q to quit; the server
receives SIGTERM and the app waits the grace window before SIGKILL.

```sh
# 5. Headless smoke of just the server half (no window). Expect:
#    `smoke-boot: PASS — http://127.0.0.1:<port> served the assembled web app`
#    followed by `server exited cleanly with code 0`.
node apps/desktop/scripts/smoke-boot.mjs
```The same smoke under a real Electron binary (the packaged-app execution path; Electron 43.4.0 is
the version the shell pins):

```sh
mkdir -p apps/desktop/build/electron-test
curl -sSL --retry 5 "https://github.com/electron/electron/releases/download/v43.4.0/electron-v43.4.0-darwin-arm64.zip" \
  -o apps/desktop/build/electron-test/electron.zip
unzip -qo apps/desktop/build/electron-test/electron.zip -d apps/desktop/build/electron-test

SMOKE_RUNTIME="$(pwd)/apps/desktop/build/electron-test/Electron.app/Contents/MacOS/Electron" \
  node apps/desktop/scripts/smoke-boot.mjs
```

Interactive manual run (browse the app yourself): boot the staged server in a terminal with a
scratch home, then open the printed URL.

```sh
# system Node:
DSH_HOME="$(pwd)/apps/desktop/build/manual-home" \
  node --expose-internals apps/desktop/build/server/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0

# Electron-as-node (same as the packaged app will spawn):
DSH_HOME="$(pwd)/apps/desktop/build/manual-home" ELECTRON_RUN_AS_NODE=1 \
  apps/desktop/build/electron-test/Electron.app/Contents/MacOS/Electron --expose-internals \
  apps/desktop/build/server/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0
```

The server prints `dsh web: http://127.0.0.1:<port>` when ready. Open it in a browser; set the
DeepSeek API key on the web Models page (it is written to the scratch home's `.credentials.yaml`),
then start a session. Stop the server with Ctrl-C.

## Releasing an installable macOS (Apple Silicon) build

The Electron shell (phase 1) is in place; what remains is phase 2 (the `electron-builder`
configuration and the `release:mac` script). The flow below is the exact pipeline the plan commits
to; the `release:mac` script becomes the last step once the packaging config lands:

```sh
# From the repository root, on an arm64 Mac:
pnpm install && pnpm run build
node apps/desktop/scripts/gen-server-deploy-manifest.mjs
node apps/desktop/scripts/stage-server.mjs

# Rebuild ABI-bound native modules against the pinned Electron (node-pty; verified necessary):
npx --yes @electron/rebuild --version 43.4.0 --module-dir apps/desktop/build/server --force

# Build the installers:
pnpm --filter dsh-desktop run release:mac     # runs electron-builder --mac dmg zip --arm64
```

Packaging requirements the shell must satisfy (already verified in phase 0):

- `extraResources` carries `build/server` (the closure stays out of the asar; native modules unpacked).
- The main process spawns the server as `ELECTRON_RUN_AS_NODE=1` with `--expose-internals`
  in the argv — without it the cordis HMR chain fails under Electron.
- `DSH_HOME` points at `userData/dsh-home` (a subdirectory: the harness home watcher crashes on
  Electron's `SingletonSocket` when the homes share a directory).

Artifacts land in `apps/desktop/dist/` (`*.dmg`, `*-mac.zip`, plus `latest-mac.yml` when
`publish` is configured). An **unsigned** build works locally: the user right-clicks the app and
chooses Open to bypass Gatekeeper. For public distribution:

1. **Sign + notarize** (`CSC_LINK`/`CSC_KEY_PASSWORD` for a Developer ID certificate, plus
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; electron-builder notarizes
   automatically when `mac.notarize` is set). Hardened runtime enforces library validation, so the
   staged native modules must be signed with the same identity — this is the one phase-3 risk that
   was already reproduced (an Apple-signed Electron rejects the unsigned `.node` files).
2. **Upload** the `.dmg` and `-mac.zip` to GitHub Releases on the fork
   (`github.com/GideonBature/deepseek-harness/releases`, tag like `desktop-v0.1.0`).
3. Intel Macs need the same build on an x64 runner (`--x64`) or `--universal`; Windows (`nsis`)
   and Linux (`AppImage`, `deb`) follow the same staging and are built in CI later.
4. Auto-update (`electron-updater` over the `latest-mac.yml`) and a signed CI workflow
   (`.github/workflows/desktop-release.yml`) are phase-3.

## Staying in sync with upstream

```sh
git fetch upstream
git checkout apps                       # the fork-only desktop branch
git rebase upstream/master              # conflicts: at most the two fork-local one-liners
pnpm install && pnpm run build
node apps/desktop/scripts/gen-server-deploy-manifest.mjs   # pick up new/renamed workspace packages
node apps/desktop/scripts/stage-server.mjs                 # fails loudly if a peer is missing
node apps/desktop/scripts/smoke-boot.mjs
```

Harness contributions that go back upstream must branch off `upstream/master`, never off `apps`,
so upstream PR CI never sees this directory. The only upstream-owned files this fork touches are
`pnpm-workspace.yaml` (the `apps/desktop/server-deploy` member line) and `knip.json` (the
`ignoreWorkspaces` entry); both are one-line re-applies on conflict.

## Verified gotchas

- `--expose-internals` is mandatory in the server spawn (see above).
- `node-pty` must be rebuilt for Electron's ABI; `sharp` and `koffi` are N-API and load as-is.
- `pnpm deploy` and the harness build fetch pnpm's standalone `@pnpm/exe` from npm on first run.
- In the VS Code agent sandbox, `pnpm deploy` additionally needs host filesystem access (the
  sandbox denies writing package files named `.gitmodules`/`.idea`); a normal developer terminal
  or CI has no such restriction.
