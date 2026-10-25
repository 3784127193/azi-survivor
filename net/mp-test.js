/* mp-test.js — 前端双端联机自动化测试（host + guest 真浏览器对打）
 *
 * 用法：
 *   node mp-test.js [--secs 9] [--room 924362] [--net wss://...] [--port 8898]
 * 流程：
 *   1) 起本地静态服务器托管 src/（模拟线上环境）
 *   2) 拉两个 headless Chrome（不同 profile → 不同设备ID → 不同联机身份）
 *   3) CDP 驱动：host 先开局建房，2 秒后 guest 加入，各跑 secs 秒
 *   4) 抓 #test-result 的 JSON，按断言判 PASS/FAIL，并打印服务端 /stats 增量
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SECS = Number(arg("--secs", "9"));
const ROOM = arg("--room", "924362");
const NET = arg("--net", "wss://YOUR-TUNNEL.trycloudflare.com");
const PORT = Number(arg("--port", "8898"));
const GUEST_WAIT = 2;                       // host 先开局，guest 晚 2 秒加入
const TOTAL_WAIT = (SECS + GUEST_WAIT + 20) * 1000;

const SRC = path.resolve(__dirname, "..", "game", "src");
const CHROME = "C:/Users/25765/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8" };

/* ---------- 1) 本地静态服务器 ---------- */
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

/* ---------- 2) 起 Chrome + CDP 驱动 ---------- */
function launchChrome(debugPort, url) {
  const args = [
    "--disable-gpu", "--no-sandbox", "--mute-audio",
    "--remote-debugging-port=" + debugPort,
    "--window-size=900,700",
    "--user-data-dir=" + path.join(require("os").tmpdir(), "azi-mp-" + debugPort),
    url,
  ];
  const ch = spawn(CHROME, args, { stdio: "ignore" });
  return ch;
}

async function cdpClient(debugPort) {
  /* 等 devtools 端口起来 */
  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      page = list.find(t => t.type === "page");
      if (page) break;
    } catch (e) { /* 端口未起 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!page) throw new Error("chrome devtools 未就绪 port=" + debugPort);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("cdp ws 连接失败")); });
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => rej(new Error("timeout " + method)), 20000);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, ws };
}

/* 轮询页面里的 #test-result，返回解析后的 JSON */
async function waitResult(cdp, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < TOTAL_WAIT) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const el = document.getElementById('test-result'); return el ? el.textContent : ''; })()`,
      returnByValue: true,
    });
    const txt = r.result && r.result.result && r.result.result.value;
    if (txt && txt.startsWith("RESULT ")) {
      return JSON.parse(txt.slice(7));
    }
    await new Promise(r2 => setTimeout(r2, 500));
  }
  throw new Error(label + " 等待结果超时");
}

/* 抓页面 console 错误（额外证据） */
async function collectConsole(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__errors || [])`,
    returnByValue: true,
  });
  try { return JSON.parse(r.result.result.value); } catch (e) { return []; }
}

/* ---------- 3) 断言 ---------- */
function verdict(host, guest) {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };

  for (const [name, r, wantMode] of [["host", host, "host"], ["guest", guest, "guest"]]) {
    ok(!r.fatal, name + " 页面致命错误: " + r.fatal);
    ok(!(r.errors || []).length, name + " 运行时报错: " + JSON.stringify(r.errors));
    ok(r.mode === wantMode, name + " mode 应为 " + wantMode + " 实为 " + r.mode);
    ok(r.ready === true, name + " 未收到 welcome（联机没连上）");
  }
  /* host：建房、广播快照、收到 guest 输入并建影子 */
  ok(host.stats.sent >= 5, "host 快照发送数不足: " + host.stats.sent);
  ok(host.shadows.length >= 1, "host 侧没有 guest 的影子玩家: " + JSON.stringify(host.shadows));
  ok(host.enemies > 0, "host 本地没有敌人: " + host.enemies);
  /* guest：收到快照、世界已同步、能看到房主 */
  ok(guest.stats.snaps >= 5, "guest 收到快照数不足: " + guest.stats.snaps);
  ok(guest.enemies > 0, "guest 世界未同步（敌人数为 0）");
  ok(guest.remotes.length >= 1, "guest 看不到房主: " + JSON.stringify(guest.remotes));
  ok(guest.wave >= 1, "guest 波次异常: " + guest.wave);
  /* 影子移动：guest 一直按右，影子 x 应明显右移（被竞技场右墙截停也算） */
  const tl = host.timeline.filter(s => s.shx >= 0);
  if (tl.length >= 2) {
    const dx = tl[tl.length - 1].shx - tl[0].shx;
    ok(dx > 100, "影子几乎没移动（dx=" + dx + "），输入链路可能不通");
  } else {
    fails.push("host 时间线里没有影子坐标样本");
  }
  /* 输入频率：guest 20Hz 发送，host 应收到几十条 */
  ok(host.stats.inps >= 10, "host 收到的 guest 输入过少: " + host.stats.inps);
  /* 共享怪物 + 人数血量倍率：2 人房间 → 怪物血量 ×2 */
  ok(host.coop === 2, "host 人数倍率应为 2（房主+房客）实为 " + host.coop);
  ok(host.hpRatio > 0, "host 侧没有可采样的普通怪，无法验证血量倍率");
  if (host.hpRatio > 0) {
    ok(host.hpRatio >= 1.8 && host.hpRatio <= 2.2,
      "怪物血量不是 2 倍（实测 ×" + host.hpRatio + "）");
  }
  /* 共同打怪：房客命中上报 → 房主权威结算，双方击杀数共享 */
  ok(guest.stats.hitsSent > 0, "房客没有上报任何命中（hitsSent=0），子弹/伤害链路不通");
  ok(host.stats.hitsRecv > 0, "房主未结算到房客的伤害（hitsRecv=0）");
  return fails;
}

