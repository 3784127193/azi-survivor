/* admin-test.js — 管理后台真浏览器验证（打线上域名，走真实 nginx + 云接口代理）
 *
 * 断言：
 *   1. 页面能打开、无 JS 异常
 *   2. 登录框可见、主界面隐藏
 *   3. 用假账号登录 → 服务端真的回「用户名或密码错误」（证明 /api 代理链路通）
 *   4. 空用户名/空密码 → 前端就地拦截
 *
 * 用法：node admin-test.js [--url https://relay.example.com/admin/]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const SHOTS = path.resolve(__dirname, "shots");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = arg("url", "https://relay.example.com/admin/");
const DEBUG_PORT = Number(arg("debug", 9357));

async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) { try { return await (await fetch(url)).json(); } catch (e) { } await new Promise(r => setTimeout(r, 250)); }
  throw new Error("CDP 没起来");
}

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-admin-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=1280,900", "--remote-debugging-port=" + DEBUG_PORT,
    "--user-data-dir=" + prof, "about:blank",
  ], { stdio: "ignore" });
  const cleanup = () => {
    try { chrome.kill(); } catch (e) { }
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
    setTimeout(() => rej(new Error("timeout " + method)), 40000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: URL_ });
  await new Promise(r => setTimeout(r, 4000));

  const expr = `(async () => {
    const $ = id => document.getElementById(id);
    const vis = id => { const el = $(id); return !el ? "missing" : (getComputedStyle(el).display === "none" ? "hidden" : "visible"); };
    const out = {};
    out.title = document.title;
    out.loginBox = vis("login");
    out.appBox = $("app").classList.contains("on") ? "visible" : "hidden";
    out.hasNav = document.querySelectorAll("nav button").length;

    // 空提交
    $("u").value = ""; $("p").value = "";
    $("btnLogin").click();
    await new Promise(r => setTimeout(r, 300));
    out.emptyMsg = $("loginMsg").textContent;

    // 假账号
    $("u").value = "__probe_admin__";
    $("p").value = "__probe_pass__";
    $("btnLogin").click();
    out.pendingMsg = $("loginMsg").textContent;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const t = $("loginMsg").textContent;
      if (t && !/正在登录/.test(t)) { out.finalMsg = t; break; }
    }
    out.finalMsg = out.finalMsg || $("loginMsg").textContent;
    return out;
  })()`;

  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const v = (r.result && r.result.result && r.result.result.value) || {};
  let pass = true;
  const chk = (n, ok, extra) => { if (!ok) pass = false; console.log((ok ? "  PASS " : "  FAIL ") + n + (extra !== undefined ? "  → " + extra : "")); };

  console.log("===== 管理后台验证 =====");
  console.log("  URL: " + URL_);
  chk("页面标题", /管理后台/.test(v.title || ""), v.title);
  chk("登录框可见", v.loginBox === "visible", v.loginBox);
  chk("登录前主界面隐藏", v.appBox === "hidden", v.appBox);
  chk("导航项齐全(>=8)", (v.hasNav || 0) >= 8, v.hasNav);
  chk("空账号被前端拦截", /请填写用户名和密码/.test(v.emptyMsg || ""), v.emptyMsg);
  chk("假账号得到服务端应答", /用户名或密码错误/.test(v.finalMsg || ""), v.finalMsg);
  chk("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, "admin-login.png"), Buffer.from(shot.result.data, "base64"));
    console.log("  截图：" + path.join(SHOTS, "admin-login.png"));
  } catch (e) { }

  console.log(pass ? "\nPASS ✅ 管理后台链路正常" : "\nFAIL ❌ 有断言未通过");
  cleanup();
  process.exit(pass ? 0 : 1);
})();
