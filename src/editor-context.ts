/** Owns the transient, model-facing metadata for VS Code editor files. */
import path from "node:path";

export interface EditorSelectionSnapshot {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface VisibleEditorFile {
  path: string;
  languageId: string;
  dirty: boolean;
  active: boolean;
  selections: EditorSelectionSnapshot[];
}

export type EditorContextSource = "visible" | "pinned";
export const MAX_PINNED_EDITOR_FILES = 100;

export interface EditorContextFile extends VisibleEditorFile {
  relativePath?: string;
  source: EditorContextSource;
}

export interface EditorContextSnapshot {
  version: 1;
  expiresAt: number;
  workspaceRoot: string;
  files: EditorContextFile[];
}

/** Keeps editor visibility rules behind one snapshot-oriented interface. */
export class EditorContextModel {
  private visibleFiles: VisibleEditorFile[] = [];
  private readonly allowedExternal = new Set<string>();
  private readonly deniedExternal = new Set<string>();
  private readonly pinned = new Map<string, string>();
  private readonly pathApi: typeof path.win32 | typeof path.posix;
  private normalizedRoot: string;

  constructor(
    workspaceRoot: string,
    pinnedPaths: readonly string[],
    platform: NodeJS.Platform = process.platform,
  ) {
    this.pathApi = platform === "win32" ? path.win32 : path.posix;
    this.normalizedRoot = this.pathApi.resolve(workspaceRoot);
    for (const pinnedPath of pinnedPaths) {
      if (this.pinned.size >= MAX_PINNED_EDITOR_FILES) break;
      const absolutePath = this.pathApi.resolve(pinnedPath);
      const key = this.pathKey(absolutePath);
      if (!this.pinned.has(key)) this.pinned.set(key, absolutePath);
    }
  }

  /** Updates the DSH workspace root without discarding pinned or session-approved files. */
  setWorkspaceRoot(workspaceRoot: string): boolean {
    const nextRoot = this.pathApi.resolve(workspaceRoot);
    if (this.pathKey(nextRoot) === this.pathKey(this.normalizedRoot)) return false;
    this.normalizedRoot = nextRoot;
    return true;
  }

  workspaceRoot(): string {
    return this.normalizedRoot;
  }

  updateVisible(files: readonly VisibleEditorFile[]): string[] {
    const deduplicated = new Map<string, VisibleEditorFile>();
    for (const file of files) {
      const absolutePath = this.pathApi.resolve(file.path);
      const key = this.pathKey(absolutePath);
      const existing = deduplicated.get(key);
      if (existing === undefined) {
        deduplicated.set(key, {
          ...file,
          path: absolutePath,
          selections: file.selections.map((selection) => ({ ...selection })),
        });
        continue;
      }
      existing.active ||= file.active;
      existing.dirty ||= file.dirty;
      existing.selections.push(...file.selections.map((selection) => ({ ...selection })));
      if (file.active) existing.languageId = file.languageId;
    }
    this.visibleFiles = [...deduplicated.values()];
    return this.visibleFiles
      .filter((file) => !this.isInsideWorkspace(file.path))
      .filter((file) => {
        const key = this.pathKey(file.path);
        return !this.pinned.has(key) && !this.allowedExternal.has(key) && !this.deniedExternal.has(key);
      })
      .map((file) => this.pathApi.resolve(file.path));
  }

  allowExternal(filePath: string): void {
    const key = this.pathKey(filePath);
    this.deniedExternal.delete(key);
    this.allowedExternal.add(key);
  }

  denyExternal(filePath: string): void {
    const key = this.pathKey(filePath);
    this.allowedExternal.delete(key);
    this.deniedExternal.add(key);
  }

  pin(filePath: string): boolean {
    const absolutePath = this.pathApi.resolve(filePath);
    const key = this.pathKey(absolutePath);
    if (this.pinned.has(key)) return false;
    if (this.pinned.size >= MAX_PINNED_EDITOR_FILES) {
      throw new Error(`DSH supports at most ${String(MAX_PINNED_EDITOR_FILES)} pinned editor files.`);
    }
    this.pinned.set(key, absolutePath);
    return true;
  }

  unpin(filePath: string): boolean {
    return this.pinned.delete(this.pathKey(filePath));
  }

  pinnedPaths(): string[] {
    return [...this.pinned.values()];
  }

  snapshot(now: number, ttlMs: number): EditorContextSnapshot {
    const visibleKeys = new Set(this.visibleFiles.map((file) => this.pathKey(file.path)));
    const files = [
      ...this.visibleFiles.flatMap((file) => {
        const converted = this.toContextFile(file);
        return converted === undefined ? [] : [converted];
      }),
      ...[...this.pinned.entries()]
        .filter(([key]) => !visibleKeys.has(key))
        .map(([, pinnedPath]) => this.pinnedContextFile(pinnedPath)),
    ].sort((left, right) => Number(right.active) - Number(left.active));
    return {
      version: 1,
      expiresAt: now + ttlMs,
      workspaceRoot: this.normalizedRoot,
      files,
    };
  }

  private toContextFile(file: VisibleEditorFile): EditorContextFile | undefined {
    const absolutePath = this.pathApi.resolve(file.path);
    const relativePath = this.pathApi.relative(this.normalizedRoot, absolutePath);
    const insideWorkspace = this.isInsideWorkspace(absolutePath);
    const key = this.pathKey(absolutePath);
    if (!insideWorkspace && !this.pinned.has(key) && !this.allowedExternal.has(key)) return undefined;
    return {
      path: absolutePath,
      ...(insideWorkspace ? { relativePath } : {}),
      source: this.pinned.has(key) ? "pinned" : "visible",
      active: file.active,
      languageId: file.languageId,
      dirty: file.dirty,
      selections: file.selections.map((selection) => ({ ...selection })),
    };
  }

  private pinnedContextFile(filePath: string): EditorContextFile {
    const relativePath = this.pathApi.relative(this.normalizedRoot, filePath);
    return {
      path: filePath,
      ...(this.isInsideWorkspace(filePath) ? { relativePath } : {}),
      source: "pinned",
      active: false,
      languageId: "unknown",
      dirty: false,
      selections: [],
    };
  }

  private isInsideWorkspace(filePath: string): boolean {
    const relativePath = this.pathApi.relative(this.normalizedRoot, this.pathApi.resolve(filePath));
    return relativePath === ""
      || (relativePath !== ".." && !relativePath.startsWith(`..${this.pathApi.sep}`) && !this.pathApi.isAbsolute(relativePath));
  }

  private pathKey(filePath: string): string {
    const resolved = this.pathApi.resolve(filePath);
    return this.pathApi === path.win32 ? resolved.toLowerCase() : resolved;
  }
}
