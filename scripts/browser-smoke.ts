/** Exercises the real DSH client in headless Edge through its built-in debugging protocol. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { killTree } from "../src/server";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runBrowserSmoke(
  url: string,
  firstRoot: string,
  secondRoot: string,
  runtimeDirectory: string,
  switchRoot: () => Promise<void>,
): Promise<void> {
  const browserPath = [process.env.DSH_SMOKE_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
  if (browserPath === undefined) throw new Error("Set DSH_SMOKE_BROWSER to a Chromium or Edge executable for --browser smoke tests.");
  const profile = join(runtimeDirectory, "browser-profile");
  const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  // localhost 与 127.0.0.1 是不同站点，模拟 VS Code Webview 的跨站 iframe。
  const wrapper = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<html><body><script>window.addEventListener("message", event => {
      if(event.data?.source === "dsh-vscode-workspace-sync") window.__DSH_SMOKE_STATUS__ = event.data;
    });</script><iframe sandbox="allow-scripts allow-same-origin allow-forms allow-modals" src="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body></html>`);
  });
  await new Promise<void>((resolve) => wrapper.listen(0, "127.0.0.1", resolve));
  let socket: WebSocket | undefined;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const portDeadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < portDeadline) await delay(100);
    if (!existsSync(portFile)) throw new Error("Browser did not publish its debugging port.");
    const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((entry) => entry.type === "page");
    if (target === undefined) throw new Error("Browser debugging page is missing.");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("Browser debugging connection failed.")), { once: true });
    });
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const task = pending.get(message.id);
      if (task === undefined) return;
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timed out: ${method}`)); }, 10_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const address = wrapper.address() as { port: number };
    await send("Page.navigate", { url: `http://localhost:${address.port}/` });
    const waitForRoot = async (root: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      let last: unknown;
      while (Date.now() < deadline) {
        const evaluation = await send("Runtime.evaluate", { returnByValue: true, expression: "window.__DSH_SMOKE_STATUS__ ?? { state: 'waiting' }" });
        last = evaluation.result?.value;
        const status = last as { state?: string; workspaceRoot?: string };
        if (status?.state === "synced" && status.workspaceRoot?.replaceAll("\\", "/").toLowerCase() === root.replaceAll("\\", "/").toLowerCase()) return;
        await delay(200);
      }
      throw new Error(`DSH browser never selected ${root}: ${JSON.stringify(last)}`);
    };
    await waitForRoot(firstRoot);
    await switchRoot();
    await waitForRoot(secondRoot);
    console.log("Real browser workspace/session switching passed for two roots.");
  } finally {
    socket?.close();
    if (browser.pid !== undefined) await killTree(browser.pid);
    wrapper.closeAllConnections();
    await new Promise<void>((resolve) => wrapper.close(() => resolve()));
  }
}
