# DSH for VS Code (Welcome everyone to develop together)

Use [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) inside
VS Code the way Codex / Claude Code extensions work: the extension manages a
local `dsh web` server and embeds the **full DSH web GUI** in a sidebar panel,
so every DSH capability — agent chat, tool execution, sessions, approval
prompts, and any plugins installed in your web profile (SSH, task board,
preview/SCM panels, …) — is available right inside the editor.

## Features

- **Native Secondary Sidebar** embedding the complete DSH web GUI (`dsh web` on `127.0.0.1`).
- **Editor title shortcut**: click the DSH icon in the editor's upper-right corner to start DSH and focus its sidebar.
- VS Code versions before 1.106 automatically use the legacy Activity Bar location instead.
- **Lifecycle management**: auto-start on activation, Start / Stop / Restart
  commands, status-bar indicator with the live port.
- **Workspace-aware**: managed DSH automatically registers and selects the
  workspace/session matching the active local VS Code workspace folder.
- **Optional editor context**: visible and pinned local file metadata can be
  exposed to managed DSH without copying file contents or changing VS Code workspace folders.
- **Notebook context**: local `.ipynb` and other VS Code Notebooks expose the
  active/selected cells, language, cell kind, dirty state, and one-based
  selection coordinates without exposing cell source or outputs.
- **Verified fixed-port reuse**: with `dsh.port` set (non-zero), the extension attaches only after the existing endpoint identifies itself as DSH.
- **Open in Browser**, output-channel logging, and a start/error screen with
  actionable hints when `dsh` is missing.
- DSH binds to loopback only. When `dsh.dshHome` is empty, the DSH process uses its normal profile directory (typically `~/.dsh`).

## Requirements

- VS Code `>= 1.90` (desktop) with a trusted local workspace folder. VS Code `>= 1.106` uses the native Secondary Sidebar; older supported versions use the Activity Bar fallback.
- Node.js `>= 18` on PATH.
- A `dsh` installation, either:
  - global npm install: `npm install -g @deepseek-ai/dsh` (auto-detected), or
  - `dsh.executablePath` pointing at `@deepseek-ai/dsh/lib/bin.js` or a
    `dsh.cmd` shim.

## Install

### From the packaged .vsix

1. Run `npm run package` (produces `dsh-for-vscode-<version>.vsix`), then in
   VS Code: **Extensions → … → Install from VSIX…** and pick the file.
2. Open a workspace folder, then click the DSH icon in the editor title, select the DSH sidebar icon, or run `DSH: Open Sidebar`.

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
| `dsh.autoStart` | `false` | Start the server automatically when a workspace is open. Opening the DSH panel still starts it on demand. |
| `dsh.port` | `0` | Web-server port; `0` = OS-assigned. Non-zero ports are probed for an existing instance first. |
| `dsh.host` | `127.0.0.1` | Loopback only: `127.0.0.1` or `localhost`. |
| `dsh.extraArgs` | `[]` | Machine-level extra args; cannot override profile, host, or port. |
| `dsh.extraEnv` | `{}` | Explicit environment variables applied after inherited VS Code/Electron/Chrome values are scrubbed, so trusted values here can restore or override them. |
| `dsh.dshHome` | `""` | Custom `DSH_HOME`. Empty inherits the default (`~/.dsh`). |
| `dsh.startupTimeoutSeconds` | `30` | Readiness timeout after spawn. |
| `dsh.stopOnDeactivate` | `true` | Kill the spawned server when VS Code exits/reloads. |
| `dsh.autoRestart` | `false` | Auto-restart (max 3 attempts) after an unexpected crash. |
| `dsh.workspaceSync.enabled` | `true` | Keep managed DSH on the active local VS Code workspace. In multi-root windows, the active file selects the root. |
| `dsh.editorContext.enabled` | false | Send short-lived metadata for visible and pinned local files and Notebooks to extension-managed DSH. Cell and file contents are never copied into the bridge; changing this setting restarts managed DSH. |

## Commands

