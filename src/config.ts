/**
 * Validates VS Code settings and resolves the local workspace directory used by DSH.
 */
import * as vscode from "vscode";

export type LoopbackHost = "127.0.0.1" | "localhost";

/** Immutable, validated settings consumed by the DSH lifecycle module. */
export interface DshSettings {
  executablePath: string;
  autoStart: boolean;
  port: number;
  host: LoopbackHost;
  extraArgs: string[];
  extraEnv: Record<string, string>;
  dshHome: string;
  startupTimeoutSeconds: number;
  stopOnDeactivate: boolean;
  autoRestart: boolean;
  workspaceSyncEnabled: boolean;
  editorContextEnabled: boolean;
}

type RawSettings = { [key in keyof DshSettings]?: unknown };

const DEFAULTS: DshSettings = {
  executablePath: "",
  autoStart: false,
  port: 0,
  host: "127.0.0.1",
  extraArgs: [],
  extraEnv: {},
  dshHome: "",
  startupTimeoutSeconds: 30,
  stopOnDeactivate: true,
  autoRestart: false,
  workspaceSyncEnabled: true,
  editorContextEnabled: false,
};

const RESERVED_ARGUMENT = /^(--(?:profile|patch|host|port)(?:=|$)|--)$/;
const SHELL_META_CHARACTER = /[\r\n&|<>^()%!"']/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`dsh.${name} must be a string.`);
  return value;
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`dsh.${name} must be a boolean.`);
  return value;
}

function readNumber(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh.${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`);
  }
  return value;
}

function readExtraArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((argument) => typeof argument === "string")) {
    throw new Error("dsh.extraArgs must be an array of strings.");
  }
  for (const argument of value) {
    if (argument === "" || RESERVED_ARGUMENT.test(argument)) {
      throw new Error("dsh.extraArgs cannot override --profile, --patch, --host, or --port.");
    }
    if (SHELL_META_CHARACTER.test(argument)) {
      throw new Error("dsh.extraArgs cannot contain shell control characters.");
    }
  }
  return [...value];
}

function readExtraEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dsh.extraEnv must be an object of string values.");
  }

  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`dsh.extraEnv contains an invalid name: ${name}.`);
    if (typeof entry !== "string") throw new Error(`dsh.extraEnv.${name} must be a string.`);
    environment[name] = entry;
  }
  return environment;
}

/** Validate values from VS Code or tests before a process launch is attempted. */
export function validateSettings(raw: RawSettings): DshSettings {
  const host = readString(raw.host, DEFAULTS.host, "host");
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("dsh.host must be 127.0.0.1 or localhost; non-loopback hosts are not supported.");
  }

  return {
    executablePath: readString(raw.executablePath, DEFAULTS.executablePath, "executablePath").trim(),
    autoStart: readBoolean(raw.autoStart, DEFAULTS.autoStart, "autoStart"),
    port: readNumber(raw.port, DEFAULTS.port, "port", 0, 65_535),
    host,
    extraArgs: readExtraArgs(raw.extraArgs),
    extraEnv: readExtraEnv(raw.extraEnv),
    dshHome: readString(raw.dshHome, DEFAULTS.dshHome, "dshHome").trim(),
    startupTimeoutSeconds: readNumber(
      raw.startupTimeoutSeconds,
      DEFAULTS.startupTimeoutSeconds,
      "startupTimeoutSeconds",
      5,
      300,
    ),
    stopOnDeactivate: readBoolean(raw.stopOnDeactivate, DEFAULTS.stopOnDeactivate, "stopOnDeactivate"),
    autoRestart: readBoolean(raw.autoRestart, DEFAULTS.autoRestart, "autoRestart"),
    workspaceSyncEnabled: readBoolean(raw.workspaceSyncEnabled, DEFAULTS.workspaceSyncEnabled, "workspaceSync.enabled"),
    editorContextEnabled: readBoolean(raw.editorContextEnabled, DEFAULTS.editorContextEnabled, "editorContext.enabled"),
  };
}

/** Read and validate the current DSH configuration. */
export function readSettings(): DshSettings {
  const configuration = vscode.workspace.getConfiguration("dsh");
  const raw: RawSettings = {};
  for (const key of Object.keys(DEFAULTS) as (keyof DshSettings)[]) {
    const configurationKey = key === "editorContextEnabled"
      ? "editorContext.enabled"
      : key === "workspaceSyncEnabled"
        ? "workspaceSync.enabled"
        : key;
    raw[key] = configuration.get<unknown>(configurationKey);
  }
  return validateSettings(raw);
}

/** The DSH session directory, or undefined when there is no local workspace folder. */
export function workspaceCwd(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri?.scheme === "file" ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  return selectWorkspaceRoot(folders, activeUri, activeFolder);
}

interface WorkspaceFolderLike {
  uri: { scheme: string; fsPath: string };
}

interface UriLike {
  scheme: string;
}

/** Selects the active file's local root, falling back to the first local root. */
export function selectWorkspaceRoot(
  folders: readonly WorkspaceFolderLike[] | undefined,
  activeUri: UriLike | undefined,
  activeFolder: WorkspaceFolderLike | undefined,
): string | undefined {
  if (activeUri?.scheme === "file" && activeFolder?.uri.scheme === "file") return activeFolder.uri.fsPath;
  return folders?.find((folder) => folder.uri.scheme === "file")?.uri.fsPath;
}
