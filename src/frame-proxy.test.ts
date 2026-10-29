/** Tests authenticated iframe forwarding, path isolation, origin checks, and shutdown. */
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { describe, it } from "node:test";
import { DshFrameProxy } from "./frame-proxy";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("DSH authenticated iframe gateway", () => {
  it("exchanges the launch token, retains cookies server-side, and reuses one gateway", async () => {
    const seen: Array<{ url?: string; cookie?: string }> = [];
    const upstream = createServer((request, response) => {
      if (request.url === "/?token=launch-secret") {
        response.writeHead(303, { location: "./", "set-cookie": "session=signed-secret; HttpOnly; SameSite=Strict" });
        response.end();
        return;
      }
      seen.push({ url: request.url, cookie: request.headers.cookie });
      if (request.headers.cookie !== "session=signed-secret") { response.writeHead(401); response.end(); return; }
      response.setHeader("set-cookie", "session=signed-secret; HttpOnly; SameSite=Strict");
      response.end(request.method === "POST" ? "submitted" : "authenticated");
    });
    const origin = await listen(upstream);
    const proxy = new DshFrameProxy();
    let frameUrl = "";
    try {
      frameUrl = await proxy.open(`${origin}/?token=launch-secret`);
      assert.doesNotMatch(frameUrl, /launch-secret|signed-secret/);
      assert.equal(await proxy.open(`${origin}/?token=launch-secret`), frameUrl);
      const page = await fetch(frameUrl);
      assert.equal(await page.text(), "authenticated");
      assert.deepEqual(page.headers.getSetCookie(), []);
      const submission = await fetch(new URL("api/submit?value=1", frameUrl), {
        method: "POST", headers: { origin: new URL(frameUrl).origin }, body: "test",
      });
      assert.equal(await submission.text(), "submitted");
      assert.deepEqual(seen.at(-1), { url: "/api/submit?value=1", cookie: "session=signed-secret" });
      const before = seen.length;
      assert.equal((await fetch(new URL("/", frameUrl))).status, 404);
      assert.equal((await fetch(frameUrl, { headers: { origin: "https://foreign.example" } })).status, 404);
      assert.equal(seen.length, before);
    } finally {
      await proxy.dispose();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
    await assert.rejects(() => fetch(frameUrl));
  });

  it("does not authenticate an older URL without a token and rejects non-loopback targets", async () => {
    const proxy = new DshFrameProxy();
    try {
      assert.equal(await proxy.open("http://127.0.0.1:3080"), "http://127.0.0.1:3080");
      await assert.rejects(() => proxy.open("https://example.test/?token=secret"), /loopback/);
    } finally { await proxy.dispose(); }
  });

  it("fails clearly when Harness refuses the token", async () => {
    const server = createServer((_request, response) => { response.writeHead(401); response.end(); });
    const origin = await listen(server);
    const proxy = new DshFrameProxy();
    try { await assert.rejects(() => proxy.open(`${origin}/?token=bad`), /HTTP 401/); }
    finally {
      await proxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps double-slash paths on the authenticated upstream", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      if (request.url?.includes("token=")) {
        response.writeHead(303, { "set-cookie": "session=signed; HttpOnly", location: "./" });
      } else paths.push(request.url ?? "");
      response.end("local");
    });
    const origin = await listen(server);
    const proxy = new DshFrameProxy();
    try {
      const frameUrl = await proxy.open(`${origin}/?token=test`);
      assert.equal(await (await fetch(`${frameUrl}/external.example/path`)).text(), "local");
      assert.deepEqual(paths, ["//external.example/path"]);
    } finally {
      await proxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards authenticated upgrades and rejects foreign-origin upgrades", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(303, { "set-cookie": "session=signed; HttpOnly", location: "./" });
      response.end();
    });
    let upgrades = 0;
    server.on("upgrade", (incoming, socket) => {
      upgrades += 1;
      assert.equal(incoming.headers.cookie, "session=signed");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
      socket.end("upgraded");
    });
    const origin = await listen(server);
    const proxy = new DshFrameProxy();
    try {
      const frameUrl = await proxy.open(`${origin}/?token=test`);
      await new Promise<void>((resolve, reject) => {
        const outgoing = request(new URL("api/socket", frameUrl), {
          headers: { origin: new URL(frameUrl).origin, connection: "Upgrade", upgrade: "test" },
        });
        outgoing.on("error", reject);
        outgoing.on("upgrade", (response, socket, head) => {
          assert.equal(response.statusCode, 101);
          let data = head.toString();
          socket.on("data", (chunk) => { data += chunk; });
          socket.on("end", () => {
            assert.equal(data, "upgraded");
            socket.destroy();
            resolve();
          });
          socket.on("error", reject);
        });
        outgoing.end();
      });
      await new Promise<void>((resolve) => {
        const outgoing = request(new URL("api/socket", frameUrl), {
          headers: { origin: "https://foreign.example", connection: "Upgrade", upgrade: "test" },
        });
        outgoing.on("error", () => resolve());
        outgoing.on("upgrade", () => assert.fail("Foreign origin reached the upgrade handler"));
        outgoing.end();
      });
      assert.equal(upgrades, 1);
    } finally {
      await proxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
