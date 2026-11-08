# Desktop client (QG-801 to QG-805)

`packages/desktop` is a Tauri 2 shell around the shared web dashboard. It adds a project picker, a permission prompt,
the local bridge, opt-in notifications and "open folder" buttons. It does not copy the dashboard: after you allow a
project the window navigates to the same dashboard server (`packages/dashboard`) that `pnpm dashboard` runs.

## Status: read this first

| Part | State |
| --- | --- |
| TypeScript logic (workspace store, validation, bridge launcher, notification mapping, run watcher, folder opener, host protocol, launcher page) | Built and tested here: `tests/desktop-*.test.ts`, run inside `pnpm check` with the 100% line / 95% branch floors. The tests include a run against the real `qualitygate bridge`, the real dashboard server and the real CLI. |
| Rust shell `packages/desktop/src-tauri/src/main.rs`, `Cargo.toml`, `tauri.conf.json`, `capabilities/` | **Unbuilt and unverified.** When this was written `cargo` and the Tauri CLI were not installed (`cargo --version`: command not found), so nothing was compiled. API names and versions follow the Tauri 2 documentation and may need fixes on the first real build. |
| Tauri webview behaviour (IPC, `window.__TAURI__`, navigating to the dashboard, the folder dialog, notifications) | **Unverified.** The launcher page is tested in jsdom against a fake `__TAURI__`, not in a Tauri webview. |
| macOS and Windows packages, signing, notarization, updates | **Not done.** Plan only: [DESKTOP_SIGNING.md](DESKTOP_SIGNING.md). |
| CI | `.github/workflows/desktop-smoke.yml`, manual dispatch only, unsigned debug build on macOS and Windows. Never run. |

## How it is split

```
launcher page (React, packages/desktop/src/ui)       no privileges, talks only through host_send
        |  JSON line  {id, method, params}
Rust shell (src-tauri/src/main.rs, ~100 lines)       forwards 7 method names, shows OS notifications, nothing else
        |  stdin / stdout of one child process
Node host (src/host.ts, host-main.ts)                all project logic, validates every request with zod
        |-- workspace store, recents, preferences   (src/workspace.ts)
        |-- qualitygate bridge as a child process     (src/launcher.ts)  or attach to a running bridge
        |-- the shared dashboard, in process          (src/dashboard.ts)
        |-- run watcher and notification text         (src/notify.ts)
        '-- folder resolver and file manager opener   (src/open.ts)
```

The page that shows the dashboard is an ordinary `http://127.0.0.1:<port>` page. It receives no Tauri capability
(`capabilities/default.json` is limited to the local launcher window), so a bug or hostile content in it cannot reach
the shell commands.

The Rust shell has no shell, filesystem, opener or HTTP plugin. It can start exactly one process, `node host.mjs`.
`tests/desktop-package.test.ts` pins this, pins the Content-Security-Policy, and checks that the Rust method allow list
equals `HOST_METHODS` in `src/host.ts`.

## Using it (what is possible today)

Without Rust you can run the whole host and talk to it, which is what the tests do:

```bash
pnpm build:desktop      # packages/desktop/dist/host.mjs (self-contained) and dist/ui (the launcher page)
node packages/desktop/dist/host.mjs --cli dist/qualitygate.mjs --assets packages/dashboard/dist --data-dir ~/.qualitygate-desktop
# then one JSON object per line on stdin, e.g. {"id":1,"method":"state"}
```

