/** Verifies the bundled adapter against the DSH 0.2 Workspace and UI Session interfaces. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

async function loadClient(roots: string[], enabled = true) {
  const source = await readFile(join(process.cwd(), "dsh", "workspace-sync-client.js"), "utf8");
  let registration: any;
  let poll: (() => void) | undefined;
  let fetches = 0;
  let now = Date.now();
  const messages: Array<Record<string, unknown>> = [];
  const desiredRoots = [...roots];
  const sandbox: Record<string, any> = {
    URL, console, AbortSignal,
    Date: { now: () => now },
    location: { href: "http://127.0.0.1:1234/", origin: "http://127.0.0.1:1234" },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    parent: { postMessage(message: Record<string, unknown>) { messages.push(message); } },
    fetch: async () => {
      fetches += 1;
      const workspaceRoot = desiredRoots.length > 1 ? desiredRoots.shift() : desiredRoots[0];
      return {
        status: 200, ok: true,
        async json() { return { version: 1, expiresAt: now + 45_000, workspaceRoot }; },
      };
    },
    setInterval(callback: () => void) { poll = callback; return 1; },
    clearInterval() { poll = undefined; },
    __DSH_VSCODE__: { version: 1, enabled, statePath: "/bridge/state.json" },
    __ModuleLoader__: { load(value: unknown) { registration = value; } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "workspace-sync-client.js" });
  assert.equal(registration.id, "dsh-vscode-integration");
  return {
    plugin: registration.factory(), messages, sandbox,
    poll: () => poll?.(), fetches: () => fetches,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function context(cwd = "C:/old", workspacePaths: string[] = []) {
  const calls: string[] = [];
  const snapshot = {
    phase: "ready", ids: ["current"],
    byId: { current: { cwd, retainedBy: { mainView: 1 } } } as Record<string, any>,
  };
  const list = (value: unknown) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const workspaces = {
    phase: "ready",
    items: workspacePaths.map((path) => ({ path, workspaceId: path })),
  };
  const ctx = {
    workspaces: {
      list: list(workspaces),
      async create({ path }: { path: string }) {
        calls.push(`create:${path}`);
        const workspace = { workspaceId: path, path };
        workspaces.items.push(workspace);
        return workspace;
      },
    },
    sessions: { list: list(snapshot) },
    uiWorkspace: {
      async connectWorkspace(id: string) {
        calls.push(`connect:${id}`);
        snapshot.byId[`session:${id}`] = { cwd: id, retainedBy: {} };
        return `session:${id}`;
      },
      openSession(id: string) {
        calls.push(`open:${id}`);
        for (const session of Object.values(snapshot.byId)) session.retainedBy.mainView = 0;
        snapshot.byId[id]!.retainedBy.mainView = 1;
      },
    },
  };
  return { ctx, calls, snapshot, workspaces };
}

describe("DSH 0.2 workspace sync client", () => {
  it("keeps a selected session whose mainView cwd already matches", async () => {
    const harness = await loadClient(["C:\\OLED"]);
    const fixture = context("c:/oled/");
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    assert.deepEqual(fixture.calls, []);
    assert.equal(harness.messages.at(-1)?.state, "synced");
    dispose();
  });

  it("creates, connects, and selects via uiWorkspace, without repeated creation", async () => {
    const harness = await loadClient(["C:/OLED"]);
    const fixture = context();
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    harness.poll();
    await settle();
    assert.deepEqual(fixture.calls, ["create:C:/OLED", "connect:C:/OLED", "open:session:C:/OLED"]);
    assert.equal(harness.messages.at(-1)?.state, "synced");
    dispose();
  });

  it("reuses a registered workspace and preserves a matching historical session", async () => {
    const harness = await loadClient(["C:/OLED"]);
    const fixture = context("C:/old", ["C:/OLED"]);
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    fixture.snapshot.byId.current!.retainedBy.mainView = 1;
    fixture.snapshot.byId.current!.cwd = "C:/OLED";
    fixture.snapshot.byId["session:C:/OLED"]!.retainedBy.mainView = 0;
    harness.poll();
    await settle();
    assert.deepEqual(fixture.calls, ["connect:C:/OLED", "open:session:C:/OLED"]);
    dispose();
  });

  it("does not select an obsolete root after an asynchronous connection", async () => {
    const harness = await loadClient(["C:/first", "C:/second", "C:/second"]);
    const fixture = context();
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    assert.deepEqual(fixture.calls.filter((call) => call.startsWith("open:")), ["open:session:C:/second"]);
    dispose();
  });

  it("waits for both ready phases before creating anything", async () => {
    const harness = await loadClient(["C:/OLED"]);
    const fixture = context();
    fixture.workspaces.phase = "pending";
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    assert.deepEqual(fixture.calls, []);
    assert.equal(harness.messages.at(-1)?.state, "syncing");
    dispose();
  });

  it("does not fetch, register, or select when synchronization is disabled", async () => {
    const harness = await loadClient(["C:/OLED"], false);
    const fixture = context();
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    assert.equal(harness.fetches(), 0);
    assert.deepEqual(fixture.calls, []);
    dispose();
  });

  it("backs off after a failure and resumes without duplicate polling", async () => {
    const harness = await loadClient(["C:/OLED"]);
    const fixture = context();
    let attempts = 0;
    fixture.ctx.workspaces.create = async () => { attempts += 1; throw new Error("workspace missing"); };
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    harness.poll();
    await settle();
    assert.equal(attempts, 1);
    assert.equal(harness.messages.at(-1)?.state, "error");
    harness.advance(5_001);
    harness.poll();
    await settle();
    assert.equal(attempts, 2);
    dispose();
  });

  it("never advertises synced until the main session actually changes", async () => {
    const harness = await loadClient(["C:/OLED"]);
    const fixture = context();
    fixture.ctx.uiWorkspace.openSession = () => {};
    const dispose = harness.plugin.apply(fixture.ctx);
    await settle();
    assert.equal(harness.messages.at(-1)?.state, "syncing");
    dispose();
  });

  it("ignores stale state and refuses a cross-origin bridge", async () => {
    for (const crossOrigin of [false, true]) {
      const harness = await loadClient(["C:/OLED"]);
      const fixture = context();
      if (crossOrigin) harness.sandbox.__DSH_VSCODE__.statePath = "https://example.test/state.json";
      else harness.sandbox.fetch = async () => ({ status: 200, ok: true, json: async () => ({ version: 1, workspaceRoot: "C:/OLED", expiresAt: 0 }) });
      const dispose = harness.plugin.apply(fixture.ctx);
      await settle();
      assert.deepEqual(fixture.calls, []);
      assert.equal(harness.messages.at(-1)?.state, crossOrigin ? "error" : "unavailable");
      dispose();
    }
  });
});
