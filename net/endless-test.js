/* endless-test.js — 无尽模式行为验证（真浏览器 + 真游戏代码）
 *
 * 断言两件事：
 *   1) 无尽局打到第 20 波（= WAVE_TOTAL 通关波数）不会结算胜利，波次继续 +1
 *   2) 普通局打到第 20 波会进 victory 结算（对照组，证明判定逻辑没被写坏）
 *
 * 用法：node endless-test.js [--port 8897] [--debug-port 9333]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg("--port", "8897"));
const DPORT = Number(arg("--debug-port", "9333"));
const SRC = path.resolve(__dirname, "..", "game", "src");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const p = path.join(SRC, u === "/" ? "index.html" : u);
    if (!p.startsWith(SRC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  } catch (e) { res.writeHead(500); res.end(); }
});

async function cdp(port) {
  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find(t => t.type === "page");
      if (page) break;
    } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!page) throw new Error("devtools 未就绪 port=" + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 20000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable");
  return { send, ws };
}

const EXPR = `(function () {
  const HG = window.__game;
  if (!HG) return { fatal: "__game 钩子未暴露（URL 需带 test=1）" };
  try { CloudLB.user = { id: "zz-endless-test", name: "测试" }; } catch (e) {}
  HG.Room.runCode = ""; HG.Room.code = ""; HG.Room.status = "";
  const cid = (CHARS[0] || {}).id || "azi";

  const run = (endless) => {
    HG.startGame(cid);
    HG.G.endless = !!endless;
    HG.G.wave = 20;                 // WAVE_TOTAL
    HG.G.waveCleared = false;
    HG.G.waveClearHold = 0;
    HG.debug.endWave();
    return { screen: HG.G.screen, wave: HG.G.wave, endless: !!HG.G.endless, best: HG.G.best };
  };
  const endless = run(true);
  const normal = run(false);
  return { endless, normal, errors: window.__errors || [] };
})()`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const url = `http://127.0.0.1:${PORT}/test-mp.html?test=1`;
  console.log("[endless] 页面:", url);
  const ch = spawn(CHROME, ["--disable-gpu", "--no-sandbox", "--mute-audio",
    "--remote-debugging-port=" + DPORT, "--window-size=900,700",
    "--user-data-dir=" + path.join(require("os").tmpdir(), "azi-endless-" + DPORT), url], { stdio: "ignore" });
  const { send, ws } = await cdp(DPORT);
  await new Promise(r => setTimeout(r, 3500));   // 等 game.js 初始化完

  const r = await send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true });
  const v = r.result && r.result.result && r.result.result.value;
  console.log("[endless] 原始结果:", JSON.stringify(v));

  const fails = [];
  if (!v || v.fatal) fails.push("页面未就绪: " + (v && v.fatal));
  else {
    if ((v.errors || []).length) fails.push("页面报错: " + JSON.stringify(v.errors));
    if (v.endless.wave !== 21) fails.push("无尽局第 20 波后应到 21 波，实为 " + v.endless.wave);
    if (v.endless.screen === "victory") fails.push("无尽局第 20 波错误地进入了通关结算");
    if (v.normal.screen !== "victory") fails.push("普通局第 20 波应进入通关结算，实为 " + v.normal.screen);
  }
  console.log("\n===== 判定 =====");
  if (fails.length) {
    fails.forEach(f => console.log("  ✗ " + f));
    process.exitCode = 1;
  } else {
    console.log("PASS ✅  无尽模式不设通关波次；普通模式 20 波仍正常结算");
  }
  ws.close(); try { ch.kill(); } catch (e) { }
  server.close();
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
