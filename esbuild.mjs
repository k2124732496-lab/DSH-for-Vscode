// Bundle the extension and its tests with esbuild. No runtime npm dependencies.
//
// Strategy: when the platform binary (@esbuild/<platform>-<arch>) is present,
// run it directly with stdio inherit (works everywhere, incl. sandboxes that
// block piped child stdio). Otherwise fall back to the esbuild JS API, which
// requires its postinstall script to have run.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");
const buildTests = process.argv.includes("--test");
const buildSmoke = process.argv.includes("--smoke");

function platformBinary() {
  const name = `esbuild${process.platform === "win32" ? ".exe" : ""}`;
  try {
    const path = require.resolve(`@esbuild/${process.platform}-${process.arch}/${name}`);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function cliArgs(entries, outdir, outbase) {
  return [
    ...entries,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node18",
    "--sourcemap",
    "--external:vscode",
    `--outbase=${outbase}`,
    `--outdir=${outdir}`,
    "--log-level=info",
  ];
}

async function main() {
  const entries = buildTests ? ["src/**/*.test.ts"] : buildSmoke ? ["scripts/smoke.ts"] : ["src/extension.ts"];
  const outdir = buildTests ? "dist-test" : buildSmoke ? "dist-smoke" : "dist";
  const outbase = buildSmoke ? "scripts" : "src";
  const binary = platformBinary();
  if (binary !== undefined) {
    const args = cliArgs(entries, outdir, outbase);
    if (watch) {
      const child = spawn(binary, [...args, "--watch"], { stdio: "inherit", windowsHide: true });
      child.on("exit", (code) => process.exit(code ?? 0));
      console.log("watching…");
    } else {
      const result = spawnSync(binary, args, { stdio: "inherit", windowsHide: true });
      process.exit(result.status ?? 0);
    }
    return;
  }

  const { build, context } = await import("esbuild");
  const base = {
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    external: ["vscode"],
    logLevel: "info",
    outbase,
  };
  if (watch) {
    const ctx = await context({ ...base, entryPoints: entries, outdir });
    await ctx.watch();
    console.log("watching…");
  } else {
    await build({ ...base, entryPoints: entries, outdir });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