With a Rust toolchain and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`), from
`packages/desktop/src-tauri`: `cargo tauri icon icons/icon.png` once, then `cargo tauri dev` or `cargo tauri build`.
This path is unverified. The shell starts `node`, so Node 22 must be on `PATH`, and the bundled `qualitygate.mjs`
is the externals-based CLI build that needs its `node_modules`; set `QUALITYGATE_CLI` to a CLI that has them
(for example this checkout's `dist/qualitygate.mjs`). Shipping a self-contained CLI and a Node runtime is open work.

## Workspace selection and recent projects (QG-803)

- A project is a folder that contains `.qualitygate.yml`. The picker takes a folder from the native dialog or a typed
  absolute path. Nothing is created in the folder.
- Every launch validates the path again, both when the prompt is shown and when you press Allow: absolute, exists, is a
  directory (symlinks resolved, the resolved path is what runs), has a regular `.qualitygate.yml` that parses.
  Recents whose folder vanished are listed with the reason and cannot be opened.
- Recents (newest first, at most 10) and preferences live in `workspaces.json` in the app data folder, mode 0600,
  replaced atomically. A damaged file is moved to `workspaces.json.corrupt` and the list starts empty, with a notice.
- Run history is the dashboard's own history view (QG-803 history part was delivered with the web dashboard).

## Permission prompt and the bridge (QG-802)

Nothing starts until the person presses Allow in a dialog that lists what will happen: start the bridge for this
folder on 127.0.0.1 only, serve the dashboard for it, and (only if notifications are on) read verdicts and gate names.
The host issues a one-time prompt id for a validated folder; `project.start` is refused without it, without
`accepted: true`, or when the id was already used.

- **Launch**: `qualitygate bridge --port 0 --config <project>/.qualitygate.yml` runs as a child process. The one-time
  pairing code is read from the child's own output and used by the host; it never reaches the page. The token stays in
  memory (not on disk) and is revoked when you stop the project. The origin presented is `tauri://localhost`, which
  [BRIDGE.md](BRIDGE.md) already allows.
- **Attach**: connect to a bridge you started in a terminal with the pairing code you type. The app cannot check which
  project that bridge serves (the bridge API does not say), and the prompt tells you so. Stopping only revokes the app's
  own token; the bridge keeps running.
- Only gates already in the project's `.qualitygate.yml` can run. The app has no command, path or config input, and the
  verdict shown is the stored run's: a client cannot change it. Exit codes are 0 PASS, 1 BLOCK, 2 error, 3 timeout,
  130 interrupted.
- The Rust shell and the page never see gate output. Bridge responses already exclude it, and notification text is built
  from the verdict and gate ids only.

## Notifications (QG-804)

Off by default; the checkbox in the launcher turns them on and is stored with the preferences. The host polls
`GET /v1/runs/latest` every 3 seconds while a project is open. The run present at start is not announced; each later run
id is announced once.

| Exit code | Notification |
| --- | --- |
| 0 with decision PASS | `<project>: PASS`, number of gates checked |
| 1 with decision BLOCK | `<project>: BLOCK`, `Blocked by <up to 3 gate ids>` |
| 2, unknown, or a decision that contradicts the exit code | `<project>: run failed`, never shown as PASS |
| 3 | `<project>: run timed out` |
| 130 | none (a person cancelled it) |

Limits: a run started by a terminal CLI while the bridge is up is seen, because the history is the shared source; a run
that finishes between two polls and is followed by another within 3 seconds shows only the newest. Clicking a
notification does not open anything: Tauri's desktop notification API has no click callback (unverified for the
version you build). The "link to the artifact" is therefore in the window: the launcher shows the latest run with an
"Open evidence folder" button.

## Opening evidence and reports (QG-804)

"Open reports folder" opens the project's `outputDir`; "Open evidence folder" opens `<outputDir>/<runId>`. The host
resolves both from the approved config, accepts only a UUID run id, requires a real directory (a symlink as the run
folder is refused), and starts the platform file manager (`open`, `explorer.exe`, `xdg-open`) with one directory argument
and no shell. It never opens files, so nothing is executed. The `outputDir` of the config is trusted: it is part of the
approved `.qualitygate.yml`.

## Not done

- Everything marked unbuilt or unverified above.
- Updates (no updater plugin is installed on purpose) and a clean-install/upgrade smoke test (QG-805).
- A bundled Node runtime and a self-contained CLI.
- Windows and Linux behaviour of the TypeScript parts is expected but only macOS was exercised here. File modes
  (0600/0700) are not enforced on Windows.
- Per-project remembered permission. The prompt is shown on every launch on purpose.
