/* live-board.js — 线上（混淆版）排行榜 UI 验证
 *
 * 为什么不用 board-test.js：那个依赖 ?test=1 的 window.__game 钩子，
 * 而发布产物（dist）在构建时已把测试接口整段剥离。这里改走真实点击路径。
 *
 * 做什么：
 *   1. 真浏览器打开线上地址
 *   2. 点「排行榜」按钮 → 读榜单行
 *   3. 勾选「显示匿名玩家」→ 再读一次
 *   4. 打印两次结果 + 页面异常
 *
 * 用法：
 *   node live-board.js --url "https://.../?sharecode=xxx"
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const URL_ = arg("url", "");
const DEBUG_PORT = Number(arg("debug", 9341));
const WAIT = Number(arg("wait", 7000));

async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { return await (await fetch(url)).json(); } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("CDP 端口没起来：" + url);
}

(async () => {
  if (!URL_) { console.error("缺少 --url"); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.error("找不到 Chrome：" + CHROME); process.exit(2); }

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-lb-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=430,900",
    "--remote-debugging-port=" + DEBUG_PORT,
    "--user-data-dir=" + prof,
    "about:blank",
  ], { stdio: "ignore" });

  const cleanup = () => {
    try { chrome.kill(); } catch (e) { }
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
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true, timeout: 25000,
    });
    return r.result && r.result.result && r.result.result.value;
  };

  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable");
  await send("Page.enable");

  await send("Page.navigate", { url: URL_ });
  console.log("[live-board] 打开线上地址，等 " + WAIT + "ms");
  await new Promise(r => setTimeout(r, WAIT));

  // 点开排行榜
  const opened = await evalJs(`(() => {
    const b = document.getElementById("btn-board");
    if (!b) return "no-btn-board";
    b.click();
    return document.getElementById("screen-board").classList.contains("hidden") ? "still-hidden" : "opened";
  })()`);
  console.log("[live-board] 排行榜面板:", opened);
  await new Promise(r => setTimeout(r, 3000));

  const pick = `(() => {
    const rows = Array.from(document.querySelectorAll("#board-list .lb-row")).map(r => ({
      rank: (r.querySelector(".lb-rank")||{}).textContent || "",
      name: (r.querySelector(".lb-name")||{}).textContent || "",
      wave: (r.querySelector(".lb-wave")||{}).textContent || "",
      kills: (r.querySelector(".lb-kills")||{}).textContent || "",
      anon: r.classList.contains("anon"),
    }));
    return {
      rows, count: rows.length,
      note: (document.querySelector("#board-list .lb-note")||{}).textContent || "",
      status: (document.getElementById("board-status")||{}).innerText || "",
      hint: (document.getElementById("board-hint")||{}).innerText || "",
      checked: !!(document.getElementById("board-show-anon")||{}).checked,
      hasToggle: !!document.getElementById("board-show-anon"),
    };
  })()`;

  const hideAnon = await evalJs(pick);

  // 勾选「显示匿名玩家」并触发 change（用 click 走真实路径）
  const toggled = await evalJs(`(() => {
    const c = document.getElementById("board-show-anon");
    if (!c) return "no-checkbox";
    if (!c.checked) c.click();
    return c.checked ? "checked" : "click-failed";
  })()`);
  console.log("[live-board] 匿名开关:", toggled);
  await new Promise(r => setTimeout(r, 3000));
  const withAnon = await evalJs(pick);

  console.log("\n===== 隐藏匿名（默认）=====");
  console.log(JSON.stringify(hideAnon, null, 2));
  console.log("\n===== 勾选显示匿名 =====");
  console.log(JSON.stringify(withAnon, null, 2));

  if (errors.length) {
    console.log("\n===== 页面报错 =====");
    errors.slice(0, 10).forEach(e => console.log(" - " + e));
  } else {
    console.log("\n页面报错：无");
  }

  const ok = opened === "opened" && hideAnon && hideAnon.hasToggle && errors.length === 0;
  console.log("\n判定: " + (ok ? "PASS" : "FAIL"));
  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
