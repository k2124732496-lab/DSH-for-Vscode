/** Verifies VS Code editor metadata conversion without starting an extension host. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { integrationSnapshot, toVisibleEditorFile } from "./editor-context-vscode";

function editor(scheme: string): vscode.TextEditor {
  return {
    document: {
      uri: { scheme, fsPath: "C:\\work\\sample.ts" },
      languageId: "typescript",
      isDirty: true,
    },
    selections: [{
      start: { line: 0, character: 2 },
      end: { line: 3, character: 4 },
    }],
  } as unknown as vscode.TextEditor;
}

describe("toVisibleEditorFile", () => {
  it("maps local metadata with one-based selections and no document contents", () => {
    const activeEditor = editor("file");
    assert.deepEqual(toVisibleEditorFile(activeEditor, activeEditor), {
      editorType: "text",
      path: "C:\\work\\sample.ts",
      languageId: "typescript",
      dirty: true,
      active: true,
      selections: [{ startLine: 1, startColumn: 3, endLine: 4, endColumn: 5 }],
    });
  });

  it("rejects virtual, untitled, and remote editors", () => {
    for (const scheme of ["git", "untitled", "output", "vscode-remote"]) {
      assert.equal(toVisibleEditorFile(editor(scheme), undefined), undefined);
    }
  });
});

describe("integrationSnapshot", () => {
  it("keeps the root but strips every file when editor context is disabled", () => {
    const snapshot = integrationSnapshot({
      version: 2,
      expiresAt: 46_000,
      workspaceRoot: "C:\\OLED",
      files: [{
        path: "C:\\OLED\\secret.c",
        relativePath: "secret.c",
        source: "visible",
        active: true,
        editorType: "text",
        languageId: "c",
        dirty: false,
        selections: [],
      }],
    }, false);
    assert.equal(snapshot.workspaceRoot, "C:\\OLED");
    assert.deepEqual(snapshot.files, []);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret\.c/);
  });
});
