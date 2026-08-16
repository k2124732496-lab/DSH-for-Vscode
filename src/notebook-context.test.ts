/** Verifies Notebook metadata collection without reading cell bodies or outputs. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { NotebookContextAdapter } from "./notebook-context";

function uri(scheme: string, fsPath: string, value: string): vscode.Uri {
  return { scheme, fsPath, toString: () => value } as vscode.Uri;
}

function selection(startLine: number, startCharacter: number, endLine: number, endCharacter: number): vscode.Selection {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  } as vscode.Selection;
}

function notebookFixture(): {
  notebook: vscode.NotebookDocument;
  editor: vscode.NotebookEditor;
  cellEditor: vscode.TextEditor;
} {
  const notebookUri = uri("file", "C:\\work\\analysis.ipynb", "file:///C:/work/analysis.ipynb");
  const cells = [
    {
      index: 0,
      kind: 1,
      document: {
        uri: uri("vscode-notebook-cell", "", "vscode-notebook-cell:/C:/work/analysis.ipynb#W0sZmlsZQ%3D%3D"),
        languageId: "markdown",
      },
    },
    {
      index: 1,
      kind: 2,
      document: {
        uri: uri("vscode-notebook-cell", "", "vscode-notebook-cell:/C:/work/analysis.ipynb#W1sZmlsZQ%3D%3D"),
        languageId: "python",
      },
    },
  ] as vscode.NotebookCell[];
  const notebook = {
    uri: notebookUri,
    notebookType: "jupyter-notebook",
    isDirty: true,
    cellCount: cells.length,
    getCells: () => cells,
  } as unknown as vscode.NotebookDocument;
  const editor = {
    notebook,
    selection: { start: 1, end: 2 },
    selections: [{ start: 1, end: 2 }],
  } as unknown as vscode.NotebookEditor;
  const cellEditor = {
    document: cells[1]?.document,
    selections: [selection(2, 4, 4, 8), selection(6, 0, 6, 3)],
  } as unknown as vscode.TextEditor;
  return { notebook, editor, cellEditor };
}

describe("NotebookContextAdapter", () => {
  it("maps an active local notebook and cell selections without reading contents", () => {
    const { editor, cellEditor } = notebookFixture();
    const adapter = new NotebookContextAdapter();
    adapter.recordTextEditorSelection(cellEditor);

    assert.deepEqual(adapter.collect([editor], editor, cellEditor), [{
      editorType: "notebook",
      path: "C:\\work\\analysis.ipynb",
      active: true,
      dirty: true,
      notebookType: "jupyter-notebook",
      cellsTruncated: false,
      cells: [{
        index: 2,
        kind: "code",
        languageId: "python",
        active: true,
        selected: true,
        selections: [
          { startLine: 3, startColumn: 5, endLine: 5, endColumn: 9 },
          { startLine: 7, startColumn: 1, endLine: 7, endColumn: 4 },
        ],
      }],
    }]);
  });

  it("ignores non-local and untitled notebooks", () => {
    const { editor } = notebookFixture();
    const adapter = new NotebookContextAdapter();
    for (const scheme of ["untitled", "vscode-remote", "interactive"]) {
      const remoteEditor = {
        ...editor,
        notebook: {
          ...editor.notebook,
          uri: uri(scheme, "", `${scheme}:/analysis.ipynb`),
        },
      } as unknown as vscode.NotebookEditor;
      assert.deepEqual(adapter.collect([remoteEditor], remoteEditor, undefined), []);
    }
  });

  it("puts the active cell first and truncates more than 100 selected cells", () => {
    const notebookUri = uri("file", "C:\\work\\large.ipynb", "file:///C:/work/large.ipynb");
    const cells = Array.from({ length: 105 }, (_, index) => ({
      index,
      kind: index % 2 === 0 ? 2 : 1,
      document: {
        uri: uri("vscode-notebook-cell", "", `vscode-notebook-cell:/large.ipynb#${String(index)}`),
        languageId: index % 2 === 0 ? "python" : "markdown",
      },
    })) as vscode.NotebookCell[];
    const notebook = {
      uri: notebookUri,
      notebookType: "jupyter-notebook",
      isDirty: false,
      cellCount: cells.length,
      getCells: () => cells,
    } as unknown as vscode.NotebookDocument;
    const editor = {
      notebook,
      selection: { start: 104, end: 105 },
      selections: [{ start: 0, end: 105 }],
    } as unknown as vscode.NotebookEditor;
    const activeCellEditor = {
      document: cells[104]?.document,
      selections: [],
    } as unknown as vscode.TextEditor;

    const [file] = new NotebookContextAdapter().collect([editor], editor, activeCellEditor);
    assert.equal(file?.cellsTruncated, true);
    assert.equal(file?.cells.length, 100);
    assert.equal(file?.cells[0]?.index, 105);
    assert.equal(file?.cells[0]?.active, true);
    assert.equal(file?.cells[0]?.selected, true);
    assert.equal(file?.cells.some((cell) => cell.kind === "markup"), true);
  });

  it("clears cached selections when a notebook closes", () => {
    const { notebook, editor, cellEditor } = notebookFixture();
    const adapter = new NotebookContextAdapter();
    adapter.recordTextEditorSelection(cellEditor);
    adapter.forgetNotebook(notebook);

    const [file] = adapter.collect([editor], editor, undefined);
    assert.equal(file?.cells[0]?.index, 2);
    assert.deepEqual(file?.cells[0]?.selections, []);
  });

  it("reflects Notebook dirty and saved state without caching it", () => {
    const { notebook, editor } = notebookFixture();
    const adapter = new NotebookContextAdapter();
    assert.equal(adapter.collect([editor], editor, undefined)[0]?.dirty, true);

    (notebook as { isDirty: boolean }).isDirty = false;
    assert.equal(adapter.collect([editor], editor, undefined)[0]?.dirty, false);
  });
});
