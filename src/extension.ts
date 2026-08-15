/** Activates DSH commands, sidebar state, settings refresh, and process teardown. */
import * as vscode from "vscode";
import { readSettings, workspaceCwd } from "./config";
import { discoverDsh, realDiscoveryEnv } from "./discovery";
import { disposeLogs, log, showLogs } from "./logger";
import { DshServer } from "./server";
import { SidebarProvider } from "./sidebar";
import { StatusBar } from "./status";

let activeServer: DshServer | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  log("DSH for VS Code activating");
  const server = new DshServer({
    resolveLocation: async () => discoverDsh(readSettings().executablePath, realDiscoveryEnv()),
    settings: readSettings,
    cwd: workspaceCwd,
    log,
  });
  activeServer = server;
  const statusBar = new StatusBar();
  let sidebar: SidebarProvider | undefined;

  const start = async (): Promise<void> => { if (canStartDsh(true)) await server.start(); };
  const handleWebviewCommand = (message: { type: string }): void => {
    switch (message.type) {
      case "start": void start(); break;
      case "stop": void server.stop(); break;
      case "restart": if (canStartDsh(true)) void server.restart(); break;
      case "refresh": if (canStartDsh(true)) void server.restart(); break;
      case "openExternal": {
        const url = server.getSnapshot().url;
        if (url !== undefined) void vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
    }
  };

  const unsubscribe = server.onChange((snapshot) => {
    statusBar.update(snapshot);
    void vscode.commands.executeCommand("setContext", "dsh.running", snapshot.state === "running");
    void sidebar?.push(snapshot);
  });
  sidebar = new SidebarProvider(handleWebviewCommand, async (url) => (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true));

  context.subscriptions.push(
    statusBar,
    { dispose: unsubscribe },
    { dispose: disposeLogs },
    vscode.window.registerWebviewViewProvider("dsh.sidebarView", sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("dsh.openPanel", async () => { await start(); await vscode.commands.executeCommand("dsh.sidebarView.focus"); }),
    vscode.commands.registerCommand("dsh.startServer", start),
    vscode.commands.registerCommand("dsh.stopServer", () => server.stop()),
    vscode.commands.registerCommand("dsh.restartServer", async () => { if (canStartDsh(true)) await server.restart(); }),
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      const url = server.getSnapshot().url;
      if (url === undefined) { await vscode.window.showWarningMessage("DSH is not running yet."); return; }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("dsh.showLogs", showLogs),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (server.getSnapshot().state === "running" && server.getSnapshot().owned && canStartDsh(false)) void server.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("dsh")) return;
      const state = server.getSnapshot().state;
      if ((state === "running" || state === "starting") && canStartDsh(false)) {
        log("DSH settings changed - restarting the managed process");
        void server.restart();
      }
    }),
  );

  try {
    if (readSettings().autoStart && canStartDsh(false)) void server.start();
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function deactivate(): Promise<void> {
  log("DSH for VS Code deactivating");
  const server = activeServer;
  activeServer = undefined;
  if (server === undefined) return;
  let stopOnDeactivate = true;
  try { stopOnDeactivate = readSettings().stopOnDeactivate; } catch {}
  await server.dispose(stopOnDeactivate);
}
