import * as vscode from "vscode";
import type { ServerSnapshot } from "./types";
import type { EditorContextSummary } from "./editor-context-vscode";
import { randomBytes } from "node:crypto";

type WebviewOutMessage =
  | { type: "start" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "manageContext" }
  | { type: "openExternal" }
  | { type: "workspaceSyncStatus"; state: string; workspaceRoot?: string; error?: string };

export interface WorkspaceSyncSummary {
  enabled: boolean;
  available: boolean;
  workspaceRoot?: string;
  reason?: string;
}

interface WebviewInState {
  type: "state";
  state: ServerSnapshot["state"];
  url?: string;
  error?: string;
}

interface WebviewInContext extends EditorContextSummary {
  type: "editorContext";
}

/**
 * Sidebar webview: an iframe embedding the DSH web GUI plus a small toolbar,
 * a start/error screen, and a postMessage bridge (extension ⇄ webview).
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pushSequence = 0;
  private lastSnapshot: ServerSnapshot = { state: "stopped", owned: false };
  private lastContext: EditorContextSummary = {
    enabled: false, available: false, count: 0, pinnedCount: 0, temporaryExternalCount: 0,
  };
  private lastWorkspaceSync: WorkspaceSyncSummary = { enabled: true, available: false };

  constructor(
    private readonly onCommand: (message: WebviewOutMessage) => void,
    private readonly toWebviewUrl: (url: string) => Promise<string>,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // Loopback-origin iframes only; the extension never loads other origins.
    };
    webviewView.webview.html = this.render(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewOutMessage) => {
      this.onCommand(message);
    });
    this.push(this.lastSnapshot);
    void this.pushContext(this.lastContext);
    void this.pushWorkspaceSync(this.lastWorkspaceSync);
  }

  /** Extension → webview: push the latest server state. */
  async push(snapshot: ServerSnapshot): Promise<void> {
    this.lastSnapshot = snapshot;
    const sequence = ++this.pushSequence;
    let url = snapshot.url;
    if (url !== undefined && this.view !== undefined) {
      try { url = await this.toWebviewUrl(url); } catch { url = undefined; }
    }
    if (sequence !== this.pushSequence) return;
    const message: WebviewInState = { type: "state", state: snapshot.state, url, error: snapshot.error };
    await this.view?.webview.postMessage(message);
  }

  async pushContext(summary: EditorContextSummary): Promise<void> {
    this.lastContext = summary;
    const message: WebviewInContext = { type: "editorContext", ...summary };
    await this.view?.webview.postMessage(message);
  }

  async pushWorkspaceSync(summary: WorkspaceSyncSummary): Promise<void> {
    this.lastWorkspaceSync = summary;
    await this.view?.webview.postMessage({ type: "workspaceSync", ...summary });
  }

  private render(webview: vscode.Webview): string {
    const cspNonce = randomBytes(16).toString("base64url");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${cspNonce}'`,
      "frame-src http://127.0.0.1:* http://localhost:* https:",
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --toolbar-h: 34px;
    }
    html, body {
      margin: 0; padding: 0; height: 100%; overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #toolbar {
      display: flex; align-items: center; gap: 4px;
      height: var(--toolbar-h); padding: 0 6px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBar-border, transparent);
    }
    #toolbar button {
      display: inline-flex; align-items: center; gap: 4px;
      background: transparent; border: none; cursor: pointer;
      color: var(--vscode-foreground); border-radius: 3px;
      padding: 2px 6px; font-size: 12px;
    }
    #toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #toolbar button:disabled { opacity: 0.4; cursor: default; }
    #workspace-label { font-size: 11px; opacity: 0.9; white-space: nowrap; max-width: 34%; overflow: hidden; text-overflow: ellipsis; }
    #state-label { margin-left: auto; font-size: 11px; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
    #state-dot.running { background: var(--vscode-testing-iconPassed, #89d185); }
    #state-dot.starting, #state-dot.stopping { background: var(--vscode-editorWarning-foreground, #cca700); }
    #state-dot.crashed { background: var(--vscode-testing-iconFailed, #f14c4c); }
    #stage { position: relative; height: calc(100% - var(--toolbar-h)); }
    #frame { position: absolute; inset: 0; width: 100%; height: 100%; border: none; display: none; background: #fff; }
    #frame.visible { display: block; }
    #screen {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center;
    }
    #screen.hidden { display: none; }
    #screen .big { font-size: 13px; }
    #screen .hint { font-size: 12px; opacity: 0.8; max-width: 90%; overflow-wrap: anywhere; white-space: pre-wrap; }
    #screen button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer;
    }
    #screen button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-start" title="Start DSH">▶</button>
    <button id="btn-restart" title="Restart DSH">↻</button>
    <button id="btn-stop" title="Stop DSH">■</button>
    <button id="btn-browser" title="Open in browser">↗</button>
    <button id="btn-context" title="Manage DSH editor context">Ctx off</button>
    <span id="workspace-label" title="Workspace sync status">WS: --</span>
    <span id="state-dot"></span>
    <span id="state-label">stopped</span>
  </div>
  <div id="stage">
    <iframe id="frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" title="DSH"></iframe>
    <div id="screen">
      <div class="big">DSH is not running</div>
      <div class="hint" id="screen-hint">Click Start to launch the DeepSeek Harness web GUI in this panel.</div>
      <button id="btn-screen-start">Start DSH</button>
    </div>
  </div>
  <script nonce="${cspNonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("frame");
    const screen = document.getElementById("screen");
    const dot = document.getElementById("state-dot");
    const label = document.getElementById("state-label");
    const hint = document.getElementById("screen-hint");
    const btnStart = document.getElementById("btn-start");
    const btnRestart = document.getElementById("btn-restart");
    const btnStop = document.getElementById("btn-stop");
    const btnBrowser = document.getElementById("btn-browser");
    const btnContext = document.getElementById("btn-context");
    const workspaceLabel = document.getElementById("workspace-label");
    const btnScreenStart = document.getElementById("btn-screen-start");
    let lastUrl = undefined;
    let currentState = "stopped";

    function post(message) { vscode.postMessage(message); }
    btnStart.addEventListener("click", () => post({ type: "start" }));
    btnRestart.addEventListener("click", () => post({ type: "restart" }));
    btnStop.addEventListener("click", () => post({ type: "stop" }));
    btnBrowser.addEventListener("click", () => post({ type: "openExternal" }));
    btnContext.addEventListener("click", () => post({ type: "manageContext" }));
    btnScreenStart.addEventListener("click", () => post({ type: "start" }));

    function applyState(state, url, error) {
      currentState = state;
      dot.className = state;
      label.textContent = state + (url ? " · " + url.replace(/^https?:\\/\\//, "") : "");
      const running = state === "running" && !!url;
      if (running) {
        if (url !== lastUrl) {
          frame.src = url;
          lastUrl = url;
        }
        frame.classList.add("visible");
        screen.classList.add("hidden");
        if (error) hint.textContent = error;
      } else {
        frame.classList.remove("visible");
        screen.classList.remove("hidden");
        hint.textContent =
          state === "crashed"
            ? (error || "DSH exited unexpectedly. Check the DSH output log.") + "\\n\\nRestart it to try again."
            : state === "starting"
              ? "Starting the DSH web server…"
              : "Click Start to launch the DeepSeek Harness web GUI in this panel.";
      }
      btnStart.disabled = running || state === "starting";
      btnRestart.disabled = !running;
      btnStop.disabled = !running;
      btnBrowser.disabled = !running;
    }

    function applyEditorContext(message) {
      if (!message.enabled) {
        btnContext.textContent = "Ctx off";
        btnContext.title = "Editor context is disabled; click to open settings";
        return;
      }
      btnContext.textContent = "Ctx " + String(message.count) + (message.available ? "" : " N/A");
      btnContext.title = message.available
        ? "Manage context files (" + String(message.pinnedCount) + " pinned, " + String(message.temporaryExternalCount) + " external)"
        : (message.reason || "Editor context is unavailable for this DSH instance");
    }

    function workspaceName(workspaceRoot) {
      if (!workspaceRoot) return "--";
      const parts = workspaceRoot.split(/[\\\\/]/).filter(Boolean);
      return parts[parts.length - 1] || workspaceRoot;
    }

    function applyWorkspaceSync(message) {
      if (!message.enabled) {
        workspaceLabel.textContent = "WS off";
        workspaceLabel.title = "DSH workspace sync is disabled";
        return;
      }
      if (!message.available) {
        workspaceLabel.textContent = "WS N/A";
        workspaceLabel.title = message.reason || "DSH workspace sync is unavailable";
        return;
      }
      workspaceLabel.textContent = "WS: " + workspaceName(message.workspaceRoot);
      workspaceLabel.title = "Waiting for DSH to confirm workspace sync: " + (message.workspaceRoot || "unknown");
    }

    function applyWorkspaceBridge(message) {
      const name = workspaceName(message.workspaceRoot);
      workspaceLabel.textContent = message.state === "synced"
        ? "WS: " + name
        : message.state === "syncing"
          ? "WS: syncing"
          : "WS N/A";
      workspaceLabel.title = message.state === "synced"
        ? "DSH workspace synced: " + message.workspaceRoot
        : message.state === "syncing"
          ? "Synchronizing DSH workspace: " + (message.workspaceRoot || "unknown")
          : (message.error || "DSH workspace sync is unavailable");
      post({ type: "workspaceSyncStatus", state: message.state, workspaceRoot: message.workspaceRoot, error: message.error });
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source === frame.contentWindow) {
        let expectedOrigin;
        try { expectedOrigin = lastUrl ? new URL(lastUrl).origin : undefined; } catch {}
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        if (message && message.source === "dsh-vscode-workspace-sync" && message.version === 1) {
          applyWorkspaceBridge(message);
        }
        return;
      }
      if (message && message.type === "state") applyState(message.state, message.url, message.error);
      if (message && message.type === "editorContext") applyEditorContext(message);
      if (message && message.type === "workspaceSync") applyWorkspaceSync(message);
    });

    applyState("stopped", undefined, undefined);
    applyEditorContext({ enabled: false, available: false, count: 0, pinnedCount: 0, temporaryExternalCount: 0 });
    applyWorkspaceSync({ enabled: true, available: false });
  </script>
</body>
</html>`;
  }
}
