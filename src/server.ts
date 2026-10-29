/** Owns safe DSH web-process launch, readiness, restart, and teardown. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { get as httpGet } from "node:http";
import { basename } from "node:path";
import type { DshLocation, ServerSnapshot, ServerState } from "./types";

const STARTUP_LINE = /dsh web:\s+(https?:\/\/[^\s]+)/i;
const MAX_AUTO_RESTARTS = 3;
const PROBE_INTERVAL_MS = 250;
const RESTART_DELAY_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const MAX_STREAM_BUFFER = 64 * 1024;

export interface ParsedWebUrl { url: string; port: number }
export interface SpawnSpec { command: string; args: string[]; shell?: boolean }
export interface SpawnedChild {
  pid?: number;
  onStdout(listener: (line: string) => void): void;
  onStderr(listener: (line: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}
export type SpawnFn = (spec: SpawnSpec, cwd: string, env: Record<string, string | undefined>) => SpawnedChild;
export type KillFn = (pid: number) => Promise<void>;
export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;
export type FixedPortProbeResult =
  | { kind: "dsh" }
  | { kind: "free" }
  | { kind: "occupied"; reason: string };
export type FixedPortProbeFn = (url: string, timeoutMs: number) => Promise<FixedPortProbeResult>;
export type LogFn = (message: string) => void;

/** Parses the loopback URL printed by the DSH web profile. */
export function parseWebUrl(line: string): ParsedWebUrl | undefined {
  const value = STARTUP_LINE.exec(line)?.[1];
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    if (parsed.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) return undefined;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    // 新版启动地址包含鉴权令牌，加载 iframe 时必须保留查询参数。
    const suffix = parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
      ? "" : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return { url: `http://${host}:${String(port)}${suffix}`, port };
  } catch { return undefined; }
}

export function loopbackUrl(host: string, port: number): string {
  if ((host !== "127.0.0.1" && host !== "localhost") || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DSH requires a loopback host and a port between 1 and 65535.");
  }
  return `http://${host}:${String(port)}`;
}

/** Resolves when an HTTP process is reachable; used only after this module launched it. */
export function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const request = httpGet(url, (response) => {
        response.resume();
        const status = response.statusCode ?? 500;
        done(status >= 200 && status < 400);
      });
      request.on("error", () => done(false));
      request.setTimeout(timeoutMs, () => { request.destroy(); done(false); });
    } catch { done(false); }
  });
}

/** Distinguishes a reusable DSH instance from a free or foreign fixed port. */
export function probeFixedPort(url: string, timeoutMs: number): Promise<FixedPortProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const done = (value: FixedPortProbeResult) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const request = httpGet(url, (response) => {
        const header = String(response.headers["x-dsh"] ?? response.headers["x-powered-by"] ?? "").toLowerCase();
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 32 * 1024) body += chunk.slice(0, 32 * 1024 - body.length);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          const lowerBody = body.toLowerCase();
          const isDsh = header.includes("dsh")
            || lowerBody.includes("deepseek harness")
            || lowerBody.includes("data-dsh-web")
            || lowerBody.includes("__dsh_boot__");
          if (status >= 200 && status < 400 && isDsh) {
            done({ kind: "dsh" });
            return;
          }
          const reason = status === 401 || status === 403
            ? "The endpoint requires authentication; use an extension-managed DSH process instead of attaching without credentials."
            : status < 200 || status >= 400
            ? `The endpoint returned HTTP ${String(status)}.`
            : "The HTTP endpoint did not identify itself as DSH.";
          done({ kind: "occupied", reason });
        });
        response.on("error", (error: Error) => {
          done({ kind: "occupied", reason: `The HTTP endpoint failed during probing: ${error.message}` });
        });
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") {
          done({ kind: "free" });
          return;
        }
        done({ kind: "occupied", reason: `The port could not be safely identified: ${error.message}` });
      });
      request.setTimeout(timeoutMs, () => {
        done({ kind: "occupied", reason: `The endpoint did not identify itself within ${String(timeoutMs)}ms.` });
        request.destroy();
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      done({ kind: "occupied", reason: `The port probe failed: ${reason}` });
    }
  });
}
export function defaultNodeBin(execPath: string = process.execPath): string {
  const base = basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe" ? execPath : "node";
}

