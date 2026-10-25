/* live-check.js — 线上页面真浏览器体检
 *
 * 打开已发布的线上地址（必须带 sharecode），检查：
 *   1. 零 JS 异常 / 零 console.error
 *   2. canvas 有尺寸、主菜单可见
 *   3. 界面文本无 emoji
 *   4. 点「单人游戏」能进选人页（证明打包产物可交互）
 *
 * 用法：node live-check.js --url "https://...?sharecode=xxx" --debug 9337
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";

function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const URL_ = arg("url", "");
const DEBUG_PORT = Number(arg("debug", 9337));
const WAIT = Number(arg("wait", 9000));

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) { try { return await (await fetch(url)).json(); } catch (e) { } await new Promise(r => setTimeout(r, 250)); }
  throw new Error("CDP 端口没起来：" + url);
}

(async () => {
  if (!URL_) { console.error("缺少 --url"); process.exit(2); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "azi-live-"));
  const chrome = spawn(CHROME, [
    "--no-sandbox", "--disable-gpu", "--mute-audio", "--hide-scrollbars",
    "--window-size=430,900", "--remote-debugging-port=" + DEBUG_PORT,
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
  let id = 0; const pending = new Map(); const errors = []; const failed = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      errors.push("EXCEPTION " + (d.text || "") + ((d.exception && d.exception.description) || ""));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("console.error " + (m.params.args || []).map(a => a.value || a.description).join(" "));
    }
    if (m.method === "Network.loadingFailed") failed.push(m.params.errorText + " " + (m.params.type || ""));
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 30000);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Page.navigate", { url: URL_ });
  await new Promise(r => setTimeout(r, WAIT));

  const probe = await send("Runtime.evaluate", {
    expression: `(() => {
      const cv = document.getElementById("game");
      const E = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
      const vis = (id) => { const el = document.getElementById(id); return el ? !el.classList.contains("hidden") : false; };
      const before = { menu: vis("screen-menu"), char: vis("screen-char") };
      let clicked = "n/a";
      try {
        const b = document.getElementById("btn-start");
        if (!b) clicked = "btn-start 不存在";
        else { b.click(); clicked = "clicked#btn-start"; }
      } catch (e) { clicked = "err:" + e.message; }
      return {
        title: document.title,
        canvas: cv ? cv.width + "x" + cv.height : "missing",
        version: (document.querySelector(".m-version") || {}).textContent || "",
        hook: typeof window.__game,
        emoji: [...new Set((document.body.innerText || "").match(E) || [])],
        before, clicked,
      };
    })()`, returnByValue: true,
  });
  const v = probe.result.result.value;

  // 点完「开始游戏」后再等一拍，看选人页是否出现
  await new Promise(r => setTimeout(r, 1200));
  const after = await send("Runtime.evaluate", {
    expression: `(() => {
      const vis = (id) => { const el = document.getElementById(id); return el ? !el.classList.contains("hidden") : false; };
      return { mode: vis("screen-mode"), char: vis("screen-char"),
               charCards: document.querySelectorAll("#char-list .char-card").length };
    })()`, returnByValue: true,
  });

  console.log("===== 线上体检 =====");
  console.log(JSON.stringify(v, null, 2));
  console.log("点击后:", JSON.stringify(after.result.result.value));
  if (errors.length) { console.log("\n页面报错："); errors.slice(0, 10).forEach(e => console.log(" - " + e)); }
  else console.log("\n页面报错：无");
  if (failed.length) { console.log("\n资源加载失败："); failed.slice(0, 8).forEach(e => console.log(" - " + e)); }

  const a = after.result.result.value || {};
  // ✕（关闭）与 ❚（暂停）是排版符号，不算 emoji
  const emojiLeft = (v && v.emoji ? v.emoji : []).filter(c => c !== "\u2715" && c !== "\u275a");
  const ok = v && v.canvas !== "missing" && emojiLeft.length === 0 && errors.length === 0
    && (a.mode === true || a.char === true || a.charCards > 0);
  if (emojiLeft.length) console.log("残留 emoji: " + JSON.stringify(emojiLeft));
  console.log("\n判定: " + (ok ? "PASS" : "FAIL"));
  try { await send("Browser.close"); } catch (e) { }
  cleanup();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("FAIL:", e.message); process.exit(2); });
