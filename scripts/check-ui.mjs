/** 检查源码文本编码及最终生成的 Sidebar 内嵌脚本。 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { buildSync } from "esbuild";

const textFilePattern = /\.(?:ts|js|mjs|json|md|svg|css|html|yml|yaml|txt)$/i;
const allowedNonAscii = new Set(["—", "→", "…", "⇄", "▶", "↻", "■", "↗", "·"]);
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => file !== "scripts/check-ui.mjs")
  .filter((file) => textFilePattern.test(file) && fs.existsSync(file));

const encodingIssues = [];
for (const file of files) {
  const bytes = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    encodingIssues.push(`${file}: invalid UTF-8`);
    continue;
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if ([...line].some((character) => character.codePointAt(0) > 127 && !allowedNonAscii.has(character))) {
      encodingIssues.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}
if (encodingIssues.length > 0) {
  throw new Error(`检测到乱码：\n${encodingIssues.join("\n")}`);
}

const bundledSidebar = buildSync({
  entryPoints: ["src/sidebar.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
}).outputFiles[0].text;
const loadedModule = { exports: {} };
new Function("require", "module", "exports", bundledSidebar)(
  (specifier) => {
    if (specifier === "vscode") return {};
    if (specifier === "node:crypto") return { randomBytes };
    throw new Error(`测试中出现未处理的模块：${specifier}`);
  },
  loadedModule,
  loadedModule.exports,
);

const SidebarProvider = loadedModule.exports.SidebarProvider;
const provider = new SidebarProvider(() => undefined, async (url) => url);
const html = provider.render({ cspSource: "vscode-webview://test" });
const nonceMatch = html.match(/script-src 'nonce-([A-Za-z0-9_-]+)'/);
if (!nonceMatch || !/^[A-Za-z0-9_-]{22}$/.test(nonceMatch[1])) {
  throw new Error("Sidebar CSP nonce must be a 16-byte base64url value");
}
const secondHtml = provider.render({ cspSource: "vscode-webview://test" });
if (secondHtml.includes(`nonce-${nonceMatch[1]}`)) throw new Error("Sidebar CSP nonce was reused");
for (const symbol of ["▶", "↻", "■", "↗"]) {
  if (!html.includes(symbol)) throw new Error(`Sidebar 缺少按钮符号：${symbol}`);
}
const scriptMarker = "    const vscode = acquireVsCodeApi();";
const scriptStart = html.indexOf(scriptMarker);
const scriptEnd = html.indexOf("</script>", scriptStart);
if (scriptStart < 0 || scriptEnd < 0) throw new Error("未找到 Sidebar 内嵌脚本");
new vm.Script(html.slice(scriptStart, scriptEnd), { filename: "sidebar-inline.js" });

console.log("UI encoding and rendered Sidebar script checks passed.");