- `DSH: Open Sidebar` — start DSH if needed and focus the right sidebar (or the legacy left sidebar on VS Code before 1.106).
- `DSH: Start Server` / `DSH: Stop Server` / `DSH: Restart Server`
- `DSH: Open in Browser` — open the GUI in your default browser.
- `DSH: Show Logs` — the DSH output channel.

- `DSH: Pin Current File` / `DSH: Unpin Current File` persist or remove a file from editor context.
- `DSH: Manage Context Files` inspects visible, pinned, and session-authorized external files; pinned items can be removed.

Editor context contains paths, workspace-relative paths, language IDs, dirty flags,
and one-based selections only. For a visible Notebook, it also contains up to
100 active/selected cell records with one-based cell indexes, code/Markdown
kind, language, and selection coordinates. Closing the Notebook removes its
automatic record; pinning it keeps only the `.ipynb` path until it is visible
again. Unsaved file and cell contents are not sent. External files require one
session-only confirmation, and existing DSH write approvals still apply.
The feature is unavailable when a fixed port attaches to a DSH process that this
extension did not start.

## Notebook context usage

To share Notebook editor metadata with the DSH process started by this
extension:

1. Set dsh.editorContext.enabled to true in VS Code Settings.
2. Reload the DSH panel or run DSH: Restart Server so the integration patch is
   loaded.
3. Open a local .ipynb file, select one or more cells, and keep the Notebook
   visible. DSH will receive the Notebook path, active/selected cell indexes,
   cell kind, language, dirty state, and selection coordinates.
4. Use DSH: Pin Current File if the Notebook path should remain in context when
   the Notebook is hidden. Unpin it with DSH: Unpin Current File.

Only local file-based Notebooks are included. Cell source, selected text,
outputs, execution results, and custom Notebook metadata are never sent. A
dirty Notebook is marked as potentially stale; save it before asking DSH to
modify the corresponding file. A Notebook outside the current workspace
requires one session-only confirmation. The context feature uses the public
VS Code Notebook API and does not require a private Jupyter extension API.

## How it works

1. **Discovery** — `dsh.executablePath`, then the global npm
   `@deepseek-ai/dsh/lib/bin.js` (spawned via `node`), then `dsh` on PATH.
2. **Spawn** — `dsh --profile web [--patch <vscode-integration-patch>] --host 127.0.0.1 --port <port>` with the
   active local workspace root as `cwd`, and with the VS Code host's own
   environment variables scrubbed (`NODE_OPTIONS` points at VS Code bootstrap
   files and must never leak into the child).
3. **Readiness** — the `dsh web: http://127.0.0.1:PORT` line is parsed from
   stdout and confirmed by HTTP health probes.
4. **Embed** — the sidebar webview loads that loopback URL in a sandboxed
   iframe. The bundled DSH client adapter registers the active VS Code root,
   reuses or creates its blank session, and selects it without deleting history.
5. **Teardown** — Windows uses `taskkill /T /F` (whole-tree kill); POSIX uses
   process-group SIGTERM→SIGKILL.

## Troubleshooting

- **"Could not find the dsh executable"** — run
  `npm install -g @deepseek-ai/dsh`, or set `dsh.executablePath`.
- **Port in use / won't start** — keep `dsh.port` at `0`, or make sure the
  fixed port really serves DSH (the extension attaches only after it verifies the endpoint is DSH).
- **Blank panel** — check the DSH output channel (`DSH: Show Logs`) and the
  status-bar tooltip; restart with `DSH: Restart Server`.
- **Workspace sync unavailable** — it only applies to a DSH process started by
  this extension. Fixed-port attachment to an external DSH instance is left unchanged.

## Roadmap

- File-path deep-links: click a path in the embedded GUI to open the file in
  the VS Code editor.
- Editor-selection → DSH ("Explain / Improve with DSH" context menu).
- Headless task runner with a per-file git-diff accept/reject panel
  (built on `dsh --profile headless` + `DSH_TOOLS_MODE`).
- Native streaming chat client speaking the DSH host protocol.

## License

MIT — see the LICENSE file in this repository.
