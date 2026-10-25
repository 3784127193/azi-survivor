/* connect-probe.js — 在真浏览器里直接调 Net.connect，抓真实失败原因
 * 用法：node connect-probe.js [--port 8911] [--debug 9377] [--net wss://...]
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
const PORT = Number(arg("port", 8911));
const DEBUG_PORT = Number(arg("debug", 9377));
const NET = arg("net", "");

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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-probe-"));
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

  const url = `http://127.0.0.1:${PORT}/index.html?test=1`;
  await send("Page.navigate", { url });
  await new Promise(r => setTimeout(r, 5000));

  if (NET) {
    await send("Runtime.evaluate", { expression: `localStorage.setItem("azi_net_url", ${JSON.stringify(NET)});` });
  }

  const expr = `(async () => {
    const out = { cfg: { url: Net.cfg.url, fallback: Net.cfg.fallback,
                         timeout: Net.cfg.connectTimeout, rounds: Net.cfg.connectRounds } };
    try {
      const r = await Promise.race([
        Net.connect("host", "PROBE" + Math.floor(Math.random()*900+100), "probe-k", "探针"),
        new Promise((_, rj) => setTimeout(() => rj(new Error("外层 45s 超时")), 45000))
      ]);
      out.ok = true;
      out.active = Net.cfg.activeUrl;
      out.welcome = r && r.role ? r.role : "n/a";
    } catch (e) {
      out.ok = false;
      out.err = String((e && e.message) || e);
      out.errs = (Net.lastConnectErrors || []).slice();
    }
    try { Net.ws && Net.ws.close(); } catch (e) {}
    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const v = (r.result && r.result.result && r.result.result.value) || {};
  console.log(JSON.stringify(v, null, 2));
  cleanup();
  process.exit(0);
})();
