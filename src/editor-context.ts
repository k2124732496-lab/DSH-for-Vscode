/** Owns the transient, model-facing metadata for VS Code editor files. */
import path from "node:path";

export interface EditorSelectionSnapshot {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface VisibleEditorFileBase {
  path: string;
  dirty: boolean;
  active: boolean;
}

export interface VisibleTextEditorFile extends VisibleEditorFileBase {
  editorType: "text";
  languageId: string;
  selections: EditorSelectionSnapshot[];
}

export type NotebookCellKind = "code" | "markup";

export interface NotebookCellSnapshot {
  /** One-based cell index for model-facing display. */
  index: number;
  kind: NotebookCellKind;
  languageId: string;
  active: boolean;
  selected: boolean;
  selections: EditorSelectionSnapshot[];
}

export interface VisibleNotebookEditorFile extends VisibleEditorFileBase {
  editorType: "notebook";
  notebookType: string;
  cells: NotebookCellSnapshot[];
  cellsTruncated: boolean;
}

export type VisibleEditorFile = VisibleTextEditorFile | VisibleNotebookEditorFile;

export type EditorContextSource = "visible" | "pinned";
export const MAX_PINNED_EDITOR_FILES = 100;

interface EditorContextFileBase extends VisibleEditorFileBase {
  relativePath?: string;
  source: EditorContextSource;
}

export const MAX_SELECTIONS_PER_EDITOR = 64;
export const MAX_NOTEBOOK_CONTEXT_CELLS = 100;
export type EditorContextFile =
  | (EditorContextFileBase & Omit<VisibleTextEditorFile, keyof VisibleEditorFileBase>)
  | (EditorContextFileBase & Omit<VisibleNotebookEditorFile, keyof VisibleEditorFileBase>)
  | (EditorContextFileBase & { editorType: "file" });

export interface EditorContextSnapshot {
  version: 2;
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
      const normalized = this.cloneVisibleFile(file, absolutePath);
      const existing = deduplicated.get(key);
      if (existing === undefined) {
        deduplicated.set(key, normalized);
        continue;
      }
      deduplicated.set(key, this.mergeVisibleFiles(existing, normalized));
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

  removePinnedPathsAtOrBelow(filePath: string): boolean {
    const rootPath = this.pathApi.resolve(filePath);
    let changed = false;
    for (const [key, pinnedPath] of [...this.pinned.entries()]) {
      if (!this.isPathAtOrBelow(rootPath, pinnedPath)) continue;
      this.pinned.delete(key);
      this.allowedExternal.delete(key);
      this.deniedExternal.delete(key);
      changed = true;
    }
    return changed;
  }

