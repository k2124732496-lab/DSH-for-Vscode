import * as vscode from "vscode";
import type { DshServer } from "./server";
import type { ServerSnapshot } from "./types";

type WebviewOutMessage =
  | { type: "start" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "refresh" }
  | { type: "openExternal" };

interface WebviewInState {
  type: "state";
  state: ServerSnapshot["state"];
  url?: string;
  error?: string;
}

/**
 * Sidebar webview: an iframe embedding the DSH web GUI plus a small toolbar,
 * a start/error screen, and a postMessage bridge (extension ⇄ webview).
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private lastUrl: string | undefined;
  private lastSnapshot: ServerSnapshot = { state: "stopped", owned: false };

  constructor(
    private readonly server: DshServer,
    private readonly onCommand: (message: WebviewOutMessage) => void,
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
  }

  /** Extension → webview: push the latest server state. */
  push(snapshot: ServerSnapshot): void {
    this.lastSnapshot = snapshot;
    const message: WebviewInState = {
      type: "state",
      state: snapshot.state,
      url: snapshot.url,
      error: snapshot.error,
    };
    void this.view?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = (): string => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let out = "";
      for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
      return out;
    };
    const cspNonce = nonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${cspNonce}'`,
      "frame-src http://127.0.0.1:* http://localhost:*",
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
    const btnScreenStart = document.getElementById("btn-screen-start");
    let lastUrl = undefined;
    let currentState = "stopped";

    function post(message) { vscode.postMessage(message); }
    btnStart.addEventListener("click", () => post({ type: "start" }));
    btnRestart.addEventListener("click", () => post({ type: "restart" }));
    btnStop.addEventListener("click", () => post({ type: "stop" }));
    btnBrowser.addEventListener("click", () => post({ type: "openExternal" }));
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

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") applyState(message.state, message.url, message.error);
    });

    applyState("stopped", undefined, undefined);
  </script>
</body>
</html>`;
  }
}