/* ---------- 主流程 ---------- */
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const base = `http://127.0.0.1:${PORT}/test-mp.html`;
  const urlHost = `${base}?test=1&role=host&room=${ROOM}&secs=${SECS}&wait=0&net=${encodeURIComponent(NET)}`;
  const urlGuest = `${base}?test=1&role=guest&room=${ROOM}&secs=${SECS}&wait=${GUEST_WAIT}&net=${encodeURIComponent(NET)}`;
  console.log("[mp-test] 静态服务器:", base);
  console.log("[mp-test] 中继地址:", NET);
  console.log("[mp-test] 房间:", ROOM, "| 时长:", SECS + "s | guest 延迟加入:", GUEST_WAIT + "s");

  let statsBefore = null;
  try {
    const r = await (await fetch(NET.replace("wss://", "https://").replace("ws://", "http://") + "/stats")).json();
    statsBefore = r.counters;
    console.log("[mp-test] 服务端起始 counters:", JSON.stringify(statsBefore));
  } catch (e) { console.log("[mp-test] 取服务端 stats 失败（不影响测试）:", e.message); }

  const chromeH = launchChrome(9222, urlHost);
  const chromeG = launchChrome(9223, urlGuest);
  try {
    const cdpH = await cdpClient(9222);
    const cdpG = await cdpClient(9223);
    console.log("[mp-test] 两端浏览器已就绪，等待对局结束…");

    const [host, guest] = await Promise.all([waitResult(cdpH, "host"), waitResult(cdpG, "guest")]);
    const errH = await collectConsole(cdpH), errG = await collectConsole(cdpG);

    console.log("\n===== HOST 结果 =====");
    console.log(JSON.stringify({ ...host, timeline: host.timeline.filter((_, i) => i % 4 === 0) }, null, 1));
    console.log("\n===== GUEST 结果 =====");
    console.log(JSON.stringify({ ...guest, timeline: guest.timeline.filter((_, i) => i % 4 === 0) }, null, 1));
    if (errH.length || errG.length) console.log("\n页面错误 host:", JSON.stringify(errH), "guest:", JSON.stringify(errG));

    let statsAfter = null;
    try {
      const r = await (await fetch(NET.replace("wss://", "https://").replace("ws://", "http://") + "/stats")).json();
      statsAfter = r.counters;
      console.log("\n[mp-test] 服务端结束 counters:", JSON.stringify(statsAfter));
      if (statsBefore) {
        const d = {};
        for (const k of Object.keys(statsBefore)) d[k] = statsAfter[k] - statsBefore[k];
        console.log("[mp-test] 服务端增量:", JSON.stringify(d));
      }
    } catch (e) { }

    const fails = verdict(host, guest);
    console.log("\n===== 判定 =====");
    if (fails.length) {
      console.log("FAIL:");
      fails.forEach(f => console.log("  ✗ " + f));
      process.exitCode = 1;
    } else {
      console.log("PASS ✅  双端实时同步正常（快照/输入/影子/敌人同步全部达标）");
    }
    cdpH.ws.close(); cdpG.ws.close();
  } finally {
    try { chromeH.kill(); } catch (e) {}
    try { chromeG.kill(); } catch (e) {}
    server.close();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