const HOST_ENV_PREFIXES = ["VSCODE_", "ELECTRON_", "CHROME_"];
const HOST_ENV_NAMES = new Set(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);
export function scrubExtensionHostEnv(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value !== undefined && !HOST_ENV_NAMES.has(upper) && !HOST_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) output[key] = value;
  }
  return output;
}

export function buildSpawn(location: DshLocation, args: string[], platform: NodeJS.Platform, nodeBin: string): SpawnSpec {
  if (location.kind === "node") return { command: nodeBin, args: [location.path, ...args] };
  if (location.kind === "cmd") return platform === "win32" ? { command: location.path, args, shell: true } : { command: location.path, args };
  return platform === "win32" && !location.path.toLowerCase().endsWith(".exe") ? { command: location.path, args, shell: true } : { command: location.path, args };
}

/** Terminates only a valid PID. POSIX callers must spawn a detached process group. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const done = () => { if (!settled) { settled = true; if (fallback !== undefined) clearTimeout(fallback); resolve(); } };
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", done); killer.on("exit", done);
      fallback = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} done(); }, 3000);
    });
  }
  try { process.kill(-pid, "SIGTERM"); } catch { return Promise.resolve(); }
  const escalation = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 3000);
  escalation.unref?.();
  return Promise.resolve();
}

function lineReader(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams): (listener: (line: string) => void) => void {
  let listener: ((line: string) => void) | undefined;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_STREAM_BUFFER) { listener?.(`${buffer.slice(0, MAX_STREAM_BUFFER)} [stream line truncated]`); buffer = ""; return; }
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) listener?.(line);
  });
  child.on("exit", () => { if (buffer !== "") listener?.(buffer); buffer = ""; });
  return (next) => { listener = next; };
}

function realSpawn(spec: SpawnSpec, cwd: string, env: Record<string, string | undefined>): SpawnedChild {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, {
    cwd, env: { ...env }, windowsHide: true, shell: spec.shell ?? false, detached: process.platform !== "win32",
  });
  return { pid: child.pid, onStdout: lineReader(child.stdout, child), onStderr: lineReader(child.stderr, child), onExit: (listener) => child.on("exit", listener), onError: (listener) => child.on("error", listener) };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function redact(text: string): string { return text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-***").replace(/(bearer\s+)[^\s]+/gi, "$1***").replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, "$1***"); }
function redactArgs(args: string[]): string[] {
  let hideNext = false;
  return args.map((arg) => { if (hideNext) { hideNext = false; return "***"; } if (/--(?:token|secret|password|api[-_]?key)(?:=|$)/i.test(arg)) { hideNext = !arg.includes("="); return arg.includes("=") ? `${arg.slice(0, arg.indexOf("=") + 1)}***` : arg; } return redact(arg); });
}

export interface DshLaunchSettings { port: number; host: string; extraArgs: string[]; extraEnv: Record<string, string>; dshHome: string; startupTimeoutSeconds: number; autoRestart: boolean; editorContextPatchPath?: string }
export interface DshServerOptions {
  resolveLocation(): Promise<DshLocation>;
  settings(): DshLaunchSettings;
  cwd(): string | undefined;
  log?: LogFn;
  spawnFn?: SpawnFn; killFn?: KillFn; probeFn?: ProbeFn; fixedPortProbeFn?: FixedPortProbeFn;
  platform?: NodeJS.Platform; nodeBin?: string; parentEnv?: () => Record<string, string | undefined>;
  probeIntervalMs?: number; restartDelayMs?: number; attachedProbeIntervalMs?: number;
}
interface Launch { generation: number; child: SpawnedChild; settings: DshLaunchSettings; ready: boolean; exit: Promise<void>; resolveExit: () => void; stopping?: Promise<void>; failing?: Promise<void> }

/** Exposes one lifecycle interface while keeping ownership, timers, and process generations local. */
export class DshServer {
  private readonly listeners = new Set<(snapshot: ServerSnapshot) => void>();
  private snapshot: ServerSnapshot = { state: "stopped", owned: false };
  private launch: Launch | undefined;
  private sequence = 0;
  private startTask: Promise<ServerSnapshot> | undefined;
  private stopTask: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private attachedTimer: ReturnType<typeof setTimeout> | undefined;
  private shouldRun = false;
  private attempts = 0;
  private disposed = false;
  private stderrTail: string[] = [];

