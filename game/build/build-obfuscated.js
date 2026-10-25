/* 构建：把 6 个 JS（含联机层 net.js）合并成单个文件并混淆，输出到发布目录 dist/
 * 源码（可读）保留在 src/，发布目录里不留可读 JS */
const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist");
const FILES = ["icons.js", "data.js", "audio.js", "cloud.js", "art.js", "net.js", "game.js"];
const SDK_CDN = "sdk/workbuddy-cloud-sdk.js";
const VER = process.argv[2] || "1.2.0";

// 1) 合并
const parts = FILES.map(f => {
  const p = path.join(SRC, "js", f);
  return "/* ---- " + f + " ---- */\n" + fs.readFileSync(p, "utf8");
});
let bundle = parts.join("\n\n");

/* 安全：把测试接口整段从发布产物剥掉（源码 potato-survivor-src 保留，供自动化测试用）
   源码里用 #test-hook-start 与 #test-hook-end 注释标出这一段的边界 */
{
  const re = /\/\* #test-hook-start[\s\S]*?#test-hook-end \*\//;
  if (re.test(bundle)) {
    bundle = bundle.replace(re, "/* test hook stripped in release build */");
    console.log("[build] 已从发布产物移除测试接口（#test-hook 段）");
  } else {
    console.log("[build] 警告：未找到 #test-hook 段，请检查 game.js 结构");
  }
}
const sizeIn = Buffer.byteLength(bundle, "utf8");

// 2) 混淆
const t0 = Date.now();
const result = JavaScriptObfuscator.obfuscate(bundle, {
  compact: true,
  target: "browser",
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: true,
  renameProperties: false,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: "variable",
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  transformObjectKeys: true,
  selfDefending: true,
  debugProtection: false,
  disableConsoleOutput: true,
  unicodeEscapeSequence: false
});
const code = result.getObfuscatedCode();
const sizeOut = Buffer.byteLength(code, "utf8");

// 3) 写出（发布目录只保留 app.min.js）
const jsDir = path.join(OUT, "js");
fs.mkdirSync(jsDir, { recursive: true });
for (const f of FILES) {
  const p = path.join(jsDir, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
fs.writeFileSync(path.join(jsDir, "app.min.js"), code, "utf8");

/* 3.5) 墓碑文件（重要）
 * 发布器是「叠加写入、不删除旧文件」：早先用 src/ 直接发布过的 js/icons.js…js/game.js、
 * test-mp.html 会一直留在远端站点里被任意人下载（源码 250KB + 带 ?test=1 钩子的测试入口）。
 * 这里在发布产物里把同路径写成占位文件，重新发布时正好把远端残留覆盖掉。
 * 内容对实际运行无影响：index.html 只引用 js/app.min.js。 */
const TOMB_JS = "/* 404 */\n";
const TOMB_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title></head>' +
  '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#14121a;color:#cfc8e0;font:600 15px system-ui,sans-serif"><p>页面不存在</p></body></html>\n';
for (const f of FILES) fs.writeFileSync(path.join(jsDir, f), TOMB_JS, "utf8");
fs.writeFileSync(path.join(OUT, "test-mp.html"), TOMB_HTML, "utf8");

// 4) 同步 index.html，并把脚本引用换成单文件 + 版本号
let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
html = html.replace(/<script[\s\S]*?<\/script>/g, "");   // 先清空所有 script
html = html.replace(/<\/body>/, '<script src="' + SDK_CDN + '?v=' + VER + '"></script>\n<script src="js/app.min.js?v=' + VER + '"></script>\n</body>');

// 4.5) HTML + 内联 CSS 压缩：去掉注释与缩进，降低可读性（不改变排版）
function minifyHtml(src) {
  let s = src;
  s = s.replace(/<!--[\s\S]*?-->/g, "");                       // HTML 注释
  s = s.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, at, css) => {
    const min = css
      .replace(/\/\*[\s\S]*?\*\//g, "")                        // CSS 注释
      .replace(/\s*([{};:,>])\s*/g, "$1")                      // 标点周围空白
      .replace(/\s+/g, " ")
      .replace(/;}/g, "}")
      .trim();
    return "<style" + at + ">" + min + "</style>";
  });
  s = s.replace(/\s+/g, " ");                                  // 折叠所有空白为单空格
  return s.trim();
}
html = minifyHtml(html);
fs.writeFileSync(path.join(OUT, "index.html"), html, "utf8");

// 5) SDK 与 README 一并复制到发布目录
const sdkSrc = path.join(SRC, "sdk");
const sdkOut = path.join(OUT, "sdk");
if (fs.existsSync(sdkSrc)) {
  fs.mkdirSync(sdkOut, { recursive: true });
  for (const f of fs.readdirSync(sdkSrc)) fs.copyFileSync(path.join(sdkSrc, f), path.join(sdkOut, f));
}
fs.copyFileSync(path.join(SRC, "README.md"), path.join(OUT, "README.md"));

console.log(JSON.stringify({
  in: sizeIn, out: sizeOut,
  ratio: (sizeOut / sizeIn).toFixed(2),
  ms: Date.now() - t0,
  jsFiles: fs.readdirSync(jsDir),
  tombstones: FILES.length + 1,   /* js/<源码名>.js ×7 + test-mp.html */
  htmlScripts: (html.match(/<script[^>]*>/g) || [])
}, null, 2));
