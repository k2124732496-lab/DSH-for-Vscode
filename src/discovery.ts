import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DshLocation } from "./types";

/**
 * dsh executable discovery. Pure logic over an injectable environment so the
 * decision tree is unit-testable without VS Code or a real dsh install.
 */

/** The parts of the runtime environment discovery reads. */
export interface DiscoveryEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  pathVar: string;
  /** Run a command and resolve its trimmed stdout ("" on failure). */
  runCommand: (command: string, args: string[]) => Promise<string>;
  /** True when the path exists and is a regular file. */
  isFile: (path: string) => boolean;
}

/** Real process-backed environment (used by the extension). */
export function realDiscoveryEnv(): DiscoveryEnv {
  return {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    pathVar: process.env.PATH ?? "",
    runCommand: (command, args) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: 8000, windowsHide: true, encoding: "utf8" },
          (error, stdout) => {
            if (error) {
              resolve("");
              return;
            }
            resolve(stdout.trim());
          },
        );
      }),
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Classify a configured executable path by its extension. */
export function classifyConfigured(path: string): DshLocation | undefined {
  const lower = path.toLowerCase();
  if (/\.(c|m)?js$/.test(lower)) return { kind: "node", path };
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return { kind: "cmd", path };
  if (lower.endsWith(".ps1")) return undefined; // PowerShell shim: unsupported, let the caller explain
  if (lower.endsWith(".exe")) return { kind: "direct", path };
  return { kind: "direct", path };
}

/** The well-known global-npm bin.js location for the platform. */
export function globalNpmBinCandidates(
  env: DiscoveryEnv,
): string[] {
  const candidates: string[] = [];
  if (env.platform === "win32") {
    const appData = env.env["APPDATA"];
    if (appData) {
      candidates.push(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
  } else {
    const home = env.env["HOME"] ?? homedir();
    candidates.push(
      join(home, ".local", "share", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
      "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
  }
  return candidates;
}

/** First PATH entry named `dsh` (windows: prefer the .cmd shim). */
export function pickFromWhereOutput(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const prefer = (suffix: string) => lines.find((line) => line.toLowerCase().endsWith(suffix));
  return prefer(".cmd") ?? prefer(".bat") ?? prefer(".exe") ?? lines[0];
}

/**
 * Resolve a spawnable dsh location.
 * Priority: configured path → global-npm bin.js → `dsh` on PATH.
 * Throws a user-facing Error when nothing is found.
 */
export async function discoverDsh(
  configuredPath: string,
  env: DiscoveryEnv,
): Promise<DshLocation> {
  if (configuredPath !== "") {
    const classified = classifyConfigured(configuredPath);
    if (classified === undefined) {
      throw new Error(
        `dsh.executablePath points to ${configuredPath}: PowerShell shims (.ps1) are not supported. Use dsh.cmd or the bin.js under @deepseek-ai/dsh/lib.`,
      );
    }
    if (!env.isFile(classified.path)) {
      throw new Error(
        `dsh.executablePath points to ${classified.path}, which does not exist. Install dsh or fix the setting.`,
      );
    }
    return classified;
  }

  for (const candidate of globalNpmBinCandidates(env)) {
    if (env.isFile(candidate)) return { kind: "node", path: candidate };
  }

  const whereOutput =
    env.platform === "win32"
      ? await env.runCommand("where", ["dsh"])
      : await env.runCommand("which", ["dsh"]);
  const picked = pickFromWhereOutput(whereOutput);
  if (picked !== undefined) {
    const lower = picked.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return { kind: "cmd", path: picked };
    if (lower.endsWith(".exe")) return { kind: "direct", path: picked };
    if (lower.endsWith(".ps1")) {
      throw new Error(
        `Only ${picked} was found for dsh, but PowerShell shims are not supported. Install dsh globally with: npm install -g @deepseek-ai/dsh`,
      );
    }
    // Extensionless shell shim (POSIX, or Git Bash's `dsh` on Windows).
    return { kind: "direct", path: picked };
  }

  throw new Error(
    "Could not find the dsh executable. Install it with: npm install -g @deepseek-ai/dsh — or set dsh.executablePath to @deepseek-ai/dsh/lib/bin.js.",
  );
}

export type { DshLocation };
