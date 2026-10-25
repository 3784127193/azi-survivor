/* shop-mobile-test.js — 手机端「波次完成」面板不遮挡操作按钮 + 模式文案
 *
 * 断言：
 *   1. 模式卡片文案 = 单人模式 / 多人模式；未登录提示保持「未登录时只能单人游戏」
 *   2. 430×900 手机视口下，属性面板（.side-stats）不覆盖
 *      「刷新 / 治疗 / 开始下一波」三个按钮（矩形不相交）
 *   3. 三个按钮都在可视区域内（bottom <= 视口高度）
 *
 * 用法：node shop-mobile-test.js [--port 8909] [--debug 9367]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SRC = path.resolve(__dirname, "..", "game", "src");
const SHOTS = path.resolve(__dirname, "shots");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg("port", 8909));
const DEBUG_PORT = Number(arg("debug", 9367));

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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-shop-"));
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
      errors.push((d.text || "") + ((d.exception && d.exception.description) || ""));
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
  await new Promise(r => setTimeout(r, 5000));

  const expr = `(() => {
    const $ = id => document.getElementById(id);
    const out = {};

    // ---- 1. 文案 ----
    out.solo = ($("btn-mode-solo") || {}).textContent || "";
    out.multi = ($("btn-mode-multi") || {}).textContent || "";
    out.hint = ($("mode-mp-hint") || {}).textContent || "";

    // ---- 2. 造一个手机端「波次完成」界面 ----
    document.body.classList.add("is-mobile");
    document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    const shop = $("screen-shop");
    shop.classList.remove("hidden");

    const grid = $("shop-grid");
    grid.innerHTML = "";
    for (let i = 0; i < 6; i++) {
      const d = document.createElement("div");
      d.className = "shop-card";
      d.style.cssText = "min-height:86px;border:1px solid #333;border-radius:10px;padding:8px";
      d.innerHTML = "<b>测试商品 " + (i + 1) + "</b><br><small>占位描述文本</small>";
      grid.appendChild(d);
    }
    const inv = $("shop-inv");
    if (inv) inv.innerHTML = '<div style="min-height:28px">物品栏</div>';

    // 属性面板塞几行，撑到真实高度
    const st = document.querySelector("#screen-shop .side-stats");
    const statBox = $("shop-stats");
    if (statBox) {
      statBox.innerHTML = "";
      ["生命 100/100", "攻击 12", "攻速 1.2", "暴击 8%", "护甲 3", "移速 4.2"].forEach(t => {
        const r = document.createElement("div");
        r.className = "stat-row";
        r.textContent = t;
        statBox.appendChild(r);
      });
    }

    const R = el => { const r = el.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, rr: r.right }; };
    const inter = (a, b) => !(a.b <= b.t || b.b <= a.t || a.rr <= b.l || b.rr <= a.l);

    const btnReroll = $("btn-reroll"), btnHeal = $("btn-heal"), btnNext = $("btn-nextwave");
    out.hasBtns = !!(btnReroll && btnHeal && btnNext);
    const stR = st ? R(st) : null;
    out.statRect = stR;
    out.btns = {
      reroll: R(btnReroll), heal: R(btnHeal), next: R(btnNext)
    };
    out.overlap = {
      reroll: stR ? inter(stR, out.btns.reroll) : null,
      heal: stR ? inter(stR, out.btns.heal) : null,
      next: stR ? inter(stR, out.btns.next) : null
    };
    out.vh = window.innerHeight;
    out.visible = {
      healBottom: out.btns.heal.b,
      nextBottom: out.btns.next.b,
      healInView: out.btns.heal.t >= 0 && out.btns.heal.b <= window.innerHeight,
      nextInView: out.btns.next.t >= 0 && out.btns.next.b <= window.innerHeight
    };
    out.flexDir = getComputedStyle(document.querySelector("#screen-shop .panel-with-side")).flexDirection;
    out.statPos = st ? getComputedStyle(st).position : "n/a";
    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const v = (r.result && r.result.result && r.result.result.value) || {};

  let pass = true;
  const chk = (n, ok, extra) => { if (!ok) pass = false; console.log((ok ? "  PASS " : "  FAIL ") + n + (extra !== undefined ? "  → " + extra : "")); };

  console.log("===== 手机端商店面板 / 模式文案 =====");
  chk("单人卡片=单人模式", /单人模式/.test(v.solo), (v.solo || "").trim());
  chk("多人卡片=多人模式", /多人模式/.test(v.multi), (v.multi || "").trim());
  chk("未登录提示保持原样", /未登录时只能单人游戏/.test(v.hint), v.hint);
  chk("三个操作按钮存在", v.hasBtns === true);
  chk("手机端单列布局", v.flexDir === "column", v.flexDir);
  chk("属性面板不再 sticky", v.statPos === "static", v.statPos);
  chk("不遮挡「治疗」", v.overlap && v.overlap.heal === false, JSON.stringify(v.overlap));
  chk("不遮挡「开始下一波」", v.overlap && v.overlap.next === false);
  chk("不遮挡「刷新」", v.overlap && v.overlap.reroll === false);
  chk("「治疗」在可视区", v.visible && v.visible.healInView === true, v.visible && v.visible.healBottom);
  chk("「开始下一波」在可视区", v.visible && v.visible.nextInView === true, v.visible && v.visible.nextBottom);
  chk("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, "shop-mobile.png"), Buffer.from(shot.result.data, "base64"));
    console.log("  截图：" + path.join(SHOTS, "shop-mobile.png"));
  } catch (e) { }

  console.log(pass ? "\nPASS ✅ 手机端面板不再遮挡" : "\nFAIL ❌ 有断言未通过");
  cleanup();
  process.exit(pass ? 0 : 1);
})();
