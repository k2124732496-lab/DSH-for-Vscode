import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import {
  buildSpawn,
  defaultNodeBin,
  DshServer,
  parseWebUrl,
  probeHealth,
  scrubExtensionHostEnv,
  type SpawnedChild,
  type SpawnSpec,
} from "./server";

describe("parseWebUrl", () => {
  it("parses the real startup line", () => {
    assert.deepEqual(
      parseWebUrl("dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)"),
      { url: "http://127.0.0.1:3080", port: 3080 },
    );
  });

  it("parses an OS-assigned port line", () => {
    const parsed = parseWebUrl("dsh web: http://127.0.0.1:47893");
    assert.equal(parsed?.port, 47893);
    assert.equal(parsed?.url, "http://127.0.0.1:47893");
  });

  it("ignores unrelated lines", () => {
    assert.equal(parseWebUrl("some other output"), undefined);
    assert.equal(parseWebUrl("dsh web: http://192.168.1.5:3080"), undefined);
    assert.equal(parseWebUrl(""), undefined);
  });
});

describe("probeHealth", () => {
  it("detects a live server", async () => {
    const server: HttpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      assert.equal(await probeHealth(`http://127.0.0.1:${String(port)}/`, 2000), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a dead port quickly", async () => {
    // Port 1 is reserved and never serves HTTP on loopback in practice.
    assert.equal(await probeHealth("http://127.0.0.1:1/", 1000), false);
  });
});

describe("buildSpawn", () => {
  it("spawns a bin.js through node", () => {
    const spec = buildSpawn({ kind: "node", path: "C:\\npm\\dsh\\lib\\bin.js" }, ["--profile", "web", "--port", "0"], "win32", "C:\\node\\node.exe");
    assert.deepEqual(spec, {
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\dsh\\lib\\bin.js", "--profile", "web", "--port", "0"],
    });
  });

  it("routes .cmd shims through the shell on Windows", () => {
    const spec = buildSpawn({ kind: "cmd", path: "C:\\npm\\dsh.cmd" }, ["--profile", "web"], "win32", "node");
    assert.equal(spec.command, "C:\\npm\\dsh.cmd");
    assert.equal(spec.shell, true);
  });

  it("does not shell-wrap .cmd shims on POSIX (not applicable)", () => {
    const spec = buildSpawn({ kind: "cmd", path: "/usr/local/bin/dsh.cmd" }, ["--profile", "web"], "linux", "node");
    assert.equal(spec.command, "/usr/local/bin/dsh.cmd");
    assert.equal(spec.shell, undefined);
  });

  it("shell-wraps extensionless shims on Windows", () => {
    const spec = buildSpawn({ kind: "direct", path: "C:\\npm\\dsh" }, ["--profile", "web"], "win32", "node");
    assert.equal(spec.shell, true);
  });

  it("spawns extensionless POSIX shims directly", () => {
    const spec = buildSpawn({ kind: "direct", path: "/usr/local/bin/dsh" }, ["--profile", "web"], "linux", "node");
    assert.equal(spec.command, "/usr/local/bin/dsh");
    assert.equal(spec.shell, undefined);
  });
});

class FakeChild implements SpawnedChild {
  pid = 4242;
  readonly spawned: SpawnSpec;
  private readonly stdoutListeners: ((line: string) => void)[] = [];
  private readonly stderrListeners: ((line: string) => void)[] = [];
  private readonly exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(spawned: SpawnSpec) {
    this.spawned = spawned;
  }

  onStdout(listener: (line: string) => void): void {
    this.stdoutListeners.push(listener);
  }

  onStderr(listener: (line: string) => void): void {
    this.stderrListeners.push(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  emitLine(line: string): void {
    for (const listener of this.stdoutListeners) listener(line);
  }

  emitErr(line: string): void {
    for (const listener of this.stderrListeners) listener(line);
  }

  exit(code: number | null, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener(code, signal);
  }

  fail(message: string): void {
    for (const listener of this.errorListeners) listener(new Error(message));
    // Real Node emits exit after a spawn failure too; keeps stopChild()'s wait bounded.
    this.exit(1);
  }
}

/** Wait until a condition holds (spawn happens on microtasks, not synchronously). */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  server: DshServer;
  spawns: SpawnSpec[];
  killed: number[];
  currentChild: () => FakeChild | undefined;
}

function makeHarness(overrides: Partial<ConstructorParameters<typeof DshServer>[0]> = {}): Harness {
  let child: FakeChild | undefined;
  const harness: Harness = {
    server: undefined as unknown as DshServer,
    spawns: [],
    killed: [],
    currentChild: () => child,
  };
  const options: ConstructorParameters<typeof DshServer>[0] = {
    resolveLocation: async () => ({ kind: "node", path: "C:\\npm\\dsh\\lib\\bin.js" }),
    settings: () => ({
      port: 0,
      host: "127.0.0.1",
      extraArgs: [],
      extraEnv: {},
      dshHome: "",
      startupTimeoutSeconds: 2,
      autoRestart: false,
    }),
    cwd: () => "C:\\work\\project with spaces",
    spawnFn: (spec, cwd, _env) => {
      harness.spawns.push(spec);
      assert.equal(cwd, "C:\\work\\project with spaces");
      child = new FakeChild(spec);
      return child;
    },
    killFn: async (pid) => {
      harness.killed.push(pid);
    },
    probeFn: async () => true,
    probeIntervalMs: 5,
    restartDelayMs: 10,
    ...overrides,
  };
  harness.server = new DshServer(options);
  return harness;
}

const readyLine = "dsh web: http://127.0.0.1:34821";

describe("scrubExtensionHostEnv", () => {
  it("removes NODE_OPTIONS and the VSCODE_/ELECTRON_ family, keeps the rest", () => {
    const scrubbed = scrubExtensionHostEnv({
      PATH: "C:\\Windows;C:\\node",
      HOME: "C:\\Users\\me",
      NODE_OPTIONS: "--require bootstrap-fork.js",
      ELECTRON_RUN_AS_NODE: "1",
      VSCODE_IPC_HOOK_CLI: "\\\\.\\pipe\\vscode-ipc-x",
      ELECTRON_NO_ASAR: "1",
      DEEPSEEK_API_KEY: "sk-secret",
      lower_keep: "x",
    });
    assert.deepEqual(scrubbed, {
      PATH: "C:\\Windows;C:\\node",
      HOME: "C:\\Users\\me",
      DEEPSEEK_API_KEY: "sk-secret",
      lower_keep: "x",
    });
  });

  it("drops entries with undefined values", () => {
    assert.deepEqual(scrubExtensionHostEnv({ A: "1", B: undefined }), { A: "1" });
  });
});

describe("defaultNodeBin", () => {
  it("keeps a real node executable", () => {
    assert.equal(defaultNodeBin("C:\\Program Files\\nodejs\\node.exe"), "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(defaultNodeBin("/usr/bin/node"), "/usr/bin/node");
  });

  it("falls back to PATH lookup when execPath is not node (VS Code extension host)", () => {
    assert.equal(defaultNodeBin("D:\\Microsoft VS Code\\Code.exe"), "node");
    assert.equal(defaultNodeBin("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), "node");
  });
});

describe("DshServer lifecycle", () => {
  it("starts, parses the port line, probes health, and reports running", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine("boot noise");
    harness.currentChild()!.emitLine(readyLine);
    const snapshot = await pending;
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.owned, true);
    assert.equal(snapshot.url, "http://127.0.0.1:34821");
    assert.equal(snapshot.port, 34821);
    assert.deepEqual(harness.spawns[0]?.args, [
      "C:\\npm\\dsh\\lib\\bin.js",
      "--profile",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
  });

  it("attaches to an existing instance on a fixed port without spawning", async () => {
    const harness = makeHarness({
      settings: () => ({
        port: 3080,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: {},
        dshHome: "",
        startupTimeoutSeconds: 2,
        autoRestart: false,
      }),
      probeFn: async () => true,
    });
    const snapshot = await harness.server.start();
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.owned, false);
    assert.equal(snapshot.url, "http://127.0.0.1:3080");
    assert.equal(harness.spawns.length, 0);
  });

  it("spawns when the fixed port is dead", async () => {
    const harness = makeHarness({
      settings: () => ({
        port: 3080,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: {},
        dshHome: "",
        startupTimeoutSeconds: 2,
        autoRestart: false,
      }),
      probeFn: async (url) => (url === "http://127.0.0.1:3080" ? false : true),
    });
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    const snapshot = await pending;
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.owned, true);
  });

  it("reports crashed when discovery fails", async () => {
    const harness = makeHarness({
      resolveLocation: async () => {
        throw new Error("Could not find the dsh executable. Install it with: npm install -g @deepseek-ai/dsh");
      },
    });
    const snapshot = await harness.server.start();
    assert.equal(snapshot.state, "crashed");
    assert.match(snapshot.error ?? "", /Could not find the dsh executable/);
    assert.equal(harness.spawns.length, 0);
  });

  it("reports crashed when the process exits before readiness", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.exit(1);
    const snapshot = await pending;
    assert.equal(snapshot.state, "crashed");
    assert.match(snapshot.error ?? "", /exited/);
  });

  it("reports a spawn failure (ENOENT-style error event) as crashed", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.fail("spawn node ENOENT");
    const snapshot = await pending;
    assert.equal(snapshot.state, "crashed");
    assert.match(snapshot.error ?? "", /Failed to start dsh: spawn node ENOENT/);
  });

  it("includes the dsh stderr tail in the exit-before-ready error", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitErr("Error: profile web failed to compose");
    harness.currentChild()!.exit(1);
    const snapshot = await pending;
    assert.equal(snapshot.state, "crashed");
    assert.match(snapshot.error ?? "", /exited \(code 1\) before the web server came up/);
    assert.match(snapshot.error ?? "", /profile web failed to compose/);
  });

  it("times out when the URL never appears", async () => {
    const harness = makeHarness({
      settings: () => ({
        port: 0,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: {},
        dshHome: "",
        startupTimeoutSeconds: 0.1,
        autoRestart: false,
      }),
    });
    const snapshot = await harness.server.start();
    assert.equal(snapshot.state, "crashed");
    assert.match(snapshot.error ?? "", /did not become reachable/);
    assert.equal(harness.killed.length, 1); // we terminate the half-started child
  });

  it("goes to crashed on an unexpected exit while running", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    await pending;
    harness.currentChild()!.exit(42);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.server.getSnapshot().state, "crashed");
    assert.match(harness.server.getSnapshot().error ?? "", /code 42/);
  });

  it("auto-restarts after an unexpected exit (with the attempt cap)", async () => {
    const harness = makeHarness({
      settings: () => ({
        port: 0,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: {},
        dshHome: "",
        startupTimeoutSeconds: 2,
        autoRestart: true,
      }),
    });
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    await pending;
    const original = harness.currentChild()!;
    original.exit(1);
    await waitFor(() => harness.currentChild() !== undefined && harness.currentChild() !== original);
    harness.currentChild()!.emitLine(readyLine);
    await waitFor(() => harness.server.getSnapshot().state === "running");
    assert.equal(harness.spawns.length, 2);
  });

  it("scrubs extension-host env vars from the spawned process", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const harness = makeHarness({
      parentEnv: () => ({
        PATH: "C:\\Windows",
        NODE_OPTIONS: "--require bootstrap-fork.js",
        VSCODE_IPC_HOOK_CLI: "\\\\.\\pipe\\vscode-ipc-x",
        ELECTRON_RUN_AS_NODE: "1",
      }),
      settings: () => ({
        port: 0,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: { MY_FLAG: "1" },
        dshHome: "C:\\custom\\dsh-home",
        startupTimeoutSeconds: 2,
        autoRestart: false,
      }),
      spawnFn: (spec, _cwd, env) => {
        capturedEnv = env;
        const child = new FakeChild(spec);
        harness.currentChild = () => child;
        return child;
      },
    });
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    await pending;
    assert.equal(capturedEnv?.["PATH"], "C:\\Windows");
    assert.equal(capturedEnv?.["NODE_OPTIONS"], undefined);
    assert.equal(capturedEnv?.["VSCODE_IPC_HOOK_CLI"], undefined);
    assert.equal(capturedEnv?.["ELECTRON_RUN_AS_NODE"], undefined);
    assert.equal(capturedEnv?.["DSH_HOME"], "C:\\custom\\dsh-home");
    assert.equal(capturedEnv?.["MY_FLAG"], "1");
  });

  it("stop() tree-kills the owned child and settles at stopped", async () => {
    const harness = makeHarness();
    const pending = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    await pending;
    const stopping = harness.server.stop();
    assert.equal(harness.server.getSnapshot().state, "stopping");
    harness.currentChild()!.exit(0);
    await stopping;
    assert.deepEqual(harness.killed, [4242]);
    assert.equal(harness.server.getSnapshot().state, "stopped");
  });

  it("stop() on an attached instance just detaches without killing anything", async () => {
    const harness = makeHarness({
      settings: () => ({
        port: 3080,
        host: "127.0.0.1",
        extraArgs: [],
        extraEnv: {},
        dshHome: "",
        startupTimeoutSeconds: 2,
        autoRestart: false,
      }),
    });
    await harness.server.start();
    await harness.server.stop();
    assert.equal(harness.server.getSnapshot().state, "stopped");
    assert.equal(harness.killed.length, 0);
  });

  it("restart() re-spawns with a fresh child", async () => {
    const harness = makeHarness();
    const first = harness.server.start();
    await waitFor(() => harness.currentChild() !== undefined);
    harness.currentChild()!.emitLine(readyLine);
    await first;
    const restart = harness.server.restart();
    harness.currentChild()!.exit(0);
    // The second spawn happens once the old child's exit resolves.
    await waitFor(() => harness.spawns.length === 2);
    harness.currentChild()!.emitLine(readyLine);
    const snapshot = await restart;
    assert.equal(snapshot.state, "running");
    assert.equal(harness.spawns.length, 2);
  });
});