  constructor(private readonly options: DshServerOptions) {}
  onChange(listener: (snapshot: ServerSnapshot) => void): () => void { this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
  getSnapshot(): ServerSnapshot { return { ...this.snapshot }; }
  private setState(state: ServerState, patch: Partial<ServerSnapshot> = {}): void { this.snapshot = { ...this.snapshot, state, ...patch }; const snapshot = this.getSnapshot(); for (const listener of this.listeners) listener(snapshot); }
  private current(sequence: number): boolean { return !this.disposed && sequence === this.sequence; }
  private currentLaunch(launch: Launch): boolean { return this.current(launch.generation) && this.launch === launch; }
  private log(message: string): void { this.options.log?.(redact(message)); }
  private interval(): number { return this.options.probeIntervalMs ?? PROBE_INTERVAL_MS; }
  private clearRestart(): void { if (this.restartTimer !== undefined) clearTimeout(this.restartTimer); this.restartTimer = undefined; }
  private clearAttached(): void { if (this.attachedTimer !== undefined) clearTimeout(this.attachedTimer); this.attachedTimer = undefined; }
  private health(url: string, timeout: number): Promise<boolean> { return (this.options.probeFn ?? probeHealth)(url, timeout); }
  private kill(pid: number): Promise<void> { return (this.options.killFn ?? ((id) => killTree(id, this.options.platform)))(pid); }

  start(): Promise<ServerSnapshot> { return this.beginStart(false); }
  private beginStart(automatic: boolean): Promise<ServerSnapshot> {
    if (this.disposed) return Promise.resolve(this.getSnapshot());
    this.shouldRun = true; if (!automatic) this.attempts = 0; this.clearRestart();
    if (this.snapshot.state === "running") return Promise.resolve(this.getSnapshot());
    if (this.startTask !== undefined) return this.startTask;
    if (this.stopTask !== undefined) return this.stopTask.then(() => this.beginStart(automatic));
    const sequence = ++this.sequence;
    const task = this.runStart(sequence); this.startTask = task;
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined; });
    return task;
  }
  private async runStart(sequence: number): Promise<ServerSnapshot> {
    this.clearAttached(); this.stderrTail = [];
    this.setState("starting", { owned: false, url: undefined, port: undefined, pid: undefined, error: undefined });
    let settings: DshLaunchSettings; let cwd: string | undefined;
    try { settings = this.options.settings(); cwd = this.options.cwd(); if (cwd === undefined) throw new Error("Open a local workspace folder before starting DSH."); } catch (error) { this.crash(sequence, describeError(error)); return this.getSnapshot(); }
    if (!this.current(sequence)) return this.getSnapshot();
    if (settings.port !== 0) {
      const url = loopbackUrl(settings.host, settings.port);
      const probeTimeoutMs = Math.min(settings.startupTimeoutSeconds * 1000, 5000);
      let probeResult: FixedPortProbeResult;
      try {
        probeResult = await (this.options.fixedPortProbeFn ?? probeFixedPort)(url, probeTimeoutMs);
      } catch (error) {
        probeResult = { kind: "occupied", reason: `The port probe failed: ${describeError(error)}` };
      }
      if (!this.current(sequence)) return this.getSnapshot();
      if (probeResult.kind === "dsh") {
        this.setState("running", { url, port: settings.port, owned: false, error: undefined });
        this.monitorAttached(sequence, url);
        return this.getSnapshot();
      }
      if (probeResult.kind === "occupied") {
        this.crash(sequence, `Port ${String(settings.port)} is already in use and cannot be safely reused. ${probeResult.reason} Stop that service, choose another dsh.port, or set dsh.port to 0.`);
        return this.getSnapshot();
      }
    }
    let location: DshLocation; try { location = await this.options.resolveLocation(); } catch (error) { this.crash(sequence, describeError(error)); return this.getSnapshot(); }
    if (!this.current(sequence)) return this.getSnapshot();
    const patchArgs = settings.editorContextPatchPath === undefined ? [] : ["--patch", settings.editorContextPatchPath];
    const host = settings.host === "localhost" ? "127.0.0.1" : settings.host;
    const args = ["--profile", "web", ...patchArgs, "--host", host, "--port", String(settings.port), ...settings.extraArgs, "--no-open"];
    const spec = buildSpawn(location, args, this.options.platform ?? process.platform, this.options.nodeBin ?? defaultNodeBin());
    const env: Record<string, string | undefined> = { ...scrubExtensionHostEnv((this.options.parentEnv ?? (() => process.env))()) };
    if (settings.dshHome !== "") env.DSH_HOME = settings.dshHome; Object.assign(env, settings.extraEnv);
    let child: SpawnedChild; try { child = (this.options.spawnFn ?? realSpawn)(spec, cwd, env); } catch (error) { this.crash(sequence, `Failed to start dsh: ${describeError(error)}`); return this.getSnapshot(); }
    if (!this.current(sequence)) { if (child.pid !== undefined) void this.kill(child.pid); return this.getSnapshot(); }
    let resolveExit: () => void = () => undefined;
    const launch: Launch = { generation: sequence, child, settings, ready: false, exit: new Promise((resolve) => { resolveExit = resolve; }), resolveExit };
    this.launch = launch; this.setState("starting", { owned: true, pid: child.pid }); this.log(`spawned dsh (pid ${child.pid ?? "?"}): ${spec.command} ${redactArgs(spec.args).join(" ")}`);
    child.onStdout((line) => { this.log(`[out] ${line}`); void this.onStdout(launch, line); });
    child.onStderr((line) => { this.log(`[err] ${line}`); this.stderrTail.push(line); if (this.stderrTail.length > 40) this.stderrTail.shift(); });
    child.onExit((code, signal) => { launch.resolveExit(); this.onExit(launch, code, signal); });
    child.onError((error) => { this.log(`spawn error: ${error.message}`); void this.fail(launch, `Failed to start dsh: ${error.message}`); });
    const deadline = Date.now() + settings.startupTimeoutSeconds * 1000;
    while (this.currentLaunch(launch) && this.snapshot.state === "starting") { if (Date.now() >= deadline) { await this.fail(launch, `dsh did not become reachable within ${String(settings.startupTimeoutSeconds)}s`); break; } await delay(this.interval()); }
    await launch.failing; return this.getSnapshot();
  }
  private async onStdout(launch: Launch, line: string): Promise<void> {
    if (!this.currentLaunch(launch) || launch.ready || this.snapshot.state !== "starting") return;
    const parsed = parseWebUrl(line); if (parsed === undefined) return; launch.ready = true;
    const deadline = Date.now() + launch.settings.startupTimeoutSeconds * 1000;
    while (this.currentLaunch(launch) && this.snapshot.state === "starting" && Date.now() < deadline) {
      let alive = false; try { alive = await this.health(parsed.url, 1000); } catch {}
      if (!this.currentLaunch(launch) || this.snapshot.state !== "starting") return;
      if (alive) { this.setState("running", { url: parsed.url, port: parsed.port, owned: true, pid: launch.child.pid, error: undefined }); return; }
      await delay(this.interval());
    }
    if (this.currentLaunch(launch) && this.snapshot.state === "starting") await this.fail(launch, `dsh printed ${redact(parsed.url)} but never answered health probes`);
  }
  private async fail(launch: Launch, reason: string): Promise<void> {
    if (!this.currentLaunch(launch)) return;
    if (launch.failing !== undefined) return launch.failing;
    launch.failing = (async () => { this.setState("stopping"); try { await this.stopLaunch(launch); } catch {} if (this.current(launch.generation)) this.setState("crashed", { error: reason, owned: false, url: undefined, port: undefined, pid: undefined }); })();
    return launch.failing;
  }
  private onExit(launch: Launch, code: number | null, signal: string | null): void {
    if (this.launch !== launch) return; this.launch = undefined;
    if (!this.current(launch.generation) || this.snapshot.state === "stopping") return;
    const how = signal === null ? `code ${code ?? "?"}` : `signal ${signal}`;
    if (this.snapshot.state === "starting") { this.setState("crashed", { error: `dsh exited (${how}) before the web server came up${this.stderrSummary()}`, owned: false, url: undefined, port: undefined, pid: undefined }); return; }
    if (this.snapshot.state === "running" && launch.settings.autoRestart && this.shouldRun && this.attempts < MAX_AUTO_RESTARTS) { this.attempts += 1; this.setState("stopped", { owned: false, url: undefined, port: undefined, pid: undefined }); this.scheduleRestart(launch.generation, how); return; }
    this.setState("crashed", { error: `dsh exited unexpectedly (${how})`, owned: false, url: undefined, port: undefined, pid: undefined });
  }
  private scheduleRestart(sequence: number, how: string): void { this.clearRestart(); this.log(`unexpected exit (${how}); auto-restart attempt ${String(this.attempts)}/${String(MAX_AUTO_RESTARTS)}`); this.restartTimer = setTimeout(() => { this.restartTimer = undefined; if (this.shouldRun && !this.disposed && sequence === this.sequence) void this.beginStart(true); }, this.options.restartDelayMs ?? RESTART_DELAY_MS); this.restartTimer.unref?.(); }
  private monitorAttached(sequence: number, url: string): void {
    const check = async () => { if (!this.current(sequence) || this.snapshot.state !== "running" || this.snapshot.owned) return; let alive = false; try { alive = await this.health(url, 1000); } catch {} if (!this.current(sequence) || this.snapshot.state !== "running" || this.snapshot.owned) return; if (!alive) { this.setState("crashed", { error: "The attached DSH server is no longer reachable.", url: undefined, port: undefined }); return; } this.attachedTimer = setTimeout(check, this.options.attachedProbeIntervalMs ?? RESTART_DELAY_MS); this.attachedTimer.unref?.(); };
    this.attachedTimer = setTimeout(check, this.options.attachedProbeIntervalMs ?? RESTART_DELAY_MS); this.attachedTimer.unref?.();
  }
  async stop(): Promise<void> { this.shouldRun = false; this.attempts = 0; this.clearRestart(); await this.stopInternal(); }
  private stopInternal(): Promise<void> { if (this.stopTask !== undefined) return this.stopTask; const task = this.stopNow(); this.stopTask = task; void task.finally(() => { if (this.stopTask === task) this.stopTask = undefined; }); return task; }
  private async stopNow(): Promise<void> {
    const sequence = ++this.sequence; this.clearAttached(); const launch = this.launch;
    if (launch === undefined) { this.setState("stopped", { owned: false, url: undefined, port: undefined, pid: undefined, error: undefined }); return; }
    this.setState("stopping"); try { await this.stopLaunch(launch); if (this.current(sequence)) this.setState("stopped", { owned: false, url: undefined, port: undefined, pid: undefined, error: undefined }); } catch (error) { if (this.current(sequence)) this.setState("crashed", { error: `Could not confirm that dsh stopped: ${describeError(error)}`, owned: false, url: undefined, port: undefined, pid: undefined }); }
  }
  private stopLaunch(launch: Launch): Promise<void> {
    if (launch.stopping !== undefined) return launch.stopping; if (this.launch === launch) this.launch = undefined;
    launch.stopping = (async () => { if (launch.child.pid === undefined) throw new Error("dsh did not expose a process ID."); await this.kill(launch.child.pid); const exited = await Promise.race([launch.exit.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)]); if (!exited) throw new Error("timed out waiting for the DSH process to exit."); })();
    return launch.stopping;
  }
  async restart(): Promise<ServerSnapshot> { if (this.disposed) return this.getSnapshot(); this.shouldRun = true; this.attempts = 0; this.clearRestart(); await this.stopInternal(); return this.beginStart(false); }
  async dispose(stopProcess: boolean): Promise<void> { this.shouldRun = false; this.clearRestart(); this.clearAttached(); if (!stopProcess) { this.disposed = true; this.sequence += 1; this.launch = undefined; return; } await this.stopInternal(); this.disposed = true; }
  private crash(sequence: number, error: string): void { if (this.current(sequence)) this.setState("crashed", { error, owned: false, url: undefined, port: undefined, pid: undefined }); }
  private stderrSummary(): string { const value = this.stderrTail.filter((line) => line.trim() !== "").join("\n"); return value === "" ? "" : `:\n${value.slice(0, 1600)}`; }
}
