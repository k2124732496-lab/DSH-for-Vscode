/** Adapts VS Code Notebook editors into short-lived, content-free DSH metadata. */
import type * as vscode from "vscode";
import {
  MAX_SELECTIONS_PER_EDITOR,
  MAX_NOTEBOOK_CONTEXT_CELLS,
  type EditorSelectionSnapshot,
  type NotebookCellSnapshot,
  type VisibleNotebookEditorFile,
} from "./editor-context";

const NOTEBOOK_CELL_KIND_CODE = 2;

function uriKey(uri: vscode.Uri): string {
  return uri.toString();
}

function toSelections(selections: readonly vscode.Selection[]): EditorSelectionSnapshot[] {
  return selections.slice(0, MAX_SELECTIONS_PER_EDITOR).map((selection) => ({
    startLine: selection.start.line + 1,
    startColumn: selection.start.character + 1,
    endLine: selection.end.line + 1,
    endColumn: selection.end.character + 1,
  }));
}

/** Keeps cell selection events behind a small adapter; no document contents are read. */
export class NotebookContextAdapter {
  private readonly selectionCache = new Map<string, EditorSelectionSnapshot[]>();

  recordTextEditorSelection(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "vscode-notebook-cell") return;
    this.selectionCache.set(uriKey(editor.document.uri), toSelections(editor.selections));
  }

  forgetNotebook(notebook: vscode.NotebookDocument): void {
    for (const cell of notebook.getCells()) this.selectionCache.delete(uriKey(cell.document.uri));
  }

  collect(
    visibleEditors: readonly vscode.NotebookEditor[],
    activeEditor: vscode.NotebookEditor | undefined,
    activeTextEditor: vscode.TextEditor | undefined,
  ): VisibleNotebookEditorFile[] {
    if (activeTextEditor?.document.uri.scheme === "vscode-notebook-cell") {
      this.recordTextEditorSelection(activeTextEditor);
    }

    const visibleCellKeys = new Set<string>();
    const files = visibleEditors.flatMap((editor) => {
      if (editor.notebook.uri.scheme !== "file") return [];
      const cells = editor.notebook.getCells();
      for (const cell of cells) visibleCellKeys.add(uriKey(cell.document.uri));

      const activeCellIndex = editor === activeEditor
        ? this.findActiveCellIndex(cells, activeTextEditor) ?? this.firstSelectedIndex(editor, cells.length)
        : undefined;
      const selectedIndices = this.selectedCellIndices(editor, cells.length, activeCellIndex);
      const cellsTruncated = selectedIndices.length > MAX_NOTEBOOK_CONTEXT_CELLS;
      const selectedCells = selectedIndices.slice(0, MAX_NOTEBOOK_CONTEXT_CELLS).map((index): NotebookCellSnapshot => {
        const cell = cells[index]!;
        return {
          index: index + 1,
          kind: cell.kind === NOTEBOOK_CELL_KIND_CODE ? "code" : "markup",
          languageId: cell.document.languageId,
          active: index === activeCellIndex,
          selected: this.isSelected(editor, index),
          selections: this.selectionCache.get(uriKey(cell.document.uri))?.map((selection) => ({ ...selection })) ?? [],
        };
      });

      return [{
        editorType: "notebook" as const,
        path: editor.notebook.uri.fsPath,
        active: editor === activeEditor,
        dirty: editor.notebook.isDirty,
        notebookType: editor.notebook.notebookType,
        cells: selectedCells,
        cellsTruncated,
      }];
    });

    for (const key of this.selectionCache.keys()) {
      if (!visibleCellKeys.has(key)) this.selectionCache.delete(key);
    }
    return files;
  }

  private findActiveCellIndex(
    cells: readonly vscode.NotebookCell[],
    activeTextEditor: vscode.TextEditor | undefined,
  ): number | undefined {
    if (activeTextEditor?.document.uri.scheme !== "vscode-notebook-cell") return undefined;
    const activeKey = uriKey(activeTextEditor.document.uri);
    const index = cells.findIndex((cell) => uriKey(cell.document.uri) === activeKey);
    return index >= 0 ? index : undefined;
  }

  private firstSelectedIndex(editor: vscode.NotebookEditor, cellCount: number): number | undefined {
    const index = editor.selection.start;
    return index >= 0 && index < cellCount ? index : undefined;
  }

  private isSelected(editor: vscode.NotebookEditor, index: number): boolean {
    return editor.selections.some((range) => index >= range.start && index < range.end);
  }

  private selectedCellIndices(
    editor: vscode.NotebookEditor,
    cellCount: number,
    activeCellIndex: number | undefined,
  ): number[] {
    const indices: number[] = [];
    const seen = new Set<number>();
    const add = (index: number): void => {
      if (index < 0 || index >= cellCount || seen.has(index)) return;
      seen.add(index);
      indices.push(index);
    };
    if (activeCellIndex !== undefined) add(activeCellIndex);
    for (const range of editor.selections) {
      const start = Math.max(0, range.start);
      const end = Math.min(cellCount, range.end);
      for (let index = start; index < end; index += 1) {
        add(index);
        if (indices.length > MAX_NOTEBOOK_CONTEXT_CELLS) return indices;
      }
    }
    return indices;
  }
}
