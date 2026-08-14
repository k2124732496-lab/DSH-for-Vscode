import { homedir } from "node:os";
import * as vscode from "vscode";

/** Extension settings, read through vscode.workspace.getConfiguration("dsh"). */
export interface DshSettings {
  executablePath: string;
  autoStart: boolean;
  port: number;
  host: string;
  extraArgs: string[];
  extraEnv: Record<string, string>;
  dshHome: string;
  startupTimeoutSeconds: number;
  stopOnDeactivate: boolean;
  autoRestart: boolean;
}

const DEFAULTS: DshSettings = {
  executablePath: "",
  autoStart: true,
  port: 0,
  host: "127.0.0.1",
  extraArgs: [],
  extraEnv: {},
  dshHome: "",
  startupTimeoutSeconds: 30,
  stopOnDeactivate: true,
  autoRestart: false,
};

export function readSettings(): DshSettings {
  const cfg = vscode.workspace.getConfiguration("dsh");
  const settings: DshSettings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof DshSettings)[]) {
    const value = cfg.get<unknown>(key);
    if (value === undefined || value === null) continue;
    if (key === "extraEnv") {
      if (typeof value === "object" && !Array.isArray(value)) {
        settings.extraEnv = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
      continue;
    }
    if (typeof DEFAULTS[key] === typeof value) {
      (settings as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return settings;
}

/** The DSH session working directory: first workspace folder, else home. */
export function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : homedir();
}
