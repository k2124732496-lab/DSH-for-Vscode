import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { get as httpGet } from "node:http";
import { basename } from "node:path";
import type { DshLocation, ServerSnapshot, ServerState } from "./types";

/**
 * DSH web-server lifecycle: discovery, spawn, port parse from stdout, health
 * probe, attach-to-running (fixed port), tree-scoped termination, crash and
 * optional auto-restart. Spawning/killing/probing are injectable so the state
 * machine is unit-testable without real processes.
 */

/** stdout line the web app prints once listening: `dsh web: http://127.0.0.1:PORT`. */
const WEB_URL_PATTERN = /dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)/;

export interface ParsedWebUrl {
  url: string;
  port: number;
}

/** Extract the loopback base URL and port from a `dsh web` stdout line. */
export function parseWebUrl(line: string): ParsedWebUrl | undefined {
  const match = WEB_URL_PATTERN.exec(line);
  if (match === null || match[1] === undefined) return undefined;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return { url: `http://127.0.0.1:${String(port)}`, port };
}

/** GET the URL; resolves true when the server answers at all. */
export function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (!settled) {
        settled = true;
        resolve(alive);
      }
    };
    const request = httpGet(url, (response) => {
      response.resume();
      done(true);
    });
    request.on("error", () => done(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      done(false);
    });
  });
}

/**
 * The node binary to run `dsh/lib/bin.js` with. Inside the VS Code extension
 * host `process.execPath` is the Electron/Code binary, not node — spawning
 * that crashes. Only trust it when the basename actually says "node".
 */
export function defaultNodeBin(execPath: string = process.execPath): string {
  const base = basename(execPath).toLowerCase();
  if (base === "node" || base === "node.exe") return execPath;
  return "node"; // resolved from PATH by the OS spawn
}

/**
 * Environment names the VS Code extension host injects for itself that must
 * NOT leak into a spawned dsh: NODE_OPTIONS points at VS Code bootstrap files
 * (relative resolves fail in the child — ERR_MODULE_NOT_FOUND), and the
 * ELECTRON_ and VSCODE_ variable families only make sense inside the host.
 */
const HOST_ENV_PREFIXES = ["VSCODE_", "ELECTRON_", "CHROME_"];
const HOST_ENV_NAMES = new Set(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);

/** Copy an environment minus the extension-host-only entries. */
export function scrubExtensionHostEnv(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (HOST_ENV_NAMES.has(upper)) continue;
    if (HOST_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Windows: run through cmd.exe so .cmd shims work. */
  shell?: boolean;
}

/** Build the spawn spec for a discovered dsh location. */
export function buildSpawn(
  location: DshLocation,
  dshArgs: string[],
  platform: NodeJS.Platform,
  nodeBin: string,
): SpawnSpec {
  switch (location.kind) {
    case "node":
      return { command: nodeBin, args: [location.path, ...dshArgs] };
    case "cmd":
      if (platform === "win32") return { command: location.path, args: dshArgs, shell: true };
      return { command: location.path, args: dshArgs };
    case "direct":
      if (platform === "win32" && !location.path.toLowerCase().endsWith(".exe")) {
        // Git-Bash-style extensionless shim: needs a shell on Windows.
        return { command: location.path, args: dshArgs, shell: true };
      }
      return { command: location.path, args: dshArgs };
  }
}

/** Tree-scoped termination: taskkill on Windows, process-group TERM→KILL elsewhere. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      // stdio: "ignore" keeps this usable inside sandboxes that forbid piped stdio.
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => finish());
      killer.on("exit", () => finish());
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        finish();
      }, 3000);
    });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, 3000);
  });
}

export interface SpawnedChild {
  pid?: number;
  onStdout: (listener: (line: string) => void) => void;
  onStderr: (listener: (line: string) => void) => void;
  onExit: (listener: (code: number | null, signal: string | null) => void) => void;
  onError: (listener: (error: Error) => void) => void;
}

export type SpawnFn = (spec: SpawnSpec, cwd: string, env: Record<string, string | undefined>) => SpawnedChild;
export type KillFn = (pid: number) => Promise<void>;
export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;
export type LogFn = (message: string) => void;

export interface DshServerOptions {
  resolveLocation: () => Promise<DshLocation>;
  settings: () => {
    port: number;
    host: string;
    extraArgs: string[];
    extraEnv: Record<string, string>;
    dshHome: string;
    startupTimeoutSeconds: number;
    autoRestart: boolean;
  };
  cwd: () => string;
  log?: LogFn;
  spawnFn?: SpawnFn;
  killFn?: KillFn;
  probeFn?: ProbeFn;
  platform?: NodeJS.Platform;
  nodeBin?: string;
  /** Test seams; defaults keep production behavior. */
  probeIntervalMs?: number;
  restartDelayMs?: number;
  parentEnv?: () => Record<string, string | undefined>;
}

const MAX_AUTO_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 5000;
const DEFAULT_PROBE_INTERVAL_MS = 250;

