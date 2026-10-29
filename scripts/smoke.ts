/** Runs an opt-in end-to-end DSH smoke test and always cleans its child process and profile. */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverDsh, realDiscoveryEnv } from "../src/discovery";
import { buildSpawn, defaultNodeBin, killTree, parseWebUrl, probeHealth, scrubExtensionHostEnv } from "../src/server";
import { EditorContextBridge } from "../src/editor-context-bridge";
import { runBrowserSmoke } from "./browser-smoke";
import { DshFrameProxy } from "../src/frame-proxy";
import type { ParsedWebUrl } from "../src/server";

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  let child: ChildProcess | undefined;
  let fileDescriptor: number | undefined;
  let bridge: EditorContextBridge | undefined;
  const frameProxy = new DshFrameProxy();
  const runtimeDirectory = mkdtempSync(join(process.cwd(), ".smoke-dsh-"));
  const outputFile = join(runtimeDirectory, "output.log");
  const dshHome = join(runtimeDirectory, "home");
  const firstRoot = join(runtimeDirectory, "first-project");
  const secondRoot = join(runtimeDirectory, "second-project");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  let workspaceRoot = firstRoot;
  try {
    const pathOption = process.argv.indexOf("--dsh-path");
    const location = await discoverDsh(pathOption < 0 ? "" : process.argv[pathOption + 1] ?? "", realDiscoveryEnv());
    bridge = new EditorContextBridge({
      storageDirectory: dshHome,
      pluginPath: join(process.cwd(), "dsh", "editor-context-plugin.mjs"),
      editorContextEnabled: true,
      workspaceSyncEnabled: true,
      snapshot: (now, ttlMs) => ({ version: 2, expiresAt: now + ttlMs, workspaceRoot, files: [] }),
    });
    await bridge.initialize();
    const spec = buildSpawn(location, ["--profile", "web", "--patch", bridge.patchPath, "--host", "127.0.0.1", "--port", "0", "--no-open"], process.platform, defaultNodeBin());
    rmSync(outputFile, { force: true });
    fileDescriptor = openSync(outputFile, "w");
    child = spawn(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...scrubExtensionHostEnv(process.env), DSH_HOME: dshHome },
      stdio: ["ignore", fileDescriptor, fileDescriptor],
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });

    const deadline = Date.now() + 60_000;
    let parsed: ParsedWebUrl | undefined;
    while (parsed === undefined && Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError;
      if (child.exitCode !== null) throw new Error(`DSH exited before readiness: ${readFileSync(outputFile, "utf8")}`);
      if (existsSync(outputFile)) {
        for (const line of readFileSync(outputFile, "utf8").split(/\r?\n/)) {
          parsed = parseWebUrl(line);
          if (parsed !== undefined) break;
        }
      }
      if (parsed === undefined) await wait(300);
    }
    if (parsed === undefined) throw new Error(`dsh never printed its URL within 60s: ${readFileSync(outputFile, "utf8")}`);

    let alive = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      alive = await probeHealth(parsed.url, 1000);
      if (alive) break;
      await wait(500);
    }
    if (!alive) throw new Error(`DSH was not reachable at ${parsed.url}`);
    const login = await fetch(parsed.url, { redirect: "manual" });
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers: Record<string, string> = cookie === "" ? {} : { cookie };
    let indexHtml = "";
    const integrationDeadline = Date.now() + 15_000;
    do {
      indexHtml = await (await fetch(new URL("./", parsed.url), { headers })).text();
      if (indexHtml.includes("dsh-vscode-integration")) break;
      await wait(250);
    } while (Date.now() < integrationDeadline);
    if (!indexHtml.includes("dsh-vscode-integration")) {
      throw new Error(`DSH index did not include the VS Code workspace client entry; HTTP body: ${indexHtml.slice(0, 300)}`);
    }
    const stateUrl = new URL(`/__dsh_vscode/${bridge.routeToken}/state.json`, parsed.url);
    const bridgeState = await (await fetch(stateUrl, { headers })).json() as { workspaceRoot?: string };
    if (bridgeState.workspaceRoot !== firstRoot) throw new Error("DSH workspace bridge returned the wrong root");
    if (process.argv.includes("--browser")) {
      const frameUrl = await frameProxy.open(parsed.url);
      await runBrowserSmoke(frameUrl, firstRoot, secondRoot, runtimeDirectory, async () => {
        workspaceRoot = secondRoot;
        await bridge!.writeNow();
      });
    }
    console.log(`DSH smoke test passed at ${new URL(parsed.url).origin}`);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    await frameProxy.dispose();
    if (child?.pid !== undefined) await killTree(child.pid, process.platform);
    await bridge?.dispose();
    rmSync(runtimeDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
