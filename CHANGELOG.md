# Changelog

All notable user-facing changes to DSH for VS Code are documented here.

## [0.2.0] - 2026-10-22

### 新版 Harness 兼容

- 适配 Harness `0.2.0-rc.2` 和 `0.2.1-rc.2` 的 Web 登录令牌及鉴权流程。
- 新增本机临时嵌入网关，解决严格 Cookie 策略导致 VS Code 侧栏无法登录的问题；
  鉴权 Cookie 留在扩展宿主，网关使用随机路径并随受管服务关闭。
- 使用官方 `dsh.client` 声明注册浏览器集成模块，兼容客户端批次加载和热更新。
- 更新工作区就绪状态、`workspaceId`、`uiWorkspace` 会话导航及 `mainView` 当前会话识别。

### 优化与修复

- 保留启动地址中的登录令牌，状态栏和日志隐藏令牌，启动服务时禁止自动弹出浏览器。
- 复用已登记的工作区，保留正确工作区内用户选择的历史会话；只在实际切换后确认同步。
- 增加请求超时和失败重试间隔，避免失败时高频重试；禁用同步后不发送工作区请求。
- 补充标签页和编辑器分组变化监听，减少启动恢复标签页时漏更新的情况。
- 包含固定文件删除清理及 VS Code 重命名迁移修复。
- 编辑器元数据禁止提示词变量插值；UTF-8 检查允许合法中文并检查常见乱码。
- 外部固定端口需要鉴权或嵌入失败时显示明确原因。

### 使用及验证

- 使用 Node.js `22.12.0` 或更新版本；建议 Node.js 24 LTS。
- 更新 Harness 后安装本插件，运行 `DSH: Restart Server`；原工作区登记和会话继续保留。
- 新增无需第三方依赖的真实浏览器测试，覆盖跨站 iframe 鉴权及两个根目录的当前会话切换。
- 已分别通过 Harness `0.2.0-rc.2` 和 `0.2.1-rc.2` 的真实浏览器 smoke 测试。
- 101 项自动化测试、类型检查、Sidebar 脚本及 UTF-8 编码检查通过。

## [0.1.9] - 2026-08-16

### Added

- Local VS Code Notebooks, including Jupyter `.ipynb` files, now participate in
  optional editor context.
- DSH receives the active and selected cell indexes, code/Markdown kind,
  language ID, dirty state, and one-based text selection coordinates.
- `DSH: Pin Current File` and `DSH: Unpin Current File` now work when a
  Notebook tab is active.

### Fixed

- `vscode-notebook-cell:` editors are mapped back to their real local Notebook
  path instead of being discarded by the normal `file:` URI filter.
- An active Notebook in a secondary workspace root now selects the correct DSH
  workspace instead of falling back to the first root.
- Closing or hiding a Notebook immediately removes its automatic context and
  clears cached cell selections.

### Privacy and compatibility

- Cell source, selected text, outputs, execution results, and arbitrary Notebook
  metadata are never written to the bridge.
- The v2 bridge format is strictly validated, while the bundled DSH plugin
  continues to accept v1 text snapshots.
- Notebook support uses only the public VS Code API and has no private Jupyter
  extension dependency.

### User guide

- Enable dsh.editorContext.enabled, restart the managed DSH server, and open a
  local .ipynb file to share its active and selected cell metadata.
- Use DSH: Pin Current File to keep a Notebook path after it is hidden, or
  DSH: Manage Context Files to review pinned and session-authorized entries.
- Notebook content, outputs, execution results, and custom metadata remain
  private; only editor metadata and selection coordinates are shared.

### Verification

- 85 automated tests passed, including Notebook selection, dirty/save,
  multi-root, close cleanup, v1/v2 parsing, and safety sanitization cases.
- Real DSH patch-loading smoke test, build, VSIX resource inspection, and
  UTF-8 encoding checks passed.

## [0.1.8] - 2026-08-16

### Added

- A DSH shortcut in the editor's upper-right title area.
- Native Secondary Sidebar placement on VS Code 1.106 and newer.
- Automatic Activity Bar fallback on older supported VS Code versions.

### Compatibility and reliability

- The existing `dsh.openPanel` command ID is preserved for shortcuts and integrations.
- Primary and secondary views are mutually exclusive and share one Webview provider, preventing duplicate DSH pages and processes.
- Server controls, workspace synchronization, and editor context remain available in both sidebar placements.


## [0.1.7] - 2026-08-15

### Added

- Automatic DSH workspace/session synchronization, enabled by default through
  `dsh.workspaceSync.enabled` and independent of editor-context sharing.
- Multi-root selection based on the active file's local workspace folder.
- Sidebar status for synchronized, syncing, disabled, and unavailable states.

### Fixed

- DSH no longer restores an unrelated previous session as the active workspace
  when VS Code was opened on a different project folder.
- Switching roots preserves old DSH workspaces and chat history and does not
  restart the managed server.

### Compatibility and safety

- Workspace synchronization uses DSH's public workspace/session client interfaces.
- Missing or incompatible Web client interfaces disable synchronization without
  preventing DSH from starting.
- Fixed-port external DSH instances are never patched or switched.

## [0.1.6] - 2026-08-15

### Added

- Optional editor context for the DSH instance started by this extension.
- Automatic metadata for visible local files, including the active file,
  language ID, dirty state, and one-based selections.
- `DSH: Pin Current File` and `DSH: Unpin Current File` commands.
- `DSH: Manage Context Files` for reviewing and removing pinned files.
- Workspace-state persistence for pinned files, with a limit of 100 files.
- Session-only confirmation when a visible file is outside the DSH workspace.
- Sidebar context status showing the current file count and availability.
- A bundled DSH dynamic system-prompt plugin loaded through a generated patch.

### Privacy and safety

- The bridge contains file paths and editor metadata only; it never contains
  file contents.
- Unsaved files are marked so DSH is told that disk contents may be stale and
  must not be modified before the user saves.
- Virtual, untitled, Git, output, remote, and other non-local document URIs
  are ignored.
- The feature is unavailable when the extension attaches to an external DSH
  process on a fixed port.
- The VS Code workspace is not changed and no files are copied or linked.

### Configuration

Enable the feature in VS Code settings:

```text
dsh.editorContext.enabled = true
```

The setting is disabled by default. Changing it restarts a DSH process managed
by this extension so the generated patch is applied consistently.

### Verification

- 63 automated tests passed.
- UTF-8 and Sidebar encoding checks passed.
- Real DSH patch-loading smoke test passed.
- VSIX package rebuilt as `dsh-for-vscode-0.1.6.vsix`.

## [0.1.5]

- Previous stable release. See the repository history for implementation
  details from earlier fixes and improvements.

## Unreleased

Add future user-visible changes here before the next version is published.
