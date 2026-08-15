/** Adapts VS Code editor events and workspace persistence to the editor-context model. */
import { basename } from "node:path";
import * as vscode from "vscode";
import { EditorContextBridge } from "./editor-context-bridge";
import {
  EditorContextModel,
  MAX_PINNED_EDITOR_FILES,
  type EditorContextFile,
  type EditorContextSnapshot,
  type VisibleEditorFile,
} from "./editor-context";

const PINNED_STATE_KEY = "dsh.editorContext.pinnedFiles";
const INCLUDE_EXTERNAL = "Include for this session";

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
  workspaceClientPath: string;
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
    path: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    active: editor === activeEditor,
    selections: editor.selections.map((selection) => ({
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
  private readonly disposables: vscode.Disposable[] = [];
  private readonly promptingExternal = new Set<string>();
  private disposed = false;

  private constructor(private readonly options: EditorContextControllerOptions) {
    const workspaceRoot = options.workspaceRoot();
    if (workspaceRoot === undefined) throw new Error("A local workspace is required for the DSH integration bridge.");
    const pinnedPaths = options.extensionContext.workspaceState.get<string[]>(PINNED_STATE_KEY, []);
    this.model = new EditorContextModel(workspaceRoot, pinnedPaths);
    this.bridge = new EditorContextBridge({
      storageDirectory: (options.extensionContext.storageUri ?? options.extensionContext.globalStorageUri).fsPath,
      pluginPath: options.pluginPath,
      workspaceClientPath: options.workspaceClientPath,
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
    await controller.bridge.initialize();
    controller.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => controller.refresh()),
    );
    if (options.editorContextEnabled) {
      controller.disposables.push(
        vscode.window.onDidChangeVisibleTextEditors(() => controller.refresh()),
        vscode.window.onDidChangeTextEditorSelection(() => controller.refresh()),
        vscode.workspace.onDidChangeTextDocument(() => controller.refresh()),
        vscode.workspace.onDidSaveTextDocument(() => controller.refresh()),
      );
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
    for (const disposable of this.disposables) disposable.dispose();
    await this.bridge.dispose();
  }

  private refresh(): void {
    if (this.disposed) return;
    const workspaceRoot = this.options.workspaceRoot();
    if (workspaceRoot !== undefined) this.model.setWorkspaceRoot(workspaceRoot);
    const activeEditor = vscode.window.activeTextEditor;
    const visibleFiles: VisibleEditorFile[] = this.options.editorContextEnabled
      ? vscode.window.visibleTextEditors.flatMap((editor) => {
        const file = toVisibleEditorFile(editor, activeEditor);
        return file === undefined ? [] : [file];
      })
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
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === "file" ? uri.fsPath : undefined;
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
