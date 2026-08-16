/** Verifies setting defaults, explicit environment overrides, and input validation. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectActiveResourceUri, selectWorkspaceRoot, validateSettings } from "./config";

describe("validateSettings", () => {
  it("does not start DSH automatically by default", () => {
    const settings = validateSettings({});
    assert.equal(settings.autoStart, false);
    assert.equal(settings.workspaceSyncEnabled, true);
    assert.equal(settings.editorContextEnabled, false);
  });

  it("accepts the explicit editor context opt-in", () => {
    assert.equal(validateSettings({ editorContextEnabled: true }).editorContextEnabled, true);
  });

  it("allows explicitly configured host variables after inherited values are scrubbed", () => {
    const settings = validateSettings({
      extraEnv: {
        NODE_OPTIONS: "--trace-warnings",
        ELECTRON_RUN_AS_NODE: "0",
        VSCODE_EXPLICIT_OVERRIDE: "enabled",
      },
    });
    assert.deepEqual(settings.extraEnv, {
      NODE_OPTIONS: "--trace-warnings",
      ELECTRON_RUN_AS_NODE: "0",
      VSCODE_EXPLICIT_OVERRIDE: "enabled",
    });
  });

  it("still rejects invalid names and non-string values", () => {
    assert.throws(() => validateSettings({ extraEnv: { "NOT-VALID": "x" } }), /invalid name/);
    assert.throws(() => validateSettings({ extraEnv: { VALID_NAME: 42 } }), /must be a string/);
  });
  it("reserves the launcher patch argument for the managed integration", () => {
    assert.throws(() => validateSettings({ extraArgs: ["--patch", "other.yaml"] }), /cannot override/);
  });
});

describe("selectWorkspaceRoot", () => {
  const first = { uri: { scheme: "file", fsPath: "C:\\first" } };
  const second = { uri: { scheme: "file", fsPath: "C:\\second" } };
  it("uses the active Notebook tab instead of its virtual cell editor", () => {
    const notebookUri = { scheme: "file", fsPath: "C:\\second\\analysis.ipynb" };
    assert.equal(selectActiveResourceUri(
      notebookUri,
      { scheme: "vscode-notebook-cell", fsPath: "" },
      notebookUri,
    ), notebookUri);
  });


  it("uses the active file's workspace in a multi-root window", () => {
    assert.equal(selectWorkspaceRoot([first, second], { scheme: "file" }, second), "C:\\second");
  });

  it("falls back to the first local root for external or virtual files", () => {
    assert.equal(selectWorkspaceRoot([first, second], { scheme: "file" }, undefined), "C:\\first");
    assert.equal(selectWorkspaceRoot([first, second], { scheme: "untitled" }, second), "C:\\first");
  });

  it("ignores remote roots", () => {
    const remote = { uri: { scheme: "vscode-remote", fsPath: "/remote" } };
    assert.equal(selectWorkspaceRoot([remote, second], undefined, undefined), "C:\\second");
  });
});
