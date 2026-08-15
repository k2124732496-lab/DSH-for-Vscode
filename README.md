# DSH for VS Code（Welcome everyone to develop together）

Use [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) inside
VS Code the way Codex / Claude Code extensions work: the extension manages a
local `dsh web` server and embeds the **full DSH web GUI** in a sidebar panel,
so every DSH capability — agent chat, tool execution, sessions, approval
prompts, and any plugins installed in your web profile (SSH, task board,
preview/SCM panels, …) — is available right inside the editor.

## Features

- **Sidebar panel** embedding the complete DSH web GUI (`dsh web` on `127.0.0.1`).
- **Lifecycle management**: auto-start on activation, Start / Stop / Restart
  commands, status-bar indicator with the live port.
- **Workspace-aware**: DSH launches with your first workspace folder as the
  session working directory; switching workspaces restarts it in the new folder.
- **Verified fixed-port reuse**: with `dsh.port` set (non-zero), the extension attaches only after the existing endpoint identifies itself as DSH.
- **Open in Browser**, output-channel logging, and a start/error screen with
  actionable hints when `dsh` is missing.
- DSH binds to loopback only. When `dsh.dshHome` is empty, the DSH process uses its normal profile directory (typically `~/.dsh`).

## Requirements

- VS Code `>= 1.90` (desktop) with a trusted local workspace folder.
- Node.js `>= 18` on PATH.
- A `dsh` installation, either:
  - global npm install: `npm install -g @deepseek-ai/dsh` (auto-detected), or
  - `dsh.executablePath` pointing at `@deepseek-ai/dsh/lib/bin.js` or a
    `dsh.cmd` shim.

## Install

### From the packaged .vsix

1. Run `npm run package` (produces `dsh-for-vscode-<version>.vsix`), then in
   VS Code: **Extensions → … → Install from VSIX…** and pick the file.
2. Open a workspace folder; DSH auto-starts in the sidebar (activity-bar icon).

### From source (development)

1. `npm install && npm run build`.
2. Press `F5` (Run Extension) in this folder.
3. `npm test` runs the unit tests; `npm run smoke` runs an end-to-end check
   against your real `dsh` binary (discovery → spawn → port parse → health →
   tree kill).

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `dsh.executablePath` | `""` | Explicit `dsh` path (bin.js / `.cmd` / executable). Empty = auto-detect. |
| `dsh.autoStart` | `true` | Start the server automatically when a workspace is open. |
| `dsh.port` | `0` | Web-server port; `0` = OS-assigned. Non-zero ports are probed for an existing instance first. |
| `dsh.host` | `127.0.0.1` | Loopback only: `127.0.0.1` or `localhost`. |
| `dsh.extraArgs` | `[]` | Machine-level extra args; cannot override profile, host, or port. |
| `dsh.extraEnv` | `{}` | Extra environment variables for the DSH process. Host-only variables (`NODE_OPTIONS`, `VSCODE_*`, `ELECTRON_*`) are always scrubbed — set them here deliberately if needed. |
| `dsh.dshHome` | `""` | Custom `DSH_HOME`. Empty inherits the default (`~/.dsh`). |
| `dsh.startupTimeoutSeconds` | `30` | Readiness timeout after spawn. |
| `dsh.stopOnDeactivate` | `true` | Kill the spawned server when VS Code exits/reloads. |
| `dsh.autoRestart` | `false` | Auto-restart (max 3 attempts) after an unexpected crash. |

## Commands

- `DSH: Open Panel` — focus the sidebar; starts the server if needed.
- `DSH: Start Server` / `DSH: Stop Server` / `DSH: Restart Server`
- `DSH: Open in Browser` — open the GUI in your default browser.
- `DSH: Show Logs` — the DSH output channel.

## How it works

1. **Discovery** — `dsh.executablePath`, then the global npm
   `@deepseek-ai/dsh/lib/bin.js` (spawned via `node`), then `dsh` on PATH.
2. **Spawn** — `dsh --profile web --host 127.0.0.1 --port <port>` with the
   first workspace folder as `cwd`, and with the VS Code host's own
   environment variables scrubbed (`NODE_OPTIONS` points at VS Code bootstrap
   files and must never leak into the child).
3. **Readiness** — the `dsh web: http://127.0.0.1:PORT` line is parsed from
   stdout and confirmed by HTTP health probes.
4. **Embed** — the sidebar webview loads that loopback URL in a sandboxed
   iframe; a postMessage bridge relays start/stop/restart and state updates.
5. **Teardown** — Windows uses `taskkill /T /F` (whole-tree kill); POSIX uses
   process-group SIGTERM→SIGKILL.

## Troubleshooting

- **"Could not find the dsh executable"** — run
  `npm install -g @deepseek-ai/dsh`, or set `dsh.executablePath`.
- **Port in use / won't start** — keep `dsh.port` at `0`, or make sure the
  fixed port really serves DSH (the extension attaches only after it verifies the endpoint is DSH).
- **Blank panel** — check the DSH output channel (`DSH: Show Logs`) and the
  status-bar tooltip; restart with `DSH: Restart Server`.
- **Sessions in the wrong folder** — DSH uses the first workspace folder as
  the working directory; open the project as the workspace root (the GUI's
  directory picker can also switch).

## Roadmap

- File-path deep-links: click a path in the embedded GUI to open the file in
  the VS Code editor.
- Editor-selection → DSH ("Explain / Improve with DSH" context menu).
- Headless task runner with a per-file git-diff accept/reject panel
  (built on `dsh --profile headless` + `DSH_TOOLS_MODE`).
- Native streaming chat client speaking the DSH host protocol.

## License

MIT — see the LICENSE file in this repository.
