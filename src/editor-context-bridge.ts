/** Maintains the short-lived UTF-8 snapshot and generated DSH patch for one activation. */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EditorContextSnapshot } from "./editor-context";

export const EDITOR_CONTEXT_TTL_MS = 45_000;
export const EDITOR_CONTEXT_HEARTBEAT_MS = 15_000;
export const EDITOR_CONTEXT_DEBOUNCE_MS = 100;

export interface EditorContextBridgeOptions {
  storageDirectory: string;
  pluginPath: string;
  editorContextEnabled: boolean;
  workspaceSyncEnabled: boolean;
  snapshot(now: number, ttlMs: number): EditorContextSnapshot;
  activationId?: string;
  now?: () => number;
}

/** Owns exactly one runtime directory so normal cleanup cannot touch another activation. */
export class EditorContextBridge {
  readonly runtimeDirectory: string;
  readonly contextPath: string;
  readonly patchPath: string;
  readonly routeToken: string;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: EditorContextBridgeOptions) {
    const activationId = options.activationId ?? randomUUID();
    this.routeToken = activationId.replace(/[^A-Za-z0-9_-]/g, "");
    if (this.routeToken === "") throw new Error("DSH integration activation id is invalid.");
    this.runtimeDirectory = join(options.storageDirectory, "editor-context", activationId);
    this.contextPath = join(this.runtimeDirectory, "context.json");
    this.patchPath = join(this.runtimeDirectory, "editor-context.patch.yaml");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(this.runtimeDirectory, { recursive: true });
    await writeFile(this.patchPath, this.renderPatch(), "utf8");
    await this.writeNow();
    if (this.disposed) return;
    this.heartbeatTimer = setInterval(() => { void this.writeNow().catch(() => undefined); }, EDITOR_CONTEXT_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  scheduleWrite(): void {
    if (!this.initialized || this.disposed) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.writeNow().catch(() => undefined);
    }, EDITOR_CONTEXT_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  writeNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const task = this.writeQueue.then(async () => {
      if (this.disposed) return;
      const now = (this.options.now ?? Date.now)();
      const text = `${JSON.stringify(this.options.snapshot(now, EDITOR_CONTEXT_TTL_MS), undefined, 2)}\n`;
      const temporaryPath = `${this.contextPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, text, "utf8");
      try {
        await rename(temporaryPath, this.contextPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.debounceTimer = undefined;
    this.heartbeatTimer = undefined;
    await this.writeQueue;
    await rm(this.runtimeDirectory, { recursive: true, force: true });
  }

  private renderPatch(): string {
    const pluginUrl = pathToFileURL(this.options.pluginPath).href;
    return [
      "- insert:",
      "    - id: vscode-integration",
      `      name: ${JSON.stringify(pluginUrl)}`,
      "      config:",
      `        contextFile: ${JSON.stringify(this.contextPath)}`,
      `        routeToken: ${JSON.stringify(this.routeToken)}`,
      `        editorContextEnabled: ${String(this.options.editorContextEnabled)}`,
      `        workspaceSyncEnabled: ${String(this.options.workspaceSyncEnabled)}`,
      "",
    ].join("\n");
  }
}