function realSpawn(spec: SpawnSpec, cwd: string, env: Record<string, string | undefined>): SpawnedChild {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, {
    cwd,
    env: { ...env },
    windowsHide: true,
    shell: spec.shell ?? false,
  });
  return {
    pid: child.pid,
    onStdout: (listener) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) listener(line);
      });
    },
    onStderr: (listener) => {
      let buffer = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) listener(line);
      });
    },
    onExit: (listener) => {
      child.on("exit", (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      child.on("error", (error) => listener(error));
    },
  };
}

export class DshServer {
  private readonly options: DshServerOptions;
  private readonly listeners = new Set<(snapshot: ServerSnapshot) => void>();
  private snapshot: ServerSnapshot = { state: "stopped", owned: false };
  private child: SpawnedChild | undefined;
  /** Resolves when the current child has actually exited (never for attached servers). */
  private exitPromise: Promise<void> | undefined;
  private autoRestartAttempts = 0;
  private stopping = false;
  private stderrTail: string[] = [];

  constructor(options: DshServerOptions) {
    this.options = options;
  }

  onChange(listener: (snapshot: ServerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ServerSnapshot {
    return this.snapshot;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private setState(state: ServerState, patch?: Partial<ServerSnapshot>): void {
    this.snapshot = { ...this.snapshot, state, ...patch };
    this.emit();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Start the server, or attach to an already-running one on a fixed port. */
  async start(): Promise<ServerSnapshot> {
    if (this.snapshot.state === "running" || this.snapshot.state === "starting") {
      return this.snapshot;
    }
    this.stopping = false;
    this.autoRestartAttempts = 0;
    this.stderrTail = [];
    this.setState("starting");

    const settings = this.options.settings();

    // Fixed-port reuse: an independent dsh already answering on that port wins.
    if (settings.port !== 0) {
      const existingUrl = `http://${settings.host}:${String(settings.port)}`;
      const alive = await (this.options.probeFn ?? probeHealth)(existingUrl, 1000);
      if (alive) {
        this.log(`reusing existing dsh web at ${existingUrl}`);
        this.setState("running", {
          url: existingUrl,
          port: settings.port,
          owned: false,
          pid: undefined,
          error: undefined,
        });
        return this.snapshot;
      }
    }

    let location: DshLocation;
    try {
      location = await this.options.resolveLocation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      this.setState("crashed", { error: message, owned: false });
      return this.snapshot;
    }

    const dshArgs = [
      "--profile",
      "web",
      "--host",
      settings.host,
      "--port",
      String(settings.port),
      ...settings.extraArgs,
    ];
    const platform = this.options.platform ?? process.platform;
    const nodeBin = this.options.nodeBin ?? defaultNodeBin();
    const spec = buildSpawn(location, dshArgs, platform, nodeBin);
    // Child env: the extension host's environment minus host-only variables,
    // plus DSH_HOME and any user-configured extras.
    const parentEnv = (this.options.parentEnv ?? (() => process.env))();
    const env: Record<string, string | undefined> = {
      ...scrubExtensionHostEnv(parentEnv),
    };
    if (settings.dshHome !== "") env["DSH_HOME"] = settings.dshHome;
    for (const [key, value] of Object.entries(settings.extraEnv)) env[key] = value;

    let child: SpawnedChild;
    try {
      child = (this.options.spawnFn ?? realSpawn)(spec, this.options.cwd(), env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to spawn dsh: ${message}`);
      this.setState("crashed", { error: `Failed to start dsh: ${message}`, owned: false });
      return this.snapshot;
    }
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      child.onExit(() => resolve());
    });
    const pid = child.pid;
    this.log(`spawned dsh (pid ${pid ?? "?"}): ${spec.command} ${spec.args.join(" ")}`);

    child.onStdout((line) => {
      this.log(`[out] ${line}`);
      void this.handleStdoutLine(line);
    });
    child.onStderr((line) => {
      this.log(`[err] ${line}`);
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    child.onExit((code, signal) => this.handleExit(code, signal));
    child.onError((error) => {
      this.log(`spawn error: ${error.message}`);
      if (this.snapshot.state === "starting") {
        this.failStartup(`Failed to start dsh: ${error.message}`);
      }
    });

    // Startup deadline; resolved by handleStdoutLine's health probe.
    const timeoutMs = Math.max(0.05, settings.startupTimeoutSeconds) * 1000;
    const probeInterval = this.options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (this.snapshot.state !== "starting") {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          this.failStartup(`dsh did not become reachable within ${String(settings.startupTimeoutSeconds)}s`);
          resolve();
          return;
        }
        setTimeout(poll, probeInterval);
      };
      poll();
    });

    return this.snapshot;
  }

  private async handleStdoutLine(line: string): Promise<void> {
    if (this.snapshot.state !== "starting") return;
    const parsed = parseWebUrl(line);
    if (parsed === undefined) return;
    const host = this.options.settings().host;
    const url = `http://${host}:${String(parsed.port)}`;
    this.log(`dsh web printing on ${url} — probing readiness…`);
    const probe = this.options.probeFn ?? probeHealth;
    const deadline = Date.now() + Math.max(0.05, this.options.settings().startupTimeoutSeconds) * 1000;
    const interval = this.options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    while (this.snapshot.state === "starting" && Date.now() < deadline) {
      if (await probe(url, 1000)) {
        this.setState("running", {
          url,
          port: parsed.port,
          owned: true,
          pid: this.child?.pid,
          error: undefined,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    if (this.snapshot.state === "starting") {
      this.failStartup(`dsh printed ${url} but never answered health probes`);
    }
  }

  private failStartup(reason: string): void {
    this.log(`startup failed: ${reason}`);
    void this.stopChild();
    this.setState("crashed", { error: reason, owned: false });
  }

  /** Last stderr lines, for actionable error messages. Node errors are
   * top-heavy (message with the module path first, stack at the bottom),
   * so keep both the head and the tail of the captured output. */
  private stderrSummary(): string {
    const tail = this.stderrTail.filter((line) => line.trim() !== "").join("\n").trim();
    if (tail === "") return "";
    if (tail.length <= 1600) return tail;
    return `${tail.slice(0, 700)}\n… (truncated — see the DSH output channel for the full log) …\n${tail.slice(-700)}`;
  }

  /** Targeted hint for the known dsh-skins "bundled skin junction" failure. */
  private skinHint(): string {
    const text = this.stderrTail.join("\n");
    if (!text.includes("ERR_MODULE_NOT_FOUND")) return "";
    const match = /dsh-client-ui-skin-([a-z0-9-]+)/.exec(text);
    if (match === null || match[1] === undefined) return "";
    return [
      "",
      `Hint: the skin "${match[1]}" is enabled in the skin center but its npm package is not installed in the web profile (the bundled asset dir has no package entry). Fix:`,
      `  rmdir "<dsn-home>\\profiles\\web\\node_modules\\@linxin666\\dsh-client-ui-skin-${match[1]}"`,
      `  dsh plugin --profile web add @linxin666/dsh-client-ui-skin-${match[1]}`,
    ].join("\n");
  }

  private handleExit(code: number | null, signal: string | null): void {
    const how = signal !== null ? `signal ${signal}` : `code ${code ?? "?"}`;
    this.log(`dsh exited (${how})`);
    this.child = undefined;
    if (this.snapshot.state === "crashed" || this.snapshot.state === "stopped") {
      // Spawn-failure or already-reported exit: nothing more to say.
      return;
    }
    if (this.stopping || this.snapshot.state === "stopping") {
      this.stopping = false;
      this.setState("stopped", { url: undefined, port: undefined, pid: undefined, owned: false });
      return;
    }
    if (this.snapshot.state === "starting") {
      const tail = this.stderrSummary();
      const hint = this.skinHint();
      this.setState("crashed", {
        error: `dsh exited (${how}) before the web server came up${tail !== "" ? `:\n${tail}` : ""}${hint}`,
        owned: false,
      });
      return;
    }
    // Unexpected exit while running.
    const settings = this.options.settings();
    if (settings.autoRestart && this.autoRestartAttempts < MAX_AUTO_RESTARTS) {
      this.autoRestartAttempts += 1;
      this.log(`unexpected exit (${how}); auto-restart attempt ${String(this.autoRestartAttempts)}/${String(MAX_AUTO_RESTARTS)}`);
      // Leave "running" first so the scheduled start() actually re-spawns.
      this.setState("stopped", { url: undefined, port: undefined, pid: undefined, owned: false });
      setTimeout(() => {
        void this.start();
      }, this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS);
      return;
    }
    this.setState("crashed", { error: `dsh exited unexpectedly (${how})`, owned: false, url: undefined, port: undefined });
  }

  /** Stop the server we spawned (attached servers are just detached). */
  async stop(): Promise<void> {
    if (this.snapshot.state === "stopped" || this.snapshot.state === "crashed") {
      if (!this.snapshot.owned) {
        this.setState("stopped", { url: undefined, port: undefined, pid: undefined });
      }
      return;
    }
    if (this.snapshot.state === "stopping") return;
    if (!this.snapshot.owned) {
      this.setState("stopped", { url: undefined, port: undefined, pid: undefined });
      return;
    }
    this.stopping = true;
    this.setState("stopping");
    await this.stopChild();
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    this.child = undefined;
    this.exitPromise = undefined;
    if (child === undefined || child.pid === undefined) return;
    const kill = this.options.killFn ?? ((pid: number) => killTree(pid, this.options.platform ?? process.platform));
    await kill(child.pid);
    // Wait for the real exit so restart() never races the old process's exit event.
    if (exitPromise !== undefined) {
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }

  async restart(): Promise<ServerSnapshot> {
    await this.stop();
    return this.start();
  }
}
