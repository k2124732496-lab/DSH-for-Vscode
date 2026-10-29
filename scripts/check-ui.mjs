/** 检查源码文本编码及最终生成的 Sidebar 内嵌脚本。 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { buildSync } from "esbuild";

const textFilePattern = /\.(?:ts|js|mjs|json|md|svg|css|html|yml|yaml|txt)$/i;
// 检查实际解码错误，允许合法中文说明和注释。
const mojibakePattern = /\uFFFD|\u951f\u65a4\u62f7|\u00ef\u00bf\u00bd|[\u00c2\u00c3][\u0080-\u00bf]/u;
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
    if (mojibakePattern.test(line)) {
      encodingIssues.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}
if (encodingIssues.length > 0) {
  throw new Error(`检测到乱码：\n${encodingIssues.join("\n")}`);
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const compatibilityContext = "dsh.doesNotSupportSecondarySidebar";
const primaryViewId = "dsh.sidebarView";
const secondaryViewId = "dsh.sidebarSecondaryView";

function requireContribution(condition, message) {
  if (!condition) throw new Error(message);
}

const activityContainer = manifest.contributes?.viewsContainers?.activitybar?.find((item) => item.id === "dsh");
const secondaryContainer = manifest.contributes?.viewsContainers?.secondarySidebar?.find((item) => item.id === "dshSecondary");
requireContribution(
  activityContainer?.when === compatibilityContext,
  "The legacy DSH Activity Bar container must be limited to unsupported VS Code versions",
);
requireContribution(
  secondaryContainer?.when === `!${compatibilityContext}`,
  "The DSH Secondary Sidebar container must be enabled on supported VS Code versions",
);

const primaryView = manifest.contributes?.views?.dsh?.find((item) => item.id === primaryViewId);
const secondaryView = manifest.contributes?.views?.dshSecondary?.find((item) => item.id === secondaryViewId);
requireContribution(primaryView?.when === compatibilityContext, "The primary DSH view is missing its compatibility condition");
requireContribution(secondaryView?.when === `!${compatibilityContext}`, "The secondary DSH view is missing its compatibility condition");

const openCommand = manifest.contributes?.commands?.find((item) => item.command === "dsh.openPanel");
requireContribution(
  openCommand?.icon?.light === "media/dsh.svg" && openCommand?.icon?.dark === "media/dsh.svg",
  "The DSH open command must use the DSH SVG icon",
);
requireContribution(
  manifest.contributes?.menus?.["editor/title"]?.some((item) => item.command === "dsh.openPanel"),
  "The DSH open command must be present in the editor title menu",
);

const requiredViewCommands = [
  "dsh.startServer",
  "dsh.restartServer",
  "dsh.stopServer",
  "dsh.openInBrowser",
  "dsh.showLogs",
];
const viewTitleItems = manifest.contributes?.menus?.["view/title"] ?? [];
for (const viewId of [primaryViewId, secondaryViewId]) {
  for (const command of requiredViewCommands) {

    requireContribution(
      viewTitleItems.some((item) => item.command === command && item.when?.includes(`view == ${viewId}`)),
      `${viewId} is missing the ${command} title command`,
    );
  }
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
