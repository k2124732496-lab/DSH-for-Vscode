import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyConfigured, discoverDsh, pickFromWhereOutput, type DiscoveryEnv } from "./discovery";

function fakeEnv(overrides: Partial<DiscoveryEnv> = {}): DiscoveryEnv {
  return {
    platform: "win32",
    env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
    pathVar: "",
    runCommand: async () => "",
    isFile: () => false,
    ...overrides,
  };
}

describe("classifyConfigured", () => {
  it("classifies a bin.js as node-spawn", () => {
    assert.deepEqual(classifyConfigured("C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"), {
      kind: "node",
      path: "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
    });
  });

  it("classifies .cmd and .bat as cmd-spawn", () => {
    assert.equal(classifyConfigured("C:\\npm\\dsh.cmd")?.kind, "cmd");
    assert.equal(classifyConfigured("C:\\npm\\dsh.bat")?.kind, "cmd");
  });

  it("rejects .ps1 shims", () => {
    assert.equal(classifyConfigured("C:\\npm\\dsh.ps1"), undefined);
  });

  it("treats other paths as direct executables", () => {
    assert.equal(classifyConfigured("/usr/local/bin/dsh")?.kind, "direct");
    assert.equal(classifyConfigured("C:\\tools\\dsh.exe")?.kind, "direct");
  });
});

describe("pickFromWhereOutput", () => {
  it("prefers .cmd over .ps1 over other entries", () => {
    const output = [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.ps1",
    ].join("\r\n");
    assert.equal(pickFromWhereOutput(output), "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd");
  });

  it("falls back to the first line when no shim suffix matches", () => {
    assert.equal(pickFromWhereOutput("/usr/local/bin/dsh\n/some/other"), "/usr/local/bin/dsh");
  });

  it("ignores blank lines", () => {
    assert.equal(pickFromWhereOutput("\r\n\r\n/opt/dsh\r\n"), "/opt/dsh");
  });
});

describe("discoverDsh", () => {
  it("uses the configured path when it exists", async () => {
    const location = await discoverDsh(
      "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      fakeEnv({ isFile: (p) => p === "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" }),
    );
    assert.deepEqual(location, { kind: "node", path: "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" });
  });

  it("rejects a configured path that does not exist", async () => {
    await assert.rejects(
      () => discoverDsh("C:\\missing\\dsh.cmd", fakeEnv()),
      /does not exist/,
    );
  });

  it("rejects a configured .ps1 path with guidance", async () => {
    await assert.rejects(
      () => discoverDsh("C:\\npm\\dsh.ps1", fakeEnv({ isFile: () => true })),
      /PowerShell shims \(.ps1\) are not supported/,
    );
  });

  it("finds the global npm bin.js on Windows", async () => {
    const binJs = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
    const location = await discoverDsh("", fakeEnv({ isFile: (p) => p === binJs }));
    assert.deepEqual(location, { kind: "node", path: binJs });
  });

  it("falls back to `where dsh` and picks the .cmd shim", async () => {
    const env = fakeEnv({
      isFile: () => false,
      runCommand: async (command) =>
        command === "where"
          ? "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\dsh.ps1"
          : "",
    });
    const location = await discoverDsh("", env);
    assert.deepEqual(location, { kind: "cmd", path: "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd" });
  });

  it("explains when only a .ps1 shim exists on PATH", async () => {
    const env = fakeEnv({
      isFile: () => false,
      runCommand: async () => "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.ps1",
    });
    await assert.rejects(() => discoverDsh("", env), /PowerShell shims are not supported/);
  });

  it("throws an install hint when nothing is found", async () => {
    await assert.rejects(() => discoverDsh("", fakeEnv()), /npm install -g @deepseek-ai\/dsh/);
  });

  it("uses `which` on POSIX and treats the result as a direct shim", async () => {
    const env = fakeEnv({
      platform: "linux",
      env: { HOME: "/home/me" },
      runCommand: async (command) => (command === "which" ? "/usr/local/bin/dsh" : ""),
    });
    const location = await discoverDsh("", env);
    assert.deepEqual(location, { kind: "direct", path: "/usr/local/bin/dsh" });
  });
});
