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
}

type RawSettings = { [key in keyof DshSettings]?: unknown };

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

const RESERVED_ARGUMENT = /^(--(?:profile|host|port)(?:=|$)|--)$/;
const SHELL_META_CHARACTER = /[\r\n&|<>^()%!"']/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_ENVIRONMENT_NAME = new Set(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);
const HOST_ENVIRONMENT_PREFIX = ["VSCODE_", "ELECTRON_", "CHROME_"];

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
      throw new Error("dsh.extraArgs cannot override --profile, --host, or --port.");
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
    const upperName = name.toUpperCase();
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`dsh.extraEnv contains an invalid name: ${name}.`);
    if (HOST_ENVIRONMENT_NAME.has(upperName) || HOST_ENVIRONMENT_PREFIX.some((prefix) => upperName.startsWith(prefix))) {
      throw new Error(`dsh.extraEnv cannot override the VS Code host variable ${name}.`);
    }
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
  };
}

/** Read and validate the current DSH configuration. */
export function readSettings(): DshSettings {
  const configuration = vscode.workspace.getConfiguration("dsh");
  const raw: RawSettings = {};
  for (const key of Object.keys(DEFAULTS) as (keyof DshSettings)[]) {
    raw[key] = configuration.get<unknown>(key);
  }
  return validateSettings(raw);
}

/** The DSH session directory, or undefined when there is no local workspace folder. */
export function workspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
}
