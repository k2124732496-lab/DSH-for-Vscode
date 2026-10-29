/** Authenticates the embedded DSH UI without relying on cross-site browser cookies. */
import { randomBytes } from "node:crypto";
import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** Owns one loopback-only, capability-scoped iframe gateway per managed DSH URL. */
export class DshFrameProxy {
  private server: Server | undefined;
  private target: string | undefined;
  private frameUrl: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sockets = new Set<Socket>();
  private readonly requests = new Set<ClientRequest>();

  open(url: string): Promise<string> {
    const operation = this.queue.then(async () => {
      if (url === this.target && this.frameUrl !== undefined) return this.frameUrl;
      await this.reset();
      const upstream = new URL(url);
      if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(upstream.hostname)) {
        throw new Error("The DSH iframe gateway requires a loopback HTTP URL.");
      }
      if (!upstream.searchParams.has("token")) return url;
      const login = await fetch(upstream, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      await login.body?.cancel();
      if (login.status !== 303 || cookie === "") throw new Error(`DSH browser authentication failed (HTTP ${login.status}).`);

      // 随机路径是此窗口的临时访问凭证，签名 Cookie 只保留在扩展宿主内。
      const prefix = `/${randomBytes(24).toString("base64url")}/`;
      let origin = "";
      const accepts = (incoming: IncomingMessage): boolean => {
        try {
          const path = new URL(incoming.url ?? "/", "http://proxy.invalid").pathname;
          return incoming.headers.host === new URL(origin).host
            && incoming.url?.startsWith(prefix) === true
            && path.startsWith(prefix) && (incoming.headers.origin === undefined || incoming.headers.origin === origin);
        } catch { return false; }
      };
      const forward = (incoming: IncomingMessage): ClientRequest => {
        const path = (incoming.url ?? "/").slice(prefix.length - 1);
        const outgoing = request({
          hostname: upstream.hostname, port: upstream.port, path,
          method: incoming.method,
          headers: { ...incoming.headers, host: upstream.host, cookie,
            ...(incoming.headers.origin === undefined ? {} : { origin: upstream.origin }) },
        });
        this.requests.add(outgoing);
        outgoing.on("close", () => this.requests.delete(outgoing));
        incoming.on("aborted", () => outgoing.destroy());
        return outgoing;
      };
      const server = createServer((incoming, response) => {
        if (!accepts(incoming)) { response.writeHead(404); response.end(); return; }
        const outgoing = forward(incoming);
        outgoing.on("response", (received) => {
          const headers = { ...received.headers };
          delete headers["set-cookie"];
          if (headers.location?.startsWith(upstream.origin)) {
            headers.location = `${origin}${prefix}${headers.location.slice(upstream.origin.length).replace(/^\//, "")}`;
          }
          response.writeHead(received.statusCode ?? 502, headers);
          received.on("error", () => response.destroy());
          received.pipe(response);
        });
        outgoing.on("error", () => this.badGateway(response));
        response.on("close", () => outgoing.destroy());
        incoming.pipe(outgoing);
      });
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      server.on("upgrade", (incoming, socket, head) => {
        if (!accepts(incoming) || incoming.headers.origin !== origin) { socket.destroy(); return; }
        const outgoing = forward(incoming);
        outgoing.on("upgrade", (received, remote, remoteHead) => {
          this.sockets.add(remote);
          remote.on("close", () => this.sockets.delete(remote));
          const headers = Object.entries(received.headers).filter(([name]) => name !== "set-cookie")
            .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`));
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
          if (remoteHead.length > 0) socket.write(remoteHead);
          if (head.length > 0) remote.write(head);
          socket.on("error", () => remote.destroy());
          remote.on("error", () => socket.destroy());
          socket.on("close", () => remote.destroy());
          remote.on("close", () => socket.destroy());
          socket.pipe(remote).pipe(socket);
        });
        outgoing.on("response", () => socket.destroy());
        outgoing.on("error", () => socket.destroy());
        outgoing.end();
      });
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      const address = server.address() as { port: number };
      origin = `http://127.0.0.1:${address.port}`;
      this.target = url;
      this.frameUrl = `${origin}${prefix}`;
      return this.frameUrl;
    });
    this.queue = operation.catch(async () => { await this.reset(); });
    return operation;
  }

  dispose(): Promise<void> {
    const operation = this.queue.then(() => this.reset());
    this.queue = operation;
    return operation;
  }

  private badGateway(response: ServerResponse): void {
    if (response.headersSent) response.destroy();
    else { response.writeHead(502); response.end("DSH is unavailable. Restart the DSH server."); }
  }

  private async reset(): Promise<void> {
    this.target = undefined;
    this.frameUrl = undefined;
    for (const outgoing of this.requests) outgoing.destroy();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
