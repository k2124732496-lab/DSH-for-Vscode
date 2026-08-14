// End-to-end smoke test against the real dsh binary: discovery → spawn
// `dsh web --port 0` → parse the printed URL → health probe → tree kill.
// Exercises exactly the code path the extension runs. DSH_HOME is redirected
// to a workspace-local directory so the run stays self-contained.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverDsh, realDiscoveryEnv } from "../src/discovery";
import { buildSpawn, defaultNodeBin, killTree, parseWebUrl, probeHealth, scrubExtensionHostEnv } from "../src/server";
import type { ParsedWebUrl } from "../src/server";

const OUT_FILE = join(process.cwd(), ".smoke-out.log");
const DSH_HOME = join(process.cwd(), ".smoke-dsh");

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const location = await discoverDsh("", realDiscoveryEnv());
  console.log(`discovered: ${location.kind} ${location.path}`);

  const spec = buildSpawn(
    location,
    ["--profile", "web", "--host", "127.0.0.1", "--port", "0"],
    process.platform,
    defaultNodeBin(),
  );
  console.log(`spawn: ${spec.command} ${spec.args.join(" ")} (shell=${spec.shell ?? false})`);

  // Sandbox-safe stdio: stdout goes to a file we tail (no pipes involved).
  rmSync(OUT_FILE, { force: true });
  const fd = openSync(OUT_FILE, "w");
  const child = spawn(spec.command, spec.args, {
    shell: spec.shell ?? false,
    windowsHide: true,
    cwd: process.cwd(),
    env: { ...scrubExtensionHostEnv(process.env), DSH_HOME },
    stdio: ["ignore", fd, "inherit"],
  });

  const deadline = Date.now() + 60_000;
  let parsed: ParsedWebUrl | undefined;
  while (parsed === undefined && Date.now() < deadline) {
    try {
      const content = readFileSync(OUT_FILE, "utf8");
      console.log(`[out] ${content.trimEnd()}`);
      for (const line of content.split(/\r?\n/)) {
        parsed = parseWebUrl(line);
        if (parsed !== undefined) break;
      }
    } catch {
      /* file not yet written */
    }
    if (parsed !== undefined) break;
    await wait(300);
  }
  closeSync(fd);

  if (parsed === undefined) {
    console.error("dsh never printed its URL within 60s");
    unlinkSync(OUT_FILE);
    process.exit(1);
  }
  console.log(`parsed URL: ${parsed.url} (port ${parsed.port})`);

  let alive = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    alive = await probeHealth(`${parsed.url}/`, 1000);
    if (alive) break;
    await wait(500);
  }
  console.log(`health probe: ${alive ? "OK" : "FAILED"}`);

  const pid = child.pid;
  await killTree(pid ?? -1, process.platform);
  await wait(500);
  console.log(`tree-killed pid ${pid ?? "?"}`);

  unlinkSync(OUT_FILE);
  rmSync(DSH_HOME, { recursive: true, force: true });

  if (!alive || parsed.port <= 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
