/** Verifies the editor-context model through its public snapshot interface. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorContextModel, type VisibleNotebookEditorFile, type VisibleTextEditorFile } from "./editor-context";

describe("EditorContextModel", () => {
  it("deduplicates a file shown in multiple editor groups", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    model.updateVisible([
      {
        editorType: "text",
        path: "C:\\work\\same.ts", languageId: "typescript", dirty: false, active: false,
        selections: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
      },
      {
        editorType: "text",
        path: "C:\\WORK\\same.ts", languageId: "typescript", dirty: false, active: true,
        selections: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }],
      },
    ]);
    const snapshot = model.snapshot(1_000, 45_000);
    assert.equal(snapshot.files.length, 1);
    assert.equal(snapshot.files[0]?.active, true);
    const file = snapshot.files[0];
    assert.equal(file?.editorType, "text");
    if (file?.editorType === "text") assert.equal(file.selections.length, 2);
  });

  it("publishes visible file metadata with the active file first", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    model.updateVisible([
      {
        editorType: "text",
        path: "C:\\work\\src\\secondary.ts",
        languageId: "typescript",
        dirty: false,
        active: false,
        selections: [{ startLine: 5, startColumn: 2, endLine: 5, endColumn: 8 }],
      },
      {
        editorType: "text",
        path: "C:\\work\\src\\active.ts",
        languageId: "typescript",
        dirty: true,
        active: true,
        selections: [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 4 }],
      },
    ]);

    assert.deepEqual(model.snapshot(1_000, 45_000), {
      version: 2,
      expiresAt: 46_000,
      workspaceRoot: "C:\\work",
      files: [
        {
          path: "C:\\work\\src\\active.ts",
          relativePath: "src\\active.ts",
          source: "visible",
          active: true,
          languageId: "typescript",
          editorType: "text",
          dirty: true,
          selections: [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 4 }],
        },
        {
          path: "C:\\work\\src\\secondary.ts",
          relativePath: "src\\secondary.ts",
          source: "visible",
          active: false,
          languageId: "typescript",
          editorType: "text",
          dirty: false,
          selections: [{ startLine: 5, startColumn: 2, endLine: 5, endColumn: 8 }],
        },
      ],
    });
  });
  it("requires session approval for visible files outside the DSH workspace", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    const external: VisibleTextEditorFile = {
      editorType: "text",
      path: "D:\\shared\\notes.md",
      languageId: "markdown",
      dirty: false,
      active: true,
      selections: [],
    };

    assert.deepEqual(model.updateVisible([external]), ["D:\\shared\\notes.md"]);
    assert.deepEqual(model.snapshot(1_000, 45_000).files, []);

    model.allowExternal(external.path);
    assert.deepEqual(model.updateVisible([external]), []);
    assert.equal(model.snapshot(1_000, 45_000).files[0]?.path, external.path);
    assert.equal(model.snapshot(1_000, 45_000).files[0]?.relativePath, undefined);

    model.updateVisible([]);
    assert.deepEqual(model.snapshot(1_000, 45_000).files, []);
  });
  it("keeps manually pinned files without duplicating visible metadata", () => {
    const pinnedPath = "D:\\shared\\pinned.md";
    const model = new EditorContextModel("C:\\work", [pinnedPath], "win32");

    assert.deepEqual(model.updateVisible([{
      path: pinnedPath,
      languageId: "markdown",
      editorType: "text",
      dirty: true,
      active: true,
      selections: [{ startLine: 7, startColumn: 1, endLine: 7, endColumn: 3 }],
    }]), []);
    assert.deepEqual(model.snapshot(1_000, 45_000).files, [{
      path: pinnedPath,
      source: "pinned",
      active: true,
      languageId: "markdown",
      dirty: true,
      editorType: "text",
      selections: [{ startLine: 7, startColumn: 1, endLine: 7, endColumn: 3 }],
    }]);

    assert.equal(model.pin("C:\\work\\README.md"), true);
    assert.equal(model.pin("c:\\WORK\\readme.md"), false);
    assert.deepEqual(model.pinnedPaths(), [pinnedPath, "C:\\work\\README.md"]);

    model.updateVisible([]);
    assert.equal(model.snapshot(1_000, 45_000).files.length, 2);
    assert.equal(model.unpin(pinnedPath), true);
    assert.equal(model.snapshot(1_000, 45_000).files.length, 1);
  });

  it("removes deleted pins and migrates pins when a path is renamed", () => {
    const work = String.raw`C:\work`;
    const deleted = String.raw`C:\work\deleted.ts`;
    const oldChild = String.raw`C:\work\folder\kept.ts`;
    const other = String.raw`C:\work\other.ts`;
    const renamedChild = String.raw`C:\work\renamed\kept.ts`;
    const model = new EditorContextModel(work, [deleted, oldChild, other], "win32");

    assert.equal(model.removePinnedPathsAtOrBelow(deleted), true);
    assert.equal(model.movePinnedPathsAtOrBelow(String.raw`C:\work\folder`, String.raw`C:\work\renamed`), true);
    assert.deepEqual(model.pinnedPaths(), [other, renamedChild]);
    const snapshotPaths = model.snapshot(1_000, 45_000).files.map((file) => file.path);
    assert.equal(snapshotPaths.includes(deleted), false);
    assert.equal(snapshotPaths.includes(oldChild), false);
  });

  it("re-roots snapshots without losing pinned files", () => {
    const model = new EditorContextModel("C:\\first", ["C:\\second\\pinned.ts"], "win32");
    assert.equal(model.setWorkspaceRoot("C:\\second"), true);
    assert.equal(model.setWorkspaceRoot("c:/second/"), false);
    const snapshot = model.snapshot(1_000, 45_000);
    assert.equal(snapshot.workspaceRoot, "C:\\second");
    assert.equal(snapshot.files[0]?.relativePath, "pinned.ts");
  });

  it("publishes structured Notebook cells and falls back to a file record when pinned and hidden", () => {
    const notebookPath = "C:\\work\\analysis.ipynb";
    const model = new EditorContextModel("C:\\work", [notebookPath], "win32");
    model.updateVisible([{
      editorType: "notebook",
      path: notebookPath,
      active: true,
      dirty: true,
      notebookType: "jupyter-notebook",
      cellsTruncated: false,
      cells: [{
        index: 3,
        kind: "code",
        languageId: "python",
        active: true,
        selected: true,
        selections: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 }],
      }],
    }]);

    assert.deepEqual(model.snapshot(1_000, 45_000).files, [{
      editorType: "notebook",
      path: notebookPath,
      relativePath: "analysis.ipynb",
      source: "pinned",
      active: true,
      dirty: true,
      notebookType: "jupyter-notebook",
      cellsTruncated: false,
      cells: [{
        index: 3,
        kind: "code",
        languageId: "python",
        active: true,
        selected: true,
        selections: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 }],
      }],
    }]);

    model.updateVisible([]);
    assert.deepEqual(model.snapshot(1_000, 45_000).files, [{
      editorType: "file",
      path: notebookPath,
      relativePath: "analysis.ipynb",
      source: "pinned",
      active: false,
      dirty: false,
    }]);
  });

  it("deduplicates split Notebook views without exceeding the cell limit", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    const view = (start: number, activeIndex?: number): VisibleNotebookEditorFile => ({
      editorType: "notebook",
      path: "C:\\work\\analysis.ipynb",
      active: activeIndex !== undefined,
      dirty: false,
      notebookType: "jupyter-notebook",
      cellsTruncated: false,
      cells: Array.from({ length: 100 }, (_, offset) => {
        const index = start + offset;
        return {
          index,
          kind: "code",
          languageId: "python",
          active: index === activeIndex,
          selected: true,
          selections: [],
        };
      }),
    });

    model.updateVisible([view(1), view(51, 150)]);
    const file = model.snapshot(1_000, 45_000).files[0];
    assert.equal(file?.editorType, "notebook");
    if (file?.editorType === "notebook") {
      assert.equal(file.cells.length, 100);
      assert.equal(file.cellsTruncated, true);
      assert.equal(file.cells[0]?.index, 150);
    }
  });
});
