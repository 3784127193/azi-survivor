/* board-test.js — 排行榜「每人最佳 + 匿名开关」真浏览器验证
 *
 * 做什么：
 *   1. 起一个只读静态服务器（默认 8897）指向 game/src
 *   2. 启一个 headless Chrome（远程调试 9333），打开 index.html?test=1
 *   3. 用 CDP 在页面里调 window.__game.setBoardAnon(false/true)，各读一次榜单文本
 *   4. 打印两次结果 + 页面异常，方便判断「只显示最佳 / 勾选才显示匿名」是否真的生效
 *
 * 用法：
 *   node board-test.js                  # 默认 http://127.0.0.1:8897
 *   node board-test.js --port 8897 --wait 7000
 *
 * 前提：云端 leaderboard 表里有数据（可用 docs 里的测试行，跑完记得删）。
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
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg",
};

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PORT = Number(arg("port", 8897));
const DEBUG_PORT = Number(arg("debug", 9333));
const WAIT = Number(arg("wait", 7000));

function startStatic() {
  const srv = http.createServer((req, res) => {
    try {
      const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const p = path.join(SRC, u === "/" ? "index.html" : u);
      if (!p.startsWith(SRC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404); return res.end();
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      fs.createReadStream(p).pipe(res);
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise(r => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { return await (await fetch(url)).json(); } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("CDP 端口没起来：" + url);
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.error("找不到 Chrome：" + CHROME); process.exit(2); }
  const srv = await startStatic();
  console.log("[board-test] 静态服务器 http://127.0.0.1:" + PORT + " -> " + SRC);

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-bt-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=430,900",
    "--remote-debugging-port=" + DEBUG_PORT,
    "--user-data-dir=" + prof,
    "about:blank",
  ], { stdio: "ignore" });

  const cleanup = () => {
    try { chrome.kill(); } catch (e) { }
    try { srv.close(); } catch (e) { }
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { }
  };
  process.on("exit", cleanup);

  await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

  let list = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  let page = list.find(t => t.type === "page");
  if (!page) {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" });
    list = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    page = list.find(t => t.type === "page");
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      errors.push("EXCEPTION " + (d.text || "") + " " +
        ((d.exception && (d.exception.description || d.exception.value)) || ""));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("console.error " + (m.params.args || []).map(a => a.value || a.description).join(" "));
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 30000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable");
  await send("Page.enable");

  const url = `http://127.0.0.1:${PORT}/index.html?test=1`;
  await send("Page.navigate", { url });
  console.log("[board-test] 打开 " + url + "，等 " + WAIT + "ms 让脚本/CDN/SDK 就绪");
  await new Promise(r => setTimeout(r, WAIT));

  const expr = `(async () => {
    const g = window.__game;
    if (!g) return { err: "__game 缺失（页面没跑起来或没带 ?test=1）" };
    const pick = () => ({
      rows: Array.from(document.querySelectorAll("#board-list .lb-row")).map(r => ({
        rank: (r.querySelector(".lb-rank")||{}).textContent,
        name: (r.querySelector(".lb-name")||{}).textContent,
        wave: (r.querySelector(".lb-wave")||{}).textContent,
        kills: (r.querySelector(".lb-kills")||{}).textContent,
      })),
      text: (document.getElementById("board-list")||{}).innerText,
      status: (document.getElementById("board-status")||{}).innerText,
      hint: (document.getElementById("board-hint")||{}).innerText,
      checked: !!(document.getElementById("board-show-anon")||{}).checked,
    });
    const out = {};
    await g.setBoardAnon(false);
    out.hideAnon = pick();
    await g.setBoardAnon(true);
    out.withAnon = pick();
    out.logged = (typeof CloudLB !== "undefined") && !!(CloudLB.user && CloudLB.user.id);
    return out;
  })()`;

  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: 25000,
  });
  const val = r.result && r.result.result && r.result.result.value;
  console.log("\n===== 结果 =====");
  console.log(JSON.stringify(val, null, 2));
  if (errors.length) { console.log("\n===== 页面报错 ====="); errors.slice(0, 12).forEach(e => console.log(" - " + e)); }
  else console.log("\n页面报错：无");

  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
