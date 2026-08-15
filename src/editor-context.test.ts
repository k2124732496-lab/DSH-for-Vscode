/** Verifies the editor-context model through its public snapshot interface. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorContextModel } from "./editor-context";

describe("EditorContextModel", () => {
  it("deduplicates a file shown in multiple editor groups", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    model.updateVisible([
      {
        path: "C:\\work\\same.ts", languageId: "typescript", dirty: false, active: false,
        selections: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
      },
      {
        path: "C:\\WORK\\same.ts", languageId: "typescript", dirty: false, active: true,
        selections: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }],
      },
    ]);
    const snapshot = model.snapshot(1_000, 45_000);
    assert.equal(snapshot.files.length, 1);
    assert.equal(snapshot.files[0]?.active, true);
    assert.equal(snapshot.files[0]?.selections.length, 2);
  });

  it("publishes visible file metadata with the active file first", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    model.updateVisible([
      {
        path: "C:\\work\\src\\secondary.ts",
        languageId: "typescript",
        dirty: false,
        active: false,
        selections: [{ startLine: 5, startColumn: 2, endLine: 5, endColumn: 8 }],
      },
      {
        path: "C:\\work\\src\\active.ts",
        languageId: "typescript",
        dirty: true,
        active: true,
        selections: [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 4 }],
      },
    ]);

    assert.deepEqual(model.snapshot(1_000, 45_000), {
      version: 1,
      expiresAt: 46_000,
      workspaceRoot: "C:\\work",
      files: [
        {
          path: "C:\\work\\src\\active.ts",
          relativePath: "src\\active.ts",
          source: "visible",
          active: true,
          languageId: "typescript",
          dirty: true,
          selections: [{ startLine: 1, startColumn: 1, endLine: 3, endColumn: 4 }],
        },
        {
          path: "C:\\work\\src\\secondary.ts",
          relativePath: "src\\secondary.ts",
          source: "visible",
          active: false,
          languageId: "typescript",
          dirty: false,
          selections: [{ startLine: 5, startColumn: 2, endLine: 5, endColumn: 8 }],
        },
      ],
    });
  });
  it("requires session approval for visible files outside the DSH workspace", () => {
    const model = new EditorContextModel("C:\\work", [], "win32");
    const external = {
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

  it("re-roots snapshots without losing pinned files", () => {
    const model = new EditorContextModel("C:\\first", ["C:\\second\\pinned.ts"], "win32");
    assert.equal(model.setWorkspaceRoot("C:\\second"), true);
    assert.equal(model.setWorkspaceRoot("c:/second/"), false);
    const snapshot = model.snapshot(1_000, 45_000);
    assert.equal(snapshot.workspaceRoot, "C:\\second");
    assert.equal(snapshot.files[0]?.relativePath, "pinned.ts");
  });
});
