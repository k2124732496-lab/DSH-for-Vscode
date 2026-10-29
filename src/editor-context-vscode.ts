/** Adapts VS Code editor events and workspace persistence to the editor-context model. */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { activeLocalResourceUri } from "./config";
import { EditorContextBridge } from "./editor-context-bridge";
import {
  EditorContextModel,
  MAX_SELECTIONS_PER_EDITOR,
  MAX_PINNED_EDITOR_FILES,
  type EditorContextFile,
  type EditorContextSnapshot,
  type VisibleEditorFile,
} from "./editor-context";
import { NotebookContextAdapter } from "./notebook-context";

const PINNED_STATE_KEY = "dsh.editorContext.pinnedFiles";
const INCLUDE_EXTERNAL = "Include for this session";
const PINNED_RECONCILE_INTERVAL_MS = 60_000;

type PinnedPathStat = (filePath: string) => Promise<unknown>;

function fileSystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Returns only paths the file system definitively reports as absent. */
export async function findMissingPinnedPaths(
  pinnedPaths: readonly string[],
  statPath: PinnedPathStat = stat,
): Promise<string[]> {
  const checks = await Promise.all(pinnedPaths.map(async (filePath) => {
    try {
      await statPath(filePath);
      return undefined;
    } catch (error) {
      const code = fileSystemErrorCode(error);
      return code === "ENOENT" || code === "ENOTDIR" ? filePath : undefined;
    }
  }));
  return checks.filter((filePath): filePath is string => filePath !== undefined);
}

/** Removes all file metadata when only workspace synchronization is enabled. */
export function integrationSnapshot(
  snapshot: EditorContextSnapshot,
  editorContextEnabled: boolean,
): EditorContextSnapshot {
  return editorContextEnabled ? snapshot : { ...snapshot, files: [] };
}

export interface EditorContextSummary {
  enabled: boolean;
  available: boolean;
  count: number;
  pinnedCount: number;
  temporaryExternalCount: number;
  reason?: string;
}

export interface EditorContextControllerOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot(): string | undefined;
  pluginPath: string;
  editorContextEnabled: boolean;
  workspaceSyncEnabled: boolean;
  onDidChange(): void;
  log(message: string): void;
}

/** Converts only a local text editor; it never reads the document body. */
export function toVisibleEditorFile(
  editor: vscode.TextEditor,
  activeEditor: vscode.TextEditor | undefined,
): VisibleEditorFile | undefined {
  if (editor.document.uri.scheme !== "file") return undefined;
  return {
    editorType: "text",
    path: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    active: editor === activeEditor,
    selections: editor.selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
    })),
  };
}

/** Owns one activation's VS Code listeners, persistence, prompts, and DSH bridge. */
export class EditorContextController implements vscode.Disposable {
  readonly patchPath: string;
  private readonly model: EditorContextModel;
  private readonly bridge: EditorContextBridge;
  private readonly notebookAdapter = new NotebookContextAdapter();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly promptingExternal = new Set<string>();
  private pinnedReconcileTimer: ReturnType<typeof setInterval> | undefined;
  private pinnedUpdateQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(private readonly options: EditorContextControllerOptions) {
    const workspaceRoot = options.workspaceRoot();
    if (workspaceRoot === undefined) throw new Error("A local workspace is required for the DSH integration bridge.");
    const pinnedPaths = options.extensionContext.workspaceState.get<string[]>(PINNED_STATE_KEY, []);
    this.model = new EditorContextModel(workspaceRoot, pinnedPaths);
    this.bridge = new EditorContextBridge({
      storageDirectory: (options.extensionContext.storageUri ?? options.extensionContext.globalStorageUri).fsPath,
      pluginPath: options.pluginPath,
      editorContextEnabled: options.editorContextEnabled,
      workspaceSyncEnabled: options.workspaceSyncEnabled,
      snapshot: (now, ttlMs) => integrationSnapshot(this.model.snapshot(now, ttlMs), options.editorContextEnabled),
    });
    this.patchPath = this.bridge.patchPath;
  }

  get workspaceRoot(): string {
    return this.model.workspaceRoot();
  }

  matchesFeatures(editorContextEnabled: boolean, workspaceSyncEnabled: boolean): boolean {
    return this.options.editorContextEnabled === editorContextEnabled
      && this.options.workspaceSyncEnabled === workspaceSyncEnabled;
  }

  /** Re-evaluates the active root after workspace-folder changes. */
  refreshWorkspace(): void {
    this.refresh();
  }

