/** Runs an opt-in end-to-end DSH smoke test and always cleans its child process and profile. */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverDsh, realDiscoveryEnv } from "../src/discovery";
import { buildSpawn, defaultNodeBin, killTree, parseWebUrl, probeHealth, scrubExtensionHostEnv } from "../src/server";
import { EditorContextBridge } from "../src/editor-context-bridge";
import type { ParsedWebUrl } from "../src/server";

const outputFile = join(process.cwd(), ".smoke-out.log");
const dshHome = join(process.cwd(), ".smoke-dsh");
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  let child: ChildProcess | undefined;
  let fileDescriptor: number | undefined;
  let bridge: EditorContextBridge | undefined;
  try {
    const location = await discoverDsh("", realDiscoveryEnv());
    bridge = new EditorContextBridge({
      storageDirectory: dshHome,
      pluginPath: join(process.cwd(), "dsh", "editor-context-plugin.mjs"),
      workspaceClientPath: join(process.cwd(), "dsh", "workspace-sync-client.js"),
      editorContextEnabled: false,
      workspaceSyncEnabled: true,
      snapshot: (now, ttlMs) => ({ version: 1, expiresAt: now + ttlMs, workspaceRoot: process.cwd(), files: [] }),
    });
    await bridge.initialize();
    const spec = buildSpawn(location, ["--profile", "web", "--patch", bridge.patchPath, "--host", "127.0.0.1", "--port", "0"], process.platform, defaultNodeBin());
    rmSync(outputFile, { force: true });
    fileDescriptor = openSync(outputFile, "w");
    child = spawn(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...scrubExtensionHostEnv(process.env), DSH_HOME: dshHome },
      stdio: ["ignore", fileDescriptor, "inherit"],
    });

    const deadline = Date.now() + 60_000;
    let parsed: ParsedWebUrl | undefined;
    while (parsed === undefined && Date.now() < deadline) {
      if (existsSync(outputFile)) {
        for (const line of readFileSync(outputFile, "utf8").split(/\r?\n/)) {
          parsed = parseWebUrl(line);
          if (parsed !== undefined) break;
        }
      }
      if (parsed === undefined) await wait(300);
    }
    if (parsed === undefined) throw new Error("dsh never printed its URL within 60s");

    let alive = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      alive = await probeHealth(parsed.url, 1000);
      if (alive) break;
      await wait(500);
    }
    if (!alive) throw new Error(`DSH was not reachable at ${parsed.url}`);
    const indexHtml = await (await fetch(parsed.url)).text();
    if (!indexHtml.includes("integration:vscode-workspace-sync")) {
      throw new Error("DSH index did not include the VS Code workspace client entry");
    }
    const stateUrl = new URL(`/__dsh_vscode/${bridge.routeToken}/state.json`, parsed.url);
    const bridgeState = await (await fetch(stateUrl)).json() as { workspaceRoot?: string };
    if (bridgeState.workspaceRoot !== process.cwd()) throw new Error("DSH workspace bridge returned the wrong root");
    console.log(`DSH smoke test passed at ${parsed.url}`);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (child?.pid !== undefined) await killTree(child.pid, process.platform);
    await bridge?.dispose();
    if (existsSync(outputFile)) unlinkSync(outputFile);
    rmSync(dshHome, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
