# Changelog

All notable user-facing changes to DSH for VS Code are documented here.

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
