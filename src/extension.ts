import * as vscode from "vscode";
import { readSettings, workspaceCwd } from "./config";
import { discoverDsh, realDiscoveryEnv } from "./discovery";
import { log, showLogs } from "./logger";
import { DshServer } from "./server";
import { SidebarProvider } from "./sidebar";
import { StatusBar } from "./status";

export function activate(context: vscode.ExtensionContext): void {
  log("DSH for VS Code activating");

  const server = new DshServer({
    resolveLocation: async () => discoverDsh(readSettings().executablePath, realDiscoveryEnv()),
    settings: () => readSettings(),
    cwd: workspaceCwd,
    log,
  });

  const statusBar = new StatusBar();
  let sidebar: SidebarProvider | undefined;

  const pushContext = (running: boolean): void => {
    void vscode.commands.executeCommand("setContext", "dsh.running", running);
  };

  const handleWebviewCommand = (message: { type: string }): void => {
    switch (message.type) {
      case "start":
        void server.start();
        break;
      case "stop":
        void server.stop();
        break;
      case "restart":
        void server.restart();
        break;
      case "refresh":
        void server.restart();
        break;
      case "openExternal": {
        const url = server.getSnapshot().url;
        if (url !== undefined) void vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
    }
  };

  server.onChange((snapshot) => {
    statusBar.update(snapshot);
    pushContext(snapshot.state === "running");
    sidebar?.push(snapshot);
  });

  sidebar = new SidebarProvider(server, handleWebviewCommand);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("dsh.sidebarView", sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.openPanel", async () => {
      const snapshot = server.getSnapshot();
      if (snapshot.state === "stopped" || snapshot.state === "crashed") {
        await server.start();
      }
      await vscode.commands.executeCommand("dsh.sidebarView.focus");
    }),
    vscode.commands.registerCommand("dsh.startServer", async () => {
      await server.start();
    }),
    vscode.commands.registerCommand("dsh.stopServer", async () => {
      await server.stop();
    }),
    vscode.commands.registerCommand("dsh.restartServer", async () => {
      await server.restart();
    }),
    vscode.commands.registerCommand("dsh.openInBrowser", async () => {
      const url = server.getSnapshot().url;
      if (url === undefined) {
        void vscode.window.showWarningMessage("DSH is not running yet.");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("dsh.showLogs", () => {
      showLogs();
    }),
  );

  // Keep the session directory in sync with the first workspace folder.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const snapshot = server.getSnapshot();
      if (snapshot.state === "running" && snapshot.owned) {
        log("workspace folders changed — restarting DSH with the new workspace directory");
        void server.restart();
      }
    }),
  );

  // Stop the process we spawned when the extension host goes down.
  context.subscriptions.push({
    dispose: () => {
      if (readSettings().stopOnDeactivate && server.getSnapshot().owned) {
        void server.stop();
      }
    },
  });

  const settings = readSettings();
  if (settings.autoStart) {
    log(`auto-start enabled (cwd: ${workspaceCwd()})`);
    void server.start();
  } else {
    log("auto-start disabled by dsh.autoStart — start manually from the DSH panel");
  }
}

export function deactivate(): void {
  log("DSH for VS Code deactivating");
}
