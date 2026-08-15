/** Verifies the bundled browser adapter against the public DSH workspace/session interface. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

interface ClientHarness {
  plugin: { apply(ctx: unknown): () => void; inject: string[] };
  messages: Array<Record<string, unknown>>;
}

async function loadClient(workspaceRoots: string[]): Promise<ClientHarness> {
  const source = await readFile(join(process.cwd(), "dsh", "workspace-sync-client.js"), "utf8");
  let registration: { factory(): { apply(ctx: unknown): () => void; inject: string[] } } | undefined;
  const messages: Array<Record<string, unknown>> = [];
  const roots = [...workspaceRoots];
  const sandbox: Record<string, any> = {
    URL,
    console,
    location: { href: "http://127.0.0.1:1234/" },
    document: {
      visibilityState: "visible",
      addEventListener(): void {},
      removeEventListener(): void {},
    },
    parent: { postMessage(message: Record<string, unknown>): void { messages.push(message); } },
    fetch: async () => {
      const workspaceRoot = roots.length > 1 ? roots.shift() : roots[0];
      return {
        status: 200,
        ok: true,
        async json() { return { version: 1, expiresAt: Date.now() + 45_000, workspaceRoot }; },
      };
    },
    setInterval(): number { return 1; },
    clearInterval(): void {},
    __DSH_BOOT__: {
      entries: [{ id: "integration:vscode-workspace-sync", url: "/bridge/client.js?rev=test" }],
    },
    __ModuleLoader__: {
      load(value: typeof registration): void { registration = value; },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "workspace-sync-client.js" });
  assert.ok(registration);
  return { plugin: registration.factory(), messages };
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function list<T>(snapshot: T): { getSnapshot(): T; subscribe(): () => void } {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

describe("DSH workspace sync client", () => {
  it("keeps a current session that already uses the desired cwd", async () => {
    const harness = await loadClient(["C:\\OLED"]);
    let creates = 0;
    const dispose = harness.plugin.apply({
      workspaces: { list: list({ baselinesReady: true }), async create() { creates += 1; } },
      sessions: {
        list: list({ phase: "ready", current: "current", byId: { current: { cwd: "c:/oled/" } } }),
      },
    });
    await settle();
    assert.equal(creates, 0);
    assert.equal(harness.messages.at(-1)?.state, "synced");
    dispose();
  });

  it("registers, connects, and opens the desired workspace without deleting history", async () => {
    const harness = await loadClient(["C:\\OLED"]);
    const calls: string[] = [];
    const dispose = harness.plugin.apply({
      workspaces: {
        list: list({ baselinesReady: true }),
        async create({ path }: { path: string }) { calls.push(`create:${path}`); return { id: "oled-workspace" }; },
        async connectWorkspace(id: string) { calls.push(`connect:${id}`); return "oled-session"; },
      },
      sessions: {
        list: list({ phase: "ready", current: "old", byId: { old: { cwd: "C:\\dsh-vscode" } } }),
        open(id: string) { calls.push(`open:${id}`); },
      },
    });
    await settle();
    assert.deepEqual(calls, ["create:C:\\OLED", "connect:oled-workspace", "open:oled-session"]);
    assert.equal(harness.messages.at(-1)?.workspaceRoot, "C:\\OLED");
    dispose();
  });

  it("does not open an obsolete root when the active file changes during connection", async () => {
    const harness = await loadClient(["C:\\first", "C:\\second", "C:\\second"]);
    const opened: string[] = [];
    const dispose = harness.plugin.apply({
      workspaces: {
        list: list({ baselinesReady: true }),
        async create({ path }: { path: string }) { return { id: path }; },
        async connectWorkspace(id: string) { return `session:${id}`; },
      },
      sessions: {
        list: list({ phase: "ready", current: "old", byId: { old: { cwd: "C:\\old" } } }),
        open(id: string) { opened.push(id); },
      },
    });
    await settle();
    assert.deepEqual(opened, ["session:C:\\second"]);
    dispose();
  });
});
