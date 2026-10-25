/* gate-test.js — 「未登录不能用联机」门槛的真浏览器验证
 *
 * 两轮对照：
 *   A. 未登录点「多人游戏」→ 必须停在登录面板（screen-auth），不得进 screen-mp
 *   B. 伪造已登录（CloudLB.user）再点 → 必须进 screen-mp
 *
 * 用法：node gate-test.js --port 8899 --debug 9335
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SRC = path.resolve(__dirname, "..", "game", "src");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg("port", 8899));
const DEBUG_PORT = Number(arg("debug", 9335));
const WAIT = Number(arg("wait", 6000));

function startStatic() {
  const srv = http.createServer((req, res) => {
    try {
      const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const p = path.join(SRC, u === "/" ? "index.html" : u);
      if (!p.startsWith(SRC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-gate-"));
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

  const expr = `(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return "missing";
      return el.classList.contains("hidden") ? "hidden" : "visible";
    };
    const hideAll = () => document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    const out = {};

    // ---- A: 未登录 ----
    try { CloudLB.user = null; } catch (e) {}
    hideAll();
    document.getElementById("btn-mode-multi").click();
    out.anon = {
      auth: vis("screen-auth"),
      mp: vis("screen-mp"),
      toast: (document.querySelector(".toast") || {}).textContent || "",
    };

    // ---- B: 伪造已登录 ----
    try { CloudLB.user = { id: "zz-gate-test", name: "门槛测试" }; } catch (e) {}
    hideAll();
    document.getElementById("btn-mode-multi").click();
    out.logged = {
      auth: vis("screen-auth"),
      mp: vis("screen-mp"),
      joinBtnExists: !!document.getElementById("btn-mp-join"),
    };

    // ---- C: 已登录但直接调联机开局前的兜底 ----
    out.isLoggedInApi = typeof window.__game.isLoggedIn === "function" ? window.__game.isLoggedIn() : "n/a";

    // 复位，避免污染后续
    try { CloudLB.user = null; } catch (e) {}
    hideAll();
    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const v = r.result.result.value;
  console.log("===== 门槛验证 =====");
  console.log(JSON.stringify(v, null, 2));

  const passA = v && v.anon && v.anon.auth === "visible" && v.anon.mp === "hidden";
  const passB = v && v.logged && v.logged.mp === "visible";
  console.log("\nA 未登录被拦: " + (passA ? "PASS" : "FAIL"));
  console.log("B 已登录放行: " + (passB ? "PASS" : "FAIL"));
  if (errors.length) { console.log("\n页面报错："); errors.slice(0, 8).forEach(e => console.log(" - " + e)); }
  else console.log("页面报错：无");

  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(passA && passB && errors.length === 0 ? 0 : 1);
})().catch(e => { console.error("FAIL:", e.message); process.exit(2); });