  static async create(options: EditorContextControllerOptions): Promise<EditorContextController> {
    const controller = new EditorContextController(options);
    if (options.editorContextEnabled) await controller.reconcilePinnedFiles();
    await controller.bridge.initialize();
    controller.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => controller.refresh()),
      vscode.window.onDidChangeActiveNotebookEditor(() => controller.refresh()),
      vscode.window.tabGroups.onDidChangeTabs(() => controller.refresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => controller.refresh()),
    );
    if (options.editorContextEnabled) {
      controller.disposables.push(
        vscode.window.onDidChangeVisibleTextEditors(() => controller.refresh()),
        vscode.window.onDidChangeVisibleNotebookEditors(() => controller.refresh()),
        vscode.window.onDidChangeTextEditorSelection((event) => {
          controller.notebookAdapter.recordTextEditorSelection(event.textEditor);
          controller.refresh();
        }),
        vscode.window.onDidChangeNotebookEditorSelection(() => controller.refresh()),
        vscode.workspace.onDidChangeTextDocument(() => controller.refresh()),
        vscode.workspace.onDidSaveTextDocument(() => controller.refresh()),
        vscode.workspace.onDidChangeNotebookDocument(() => controller.refresh()),
        vscode.workspace.onDidSaveNotebookDocument(() => controller.refresh()),
        vscode.workspace.onDidCloseNotebookDocument((notebook) => {
          controller.notebookAdapter.forgetNotebook(notebook);
          controller.refresh();
        }),
        vscode.workspace.onDidDeleteFiles((event) => {
          void controller.handleDeletedFiles(event.files);
        }),
        vscode.workspace.onDidRenameFiles((event) => {
          void controller.handleRenamedFiles(event.files);
        }),
      );
      controller.pinnedReconcileTimer = setInterval(() => {
        void controller.reconcilePinnedFiles();
      }, PINNED_RECONCILE_INTERVAL_MS);
      controller.pinnedReconcileTimer.unref?.();
    }
    controller.refresh();
    return controller;
  }

  summary(available = true, reason?: string): EditorContextSummary {
    const files = this.currentFiles();
    return {
      enabled: this.options.editorContextEnabled,
      available,
      count: files.length,
      pinnedCount: files.filter((file) => file.source === "pinned").length,
      temporaryExternalCount: files.filter((file) => file.source === "visible" && file.relativePath === undefined).length,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  async pinCurrentFile(): Promise<void> {
    const filePath = this.activeLocalFile();
    if (filePath === undefined) {
      await vscode.window.showWarningMessage("Open a local file before pinning it to DSH editor context.");
      return;
    }
    try {
      if (!this.model.pin(filePath)) {
        await vscode.window.showInformationMessage("The current file is already pinned to DSH editor context.");
        return;
      }
      await this.persistPinnedPaths();
      this.refresh();
    } catch (error) {
      await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async unpinCurrentFile(): Promise<void> {
    const filePath = this.activeLocalFile();
    if (filePath === undefined || !this.model.unpin(filePath)) {
      await vscode.window.showInformationMessage("The current file is not pinned to DSH editor context.");
      return;
    }
    await this.persistPinnedPaths();
    this.refresh();
  }

  async manageFiles(): Promise<void> {
    const files = this.currentFiles();
    if (files.length === 0) {
      await vscode.window.showInformationMessage("DSH editor context currently has no files.");
      return;
    }
    const picked = await vscode.window.showQuickPick(files.map((file) => ({
      label: basename(file.path),
      description: this.sourceLabel(file),
      detail: file.path,
      file,
    })), { placeHolder: "Context files; select a pinned file to remove it" });
    if (picked === undefined) return;
    if (picked.file.source !== "pinned") {
      await vscode.window.showInformationMessage(`${picked.description} entries follow the visible editors and cannot be removed here.`);
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Remove ${picked.label} from pinned DSH editor context?`,
      { modal: true },
      "Remove",
    );
    if (confirmation !== "Remove") return;
    this.model.unpin(picked.file.path);
    await this.persistPinnedPaths();
    this.refresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pinnedReconcileTimer !== undefined) clearInterval(this.pinnedReconcileTimer);
    this.pinnedReconcileTimer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    await this.pinnedUpdateQueue;
    await this.bridge.dispose();
  }

  private reconcilePinnedFiles(): Promise<void> {
    return this.updatePinnedFiles(async () => {
      const missingPaths = await findMissingPinnedPaths(this.model.pinnedPaths());
      let changed = false;
      for (const filePath of missingPaths) {
        changed = this.model.removePinnedPathsAtOrBelow(filePath) || changed;
      }
      return changed;
    });
  }

  private handleDeletedFiles(files: readonly vscode.Uri[]): Promise<void> {
    return this.updatePinnedFiles(() => {
      let changed = false;
      for (const uri of files) {
        if (uri.scheme !== "file") continue;
        changed = this.model.removePinnedPathsAtOrBelow(uri.fsPath) || changed;
      }
      return changed;
    });
  }

  private handleRenamedFiles(
    files: ReadonlyArray<{ readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }>,
  ): Promise<void> {
    return this.updatePinnedFiles(() => {
      let changed = false;
      for (const { oldUri, newUri } of files) {
        if (oldUri.scheme !== "file") continue;
        changed = newUri.scheme === "file"
          ? this.model.movePinnedPathsAtOrBelow(oldUri.fsPath, newUri.fsPath) || changed
          : this.model.removePinnedPathsAtOrBelow(oldUri.fsPath) || changed;
      }
      return changed;
    });
  }

  private updatePinnedFiles(update: () => boolean | Promise<boolean>): Promise<void> {
    const operation = this.pinnedUpdateQueue.then(async () => {
      if (this.disposed) return;
      const changed = await update();
      if (!changed || this.disposed) return;

      // Persist only after a missing path or explicit file event confirms the change.
      await this.persistPinnedPaths();
      this.bridge.scheduleWrite();
      this.options.onDidChange();
    });
    this.pinnedUpdateQueue = operation.catch((error) => {
      this.options.log(`Could not reconcile pinned editor files: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.pinnedUpdateQueue;
  }

  private refresh(): void {
    if (this.disposed) return;
    const workspaceRoot = this.options.workspaceRoot();
    if (workspaceRoot !== undefined) this.model.setWorkspaceRoot(workspaceRoot);
    const activeResource = activeLocalResourceUri();
    const activeTextEditor = vscode.window.activeTextEditor?.document.uri.scheme === "file"
      && vscode.window.activeTextEditor.document.uri.toString() === activeResource?.toString()
      ? vscode.window.activeTextEditor
      : undefined;
    const activeNotebookEditor = vscode.window.activeNotebookEditor?.notebook.uri.toString() === activeResource?.toString()
      ? vscode.window.activeNotebookEditor
      : undefined;
    const visibleFiles: VisibleEditorFile[] = this.options.editorContextEnabled
      ? [
        ...vscode.window.visibleTextEditors.flatMap((editor) => {
          const file = toVisibleEditorFile(editor, activeTextEditor);
          return file === undefined ? [] : [file];
        }),
        ...this.notebookAdapter.collect(
          vscode.window.visibleNotebookEditors,
          activeNotebookEditor,
          vscode.window.activeTextEditor,
        ),
      ]
      : [];
    const pendingExternal = this.model.updateVisible(visibleFiles);
    this.bridge.scheduleWrite();
    this.options.onDidChange();
    if (this.options.editorContextEnabled) void this.resolveExternalFiles(pendingExternal);
  }

  private async resolveExternalFiles(paths: readonly string[]): Promise<void> {
    for (const filePath of paths) {
      if (this.disposed || this.promptingExternal.has(filePath)) continue;
      this.promptingExternal.add(filePath);
      try {
        const answer = await vscode.window.showWarningMessage(
          `Allow DSH to receive this external file path for the current VS Code session? ${filePath}`,
          INCLUDE_EXTERNAL,
          "Ignore",
        );
        if (answer === INCLUDE_EXTERNAL) this.model.allowExternal(filePath);
        else this.model.denyExternal(filePath);
      } finally {
        this.promptingExternal.delete(filePath);
      }
      this.bridge.scheduleWrite();
      this.options.onDidChange();
    }
  }

  private currentFiles(): EditorContextFile[] {
    return this.options.editorContextEnabled ? this.model.snapshot(Date.now(), 45_000).files : [];
  }

  private activeLocalFile(): string | undefined {
    return activeLocalResourceUri()?.fsPath;
  }

  private async persistPinnedPaths(): Promise<void> {
    const pinned = this.model.pinnedPaths().slice(0, MAX_PINNED_EDITOR_FILES);
    await this.options.extensionContext.workspaceState.update(PINNED_STATE_KEY, pinned);
  }

  private sourceLabel(file: EditorContextFile): string {
    if (file.source === "pinned") return "Pinned";
    return file.relativePath === undefined ? "External session permission" : "Visible editor";
  }
}
