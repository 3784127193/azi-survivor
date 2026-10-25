/* mp-build-page.js — 由 index.html 生成联机测试页 test-mp.html
 *
 * 为什么要"生成"而不是手写测试页：
 *   测试页必须拥有和 index.html 完全一致的 DOM（#upgrade-cards / #screen-levelup /
 *   #modal / #toast …），否则 openLevelUp() 等 UI 代码会拿到 null 直接抛错，
 *   游戏卡在 levelup 状态、快照停发——曾因此误判"联机链路断了"。
 *   直接以 index.html 为基底注入测试逻辑，永远和线上页面结构保持一致。
 *
 * 用法：node mp-build-page.js
 * 产出：<src>/test-mp.html
 */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "game", "src");
const idx = fs.readFileSync(path.join(SRC, "index.html"), "utf8");

if (!idx.includes("</body>") || !idx.includes("<head>")) {
  console.error("FATAL: index.html 结构异常");
  process.exit(1);
}

/* 1) head 最前面：错误捕获（必须最早执行） */
const errHook = `<script>
  window.__errors = [];
  window.onerror = (m, s, l) => { window.__errors.push(m + " @" + (s || "").split("/").pop() + ":" + l); };
</script>`;

/* 2) head 末尾：测试浮层样式 */
const testCss = `<style>
#mp-log{position:fixed;left:8px;top:8px;color:#0f0;font-size:11px;z-index:998;white-space:pre;text-shadow:0 0 2px #000;pointer-events:none}
#test-result{position:fixed;right:8px;top:8px;background:rgba(0,0,0,.85);color:#0f0;font-size:10px;z-index:999;max-width:60%;max-height:90%;overflow:auto;padding:6px;border:1px solid #0f0}
</style>`;

