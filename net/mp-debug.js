/* mp-debug.js — 单端页面渐进式诊断：起一个 Chrome 打开测试页，每 2s 打印一次页面内部状态 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROLE = arg("--role", "host");
const POLL = Number(arg("--poll", "2"));      // 每次轮询间隔（秒）
const ROUNDS = Number(arg("--rounds", "8"));  // 轮询次数
const PORT = Number(arg("--port", "8899"));

const SRC = path.resolve(__dirname, "..", "game", "src");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const p = path.join(SRC, u === "/" ? "index.html" : u);
    if (!p.startsWith(SRC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  } catch (e) { res.writeHead(500); res.end(); }
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const url = `http://127.0.0.1:${PORT}/test-mp.html?test=1&role=${ROLE}&room=777001&secs=30&wait=0&net=${encodeURIComponent("ws://127.0.0.1:9090")}`;
  const ch = spawn(CHROME, [
    "--disable-gpu", "--no-sandbox", "--mute-audio",
    "--remote-debugging-port=9224",
    "--window-size=430,760",
    "--user-data-dir=" + path.join(require("os").tmpdir(), "azi-dbg-9224"),
    url,
  ], { stdio: "ignore" });

  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9224/json")).json();
      page = list.find(t => t.type === "page");
      if (page) break;
    } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!page) { console.log("chrome 未就绪"); ch.kill(); server.close(); process.exit(1); }
  console.log("page url:", page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Page.loadEventFired") events.push("loadEventFired");
    if (m.method === "Page.frameNavigated") events.push("frameNavigated " + (m.params.frame || {}).url);
    if (m.method === "Runtime.consoleAPICalled") events.push("console." + m.params.type + ": " + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(" ").slice(0, 200));
    if (m.method === "Runtime.exceptionThrown") events.push("EXCEPTION: " + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 300));
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("cdp ws 连接失败")); });
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 30000);
  });
  await send("Runtime.enable");
  await send("Page.enable");

  /* 不重复导航：Chrome 启动时已带 URL */
  for (let round = 1; round <= ROUNDS; round++) {
    await new Promise(r => setTimeout(r, POLL * 1000));
    let state;
    try {
      const r = await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          href: location.href,
          log: ((document.getElementById('log')||{}).textContent||'').slice(-160),
          hasResult: !!document.getElementById('test-result'),
          errors: window.__errors || [],
          netMode: typeof Net !== 'undefined' ? Net.mode : 'Net missing',
          netReady: typeof Net !== 'undefined' ? Net.ready : null,
          netStats: typeof Net !== 'undefined' ? Net.stats : null,
          wsState: typeof Net !== 'undefined' && Net.ws ? Net.ws.readyState : 'no ws',
          screen: (typeof window.__game !== 'undefined' && window.__game.G) ? window.__game.G.screen : null,
          enemies: (typeof window.__game !== 'undefined' && window.__game.enemies) ? window.__game.enemies.length : null
        })`,
        returnByValue: true,
      });
      state = r.result.result.value;
    } catch (e) { state = "EVAL-FAIL " + e.message; }
    console.log(`[round ${round}]`, state);
  }
  console.log("CDP EVENTS:", JSON.stringify(events.slice(0, 40), null, 1));
  ws.close(); ch.kill(); server.close(); process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
