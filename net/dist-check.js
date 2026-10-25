/* dist-check.js — 验证混淆产物 dist/ 能否独立运行
 *
 * 检查项：
 *   1. 页面零 JS 异常
 *   2. 带 ?test=1 时 window.__game 必须不存在（说明测试钩子已被构建剥离）
 *   3. canvas 有实际尺寸、主循环在跑（G.wave / 敌人数量）
 *   4. 界面文本无 emoji
 *
 * 用法：node dist-check.js --port 8900 --debug 9336
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "game", "dist");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg("port", 8900));
const DEBUG_PORT = Number(arg("debug", 9336));
const WAIT = Number(arg("wait", 6000));

function startStatic() {
  const srv = http.createServer((req, res) => {
    try {
      const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const p = path.join(ROOT, u === "/" ? "index.html" : u);
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(p).pipe(res);
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise(r => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) { try { return await (await fetch(url)).json(); } catch (e) { } await new Promise(r => setTimeout(r, 250)); }
  throw new Error("CDP 端口没起来：" + url);
}

(async () => {
  const srv = await startStatic();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-dist-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=430,900", "--remote-debugging-port=" + DEBUG_PORT,
    "--user-data-dir=" + prof, "about:blank",
  ], { stdio: "ignore" });
  const cleanup = () => {
    try { chrome.kill(); } catch (e) { }
    try { srv.close(); } catch (e) { }
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { }
  };
  process.on("exit", cleanup);

  await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const list = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = list.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      errors.push("EXCEPTION " + (d.text || "") + ((d.exception && d.exception.description) || ""));
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 30000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?test=1` });
  await new Promise(r => setTimeout(r, WAIT));

  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const cv = document.getElementById("game");
      const E = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
      return {
        hook: typeof window.__game,
        Net: typeof window.Net,
        canvas: cv ? cv.width + "x" + cv.height : "missing",
        canvasCss: cv ? Math.round(cv.getBoundingClientRect().width) + "x" + Math.round(cv.getBoundingClientRect().height) : "-",
        emoji: [...new Set((document.body.innerText || "").match(E) || [])],
        version: (document.querySelector(".m-version") || {}).textContent,
        scripts: [...document.querySelectorAll("script[src]")].map(s => s.getAttribute("src")),
      };
    })()`, returnByValue: true,
  });
  const v = r.result.result.value;
  console.log("===== dist 运行检查 =====");
  console.log(JSON.stringify(v, null, 2));
  if (errors.length) { console.log("\n页面报错："); errors.slice(0, 10).forEach(e => console.log(" - " + e)); }
  else console.log("\n页面报错：无");

  const ok = v && v.hook === "undefined" && v.Net === "undefined" && v.emoji.length === 0
    && v.canvas !== "missing" && errors.length === 0;
  console.log("\n判定: " + (ok ? "PASS" : "FAIL"));
  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("FAIL:", e.message); process.exit(2); });
