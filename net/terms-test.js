/* terms-test.js — 协议勾选 / 协议正文页 的真浏览器验证
 *
 * 断言：
 *   1. 未登录点联机 → 进登录面板，且「协议勾选行」可见
 *   2. 不勾选直接点「注册」→ 被拦下，提示里有「用户协议」
 *   3. 点《用户协议》→ 进协议页，标题/正文/「最终解释权」都在
 *   4. 点「返回」→ 回到账号面板
 *   5. 勾选后再点「注册」→ 不再被协议拦（改为邮箱校验提示）
 *
 * 用法：node terms-test.js [--port 8907] [--debug 9347]
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
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg("port", 8907));
const DEBUG_PORT = Number(arg("debug", 9347));

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
  throw new Error("CDP 没起来：" + url);
}

(async () => {
  const srv = await startStatic();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-terms-"));
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
  await new Promise(r => setTimeout(r, 6500));

  const expr = `(() => {
    const $ = id => document.getElementById(id);
    const vis = id => { const el = $(id); return !el ? "missing" : (el.classList.contains("hidden") ? "hidden" : "visible"); };
    const status = () => ($("auth-status") || {}).textContent || "";
    const out = {};

    try { localStorage.removeItem("azi_agree_v"); } catch (e) {}
    try { CloudLB.user = null; } catch (e) {}
    document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    $("screen-auth").classList.remove("hidden");
    document.querySelectorAll(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === "reg"));
    document.querySelectorAll(".auth-pane").forEach(p => p.classList.add("hidden"));
    $("pane-reg").classList.remove("hidden");

    out.rowVisible = vis("auth-agree-row");
    out.defChecked = $("auth-agree").checked;

    // 1) 不勾选点注册
    $("reg-email").value = "tester@example.com";
    $("reg-code").value = "123456";
    $("reg-uname").value = "协议测试";
    $("reg-pwd").value = "abc12345";
    $("reg-pwd2").value = "abc12345";
    $("btn-reg").click();
    out.blockedStatus = status();
    out.blocked = /用户协议|隐私政策/.test(status());

    // 2) 打开用户协议
    $("open-terms").click();
    out.docVisible = vis("screen-doc");
    out.docTitle = ($("doc-title") || {}).textContent || "";
    out.docLen = (($("doc-body") || {}).innerHTML || "").length;
    out.docFoot = ($("doc-foot") || {}).textContent || "";
    out.hasFinal = /最终解释权归开发者所有/.test(out.docFoot + (($("doc-body") || {}).textContent || ""));
    out.hasPrivacyWord = /隐私|账号|排行榜/.test(($("doc-body") || {}).textContent || "");

    // 3) 返回
    $("btn-doc-back").click();
    out.backToAuth = vis("screen-auth");

    // 4) 勾选后再点注册
    $("auth-agree").checked = true;
    $("auth-agree").onchange();
    out.savedAgree = (() => { try { return localStorage.getItem("azi_agree_v") || ""; } catch (e) { return ""; } })();
    $("btn-reg").click();
    out.afterStatus = status();
    out.notBlocked = !/请先阅读并勾选/.test(out.afterStatus);

    // 5) 隐私政策也能打开
    $("open-privacy").click();
    out.privTitle = ($("doc-title") || {}).textContent || "";
    out.privLen = (($("doc-body") || {}).innerHTML || "").length;
    $("btn-doc-back").click();

    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const v = r.result.result.value || {};
  let pass = true;
  const chk = (name, ok, extra) => {
    if (!ok) pass = false;
    console.log((ok ? "  PASS " : "  FAIL ") + name + (extra !== undefined ? "  → " + extra : ""));
  };
  console.log("===== 协议功能验证 =====");
  chk("勾选行可见", v.rowVisible === "visible", v.rowVisible);
  chk("默认未勾选", v.defChecked === false, v.defChecked);
  chk("未勾选点注册被拦", v.blocked === true, v.blockedStatus);
  chk("协议页可见", v.docVisible === "visible", v.docVisible);
  chk("标题=用户协议", v.docTitle === "用户协议", v.docTitle);
  chk("正文非空(>800字)", (v.docLen || 0) > 800, v.docLen);
  chk("含最终解释权条款", v.hasFinal === true, v.docFoot);
  chk("返回回到账号面板", v.backToAuth === "visible", v.backToAuth);
  chk("勾选后写入本地", v.savedAgree === "2026-10-25", v.savedAgree);
  chk("勾选后不再被协议拦", v.notBlocked === true, v.afterStatus);
  chk("隐私政策标题正确", v.privTitle === "隐私政策", v.privTitle);
  chk("隐私政策正文非空", (v.privLen || 0) > 800, v.privLen);
  chk("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

  // 截图：协议页
  await send("Runtime.evaluate", {
    expression: `(() => { document.querySelectorAll(".screen").forEach(s=>s.classList.add("hidden"));
      document.getElementById("screen-auth").classList.remove("hidden");
      document.getElementById("open-terms").click(); })()`,
  });
  await new Promise(r => setTimeout(r, 800));
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, "terms.png"), Buffer.from(shot.result.data, "base64"));
    console.log("  截图：" + path.join(SHOTS, "terms.png"));
  } catch (e) { console.log("  截图失败：" + e.message); }

  await send("Runtime.evaluate", {
    expression: `(() => { document.getElementById("btn-doc-back").click(); })()`,
  });
  await new Promise(r => setTimeout(r, 600));
  try {
    const shot2 = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, "terms-row.png"), Buffer.from(shot2.result.data, "base64"));
    console.log("  截图：" + path.join(SHOTS, "terms-row.png"));
  } catch (e) { }

  console.log(pass ? "\nPASS ✅ 协议功能全部通过" : "\nFAIL ❌ 有断言未通过");
  cleanup();
  process.exit(pass ? 0 : 1);
})();
