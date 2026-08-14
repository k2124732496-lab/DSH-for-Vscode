import * as vscode from "vscode";
import type { ServerSnapshot } from "./types";

/** Status-bar item reflecting the managed DSH server. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "dsh.openPanel";
    this.item.show();
  }

  update(snapshot: ServerSnapshot): void {
    switch (snapshot.state) {
      case "running":
        this.item.text = `$(comment-discussion) DSH:${snapshot.port !== undefined ? String(snapshot.port) : "?"}`;
        this.item.tooltip = snapshot.owned
          ? `DSH running at ${snapshot.url ?? ""} (managed by this extension)`
          : `DSH running at ${snapshot.url ?? ""} (reused existing instance)`;
        this.item.backgroundColor = undefined;
        break;
      case "starting":
        this.item.text = "$(sync~spin) DSH: starting…";
        this.item.tooltip = "DSH web server is starting";
        this.item.backgroundColor = undefined;
        break;
      case "stopping":
        this.item.text = "$(sync~spin) DSH: stopping…";
        this.item.tooltip = "Stopping DSH web server";
        this.item.backgroundColor = undefined;
        break;
      case "crashed":
        this.item.text = "$(error) DSH";
        this.item.tooltip = snapshot.error ?? "DSH stopped unexpectedly";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      case "stopped":
      default:
        this.item.text = "$(circle-slash) DSH";
        this.item.tooltip = "DSH is stopped — click to start and open";
        this.item.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