/* 3) body 末尾（game.js 之后）：测试驱动逻辑 */
const testJs = `<script>
(function () {
  const q = new URLSearchParams(location.search);
  /* 没有 test=1 时 game.js 不会暴露 __game 钩子，带上它刷新一次 */
  if (!/[?&]test=1\\b/.test(location.search)) {
    q.set("test", "1");
    location.replace(location.pathname + "?" + q.toString());
    return;
  }
  const ROLE = q.get("role") || "host";
  const ROOM = q.get("room") || "924362";
  const SECS = parseFloat(q.get("secs") || "8");
  const WAIT = parseFloat(q.get("wait") || "0");
  const NET = q.get("net") || "";
  const logEl = document.createElement("div");
  logEl.id = "mp-log";
  logEl.textContent = "booting…";
  document.body.appendChild(logEl);
  const log = (s) => { logEl.textContent += "\\n" + s; };

  /* 时间线采样：每 250ms 记一次联机关键指标，作为同步证据 */
  const timeline = [];
  let T0 = Date.now();
  const sampler = setInterval(() => {
    const g = window.__game;
    const sh0 = Net.shadows.values().next().value;
    timeline.push({
      t: +((Date.now() - T0) / 1000).toFixed(1),
      mode: Net.mode, ready: Net.ready ? 1 : 0,
      snaps: Net.stats.snaps, inps: Net.stats.inps, sent: Net.stats.sent, recv: Net.stats.recv,
      en: g && g.enemies ? g.enemies.length : -1,
      sh: Net.shadows.size, rm: Net.remotes.length,
      ck: Net.coopMul ? Net.coopMul() : 1,          // 人数血量倍率
      hs: Net.stats.hitsSent, hr: Net.stats.hitsRecv, // 房客命中上报 / 房主结算
      shx: sh0 ? Math.round(sh0.x) : -1,
      wave: g ? g.G.wave : -1,
    });
    if (timeline.length > 200) timeline.shift();
  }, 250);

  /* 自动升级：约 4 秒会弹「升级三选一」，不点的话游戏暂停、两端都停发快照/输入 */
  const autoUp = setInterval(() => {
    const cards = document.querySelectorAll("#upgrade-cards .upg-card");
    if (cards.length) cards[0].click();
  }, 120);

  function emit(obj) {
    const el = document.createElement("div");
    el.id = "test-result";
    el.textContent = "RESULT " + JSON.stringify(obj);
    document.body.appendChild(el);
    log("done");
  }

  function boot() {
    try {
      const HG = window.__game;
      if (!HG) { emit({ role: ROLE, fatal: "__game 钩子未暴露（URL 需带 test=1）" }); return; }
      if (NET) Net.cfg.url = NET;                       // 覆盖中继地址
      const diag = { Net: typeof Net, CHARS: typeof CHARS, hook: typeof HG, netUrl: Net.cfg.url };
      log("diag " + JSON.stringify(diag));

      /* 联机现在要求已登录（未登录会被 game.js 退回单人）。
         测试页注入一个假账号，仅为跑通链路，不写任何真实凭据。 */
      try {
        CloudLB.user = { id: "zz-mp-" + ROLE + "-" + ROOM, name: "测试" + ROLE };
        log("fake-login " + CloudLB.user.id);
      } catch (e) { log("fake-login FAILED " + (e && e.message)); }

      /* 绕过建房 UI，直接注入房间状态（meKey/hostKey 决定 role） */
      HG.Room.runCode = ROOM;
      HG.Room.code = ROOM;
      HG.Room.meKey = ROOM + "-" + ROLE;
      HG.Room.hostKey = ROOM + "-host";
      HG.Room.status = "playing";

      Net.onHostGone = () => log("EVENT hostgone");
      Net.onOver = (m) => log("EVENT over " + JSON.stringify(m));

      const cid = (CHARS[0] || {}).id || "azi";
      log("waiting " + WAIT + "s before start…");
      setTimeout(() => {
        T0 = Date.now();
        HG.startGame(cid);
        log("started role=" + ROLE + " char=" + cid);
        /* guest 模拟输入：一直向右移动（驱动 host 侧影子）；真实键盘事件，走游戏自身监听 */
        if (ROLE === "guest") {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
        }

        setTimeout(() => {
          if (ROLE === "guest") window.dispatchEvent(new KeyboardEvent("keyup", { key: "d", bubbles: true }));
          const out = {
            role: ROLE, room: ROOM,
            mode: Net.mode, ready: Net.ready,
            stats: Net.stats,
            coop: Net.coopMul ? Net.coopMul() : 1,
            hpRatio: (function () {
              /* 人数倍率的直接证据：普通怪 maxHp ÷ (基础血量 × 波次倍率)。
                 取最大值——房客加入前刷的老怪倍率是 1，会把结果拉低。 */
              let best = 0;
              for (const e of (HG.enemies || [])) {
                if (e.elite || !(e.maxHp > 0)) continue;
                const base = (ENEMIES[e.type] ? ENEMIES[e.type].hp : 0) * waveHpMul(HG.G.wave);
                if (base > 0) best = Math.max(best, e.maxHp / base);
              }
              return best > 0 ? Math.round(best * 100) / 100 : -1;
            })(),
            wave: HG.G.wave, kills: HG.G.kills,
            enemies: HG.enemies.length,
            player: HG.player ? { x: Math.round(HG.player.x), y: Math.round(HG.player.y), hp: Math.round(HG.player.hp), dead: !!HG.player.dead } : null,
            remotes: Net.remotes.map(r => ({ k: r.k, x: r.x, hp: r.hp, dead: r.dead })),
            shadows: [...Net.shadows.values()].map(s => ({ k: s.k, x: Math.round(s.x), hp: s.hp, dead: s.dead })),
            timeline,
            errors: window.__errors,
          };
          emit(out);
        }, SECS * 1000);
      }, WAIT * 1000);
    } catch (e) {
      emit({ role: ROLE, fatal: String(e && e.stack || e), errors: window.__errors });
    }
  }

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
</script>`;

let out = idx;
out = out.replace("<head>", "<head>\n" + errHook, 1);
out = out.replace("</head>", testCss + "\n</head>", 1);
out = out.replace("</body>", testJs + "\n</body>", 1);

/* 标题标注这是测试页，避免和线上页混淆 */
out = out.replace("<title>", "<title>[联机测试] ", 1);

const dst = path.join(SRC, "test-mp.html");
fs.writeFileSync(dst, out, "utf8");
console.log("generated:", dst, "(" + out.length + " bytes)");
console.log("checks:",
  "errHook=" + out.includes("window.__errors = []"),
  "autoUp=" + out.includes("upgrade-cards .upg-card"),
  "testResult=" + out.includes('id="test-result"'),
  "fakeLogin=" + out.includes("fake-login"),
  "gameScript=" + out.includes("js/game.js"));
