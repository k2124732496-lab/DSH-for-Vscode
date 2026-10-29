/** Verifies the private UTF-8 bridge between VS Code and the DSH prompt plugin. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EditorContextBridge } from "./editor-context-bridge";

describe("EditorContextBridge", () => {
  it("atomically writes metadata and a patch with the plugin before web arguments", async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), "dsh-vscode-context-"));
    const bridge = new EditorContextBridge({
      storageDirectory,
      pluginPath: join(process.cwd(), "dsh", "editor-context-plugin.mjs"),
      editorContextEnabled: true,
      workspaceSyncEnabled: true,
      activationId: "test-activation",
      now: () => 1_000,
      snapshot: (now, ttlMs) => ({
        version: 2,
        expiresAt: now + ttlMs,
        workspaceRoot: "C:\\work\\project",
        files: [{
          path: "C:\\work\\project\\\u4f60\u597d.ts",
          relativePath: "\u4f60\u597d.ts",
          source: "visible",
          active: true,
          editorType: "text",
          languageId: "typescript",
          dirty: false,
          selections: [],
        }],
      }),
    });

    await bridge.initialize();
    const snapshotText = await readFile(bridge.contextPath, "utf8");
    assert.match(snapshotText, /\u4f60\u597d\.ts/);
    assert.doesNotMatch(snapshotText, /documentText|fileContents/);
    assert.equal(JSON.parse(snapshotText).expiresAt, 46_000);

    const patchText = await readFile(bridge.patchPath, "utf8");
    assert.match(patchText, /id: vscode-integration/);
    assert.match(patchText, /editor-context-plugin\.mjs/);
    assert.match(patchText, /workspaceSyncEnabled: true/);
    assert.match(patchText, /editorContextEnabled: true/);
    assert.match(patchText, /contextFile/);

    await bridge.dispose();
    await assert.rejects(() => stat(bridge.runtimeDirectory), /ENOENT/);
  });
});
