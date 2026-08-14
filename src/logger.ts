import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getChannel(): vscode.OutputChannel {
  if (channel === undefined) {
    channel = vscode.window.createOutputChannel("DSH");
  }
  return channel;
}

export function log(message: string): void {
  const now = new Date().toISOString();
  getChannel().appendLine(`[${now}] ${message}`);
}

export function showLogs(): void {
  getChannel().show(true);
}