  movePinnedPathsAtOrBelow(oldPath: string, newPath: string): boolean {
    const oldRoot = this.pathApi.resolve(oldPath);
    const newRoot = this.pathApi.resolve(newPath);
    const moves = [...this.pinned.entries()].flatMap(([key, pinnedPath]) => {
      if (!this.isPathAtOrBelow(oldRoot, pinnedPath)) return [];
      const relativePath = this.pathApi.relative(oldRoot, pinnedPath);
      const destination = relativePath === "" ? newRoot : this.pathApi.resolve(newRoot, relativePath);
      return [{ key, destination }];
    });
    if (moves.length === 0) return false;

    // When VS Code renames a directory, migrate pinned descendants to the new path.
    for (const { key } of moves) {
      this.pinned.delete(key);
      this.allowedExternal.delete(key);
      this.deniedExternal.delete(key);
    }
    for (const { destination } of moves) {
      const destinationKey = this.pathKey(destination);
      if (!this.pinned.has(destinationKey)) this.pinned.set(destinationKey, destination);
    }
    return true;
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
      version: 2,
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
    const common: EditorContextFileBase = {
      path: absolutePath,
      ...(insideWorkspace ? { relativePath } : {}),
      source: this.pinned.has(key) ? "pinned" : "visible",
      active: file.active,
      dirty: file.dirty,
    };
    if (file.editorType === "text") {
      return {
        ...common,
        editorType: "text",
        languageId: file.languageId,
        selections: file.selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({ ...selection })),
      };
    }
    return {
      ...common,
      editorType: "notebook",
      notebookType: file.notebookType,
      cells: file.cells.map((cell) => ({
        ...cell,
        selections: cell.selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({ ...selection })),
      })),
      cellsTruncated: file.cellsTruncated,
    };
  }

  private pinnedContextFile(filePath: string): EditorContextFile {
    const relativePath = this.pathApi.relative(this.normalizedRoot, filePath);
    return {
      path: filePath,
      ...(this.isInsideWorkspace(filePath) ? { relativePath } : {}),
      source: "pinned",
      active: false,
      dirty: false,
      editorType: "file",
    };
  }

  private cloneVisibleFile(file: VisibleEditorFile, absolutePath = this.pathApi.resolve(file.path)): VisibleEditorFile {
    if (file.editorType === "text") {
      return {
        ...file,
        path: absolutePath,
        selections: file.selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({ ...selection })),
      };
    }
    return {
      ...file,
      path: absolutePath,
      cells: file.cells.map((cell) => ({
        ...cell,
        selections: cell.selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({ ...selection })),
      })),
    };
  }

  private mergeVisibleFiles(existing: VisibleEditorFile, incoming: VisibleEditorFile): VisibleEditorFile {
    if (existing.editorType !== incoming.editorType) {
      if (incoming.active || (!existing.active && incoming.editorType === "notebook")) return incoming;
      return existing;
    }
    if (existing.editorType === "text" && incoming.editorType === "text") {
      return {
        ...existing,
        active: existing.active || incoming.active,
        dirty: existing.dirty || incoming.dirty,
        languageId: incoming.active ? incoming.languageId : existing.languageId,
        selections: [...existing.selections, ...incoming.selections.map((selection) => ({ ...selection }))].slice(0, MAX_SELECTIONS_PER_EDITOR),
      };
    }
    if (existing.editorType === "notebook" && incoming.editorType === "notebook") {
      const cells = new Map(existing.cells.map((cell) => [cell.index, cell]));
      for (const cell of incoming.cells) {
        const previous = cells.get(cell.index);
        cells.set(cell.index, previous === undefined ? cell : {
          ...previous,
          active: previous.active || cell.active,
          selected: previous.selected || cell.selected,
          languageId: cell.active ? cell.languageId : previous.languageId,
          selections: [...previous.selections, ...cell.selections.map((selection) => ({ ...selection }))].slice(0, MAX_SELECTIONS_PER_EDITOR),
        });
      }
      const mergedCells = [...cells.values()].sort((left, right) => Number(right.active) - Number(left.active));
      return {
        ...existing,
        active: existing.active || incoming.active,
        dirty: existing.dirty || incoming.dirty,
        notebookType: incoming.active ? incoming.notebookType : existing.notebookType,
        cells: mergedCells.slice(0, MAX_NOTEBOOK_CONTEXT_CELLS),
        cellsTruncated: existing.cellsTruncated || incoming.cellsTruncated || mergedCells.length > MAX_NOTEBOOK_CONTEXT_CELLS,
      };
    }
    return existing;
  }

  private isInsideWorkspace(filePath: string): boolean {
    return this.isPathAtOrBelow(this.normalizedRoot, filePath);
  }

  private isPathAtOrBelow(rootPath: string, candidatePath: string): boolean {
    const relativePath = this.pathApi.relative(this.pathApi.resolve(rootPath), this.pathApi.resolve(candidatePath));
    return relativePath === ""
      || (relativePath !== ".." && !relativePath.startsWith(`..${this.pathApi.sep}`) && !this.pathApi.isAbsolute(relativePath));
  }

  private pathKey(filePath: string): string {
    const resolved = this.pathApi.resolve(filePath);
    return this.pathApi === path.win32 ? resolved.toLowerCase() : resolved;
  }
}
