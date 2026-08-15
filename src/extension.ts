/** Activates DSH commands, sidebar state, settings refresh, and process teardown. */
import * as vscode from "vscode";
import { readSettings, workspaceCwd } from "./config";
import { discoverDsh, realDiscoveryEnv } from "./discovery";
import { disposeLogs, log, showLogs } from "./logger";
import { DshServer } from "./server";
import { EditorContextController, type EditorContextSummary } from "./editor-context-vscode";
import { SidebarProvider } from "./sidebar";
import { StatusBar } from "./status";

let activeServer: DshServer | undefined;
let activeEditorContext: EditorContextController | undefined;

function canStartDsh(showMessage: boolean): boolean {
  if (!vscode.workspace.isTrusted) {
    if (showMessage) void vscode.window.showWarningMessage("Trust this workspace before starting DSH.");
    return false;
  }
  if (workspaceCwd() === undefined) {
    if (showMessage) void vscode.window.showWarningMessage("Open a local workspace folder before starting DSH.");
    return false;
  }
  return true;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log("DSH for VS Code activating");
  let editorContext: EditorContextController | undefined;
  let sidebar: SidebarProvider | undefined;
  const server = new DshServer({
    resolveLocation: async () => discoverDsh(readSettings().executablePath, realDiscoveryEnv()),
    settings: () => {
      const settings = readSettings();
      return {
        ...settings,
        editorContextPatchPath: settings.editorContextEnabled || settings.workspaceSyncEnabled
          ? editorContext?.patchPath
          : undefined,
      };
    },
    cwd: workspaceCwd,
    log,
  });
  activeServer = server;
  const statusBar = new StatusBar();

  const disabledContextSummary = (): EditorContextSummary => ({
    enabled: false, available: false, count: 0, pinnedCount: 0, temporaryExternalCount: 0,
  });
  const pushEditorContext = (): void => {
    if (editorContext === undefined) {
      let enabled = false;
      try { enabled = readSettings().editorContextEnabled; } catch {}
      const summary = enabled
        ? { ...disabledContextSummary(), enabled: true, reason: "Editor context requires a trusted local workspace and a working runtime bridge." }
        : disabledContextSummary();
      void sidebar?.pushContext(summary);
      return;
    }
    const serverSnapshot = server.getSnapshot();
    const attached = serverSnapshot.state === "running" && !serverSnapshot.owned;
    const reason = attached ? "Editor context is unavailable when attached to an external DSH instance." : undefined;
    void sidebar?.pushContext(editorContext.summary(!attached, reason));
  };
  const pushWorkspaceSync = (): void => {
    let enabled = true;
    try { enabled = readSettings().workspaceSyncEnabled; } catch {}
    const serverSnapshot = server.getSnapshot();
    const attached = serverSnapshot.state === "running" && !serverSnapshot.owned;
    const workspaceRoot = workspaceCwd();
    const available = enabled && editorContext !== undefined && !attached;
    const reason = !enabled
      ? "Workspace sync is disabled."
      : attached
        ? "Workspace sync is unavailable when attached to an external DSH instance."
        : workspaceRoot === undefined
          ? "Open a trusted local workspace folder to use workspace sync."
          : undefined;
    void sidebar?.pushWorkspaceSync({ enabled, available, workspaceRoot, reason });
  };
  let contextSync = Promise.resolve();
  const synchronizeEditorContext = (): Promise<void> => {
    contextSync = contextSync.then(async () => {
      const settings = readSettings();
      const root = workspaceCwd();
      const shouldEnable = (settings.editorContextEnabled || settings.workspaceSyncEnabled)
        && vscode.workspace.isTrusted
        && root !== undefined;
      if (!shouldEnable || root === undefined) {
        const previous = editorContext;
        editorContext = undefined;
        activeEditorContext = undefined;
        await previous?.dispose();
        pushEditorContext();
        pushWorkspaceSync();
        return;
      }
      if (editorContext?.matchesFeatures(settings.editorContextEnabled, settings.workspaceSyncEnabled)) {
        editorContext.refreshWorkspace();
        pushEditorContext();
        pushWorkspaceSync();
        return;
      }
      const previous = editorContext;
      editorContext = undefined;
      activeEditorContext = undefined;
      await previous?.dispose();
      editorContext = await EditorContextController.create({
        extensionContext: context,
        workspaceRoot: workspaceCwd,
        pluginPath: context.asAbsolutePath("dsh/editor-context-plugin.mjs"),
        workspaceClientPath: context.asAbsolutePath("dsh/workspace-sync-client.js"),
        editorContextEnabled: settings.editorContextEnabled,
        workspaceSyncEnabled: settings.workspaceSyncEnabled,
        onDidChange: () => {
          pushEditorContext();
          pushWorkspaceSync();
        },
        log,
      });
      activeEditorContext = editorContext;
      pushEditorContext();
      pushWorkspaceSync();
    }).catch((error) => {
      log(`Could not initialize editor context: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage("DSH editor context could not be initialized. Check the DSH output log.");
    });
    return contextSync;
  };

  const startServer = async (): Promise<void> => {
    if (!canStartDsh(true)) return;
    await synchronizeEditorContext();
    await server.start();
  };
  const restartServer = async (): Promise<void> => {
    if (!canStartDsh(true)) return;
    await synchronizeEditorContext();
    await server.restart();
  };
  const withEditorContext = async (action: (controller: EditorContextController) => Promise<void>): Promise<void> => {
    let enabled = false;
    try { enabled = readSettings().editorContextEnabled; } catch {}
    if (!enabled) {
      const openSettings = "Open Settings";
      const answer = await vscode.window.showWarningMessage("Enable dsh.editorContext.enabled to use editor context.", openSettings);
      if (answer === openSettings) await vscode.commands.executeCommand("workbench.action.openSettings", "dsh.editorContext.enabled");
      return;
    }
    await synchronizeEditorContext();
    if (editorContext === undefined) {
      await vscode.window.showWarningMessage("Open a trusted local workspace folder to use DSH editor context.");
      return;
    }
    await action(editorContext);
  };

  const handleWebviewCommand = (message: { type: string; state?: string; workspaceRoot?: string; error?: string }): void => {
    switch (message.type) {
      case "start": void startServer(); break;
      case "stop": void server.stop(); break;
      case "restart": void restartServer(); break;
      case "manageContext": void vscode.commands.executeCommand("dsh.manageContextFiles"); break;
      case "workspaceSyncStatus":
        if (message.state === "error") log(`DSH workspace sync failed: ${message.error ?? "unknown client error"}`);
        break;
      case "openExternal": {
        const url = server.getSnapshot().url;
        if (url !== undefined) void vscode.env.asExternalUri(vscode.Uri.parse(url)).then((uri) => vscode.env.openExternal(uri));
        break;
      }
    }
  };

  const unsubscribe = server.onChange((snapshot) => {
    statusBar.update(snapshot);
    void vscode.commands.executeCommand("setContext", "dsh.running", snapshot.state === "running");
    void sidebar?.push(snapshot);
    pushEditorContext();
    pushWorkspaceSync();
  });
  sidebar = new SidebarProvider(handleWebviewCommand, async (url) => (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true));

  context.subscriptions.push(
    statusBar,
    { dispose: unsubscribe },
    { dispose: disposeLogs },
    vscode.window.registerWebviewViewProvider("dsh.sidebarView", sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("dsh.openPanel", async () => { await startServer(); await vscode.commands.executeCommand("dsh.sidebarView.focus"); }),
    vscode.commands.registerCommand("dsh.startServer", startServer),
    vscode.commands.registerCommand("dsh.stopServer", () => server.stop()),
    vscode.commands.registerCommand("dsh.restartServer", restartServer),
    vscode.commands.registerCommand("dsh.pinCurrentFile", () => withEditorContext((controller) => controller.pinCurrentFile())),
    vscode.commands.registerCommand("dsh.unpinCurrentFile", () => withEditorContext((controller) => controller.unpinCurrentFile())),
    vscode.commands.registerCommand("dsh.manageContextFiles", () => withEditorContext((controller) => controller.manageFiles())),
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      const url = server.getSnapshot().url;
      if (url === undefined) { await vscode.window.showWarningMessage("DSH is not running yet."); return; }
      const externalUrl = await vscode.env.asExternalUri(vscode.Uri.parse(url));
      await vscode.env.openExternal(externalUrl);
    }),
    vscode.commands.registerCommand("dsh.showLogs", showLogs),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (async () => {
        await synchronizeEditorContext();
        const snapshot = server.getSnapshot();
        if (snapshot.state === "running" && snapshot.owned && !canStartDsh(false)) await server.stop();
      })();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("dsh")) return;
      void (async () => {
        await synchronizeEditorContext();
        const state = server.getSnapshot().state;
        if ((state === "running" || state === "starting") && canStartDsh(false)) {
          log("DSH settings changed - restarting the managed process");
          await server.restart();
        }
      })();
    }),
  );

  try {
    await synchronizeEditorContext();
    if (readSettings().autoStart && canStartDsh(false)) await server.start();
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
export async function deactivate(): Promise<void> {
  log("DSH for VS Code deactivating");
  const server = activeServer;
  const editorContext = activeEditorContext;
  activeServer = undefined;
  activeEditorContext = undefined;
  if (server === undefined) { await editorContext?.dispose(); return; }
  let stopOnDeactivate = true;
  try { stopOnDeactivate = readSettings().stopOnDeactivate; } catch {}
  await server.dispose(stopOnDeactivate);
  await editorContext?.dispose();
}
