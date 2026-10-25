/* ui-test.js — 界面 emoji 清理后的真浏览器验收
 *
 * 做四件事：
 *   1. 逐个把面板显示出来，扫描 innerText 里是否还有 emoji
 *   2. 检查登录/注册输入框的左内边距（去掉图标后不应再是 36px）
 *   3. 检查模式卡片在去掉图标后的渲染高度（不能塌成一条）
 *   4. 对关键面板截图到 net/shots/，肉眼复核布局
 *
 * 用法：node ui-test.js --port 8898 --debug 9334 --wait 7000
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SRC = path.resolve(__dirname, "..", "game", "src");
const SHOTS = path.resolve(__dirname, "shots");
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

const PORT = Number(arg("port", 8898));
const DEBUG_PORT = Number(arg("debug", 9334));
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

const SCREENS = [
  ["menu", "screen-menu"], ["mode", "screen-mode"], ["mp", "screen-mp"],
  ["join", "screen-join"], ["create", "screen-create"], ["auth", "screen-auth"],
  ["adm-login", "screen-admin-login"], ["news", "screen-news"],
  ["pause", "screen-pause"], ["gameover", "screen-gameover"],
  ["victory", "screen-victory"], ["wheel", "screen-wheel"],
  ["board", "screen-board"], ["me", "screen-me"], ["char", "screen-char"],
];

(async () => {
  if (!fs.existsSync(CHROME)) { console.error("找不到 Chrome：" + CHROME); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await startStatic();
  console.log("[ui-test] 静态服务器 http://127.0.0.1:" + PORT + " -> " + SRC);

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-ui-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=430,900", "--force-device-scale-factor=2",
    "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + prof, "about:blank",
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

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?test=1` });
  console.log("[ui-test] 打开页面，等 " + WAIT + "ms");
  await new Promise(r => setTimeout(r, WAIT));

  // ---- 静态扫描：整份 DOM 文本里的 emoji ----
  const scan = await send("Runtime.evaluate", {
    expression: `(() => {
      const E = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
      const text = document.body.innerText || "";
      const found = [...new Set(text.match(E) || [])];
      const lines = text.split("\\n").filter(l => E.test(l)).slice(0, 10);
      const ce = document.getElementById("login-email");
      const pe = document.getElementById("login-phone");
      const cs = (el) => el ? getComputedStyle(el) : null;
      const cards = Array.from(document.querySelectorAll(".mode-card")).map(c => ({
        id: c.id, h: Math.round(c.getBoundingClientRect().height),
        kids: c.children.length, txt: (c.innerText||"").replace(/\\n/g,"/").slice(0,30)
      }));
      return {
        emojiDistinct: found, emojiLines: lines,
        padEmail: cs(ce) ? cs(ce).paddingLeft : null,
        padPhone: cs(pe) ? cs(pe).paddingLeft : null,
        cards,
        muteText: (document.getElementById("btn-mute")||{}).textContent,
        modeIco: document.querySelectorAll(".mode-ico").length,
        bigEmoji: document.querySelectorAll(".big-emoji").length,
      };
    })()`, returnByValue: true,
  });
  console.log("\n===== 静态扫描 =====");
  console.log(JSON.stringify(scan.result.result.value, null, 2));

  // ---- 逐面板截图 ----
  console.log("\n===== 截图 =====");
  for (const [name, sid] of SCREENS) {
    await send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        const el = document.getElementById('${sid}');
        if (el) el.classList.remove('hidden');
        return !!el;
      })()`, returnByValue: true,
    });
    await new Promise(r => setTimeout(r, 260));
    if (name === "mode") {
      const m = await send("Runtime.evaluate", {
        expression: `Array.from(document.querySelectorAll('.mode-card')).map(c => ({
          id: c.id, h: Math.round(c.getBoundingClientRect().height),
          w: Math.round(c.getBoundingClientRect().width), kids: c.children.length
        }))`, returnByValue: true,
      });
      console.log("  模式卡片实测尺寸：" + JSON.stringify(m.result.result.value));
    }
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const buf = Buffer.from(shot.result.data, "base64");
    const fp = path.join(SHOTS, name + ".png");
    fs.writeFileSync(fp, buf);
    console.log("  " + name.padEnd(10) + (buf.length / 1024).toFixed(1) + " KB -> shots/" + name + ".png");
  }

  if (errors.length) {
    console.log("\n===== 页面报错 =====");
    errors.slice(0, 10).forEach(e => console.log(" - " + e));
  } else console.log("\n页面报错：无");

  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
