/* ws-probe.js — 在浏览器里裸测多条 wss 地址能否握手（绕开 Net 的连接逻辑）
 * 用法：node ws-probe.js [--urls "wss://a,wss://b"]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SRC = path.resolve(__dirname, "..", "game", "src");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg("port", 8913));
const DEBUG_PORT = Number(arg("debug", 9387));
const URLS = arg("urls", "wss://YOUR-TUNNEL.trycloudflare.com,wss://relay.example.com").split(",");

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
async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) { try { return await (await fetch(url)).json(); } catch (e) { } await new Promise(r => setTimeout(r, 250)); }
  throw new Error("CDP 没起来");
}

(async () => {
  const srv = await startStatic();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-ws-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--window-size=430,900",
    "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + prof, "about:blank",
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
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 60000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?test=1` });
  await new Promise(r => setTimeout(r, 4500));

  const expr = `(async () => {
    const urls = ${JSON.stringify(URLS)};
    const one = (u) => new Promise((res) => {
      const t0 = performance.now();
      let w, done = false;
      const fin = (o) => { if (done) return; done = true; o.ms = Math.round(performance.now() - t0); o.url = u; res(o); };
      try { w = new WebSocket(u); } catch (e) { return fin({ ok: false, err: "构造失败:" + e.message }); }
      w.onopen = () => { fin({ ok: true }); try { w.close(); } catch (e) {} };
      w.onerror = () => fin({ ok: false, err: "onerror" });
      w.onclose = (e) => fin({ ok: false, err: "close code=" + e.code + " reason=" + (e.reason || "") });
      setTimeout(() => fin({ ok: false, err: "15s 无响应" }), 15000);
    });
    const out = [];
    for (const u of urls) out.push(await one(u));
    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const v = (r.result && r.result.result && r.result.result.value) || [];
  console.log("===== 浏览器裸测 wss 握手 =====");
  for (const x of v) {
    console.log((x.ok ? "  OK   " : "  FAIL ") + x.url + "  (" + x.ms + "ms)" + (x.ok ? "" : "  " + x.err));
  }
  cleanup();
  process.exit(0);
})();
