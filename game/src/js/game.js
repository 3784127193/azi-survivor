/* ============================================================
 * game.js — 豆豆幸存者 核心引擎
 * 波次生存 / 自动攻击 / 商店 / 升级 / 精英 / 结算
 * ============================================================ */
"use strict";
(() => {

/* ---------- 基础 ---------- */
/* 元素查询：找不到时返回一个游离占位节点。
 * 这样即使 HTML 与 JS 版本不一致（缺某个元素），也只是那一处失效，
 * 不会在绑定 onclick 时抛错中断整个脚本（中断会导致渲染循环不启动 → 黑屏）。 */
const __ghost = document.createElement("div");
const $ = (id) => document.getElementById(id) || __ghost;
const canvas = $("game");
const ctx = canvas.getContext("2d");
let VW = 0, VH = 0, DPR = 1;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  VW = window.innerWidth; VH = window.innerHeight;
  canvas.width = VW * DPR; canvas.height = VH * DPR;
  canvas.style.width = VW + "px"; canvas.style.height = VH + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

const ARENA = { w: 2200, h: 1500, wall: 46 };
const cam = { x: 0, y: 0, shake: 0 };
let hurtFlash = 0;
let eidSeq = 1;

/* ---------- 全局状态 ---------- */
const G = {
  screen: "menu",        // menu/char/playing/shop/levelup/pause/dying/gameover/victory
  wave: 0, waveTime: 0, waveDur: 0, spawnTimer: 0, eliteDone: false, waveClearHold: 0, sandbox: false, waveCleared: false,
  endless: false, coop: 1,          // endless: 无尽模式；coop: 联机人数血量倍率
  materials: 0, kills: 0, dmgDealt: 0, time: 0,
  shotsFired: 0, shotsHit: 0,   // 命中率统计
  rerolls: 0, pendingLevels: 0, muted: false,
  best: parseInt(localStorage.getItem("spud_best") || "0", 10)
};

let player = null;
let enemies = [], shots = [], eshots = [], pickups = [], chests = [], fx = [], parts = [], texts = [];
let shopEntries = [], shopSel = -1;
let nextRunEndless = false;   // 菜单里选了"无尽模式"→ 下一局带上，startGame 时消费
let slotsSig = "", statsSig = "";
let bannerTimer = 0, toastTimer = 0, regenAcc = 0;

Art.makeBackground(ARENA.w, ARENA.h);

/* ---------- 输入 ---------- */
const keys = {};
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;      // 输入框内不触发游戏快捷键
  const k = e.key.toLowerCase();
  if (["tab", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
  keys[k] = true;
  if (k === "tab") toggleStats();
  if (k === "h") toggleKeyLegend();
  if (k === "p" && (G.screen === "playing" || G.screen === "pause")) togglePause();
  if (k === "m") toggleMute();
});
window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; if (G.screen === "playing") togglePause(); });

/* ---------- 移动端 ---------- */
const IS_TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints || 0) > 0;
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent)
  || (IS_TOUCH && window.innerWidth < 1024)     // 平板/手机（含桌面版 UA）
  || window.innerWidth < 640;                   // 窄屏兜底
const touch = { active: false, ox: 0, oy: 0, dx: 0, dy: 0, id: null };
if (IS_MOBILE) {
  setTimeout(() => { const kl = document.getElementById("key-legend"); if (kl) kl.classList.add("hidden"); }, 0);
  document.body.classList.add("is-mobile");
  canvas.addEventListener("touchstart", (e) => {
    if (G.screen !== "playing") return;
    const t0 = e.changedTouches[0];
    touch.active = true; touch.id = t0.identifier;
    touch.ox = t0.clientX; touch.oy = t0.clientY; touch.dx = 0; touch.dy = 0;
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    if (!touch.active) return;
    for (const tch of e.changedTouches) {
      if (tch.identifier !== touch.id) continue;
      let dx = tch.clientX - touch.ox, dy = tch.clientY - touch.oy;
      const len = Math.hypot(dx, dy) || 1, maxR = 56;
      if (len > maxR) { dx = dx / len * maxR; dy = dy / len * maxR; }
      touch.dx = dx / maxR; touch.dy = dy / maxR;
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const tch of e.changedTouches) if (tch.identifier === touch.id) { touch.active = false; touch.dx = 0; touch.dy = 0; }
  };
  canvas.addEventListener("touchend", endTouch, { passive: false });
  canvas.addEventListener("touchcancel", endTouch, { passive: false });
}

/* ============================================================
 * 玩家
 * ============================================================ */
function makePlayer(charId) {
  const c = CHARS.find(c => c.id === charId);
  return {
    charId, colors: c.colors, acc: c.acc, r: 14,
    x: ARENA.w / 2, y: ARENA.h / 2, vx: 0, vy: 0,
    hp: c.hp, level: 1, xp: 0,
    weapons: [{ key: c.start, lv: 1, t: 0, anim: 0 }],
    items: {}, bonus: {}, contactDmg: 0,
    itemSlots: ITEM_SLOTS_BASE,
    floatPos: null,
    aim: -Math.PI / 2, moving: false, invuln: 0,
    weaponIcon: c.start, dead: false
  };
}

function recalc() {
  const c = CHARS.find(c => c.id === player.charId);
  const st = {
    maxHp: c.hp, hpRegen: 0, lifeSteal: 0, dmg: 0, meleeDmg: 0, rangedDmg: 0,
    atkSpeed: 0, crit: 2, range: 0, armor: 0, speed: 0, harvest: 0, magnet: 0, contactDmg: 0
  };
  const add = (o, mul) => { for (const k in o) st[k] = (st[k] || 0) + o[k] * (mul || 1); };
  add(c.mods);
  for (const key in player.items) {
    const n = player.items[key];
    add(ITEMS[key].stat, n);
    if (ITEMS[key].contactDmg) st.contactDmg += ITEMS[key].contactDmg * n;
  }
  add(player.bonus);
  if (UPGRADE_CONTACT) st.contactDmg += UPGRADE_CONTACT;
  player.st = st;
  player.maxHp = st.maxHp;
  if (player.hp > st.maxHp) player.hp = st.maxHp;
}
let UPGRADE_CONTACT = 0;

/* ============================================================
 * 界面切换
 * ============================================================ */
const SCREENS = ["screen-menu", "screen-char", "screen-shop", "screen-levelup", "screen-pause", "screen-gameover", "screen-victory", "screen-wheel", "modal", "howto"];
function showScreen(id) {
  SCREENS.forEach(s => $(s).classList.toggle("hidden", s !== id));
  const hudOn = ["playing", "shop", "levelup", "pause", "dying", "wheel", "password", "debug"].includes(G.screen);
  $("hud").classList.toggle("hidden", !hudOn);
  // 键位图只在战斗中显示；触屏设备一律不显示（CSS 媒体查询再兜一层）
  const infoOn = ["playing", "dying", "pause"].includes(G.screen) && !IS_MOBILE;
  $("left-col").classList.toggle("hidden", !infoOn);
  // 波次横幅只在战斗中显示，避免压在商店/升级面板上
  if (!["playing", "dying"].includes(G.screen)) { bannerTimer = 0; $("banner").innerHTML = ""; }
  // 波间界面刷新内嵌属性表
  if ((G.screen === "shop" || G.screen === "levelup") && player) { statsSig = ""; renderStatsPanel(); }
}
function enterState(s) {
  G.screen = s;
  if (s === "playing") { showScreen(null); $("hud").classList.remove("hidden"); }
  else if (s === "shop") showScreen("screen-shop");
  else if (s === "levelup") showScreen("screen-levelup");
  else if (s === "pause") showScreen("screen-pause");
  else if (s === "gameover") showScreen("screen-gameover");
  else if (s === "victory") showScreen("screen-victory");
  else if (s === "wheel") showScreen("screen-wheel");
  else if (s === "char") showScreen("screen-char");
  else if (s === "menu") showScreen("screen-menu");
}

/* ---------- 通用居中弹窗（提示不会被商店面板挡住） ---------- */
let modalReturn = "playing";
let modalAction = null;
function showModal(msg) {
  modalReturn = G.screen;
  modalAction = null;
  $("modal-msg").innerHTML = msg;
  $("modal-cancel").classList.add("hidden");
  $("modal-ok").classList.remove("danger");
  $("modal-ok").textContent = "确 定";
  showScreen("modal");
}
/* 二次确认弹窗：onOk 在点「确定」后执行 */
function showConfirm(msg, onOk, okText, danger) {
  modalReturn = G.screen;
  modalAction = onOk || null;
  $("modal-msg").innerHTML = msg;
  $("modal-cancel").classList.remove("hidden");
  $("modal-ok").textContent = okText || "确 定";
  $("modal-ok").classList.toggle("danger", !!danger);
  showScreen("modal");
}

function showBanner(main, sub) {
  $("banner").innerHTML = '<div class="b-main">' + main + '</div><span class="b-sub">' + (sub || "") + "</span>";
  bannerTimer = 1.7;
}
function showToast(msg) {
  $("toast").innerHTML = "<span>" + msg + "</span>";
  toastTimer = 1.4;
}
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/* ============================================================
 * 流程：菜单 → 选人 → 战斗 → 商店 → … → 结算
 * ============================================================ */
function toMenu() {
  /* 关键：把上一局全部清空。player 只要还留着，render() 就会继续画战场，
     看起来就是"返回主菜单却停在结束画面"，菜单的挥剑动画也不会出现。 */
  player = null;
  enemies = []; shots = []; eshots = []; pickups = []; chests = []; fx = []; parts = []; texts = [];
  cam.x = 0; cam.y = 0; cam.shake = 0;
  G.waveClearHold = 0; G.pendingLevels = 0;
  meVerifiedUntil = 0;
  ["screen-record", "screen-board", "screen-auth", "screen-me", "screen-news",
   "screen-codex", "screen-settings", "screen-admin-login", "screen-admin"].forEach(id => { const el = $(id); if (el) el.classList.add("hidden"); });
  stopRoomPoll();
  Net.endRun();          // 离开对局 → 断开联机中继
  enterState("menu");
  $("best-record").textContent = G.best > 0 ? "历史最佳：第 " + G.best + " 波" : "";
  refreshAccountItem();
}
function toCharSelect() {
  enterState("char");
  buildCharCards();
}
function buildCharCards() {
  const box = $("char-cards");
  box.innerHTML = "";
  CHARS.forEach(c => {
    const card = document.createElement("div");
    card.className = "char-card";
    const cv = document.createElement("canvas");
    cv.width = 88 * 2; cv.height = 88 * 2;
    cv.style.width = "88px"; cv.style.height = "88px";
    const g = cv.getContext("2d");
    g.scale(2, 2);
    Art.drawPlayer(g, { x: 44, y: 50, charId: c.id, colors: c.colors, acc: c.acc, aim: -0.6, moving: false, invuln: 0,
      weapons: [{ key: c.start, lv: 1, anim: 0 }], floatPos: null }, 0.7);
    card.appendChild(cv);
    const h3 = document.createElement("h3"); h3.textContent = c.name;
    const desc = document.createElement("p"); desc.className = "c-desc"; desc.textContent = c.desc;
    card.appendChild(h3); card.appendChild(desc);
    c.stats.forEach(s => {
      const row = document.createElement("div"); row.className = "c-stat";
      row.innerHTML = "<span>" + s[0] + "</span><b>" + s[1] + "</b>";
      card.appendChild(row);
    });
    const w = document.createElement("div"); w.className = "c-wep";
    w.innerHTML = iconHTML(WEAPONS[c.start].icon || c.start, "") + "<span>初始武器 · " + WEAPONS[c.start].name + "</span>";
    card.appendChild(w);
    card.onclick = () => { SFX.init(); SFX.resume(); SFX.click(); startGame(c.id); };
    box.appendChild(card);
  });
}
function startGame(charId) {
  /* ---- 联机模式：房主/房客接入实时中继服务器 ---- */
  if (Room.runCode && !isLoggedIn()) {
    /* 兜底：未登录不允许进联机对局（防止绕过 UI 直接开局） */
    Room.runCode = "";
    showToast("未登录无法联机，本局按单人进行");
  }
  if (Room.runCode) {
    const role = (Room.meKey === Room.hostKey) ? "host" : "guest";
    Net.onHostGone = () => {
      if (Net.dead) return;
      Net.endRun(); Room.runCode = "";
      if (G.screen === "playing" || G.screen === "dying") {
        player = null; enemies = []; shots = []; eshots = []; pickups = []; chests = []; fx = []; parts = []; texts = [];
        enterState("menu");
        showConfirm("房主已离开，对局结束", () => backToRoom(), "返回房间");
      }
    };
    Net.onOver = (m) => {
      if (Net.dead) return;
      Net.endRun();
      if (G.screen === "playing" || G.screen === "dying") {
        player = null; enemies = []; shots = []; eshots = []; pickups = []; chests = []; fx = []; parts = []; texts = [];
        enterState("menu");
        showConfirm(m.win ? "房主已通关，对局结束！" : "房主已阵亡，对局结束", () => backToRoom(), "返回房间");
      }
    };
    Net.beginRun(role).then(ok => {
      if (!ok && role === "guest") {
        /* 房客连不上中继服务器：退回单人模式，提示玩家 */
        Room.runCode = "";
        showToast("联机失败，本局按单人进行");
      }
    });
  }
  Cheat.flagged = false; Cheat.sandbox = false; Cheat.reason = ""; cheatCkTimer = 0;
  Cheat.ck = null; Cheat.rate = { t: 0, mats: 0, kills: 0, dmg: 0, x: 0, y: 0 };
  G.sandbox = false;
  const bar = $("cheat-bar"); if (bar) bar.classList.add("hidden");
  /* 已被封禁的账号/设备：开局就挂横条，玩家点一下进入外挂对局 */
  if (Cheat.banned) {
    Cheat.flagged = true;
    setTimeout(() => showCheatBar("banned", "账号或设备已被限制", true), 600);
  }
  player = makePlayer(charId);
  recalc();
  enemies = []; shots = []; eshots = []; pickups = []; chests = []; fx = []; parts = []; texts = [];
  G.wave = 0; G.kills = 0; G.dmgDealt = 0; G.time = 0; G.materials = 20; G.pendingLevels = 0;
  G.shotsFired = 0; G.shotsHit = 0;
  G.rerolls = 0; UPGRADE_CONTACT = 0; regenAcc = 0; cam.shake = 0; hurtFlash = 0;
  G.endless = !!nextRunEndless; nextRunEndless = false;   // 无尽模式：不设通关波次
  G.coop = 1;
  player.hp = player.maxHp;
  G.wave = 1;
  G.waveCleared = false;
  G.waveClearHold = 0;
  startWave();
}
function startWave() {
  G.waveDur = waveDuration(G.wave);
  G.waveTime = G.waveDur;
  G.waveClearHold = 0;          // 清掉可能的残留等待
  G.waveCleared = false;        // 新的一波重新允许结算
  G.spawnTimer = 0.5;
  // 开局先放 3 只近身怪，战斗立刻打响
  for (let i = 0; i < 3; i++) spawnEnemy(pickType(), false, true);
  G.eliteDone = false;
  enterState("playing");
  showBanner((G.endless ? "无尽 · 第 " : "第 ") + G.wave + " 波", "坚持 " + G.waveDur + " 秒！");
  SFX.waveStart();
}
function endWave() {
  /* 幂等：同一波只允许结算一次。
     否则任何"非 startWave 途径回到 playing"的动作（暂停恢复/选完升级/转盘关闭/
     弹窗确定等）都会让倒计时仍 ≤0 的旧值再次触发结算，导致连跳好几波。 */
  if (G.waveCleared) return;
  G.waveCleared = true;
  // 清场：剩余敌人化作材料，材料会飞向主角并被吸收
  enemies.slice().forEach((e, i) => {
    if (!e.dead) {
      e.dead = true;
      dropMat(e.x, e.y, Math.max(1, Math.round(e.mat * 0.5)), true);
      poof(e.x, e.y, e.color);
    }
  });
  /* 场上遗留的地面材料（已死亡怪物掉的）也一并飞向主角，不要留在地上 */
  pickups.forEach(pk => { if (!pk.gone) pk.fly = true; });
  SFX.waveClear();
  if (!G.endless && G.wave >= WAVE_TOTAL) { victory(); return; }
  G.wave++;
  G.waveTime = waveDuration(G.wave);   // 立即顶到下一波的时长，避免残留负值被再次判定
  G.waveClearHold = 0.9;               // 多给点时间，让遗留材料也飞完
}
function victory() {
  roomSubmitResult();
  if (Net.mode === "host") Net.broadcastOver(true);   // 房主通关 → 广播给所有房客
  if (G.wave > G.best) { G.best = G.wave; localStorage.setItem("spud_best", String(G.best)); }
  const rec = saveBestRecord();
  uploadRecord(rec);   // 内部走服务端 submit_record() 校验
  $("vic-stats").innerHTML = resultStatsHTML();
  $("btn-vicroom").classList.toggle("hidden", !Room.runCode);
  enterState("victory");
  SFX.victory();
}
/* 保存本机最佳并返回本局战绩；同时把本局成绩上传到云端排行榜 */
function saveBestRecord() {
  const hero = (CHARS.find(c => c.id === (player && player.charId)) || {}).name || "";
  const rec = {
    wave: Math.max(1, G.wave),
    kills: G.kills,
    mats: G.materials,
    time: Math.round(G.time),
    hero: hero
  };
  let old = null;
  try { old = JSON.parse(localStorage.getItem("azi_best") || "null"); } catch (e) { }
  const better = !old || rec.wave > old.wave || (rec.wave === old.wave && rec.kills > (old.kills || 0));
  if (better) { try { localStorage.setItem("azi_best", JSON.stringify(rec)); } catch (e) { } }
  return rec;
}
/* 上传战绩：只有登录（注册）后才能上榜 */
function uploadRecord(rec) {
  if (typeof CloudLB === "undefined" || !CloudLB) return;
  if (Cheat.sandbox) { showToast("外挂对局成绩不上传"); return; }        // 沙盒对局不上榜
  if (!CloudLB.user) { showToast("未登录，本局成绩不上榜（登录后可上榜）"); return; }
  /* 走服务端 submit_record()：越界数据在数据库层直接拒绝 */
  CloudLB.submitRecord({
    name: playerName(), hero: rec.hero, wave: rec.wave,
    kills: rec.kills, mats: rec.mats, time: rec.time, hide: hideMeOn()
  }).then(r => {
      CloudLB.lastError = "";
      if (r && r.ok === false) {
        showToast("服务器校验未通过（" + (r.reason || "数据异常") + "），成绩未上传");
      }
    })
    .catch(err => { CloudLB.lastError = (err && err.message) || "网络异常"; });
}
function die() {
  player.dead = true;
  player.hp = 0;
  G.screen = "dying";
  cam.shake = 14;
  boomFx(player.x, player.y, 60);
  for (let i = 0; i < 26; i++) parts.push({
    x: player.x, y: player.y, vx: (Math.random() - 0.5) * 420, vy: (Math.random() - 0.5) * 420 - 120,
    life: 0.9, max: 0.9, size: 4 + Math.random() * 5, color: ["#e0a86e", "#ffd54f", "#ff8a65"][(Math.random() * 3) | 0], shape: "square", rot: 0
  });
  SFX.gameover();
  setTimeout(showGameOver, 1300);
  /* 房主阵亡 = 全员对局结束：广播并复位云端房间 */
  if (Net.mode === "host") {
    Net.broadcastOver(false);
    if (Room.runCode && typeof CloudLB !== "undefined" && CloudLB.roomReset) {
      CloudLB.roomReset(Room.runCode).catch(() => { });
    }
  }
}
function showGameOver() {
  roomSubmitResult();
  if (G.wave > G.best) { G.best = G.wave; localStorage.setItem("spud_best", String(G.best)); }
  uploadRecord(saveBestRecord());
  $("go-stats").innerHTML = resultStatsHTML();
  $("btn-goroom").classList.toggle("hidden", !Room.runCode);
  enterState("gameover");
}
function resultStatsHTML() {
  const waveTxt = G.endless
    ? Math.max(1, G.wave) + " 波（无尽）"
    : Math.max(1, G.wave) + " / " + WAVE_TOTAL;
  return '<div><span>抵达波次</span><b>' + waveTxt + '</b></div>' +
    '<div><span>击杀数</span><b>' + G.kills + '</b></div>' +
    '<div><span>造成伤害</span><b>' + Math.round(G.dmgDealt) + '</b></div>' +
    '<div><span>生存时间</span><b>' + fmtTime(G.time) + '</b></div>';
}

/* ============================================================
 * 商店
 * ============================================================ */
function openShop() {
  G.rerolls = 0;
  rollShop();
  enterState("shop");
  $("shop-title").textContent = "第 " + G.wave + " 波完成！";
  $("shop-sub").textContent = "花掉材料变强，然后迎接下一波";
  renderShop();
}
function rollShop() {
  shopEntries = [];
  const w = G.wave;
  const scale = (base) => Math.round(base * (1 + w * 0.1));
  // 武器池（未满级）
  const wpool = Object.keys(WEAPONS).filter(k => {
    const own = player.weapons.find(x => x.key === k);
    return !own || own.lv < WEAPON_MAX_LV;
  });
  // 道具池（未满叠层）
  const ipool = Object.keys(ITEMS).filter(k => (player.items[k] || 0) < ITEM_MAX_STACK);
  const bag = [];
  wpool.forEach(k => bag.push({ type: "weapon", key: k }));
  ipool.forEach(k => bag.push({ type: "item", key: k }));
  // 保证至少有 1 个武器（武器栏未满时）
  const forceWeapon = player.weapons.length < 2;
  for (let i = 0; i < 4 && bag.length; i++) {
    let idx;
    if (forceWeapon && i === 0) {
      const wi = bag.map((b, j) => (b.type === "weapon" ? j : -1)).filter(j => j >= 0);
      idx = wi[(Math.random() * wi.length) | 0];
    } else {
      idx = (Math.random() * bag.length) | 0;
    }
    const pick = bag.splice(idx, 1)[0];
    const own = pick.type === "weapon" ? player.weapons.find(x => x.key === pick.key) : null;
    const ownLv = own ? own.lv : 0;
    let price;
    if (pick.type === "weapon") price = scale(WEAPONS[pick.key].price * (1 + ownLv * 0.6));
    else price = scale(ITEMS[pick.key].price);
    shopEntries.push({ type: pick.type, key: pick.key, price });
  }
}
function rerollCost() { return Math.round(5 + G.wave * 1.5 + G.rerolls * 5); }
function healCost() { return 10 + G.wave * 3; }

function renderShop() {
  const grid = $("shop-grid");
  grid.innerHTML = "";
  shopEntries.forEach((en, i) => {
    const own = en.type === "weapon" ? player.weapons.find(x => x.key === en.key) : null;
    const stack = en.type === "item" ? (player.items[en.key] || 0) : 0;
    const barFull = en.type === "item" && Object.keys(player.items).length >= player.itemSlots;
    const full = en.type === "weapon" ? player.weapons.length >= 6 && !own : (stack >= ITEM_MAX_STACK || barFull);
    const cant = G.materials < en.price || full;
    const d = document.createElement("div");
    d.className = "shop-item" + (cant ? " cant" : "");
    let lvBadge = "";
    if (en.type === "weapon") lvBadge = own ? '<span class="s-lv">Lv.' + own.lv + "→" + (own.lv + 1) + "</span>" : "";
    else if (stack) lvBadge = '<span class="s-stack">x' + stack + "</span>";
    const name = en.type === "weapon" ? WEAPONS[en.key].name : ITEMS[en.key].name;
    const desc = en.type === "weapon" ? WEAPONS[en.key].desc : ITEMS[en.key].desc;
    const icon = en.type === "weapon" ? (WEAPONS[en.key].icon || en.key) : ITEMS[en.key].icon;
    const rar = RARITY[(en.type === "weapon" ? WEAPONS[en.key].rar : ITEMS[en.key].rar) || 1];
    d.style.setProperty("--rar", rar.color);
    d.innerHTML = lvBadge + iconHTML(icon, "") +
      '<div class="s-name">' + name + '</div><div class="s-desc">' + desc + '</div>' +
      '<div class="s-price">' + iconHTML("gem", "") + en.price + "</div>" +
      '<span class="rar-tag">' + rar.name + "</span>";
    d.onclick = () => buyShop(i);
    grid.appendChild(d);
  });
  $("reroll-cost").textContent = rerollCost();
  $("heal-cost").textContent = healCost();
  $("btn-reroll").disabled = G.materials < rerollCost();
  $("btn-heal").disabled = G.materials < healCost() || player.hp >= player.maxHp;
  renderShopInv();
  renderHUD();
}
function renderShopInv() {
  const box = $("shop-inv");
  box.innerHTML = "";
  const mk = (icon, extra, tip) => {
    const d = document.createElement("div");
    d.className = "slot " + extra;
    d.innerHTML = iconHTML(icon, "") + '<span class="sell-tip">' + (tip || "出售") + "</span>";
    return d;
  };
  player.weapons.forEach((wpn, i) => {
    const d = mk(WEAPONS[wpn.key].icon || wpn.key, "weapon", "卖出 +" + sellPrice("weapon", wpn.key, wpn.lv));
    const lv = document.createElement("span"); lv.className = "lv"; lv.textContent = wpn.lv;
    d.appendChild(lv);
    d.title = WEAPONS[wpn.key].name + " Lv." + wpn.lv + "（点击出售）";
    d.onclick = () => sellFrom(i);
    box.appendChild(d);
  });
  for (const k in player.items) {
    const d = mk(ITEMS[k].icon, "", "卖出 +" + sellPrice("item", k, player.items[k]));
    const st = document.createElement("span"); st.className = "st"; st.textContent = "x" + player.items[k];
    d.appendChild(st);
    d.title = ITEMS[k].name + " x" + player.items[k] + "（点击出售）";
    d.onclick = () => sellItem(k);
    box.appendChild(d);
  }
  if (!player.weapons.length && !Object.keys(player.items).length) {
    box.innerHTML = '<p style="color:#94795a;font-size:13px;margin:6px">（背包空空如也，买点武器吧！）</p>';
  }
}
function sellPrice(type, key, lv) {
  const base = type === "weapon" ? WEAPONS[key].price * (1 + (lv - 1) * 0.6) : ITEMS[key].price * lv;
  return Math.floor(base * (1 + G.wave * 0.1) * 0.5);
}
function buyShop(i) {
  const en = shopEntries[i];
  if (!en) return;
  const own = en.type === "weapon" ? player.weapons.find(x => x.key === en.key) : null;
  const barFull = en.type === "item" && Object.keys(player.items).length >= player.itemSlots;
  const stackFull = en.type === "item" && (player.items[en.key] || 0) >= ITEM_MAX_STACK;
  const full = en.type === "weapon" ? player.weapons.length >= 6 && !own : (stackFull || barFull);
  if (en.type === "item" && barFull) {
    showModal("物品栏已满！<br>当前 <b>" + player.itemSlots + "</b> 格<br><small>击败精英开转盘有机会扩容</small>");
    SFX.click();
    return;
  }
  if (full) {
    showModal(en.type === "weapon" ? "武器栏已满！<br>最多同时持有 <b>6</b> 把武器" : "该道具已满叠层！<br>最多叠加 <b>" + ITEM_MAX_STACK + "</b> 层");
    SFX.click();
    return;
  }
  if (G.materials < en.price) {
    showModal("材料不足！<br>还需 <b>" + (en.price - G.materials) + "</b> 材料");
    SFX.click();
    return;
  }
  G.materials -= en.price;
  if (en.type === "weapon") {
    if (own) { own.lv++; showToast(WEAPONS[en.key].name + " 升级到 Lv." + own.lv + "！"); }
    else { player.weapons.push({ key: en.key, lv: 1, t: 0 }); player.weaponIcon = en.key; showToast("获得武器：" + WEAPONS[en.key].name); }
  } else {
    player.items[en.key] = (player.items[en.key] || 0) + 1;
    recalc();
    if (ITEMS[en.key].stat.maxHp) { player.hp += ITEMS[en.key].stat.maxHp; healFx(player.x, player.y); }
    showToast("获得道具：" + ITEMS[en.key].name);
  }
  recalc();
  SFX.buy();
  shopEntries.splice(i, 1);
  renderShop();
}
function sellFrom(i) {
  const w = player.weapons[i];
  if (!w) return;
  const price = sellPrice("weapon", w.key, w.lv);
  const name = WEAPONS[w.key].name + " Lv." + w.lv;
  showConfirm("确定要出售「<b>" + name + "</b>」吗？<br><small>可得 " + price +
    " 材料，出售后本局内需重新购买</small>", () => {
    G.materials += price;
    player.weapons.splice(i, 1);
    if (player.weaponIcon === w.key) player.weaponIcon = player.weapons.length ? player.weapons[player.weapons.length - 1].key : null;
    showToast("已出售 " + name);
    SFX.sell();
    renderShop();
  }, "出售", true);
}
function sellItem(k) {
  const n = player.items[k];
  if (!n) return;
  const price = sellPrice("item", k, n);
  const name = ITEMS[k].name;
  showConfirm("确定要出售「<b>" + name + "</b>」×" + n + " 吗？<br><small>可得 " + price +
    " 材料，出售后本局内需重新购买</small>", () => {
    G.materials += price;
    delete player.items[k];
    recalc();
    showToast("已出售 " + name);
    SFX.sell();
    renderShop();
  }, "出售", true);
}

/* ============================================================
 * 升级三选一
 * ============================================================ */
function addXp(n) {
  if (cheatImmunity()) return;                       // 沙盒对局不获得经验
  player.xp += n;
  while (player.xp >= xpNeed(player.level)) {
    player.xp -= xpNeed(player.level);
    player.level++;
    G.pendingLevels++;
    SFX.levelup();
    beamFx(player.x, player.y);
    ringFx(player.x, player.y, 60, "#fff59d");
  }
  if (G.pendingLevels > 0 && G.screen === "playing") openLevelUp();
}
function openLevelUp() {
  enterState("levelup");
  $("lu-level").textContent = player.level;
  const pool = UPGRADES.slice();
  const picks = [];
  for (let i = 0; i < 4 && pool.length; i++) picks.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  const box = $("upgrade-cards");
  box.innerHTML = "";
  picks.forEach(u => {
    const d = document.createElement("div");
    d.className = "upg-card";
    d.innerHTML = iconHTML(u.icon, "") + "<h4>" + u.name + "</h4><p>" + u.desc + "</p>";
    d.onclick = () => chooseUpgrade(u);
    box.appendChild(d);
  });
}
function chooseUpgrade(u) {
  const before = player.st.maxHp;
  for (const k in u.stat) player.bonus[k] = (player.bonus[k] || 0) + u.stat[k];
  if (u.contactDmg) UPGRADE_CONTACT += u.contactDmg;
  recalc();
  const gain = player.st.maxHp - before;
  if (gain > 0) { player.hp += gain; healFx(player.x, player.y); }
  G.pendingLevels--;
  SFX.buy();
  if (G.pendingLevels > 0) openLevelUp();
  else { enterState("playing"); renderHUD(); }
}

/* ============================================================
 * 战斗：武器
 * ============================================================ */
function nearestEnemy(x, y, maxR) {
  let best = null, bd = maxR * maxR;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
/* 只找玩家某一侧的敌人（side: -1 左 / 1 右），避免漂浮武器枪口横穿身体 */
function nearestEnemyOnSide(maxR, side) {
  let best = null, bd = maxR * maxR;
  for (const e of enemies) {
    if (e.dead) continue;
    if ((e.x - player.x) * side < -24) continue;
    const dx = e.x - player.x, dy = e.y - player.y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function updateWeapons(dt) {
  const st = player.st;
  player.weapons.forEach((w, wi) => {
    const W = WEAPONS[w.key];
    const cd = W.cd * (1 - 0.05 * (w.lv - 1)) * (100 / (100 + st.atkSpeed));
    w.anim = Math.max(0, (w.anim || 0) - dt * 5.5);   // 攻击动画衰减（约 0.18s）
    if (w.swingT === undefined) w.swingT = -1;

    // 推进近战挥砍时间轴：刀锋落下的瞬间才结算伤害
    if (w.swingT >= 0) {
      w.swingT += dt;
      const t = w.swingT / SWING_DUR;
      if (!w.swingHit && t >= SWING_HIT) { w.swingHit = true; meleeStrike(w, W); }
      if (t >= 1) w.swingT = -1;
    }

    w.t -= dt;
    if (w.t > 0 || w.swingT >= 0) return;

    const range = (W.range || 0) * (1 + st.range / 100);
    const fpNow = player.floatPos && player.floatPos[wi];
    // 远程武器直接复用漂浮阶段算好的目标与朝向，保证枪口和子弹同向
    let target = null;
    if (W.type === "ranged" && fpNow && fpNow.target && !fpNow.target.dead) target = fpNow.target;
    if (!target) target = nearestEnemy(player.x, player.y, range);
    if (!target) { w.t = 0.06; return; }

    if (W.type === "melee") {
      /* 近战预判：怪物在刀落下的那一刻刚好进入攻击范围就起手 */
      const dist = Math.hypot(target.x - player.x, target.y - player.y);
      const approach = Math.max(0, target.speed || 0);          // 怪物接近速度
      const lead = approach * SWING_DUR * SWING_HIT;            // 起手 → 命中 之间的位移
      if (dist > range + target.size + lead) { w.t = 0.05; return; }
      w.t = cd;
      w.swingT = 0; w.swingHit = false;
      w.swingAng = Math.atan2(target.y - player.y, target.x - player.x);
      player.aim = w.swingAng;
      const lvDmg = W.dmg * (1 + 0.35 * (w.lv - 1));
      let md = lvDmg * (1 + st.dmg / 100) * (1 + st.meleeDmg / 100);
      w.swingCrit = Math.random() * 100 < st.crit;
      if (w.swingCrit) md *= 2;
      w.swingDmg = Math.round(md);
      SFX.swing();                                             // 起手挥空声
      return;
    }

    w.t = cd;
    w.anim = 1;                                        // 触发后坐力动画
    const ang = Math.atan2(target.y - player.y, target.x - player.x);
    player.aim = ang;
    const lvDmg = W.dmg * (1 + 0.35 * (w.lv - 1));
    let dmg = lvDmg * (1 + st.dmg / 100) * (1 + st.rangedDmg / 100);
    const crit = Math.random() * 100 < st.crit;
    if (crit) dmg *= 2;
    dmg = Math.round(dmg);

    /* 近战命中结算：在刀锋落下的瞬间调用，方向用起手时锁定的角度 */
    {
      // 远程：枪口朝向 = 子弹方向（同一套目标与提前量）
      const fp = fpNow;
      const wx = fp ? fp.x : player.x;
      const wy = fp ? fp.y : player.y - 2;
      let aimAng;
      if (fp && fp.target === target) {
        aimAng = fp.ang;                                  // 与绘制朝向完全一致
      } else {
        const tdx = target.x - wx, tdy = target.y - wy;
        const distT = Math.hypot(tdx, tdy);
        const lead = Math.min(0.85, distT / W.speed);
        aimAng = Math.atan2(tdy + (target.vy || 0) * lead, tdx + (target.vx || 0) * lead);
      }
      const bx = wx + Math.cos(aimAng) * 12;
      const by = wy + Math.sin(aimAng) * 12;
      fx.push({ kind: "muzzle", x: bx, y: by, ang: aimAng, t: 0, dur: 0.09 });
      const spawn = (aOff) => {
        shots.push({
          kind: w.key === "shotgun" ? "pellet" : w.key === "wand" ? "missile" : "bullet",
          x: bx, y: by, ang: aimAng + aOff,
          vx: Math.cos(aimAng + aOff) * W.speed, vy: Math.sin(aimAng + aOff) * W.speed,
          spd: W.speed, dmg, crit, life: 1.6, rot: 0
        });
        G.shotsFired++;
      };
      if (W.pellets) for (let i = 0; i < W.pellets; i++) spawn((i - (W.pellets - 1) / 2) * (W.spread / W.pellets) * 2);
      else spawn(0);
      if (w.key === "shotgun") SFX.shotgun(); else if (w.key === "smg") SFX.smgShoot(); else SFX.shoot();
    }
  });
}
/* 近战命中结算：在刀锋落下的瞬间（SWING_HIT）调用，方向用起手时锁定的角度 */
function meleeStrike(w, W) {
  const st = player.st;
  const ang = w.swingAng, dmg = w.swingDmg, crit = w.swingCrit;
  const range = (W.range || 0) * (1 + st.range / 100);
  if (W.aoe) {
    smashFx(player.x, player.y, W.aoe);
    cam.shake = Math.max(cam.shake, 5);
    SFX.smash();
    enemies.forEach(e => { if (!e.dead && dist2(e, player) < (W.aoe + e.size) * (W.aoe + e.size)) damageEnemy(e, dmg, crit, ang, 260); });
  } else if (W.line) {
    fx.push({ kind: "stab", x: player.x, y: player.y, ang, r: range, t: 0, dur: 0.22 });
    SFX.melee();
    enemies.forEach(e => {
      if (e.dead) return;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > range + e.size) return;
      let da = Math.atan2(e.y - player.y, e.x - player.x) - ang;
      while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) < 0.32) damageEnemy(e, dmg, crit, ang, 320);
    });
  } else {
    fx.push({ kind: "slash", x: player.x, y: player.y, ang, arc: W.arc, r: range, t: 0, dur: 0.24 });
    SFX.melee();
    enemies.forEach(e => {
      if (e.dead) return;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > range + e.size) return;
      let da = Math.atan2(e.y - player.y, e.x - player.x) - ang;
      while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) < W.arc / 2) damageEnemy(e, dmg, crit, ang, 200);
    });
  }
}
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

/* 玩家打怪的统一入口：房客本地先出观感，同时把真实伤害上报房主结算
   （房主侧才是敌人血量的权威）。房主/单人直接结算，不产生任何网络动作。 */
function damageEnemy(e, dmg, crit, ang, knock) {
  if (!e || e.dead) return;
  if (Net.mode === "guest" && e.id) Net.reportHit(e.id, dmg, !!crit);
  hurtEnemy(e, dmg, crit, ang, knock);
}
function hurtEnemy(e, dmg, crit, ang, knock) {
  if (e.dead) return;
  e.hp -= dmg;
  e.flash = 0.14;
  G.dmgDealt += dmg;
  if (knock) { e.kx += Math.cos(ang) * knock; e.ky += Math.sin(ang) * knock; }
  if (settings.dmgText) texts.push({ x: e.x + (Math.random() - 0.5) * 14, y: e.y - e.size, txt: String(dmg), crit, color: crit ? "#ffd54f" : "#ffffff", life: 0.7, max: 0.7 });
  for (let i = 0; i < (crit ? 7 : 3); i++) parts.push({
    x: e.x, y: e.y, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200,
    life: 0.3, max: 0.3, size: 2.5 + Math.random() * 2, color: "#fff59d", shape: "square", rot: 0
  });
  if (e.hp <= 0) killEnemy(e);
  else SFX.hit();
}
function killEnemy(e) {
  if (cheatImmunity()) {                              // 沙盒对局不计击杀/计分
    e.dead = true; poof(e.x, e.y, e.color); return;
  }
  if (e.dead) return;
  /* 房客：敌人的生死由 host 快照裁决，本地只播特效/掉落/经验，不移除实体 */
  if (Net.mode === "guest") {
    poof(e.x, e.y, e.color);
    dropMat(e.x, e.y, e.mat);
    addXp(e.xp);
    return;
  }
  e.dead = true;
  G.kills++;
  SFX.enemyDie();
  poof(e.x, e.y, e.color);
  if (e.elite) {
    chests.push({ x: e.x, y: e.y, opened: false });
    for (let i = 0; i < 5; i++) dropMat(e.x + (Math.random() - 0.5) * 40, e.y + (Math.random() - 0.5) * 40, 2 + Math.round(Math.random() * 2));
  } else {
    dropMat(e.x, e.y, e.mat);
  }
  addXp(e.xp);
  if (player.st.lifeSteal > 0 && Math.random() * 100 < player.st.lifeSteal) {
    player.hp = Math.min(player.maxHp, player.hp + 1);
    healFx(player.x, player.y);
  }
}

/* ---------- 掉落 ---------- /* fly=true 表示这撮材料会飞向主角并被吸收（清场奖励用） */
function dropMat(x, y, base, fly) {
  const val = Math.max(1, Math.round(base * (1 + player.st.harvest / 100)));
  const cx = Math.max(ARENA.wall + 12, Math.min(ARENA.w - ARENA.wall - 12, x));
  const cy = Math.max(ARENA.wall + 12, Math.min(ARENA.h - ARENA.wall - 12, y));
  pickups.push({
    x: cx, y: cy, val, ph: Math.random() * 6,
    vx: (Math.random() - 0.5) * 90, vy: (Math.random() - 0.5) * 90,
    fly: !!fly
  });
}

/* ---------- 敌人 ---------- */
function spawnEnemy(typeKey, elite, closeRing) {
  const T = ENEMIES[typeKey];
  /* 人数血量缩放：2 人 → ×2，3 人 → ×3（只有房主刷怪，倍率取房间人数） */
  const coop = (Net.mode === "host" && Net.coopMul) ? Net.coopMul() : 1;
  G.coop = coop;
  const hpMul = waveHpMul(G.wave) * coop, dmgMul = waveDmgMul(G.wave), spdMul = waveSpeedMul(G.wave);
  // 在玩家周围的环形区域刷怪（贴近玩家，保证战斗节奏）
  const ang = Math.random() * Math.PI * 2;
  const rad = closeRing ? 240 + Math.random() * 90 : 360 + Math.random() * 120;
  const lo = ARENA.wall + 30, hix = ARENA.w - ARENA.wall - 30, hiy = ARENA.h - ARENA.wall - 30;
  const clampIn = (x, y) => [
    Math.max(lo, Math.min(hix, x)),
    Math.max(lo, Math.min(hiy, y))
  ];
  let pos = clampIn(player.x + Math.cos(ang) * rad, player.y + Math.sin(ang) * rad);
  // 若被墙夹到离玩家太近，则保持最小距离
  if (Math.hypot(pos[0] - player.x, pos[1] - player.y) < 300) {
    pos = clampIn(player.x + Math.cos(ang) * 300, player.y + Math.sin(ang) * 300);
  }
  const x = pos[0], y = pos[1];
  const size = T.size * (elite ? ELITE.sizeMul : 1);
  enemies.push({
    id: eidSeq++, type: typeKey, x, y, vx: 0, vy: 0, kx: 0, ky: 0,
    hp: Math.round(T.hp * hpMul * (elite ? ELITE.hpMul : 1)),
    maxHp: Math.round(T.hp * hpMul * (elite ? ELITE.hpMul : 1)),
    size, speed: T.speed * spdMul, dmg: T.dmg * dmgMul * (elite ? ELITE.dmgMul : 1),
    xp: Math.round(T.xp * (elite ? ELITE.xpMul : 1)), mat: Math.max(1, Math.round(T.mat * (elite ? ELITE.matMul : 1))),
    color: T.color, color2: T.color2, erratic: T.erratic, ranged: T.ranged,
    keepDist: T.keepDist, fireCd: T.fireCd || 0, shotSpeed: T.shotSpeed || 0, shotDmg: T.shotDmg || 0,
    fireT: 1 + Math.random(), ph: Math.random() * 6, aim: 0, hitCd: 0, flash: 0, elite: !!elite, dead: false
  });
  fx.push({ kind: "portal", x, y, r: size + 6, t: 0, dur: 0.45 });
}
function updateWave(dt) {
  if (G.screen !== "playing") return;
  G.waveTime -= dt;
  if (G.waveTime <= 0) { endWave(); return; }
  // 刷怪：场上越空，补得越快越近（避免清完场干等）
  G.spawnTimer -= dt;
  const alive = enemies.length;
  const cap = Math.min(88, 28 + G.wave * 3);
  if (alive === 0) G.spawnTimer = Math.min(G.spawnTimer, 0.08);   // 清场后立刻补怪
  const sparse = alive < 5;
  if (G.spawnTimer <= 0 && alive < cap) {
    G.spawnTimer = Math.max(0.22, (0.9 - G.wave * 0.035) * (sparse ? 0.4 : 1));
    const n = (1 + Math.floor(G.wave / 5)) * (sparse ? 2 : 1);
    for (let i = 0; i < n; i++) spawnEnemy(pickType(), false, sparse);
  }
  // 精英
  if (!G.eliteDone && G.wave % 5 === 0 && G.waveTime < G.waveDur * 0.62) {
    G.eliteDone = true;
    spawnEnemy(pickType(), true);
    showBanner("精英出现!", "击败它掉落宝箱");
    SFX.waveStart();
  }
}
function pickType() {
  const pool = [];
  for (const k in ENEMIES) {
    let w = ENEMIES[k].weight;
    if (k === "bat" && G.wave < 2) continue;
    if (k === "golem" && G.wave < 3) continue;
    if (k === "spitter" && G.wave < 4) continue;
    if (k === "slime") w = Math.max(3, w - G.wave);
    for (let i = 0; i < w; i++) pool.push(k);
  }
  return pool[(Math.random() * pool.length) | 0];
}
function updateEnemies(dt) {
  const p = player;
  for (const e of enemies) {
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt);
    e.hitCd = Math.max(0, e.hitCd - dt);
    const dx = p.x - e.x, dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    e.aim = Math.atan2(dy, dx);
    let mx = 0, my = 0;
    if (e.ranged) {
      // 远程怪：保持距离 + 绕圈
      if (d < e.keepDist - 40) { mx = -dx / d; my = -dy / d; }
      else if (d > e.keepDist + 50) { mx = dx / d; my = dy / d; }
      else { mx = -dy / d * 0.6; my = dx / d * 0.6; }
      e.fireT -= dt;
      if (e.fireT <= 0 && d < 460 && G.screen === "playing") {
        e.fireT = e.fireCd * (0.8 + Math.random() * 0.4);
        const a = e.aim;
        eshots.push({ x: e.x + Math.cos(a) * e.size, y: e.y + Math.sin(a) * e.size, vx: Math.cos(a) * e.shotSpeed, vy: Math.sin(a) * e.shotSpeed, dmg: e.shotDmg * waveDmgMul(G.wave), life: 3.5 });
        SFX.shoot();
      }
    } else if (e.erratic) {
      const wob = Math.sin(G.time * 5 + e.ph) * 0.9;
      mx = dx / d + -dy / d * wob * 0.55; my = dy / d + dx / d * wob * 0.55;
    } else {
      mx = dx / d; my = dy / d;
    }
    e.vx = mx * e.speed; e.vy = my * e.speed;
    e.x += (e.vx + e.kx) * dt;
    e.y += (e.vy + e.ky) * dt;
    e.kx *= Math.max(0, 1 - 9 * dt); e.ky *= Math.max(0, 1 - 9 * dt);
    // 边界
    e.x = Math.max(ARENA.wall + e.size * 0.5, Math.min(ARENA.w - ARENA.wall - e.size * 0.5, e.x));
    e.y = Math.max(ARENA.wall + e.size * 0.5, Math.min(ARENA.h - ARENA.wall - e.size * 0.5, e.y));
    // 接触伤害
    if (d < e.size * 0.75 + p.r * 0.8 && e.hitCd <= 0) {
      e.hitCd = 0.85;
      damagePlayer(e.dmg);
      // 尖刺反弹
      const cd = player.st.contactDmg;
      if (cd > 0) hurtEnemy(e, cd, false, Math.atan2(e.y - p.y, e.x - p.x), 180);
    }
  }
  // 简单分离，避免叠成一坨
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i]; if (a.dead) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j]; if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const rr2 = (a.size + b.size) * 0.72;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.01 && d2 < rr2 * rr2) {
        const d = Math.sqrt(d2), push = (rr2 - d) * 0.5;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }
  enemies = enemies.filter(e => !e.dead);
  // 分离后再次收拢边界，防止被挤进墙里
  for (const e of enemies) {
    e.x = Math.max(ARENA.wall + e.size * 0.5, Math.min(ARENA.w - ARENA.wall - e.size * 0.5, e.x));
    e.y = Math.max(ARENA.wall + e.size * 0.5, Math.min(ARENA.h - ARENA.wall - e.size * 0.5, e.y));
  }
}

/* ---------- 玩家受击 ---------- */
function damagePlayer(raw) {
  if (player.invuln > 0 || player.dead || G.screen !== "playing") return;
  if (cheatImmunity()) {                                   // 沙盒对局：怪物无法造成伤害
    texts.push({ x: player.x, y: player.y - 26, txt: "免疫", crit: false, color: "#90caf9", life: 0.6, max: 0.6 });
    return;
  }
  const dmg = Math.max(1, Math.round(raw - player.st.armor));
  player.hp -= dmg;
  player.invuln = 0.7;
  hurtFlash = 0.4;
  cam.shake = 9;
  SFX.hurt();
  texts.push({ x: player.x, y: player.y - 26, txt: "-" + dmg, crit: false, color: "#ff5252", life: 0.8, max: 0.8 });
  for (let i = 0; i < 8; i++) parts.push({
    x: player.x, y: player.y, vx: (Math.random() - 0.5) * 260, vy: (Math.random() - 0.5) * 260,
    life: 0.4, max: 0.4, size: 3, color: "#ef5350", shape: "square", rot: 0
  });
  if (player.hp <= 0) die();
}

/* ---------- 弹道 ---------- */
function updateShots(dt) {
  for (const s of shots) {
    s.life -= dt;
    if (s.kind === "missile") {
      // 追踪
      const tg = nearestEnemy(s.x, s.y, 320);
      if (tg) {
        const want = Math.atan2(tg.y - s.y, tg.x - s.x);
        let da = want - s.ang;
        while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
        s.ang += Math.max(-4 * dt, Math.min(4 * dt, da * 6 * dt));
        s.vx = Math.cos(s.ang) * s.spd; s.vy = Math.sin(s.ang) * s.spd;
      }
      s.rot += dt * 10;
    } else if (s.kind === "boomerang") {
      s.rot += dt * 16;
    }
    const px0 = s.x, py0 = s.y;
    s.x += s.vx * dt; s.y += s.vy * dt;
    // 命中敌人（扫掠检测：整段飞行轨迹都参与判定）
    for (const e of enemies) {
      if (e.dead) continue;
      if (!segCircleHit(px0, py0, s.x, s.y, e.x, e.y, e.size + 6)) continue;
      if (s.kind === "boomerang") {
        if (s.hit && s.hit.includes(e.id)) continue;
        (s.hit = s.hit || []).push(e.id);
        G.shotsHit++;
        hurtEnemy(e, s.dmg, s.crit, s.ang, 60);
      } else {
        G.shotsHit++;
        hurtEnemy(e, s.dmg, s.crit, s.ang, 90);
        if (s.kind === "missile") { boomFx(s.x, s.y, 34); SFX.boom(); }
        s.life = 0;
      }
      break;
    }
    if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > ARENA.w || s.y > ARENA.h) { s.gone = true; continue; }
    // 回旋镖：飞出后飞回玩家
    if (s.kind === "boomerang") {
      if (!s.ox) { s.ox = player.x; s.oy = player.y; s.out = true; }
      if (!s.back && Math.hypot(s.x - s.ox, s.y - s.oy) > 300) s.back = true;
      if (s.back) {
        const a = Math.atan2(player.y - s.y, player.x - s.x);
        s.vx = Math.cos(a) * s.spd * 1.35; s.vy = Math.sin(a) * s.spd * 1.35;
        s.ang = a;
        if (Math.hypot(player.x - s.x, player.y - s.y) < 24) s.gone = true;
      }
    }
  }
  shots = shots.filter(s => !s.gone);
}
function updateEnemyShots(dt) {
  for (const s of eshots) {
    s.life -= dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.life <= 0 || s.x < ARENA.wall || s.y < ARENA.wall || s.x > ARENA.w - ARENA.wall || s.y > ARENA.h - ARENA.wall) { s.gone = true; continue; }
    const dx = player.x - s.x, dy = player.y - s.y;
    if (dx * dx + dy * dy < (player.r + 5) * (player.r + 5)) {
      damagePlayer(s.dmg);
      s.gone = true;
    }
  }
  eshots = eshots.filter(s => !s.gone);
}

/* ---------- 拾取 ---------- */
function updatePickups(dt) {
  const magR = 45 * (1 + player.st.magnet / 100);
  for (const pk of pickups) {
    const dx = player.x - pk.x, dy = player.y - pk.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    if (pk.fly) {
      /* 清场奖励：材料飞向主角并被吸收 */
      pk.vx += (dx / d) * 2600 * dt;
      pk.vy += (dy / d) * 2600 * dt;
      const sp = Math.hypot(pk.vx, pk.vy), MAX = 900;
      if (sp > MAX) { pk.vx = pk.vx / sp * MAX; pk.vy = pk.vy / sp * MAX; }
      if (Math.random() < 0.55) parts.push({
        x: pk.x, y: pk.y, vx: 0, vy: 0, life: 0.24, max: 0.24, size: 2.6,
        color: Math.random() < 0.5 ? "#ffe082" : "#a5d6a7", shape: "square", rot: 0
      });
    } else if (d < magR) {
      const pull = 620 * (1 - d / magR) + 160;
      pk.vx += (dx / d) * pull * dt * 6;
      pk.vy += (dy / d) * pull * dt * 6;
      // 被吸取时的拖尾火花
      if (Math.random() < 0.3) parts.push({
        x: pk.x, y: pk.y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40,
        life: 0.28, max: 0.28, size: 2, color: Math.random() < 0.5 ? "#c8e6c9" : "#ffe082", shape: "square", rot: 0
      });
    } else {
      pk.vx *= Math.max(0, 1 - 3 * dt); pk.vy *= Math.max(0, 1 - 3 * dt);
    }
    pk.x += pk.vx * dt; pk.y += pk.vy * dt;
    if (d < 24) {
      pk.gone = true;
      if (cheatImmunity()) {                                // 沙盒对局不产出材料
        texts.push({ x: pk.x, y: pk.y - 8, txt: "无效", crit: false, color: "#90a4ae", life: 0.5, max: 0.5 });
      } else {
      G.materials += pk.val;
      if (pk.fly) SFX.pickup();
      else if (Math.random() < 0.5) SFX.pickup();
      // 入体特效：绿色光环 + 火花 + "+N" 飘字
      ringFx(pk.x, pk.y, pk.fly ? 20 : 13, "#a5d6a7");
      texts.push({ x: pk.x, y: pk.y - 8, txt: "+" + pk.val, crit: false, color: "#a5d6a7", life: 0.55, max: 0.55 });
      for (let i = 0; i < (pk.fly ? 8 : 5); i++) parts.push({
        x: pk.x, y: pk.y, vx: (Math.random() - 0.5) * 150, vy: -Math.random() * 150 - 30,
        life: 0.35, max: 0.35, size: 2.6, color: i % 2 ? "#ffe082" : "#a5d6a7", shape: "square", rot: 0
      });
      }
    }
  }
  pickups = pickups.filter(p => !p.gone);
  // 宝箱 → 幸运转盘
  for (const c of chests) {
    if (c.opened) continue;
    if (Math.hypot(player.x - c.x, player.y - c.y) < 32) {
      c.opened = true;
      openWheel();
    }
  }
}

/* ============================================================
 * 幸运转盘（精英宝箱奖励）
 * ============================================================ */
const wheel = { rot: 0, spinning: false, t: 0, dur: 3.6, from: 0, to: 0, prize: null, size: 330 };

function openWheel() {
  enterState("wheel");
  wheel.rot = 0; wheel.spinning = false; wheel.t = 0; wheel.prize = null;
  $("wheel-result").innerHTML = "";
  $("wheel-result").classList.add("hidden");
  $("btn-spin").classList.remove("hidden");
  $("btn-wheel-ok").classList.add("hidden");
  setupWheelCanvas();
  drawWheelCanvas();
}
/* 按 devicePixelRatio 放大位图，避免高分屏文字发虚；盘面预渲染到离屏画布 */
function setupWheelCanvas() {
  const cv = $("wheel-canvas");
  const size = IS_MOBILE
    ? Math.min(320, Math.max(232, window.innerWidth - 108))
    : 332;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = size + "px";
  cv.style.height = size + "px";
  const g = cv.getContext("2d");
  if (g.setTransform) g.setTransform(dpr, 0, 0, dpr, 0, 0);
  wheel.size = size;
  wheel.dpr = dpr;
  // 盘面只画一次，旋转时只贴图（大幅降低每帧开销）
  const off = document.createElement("canvas");
  off.width = Math.round(size * dpr);
  off.height = Math.round(size * dpr);
  const og = off.getContext("2d");
  og.setTransform(dpr, 0, 0, dpr, 0, 0);
  Art.drawWheelBase(og, WHEEL_PRIZES, size);
  wheel.base = off;
}
function drawWheelCanvas() {
  const cv = $("wheel-canvas");
  const g = cv.getContext("2d");
  const size = wheel.size, dpr = wheel.dpr || 1;
  if (g.setTransform) g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  if (wheel.base) {
    g.save();
    g.translate(size / 2, size / 2);
    g.rotate(wheel.rot);
    g.drawImage(wheel.base, -size / 2, -size / 2, size, size);
    g.restore();
  }
  Art.drawWheelOverlay(g, size);
}
function spinWheel() {
  if (wheel.spinning) return;
  wheel.spinning = true;
  wheel.t = 0;
  wheel.from = wheel.rot;
  // 按权重抽奖（权重越低越稀有）
  const total = WHEEL_PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total, k = 0;
  for (let i = 0; i < WHEEL_PRIZES.length; i++) { r -= WHEEL_PRIZES[i].weight; if (r <= 0) { k = i; break; } }
  wheel.prize = WHEEL_PRIZES[k];
  // 目标角度：指针（正上方）对准该扇区内随机一点（扇区已按权重划分）
  const s = wheelSectors(WHEEL_PRIZES)[k];
  const pad = s.span * 0.15;                      // 留边，避免正好压在分割线上
  const theta = s.a0 + pad + Math.random() * (s.span - pad * 2);
  let to = -Math.PI / 2 - theta + 5 * Math.PI * 2;
  while (to < wheel.from + Math.PI * 5) to += Math.PI * 2;
  wheel.to = to;
  $("btn-spin").classList.add("hidden");
  SFX.click();
}
function updateWheel(dt) {
  if (!wheel.spinning) return;
  wheel.t += dt;
  const p = Math.min(1, wheel.t / wheel.dur);
  const ease = 1 - Math.pow(1 - p, 4);   // easeOutQuart 减速感
  wheel.rot = wheel.from + (wheel.to - wheel.from) * ease;
  drawWheelCanvas();
  if (p >= 1) { wheel.spinning = false; showWheelResult(); }
}
function showWheelResult() {
  const pr = wheel.prize;
  $("wheel-result").innerHTML = "获得：" + pr.name + "<small>" + pr.desc + "</small>";
  $("wheel-result").classList.remove("hidden");
  void $("wheel-result").offsetWidth;
  $("wheel-result").classList.add("pop");
  $("btn-wheel-ok").classList.remove("hidden");
  grantPrize(pr);
  SFX.chest();
}
function grantPrize(pr) {
  switch (pr.id) {
    case "mat200": G.materials += 200; break;
    case "mat500": G.materials += 500; break;
    case "mat1000": G.materials += 1000; break;
    case "mat3000": G.materials += 3000; break;
    case "heal": player.hp = player.maxHp; healFx(player.x, player.y); break;
    case "slot1": player.itemSlots = Math.min(ITEM_SLOTS_MAX, player.itemSlots + 1); break;
    case "slot2": player.itemSlots = Math.min(ITEM_SLOTS_MAX, player.itemSlots + 2); break;
    case "upall": {
      player.weapons.forEach(w => { if (w.lv < WEAPON_MAX_LV) w.lv++; else G.materials += 20; });
      for (const k in player.items) { if (player.items[k] < ITEM_MAX_STACK) player.items[k]++; else G.materials += 15; }
      recalc();
      break;
    }
  }
  slotsSig = "";   // 强制重绘槽位（可能扩容了）
  renderHUD();
}

/* ---------- 特效/粒子/文字 ---------- */
function updateFx(dt) {
  for (const f of fx) f.t += dt;
  fx = fx.filter(f => f.t < f.dur);
  for (const p of parts) {
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 500 * dt;
    p.rot = (p.rot || 0) + dt * 8;
  }
  parts = parts.filter(p => p.life > 0);
  for (const t of texts) t.life -= dt;
  texts = texts.filter(t => t.life > 0);
}
function poof(x, y, color) {
  ringFx(x, y, 22, color);
  for (let i = 0; i < 8; i++) parts.push({
    x, y, vx: (Math.random() - 0.5) * 240, vy: (Math.random() - 0.5) * 240 - 60,
    life: 0.5, max: 0.5, size: 3 + Math.random() * 3.5, color, shape: "square", rot: 0
  });
}
function ringFx(x, y, r, color) { fx.push({ kind: "ring", x, y, r, color, t: 0, dur: 0.35 }); }
function boomFx(x, y, r) { fx.push({ kind: "boom", x, y, r, t: 0, dur: 0.4 }); }
function smashFx(x, y, r) { fx.push({ kind: "smash", x, y, r, t: 0, dur: 0.3 }); }
function healFx(x, y) { fx.push({ kind: "heal", x, y, t: 0, dur: 0.7 }); }
function beamFx(x, y) { fx.push({ kind: "beam", x, y, t: 0, dur: 0.8 }); }

/* ============================================================
 * 主更新
 * ============================================================ */
function updatePlayer(dt) {
  const p = player;
  p.invuln = Math.max(0, p.invuln - dt);
  if (p.dead) return;
  let mx = 0, my = 0;
  if (keys["w"] || keys["arrowup"]) my -= 1;
  if (keys["s"] || keys["arrowdown"]) my += 1;
  if (keys["a"] || keys["arrowleft"]) mx -= 1;
  if (keys["d"] || keys["arrowright"]) mx += 1;
  if (IS_MOBILE && touch.active) {                     // 移动端虚拟摇杆
    const tm = Math.hypot(touch.dx, touch.dy);
    if (tm > 0.18) { mx = touch.dx; my = touch.dy; }
  }
  p.moving = !!(mx || my);
  if (p.moving) {
    const l = Math.hypot(mx, my);
    mx /= l; my /= l;
    const spd = 200 * (1 + p.st.speed / 100);
    p.x += mx * spd * dt;
    p.y += my * spd * dt;
  }
  p.x = Math.max(ARENA.wall + p.r, Math.min(ARENA.w - ARENA.wall - p.r, p.x));
  p.y = Math.max(ARENA.wall + p.r, Math.min(ARENA.h - ARENA.wall - p.r, p.y));
  // 瞄准最近敌人
  const tg = nearestEnemy(p.x, p.y, 520);
  if (tg) p.aim = Math.atan2(tg.y - p.y, tg.x - p.x);
  else if (p.moving) p.aim = Math.atan2(my, mx);
  // 生命回复
  if (p.st.hpRegen > 0 && p.hp < p.maxHp) {
    regenAcc += p.st.hpRegen * dt;
    if (regenAcc >= 1) { regenAcc -= 1; p.hp = Math.min(p.maxHp, p.hp + 1); healFx(p.x, p.y); }
  }
}
function update(dt) {
  G.time += dt;
  updateWheel(dt);
  if (G.screen === "menu") updateMenuHero(dt);
  if (G.screen === "playing" || G.screen === "dying") {
    updatePlayer(dt);
    player.floatPos = computeFloatPositions();   // 先算漂浮位置/目标，武器开火与绘制共用
    if (!G.artShot) {                            // 展示模式冻结战斗，构图不被打乱
      updateWeapons(dt);
      if (Net.mode === "guest") {
        /* 房客：世界状态以 host 快照为权威（_applySnap 负责合并敌人/子弹/他人），
           本地只做移动预测、武器特效与输入发送 */
        Net.updateGuestWorld(dt);   // 敌人位置插值 + 房主子弹推进（10Hz 快照 → 平滑）
        Net.updateGuestShots(dt);   // 本地子弹推进 + 命中上报给房主（真·共同打怪）
        Net.updateGuest(dt);
        if (G.waveClearHold > 0) {               // 波次切换由快照驱动，这里只管开商店的时机
          G.waveClearHold -= dt;
          const flying = pickups.some(pk => !pk.gone && pk.fly);
          if ((G.waveClearHold <= 0 && !flying) || G.waveClearHold < -1.2) {
            G.waveClearHold = 0; openShop();
          }
        }
      } else {
        updateEnemies(dt);
        updateShots(dt);
        updateEnemyShots(dt);
        updatePickups(dt);
        if (Net.mode === "host") Net.updateHost(dt);   // 影子玩家 + 快照广播
        if (!G.artShot) { cheatCheck(dt); cheatTick(dt); }
        if (G.waveClearHold > 0) {                 // 清场后先看材料飞入，再开商店
          G.waveClearHold -= dt;
          const flying = pickups.some(pk => !pk.gone && pk.fly);
          /* 没有材料在飞就立刻开；还有在飞就继续等，最多再多等 1.2 秒 */
          if ((G.waveClearHold <= 0 && !flying) || G.waveClearHold < -1.2) {
            G.waveClearHold = 0; openShop();
          }
        } else {
          updateWave(dt);
        }
      }
    }
  }
  updateFx(dt);
  // 相机
  if (player) {
    const tx = Math.max(0, Math.min(ARENA.w - VW, player.x - VW / 2));
    const ty = Math.max(0, Math.min(ARENA.h - VH, player.y - VH / 2));
    cam.x += (tx - cam.x) * Math.min(1, dt * 8);
    cam.y += (ty - cam.y) * Math.min(1, dt * 8);
  }
  cam.shake = Math.max(0, cam.shake - dt * 30);
  if (!settings.shake) cam.shake = 0;
  hurtFlash = Math.max(0, hurtFlash - dt * 1.4);
  bannerTimer = Math.max(0, bannerTimer - dt);
  if (!bannerTimer) $("banner").innerHTML = "";
  toastTimer = Math.max(0, toastTimer - dt);
  if (!toastTimer) $("toast").innerHTML = "";
}

/* ============================================================
 * 渲染
 * ============================================================ */
/* 线段与圆是否相交（子弹扫掠命中检测，避免高速穿透） */
function segCircleHit(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0.0001 ? ((cx - x1) * dx + (cy - y1) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = x1 + dx * t, py = y1 + dy * t;
  const ddx = cx - px, ddy = cy - py;
  return ddx * ddx + ddy * ddy <= r * r;
}

/* 远程武器：固定悬停在身体左右两侧（不绕圈），只做轻微上下浮动
 * 这里同时决定【枪口朝向】和【开火目标】，保证枪口指向与子弹方向完全一致 */
function computeFloatPositions() {
  const out = [];
  // 展示模式：所有武器环绕成一圈（仅截图用）
  if (G.artShot) {
    const n = player.weapons.length;
    const R = 162;
    player.weapons.forEach((w, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      out[i] = {
        x: player.x + Math.cos(a) * R,
        y: player.y - 8 + Math.sin(a) * R * 0.92,
        ang: a,
        target: null
      };
    });
    return out;
  }
  const st = player.st;
  const rw = [];
  player.weapons.forEach((w, i) => { if (WEAPONS[w.key].type === "ranged") rw.push(i); });
  const left = [], right = [];
  rw.forEach((wi, k) => (k % 2 === 0 ? left : right).push(wi));
  const place = (arr, side) => {
    const cnt = arr.length;
    const gap = cnt > 3 ? 26 : 33;                     // 同侧多把时收窄间距
    const bx = player.x + side * (cnt > 2 ? 56 : 50);   // 固定在两侧
    arr.forEach((wi, j) => {
      const W = WEAPONS[player.weapons[wi].key];
      const yOff = (j - (cnt - 1) / 2) * gap;
      const by = player.y - 4 + yOff + Math.sin(G.time * 2.2 + wi * 1.9) * 2.4;
      // 目标：全向「最近优先」（先找射程内离自己最近的敌人），找不到才退回本侧
      const range = (W.range || 0) * (1 + st.range / 100);
      const tg = nearestEnemy(bx, by, range) || nearestEnemyOnSide(range, side);
      let ang = player.aim;
      if (tg) {
        const d2 = Math.hypot(tg.x - bx, tg.y - by);
        const lead = Math.min(0.85, d2 / W.speed);      // 用该武器真实弹速预判
        ang = Math.atan2(tg.y + (tg.vy || 0) * lead - by, tg.x + (tg.vx || 0) * lead - bx);
      }
      out[wi] = { x: bx, y: by, ang, target: tg };
    });
  };
  place(left, -1);
  place(right, 1);
  return out;
}

function render() {
  ctx.clearRect(0, 0, VW, VH);
  if (!player) {
    // 主菜单氛围场景：怪物剪影 + 聚光灯 + 持械主角
    Art.drawMenuScene(ctx, VW, VH, G.time, DPR);
    Art.drawPlayer(ctx, menuHero, G.time);
    return;
  }
  const sh = cam.shake;
  const ox = (Math.random() - 0.5) * sh, oy = (Math.random() - 0.5) * sh;
  ctx.save();
  ctx.translate(-cam.x + ox, -cam.y + oy);

  ctx.drawImage(Art.bg, 0, 0);

  chests.forEach(c => Art.drawChest(ctx, c, G.time));
  pickups.forEach(p => Art.drawPickup(ctx, p, G.time));
  fx.forEach(f => Art.drawFx(ctx, f, G.time));
  enemies.forEach(e => Art.drawEnemy(ctx, e, G.time));
  /* 联机：其他玩家（房客视角看到房主与其他房客；含各自小血条） */
  if (Net.mode !== "solo") {
    for (const rp of Net.remotes) {
      if (rp.dead) continue;
      if (rp.hp < rp.maxHp) {
        const w = 40, pct = Math.max(0, rp.hp / rp.maxHp);
        ctx.fillStyle = "rgba(0,0,0,.5)"; rr(ctx, rp.x - w / 2 - 1, rp.y + 35, w + 2, 5, 2.5); ctx.fill();
        ctx.fillStyle = "#64b5f6"; rr(ctx, rp.x - w / 2, rp.y + 36, w * pct, 3, 1.5); ctx.fill();
      }
      Art.drawPlayer(ctx, rp, G.time);
    }
  }
  if (!player.dead) {
    // 玩家脚下小血条
    if (player.hp < player.maxHp) {
      const w = 40, pct = player.hp / player.maxHp;
      ctx.fillStyle = "rgba(0,0,0,.5)"; rr(ctx, player.x - w / 2 - 1, player.y + 35, w + 2, 5, 2.5); ctx.fill();
      ctx.fillStyle = "#ef5350"; rr(ctx, player.x - w / 2, player.y + 36, w * pct, 3, 1.5); ctx.fill();
    }
    Art.drawPlayer(ctx, player, G.time);
  }
  shots.forEach(s => Art.drawShot(ctx, s));
  eshots.forEach(s => Art.drawEnemyShot(ctx, s));
  parts.forEach(p => Art.drawParticle(ctx, p));
  texts.forEach(t => Art.drawText(ctx, t));

  ctx.restore();

  // 受击红晕
  if (hurtFlash > 0) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.75);
    g.addColorStop(0, "rgba(229,57,53,0)");
    g.addColorStop(1, "rgba(229,57,53," + hurtFlash * 0.55 + ")");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  // 屏幕外敌人指示箭头（贴近边缘时）
  if (G.screen === "playing") drawOffscreenMarkers();
  // 联机状态条（房主/房客 · 在线人数）
  if (Net.mode !== "solo" && player) {
    const n = 1 + (Net.mode === "host" ? Net.shadows.size : Net.remotes.length);
    ctx.font = "12px 'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.textAlign = "left";
    ctx.fillText((Net.mode === "host" ? "联机 · 房主" : "联机 · 房客") + " · " + n + " 人", 14, VH - 14);
  }
  if (IS_MOBILE) drawJoystick();
}
function drawJoystick() {
  if (!touch.active) return;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3;
  circle(ctx, touch.ox, touch.oy, 56); ctx.stroke();
  ctx.fillStyle = "#ffffff";
  circle(ctx, touch.ox + touch.dx * 56, touch.oy + touch.dy * 56, 22); ctx.fill();
  ctx.restore();
}
function drawOffscreenMarkers() {
  const pad = 26;
  const cx = VW / 2, cy = VH / 2;
  const hw = cx - pad, hh = cy - pad;
  enemies.forEach(e => {
    const sx = e.x - cam.x, sy = e.y - cam.y;
    if (sx > -20 && sx < VW + 20 && sy > -20 && sy < VH + 20) return;
    const a = Math.atan2(sy - cy, sx - cx);
    const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
    const dw = ca > 0.001 ? hw / ca : 1e9;
    const dh = sa > 0.001 ? hh / sa : 1e9;
    const r = Math.min(dw, dh);
    const mx = cx + Math.cos(a) * r, my = cy + Math.sin(a) * r;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(a);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = e.elite ? "#ffd54f" : "#ef5350";
    ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  });
}

/* ============================================================
 * HUD
 * ============================================================ */
function renderHUD() {
  if (!player) return;
  const p = player;
  $("hpfill").style.width = Math.max(0, p.hp / p.maxHp * 100) + "%";
  $("hptext").textContent = Math.max(0, Math.ceil(p.hp)) + "/" + p.maxHp;
  $("xpfill").style.width = (p.xp / xpNeed(p.level) * 100) + "%";
  $("xptext").textContent = "LV " + p.level;
  $("wavenum").textContent = "第 " + G.wave + " 波" + (G.endless ? " · 无尽" : "");
  const t = fmtTime(G.waveTime);
  $("wavetime").textContent = t;
  $("wavetime").classList.toggle("urgent", G.waveTime <= 5);
  $("resnum").textContent = G.materials;
  $("killnum").textContent = G.kills;

  // 武器/道具槽
  const sig = player.weapons.map(w => w.key + w.lv).join(",") + "|" + player.itemSlots + "|" + Object.keys(player.items).map(k => k + player.items[k]).join(",");
  if (sig !== slotsSig) {
    slotsSig = sig;
    const wbox = $("weapon-slots"), ibox = $("item-slots");
    wbox.innerHTML = ""; ibox.innerHTML = "";
    for (let i = 0; i < 6; i++) {
      const d = document.createElement("div");
      const w = player.weapons[i];
      d.className = "slot" + (w ? " weapon" : " empty");
      if (w) {
        d.innerHTML = iconHTML(WEAPONS[w.key].icon || w.key, "");
        const lv = document.createElement("span"); lv.className = "lv"; lv.textContent = w.lv;
        d.appendChild(lv);
        d.title = WEAPONS[w.key].name + " Lv." + w.lv;
        d.style.borderColor = (RARITY[WEAPONS[w.key].rar || 1].color) + "80";
      }
      wbox.appendChild(d);
    }
    const ikeys = Object.keys(player.items);
    for (let i = 0; i < player.itemSlots; i++) {
      const d = document.createElement("div");
      const k = ikeys[i];
      d.className = "slot" + (k ? "" : " empty");
      if (k) {
        d.innerHTML = iconHTML(ITEMS[k].icon, "");
        const st = document.createElement("span"); st.className = "st"; st.textContent = "x" + player.items[k];
        d.appendChild(st);
        d.title = ITEMS[k].name + " x" + player.items[k] + "：" + ITEMS[k].desc;
        d.style.borderColor = (RARITY[ITEMS[k].rar || 1].color) + "80";
      }
      ibox.appendChild(d);
    }
  }
  // 属性面板（波间界面内嵌，战斗中不显示）
  const ssig = JSON.stringify(player.st) + player.maxHp;
  if (ssig !== statsSig && ["shop", "levelup"].includes(G.screen)) {
    statsSig = ssig;
    renderStatsPanel();
  }
}
function renderStatsPanel() {
  const st = player.st;
  const fmt = (v) => {                     // 去掉浮点误差：整数直接显示，小数保留 1 位
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  let html = "";
  for (const k in STAT_META) {
    const m = STAT_META[k];
    let v = st[k];
    if (k === "maxHp") v = player.maxHp;
    const txt = m.pct ? (v > 0 ? "+" : "") + fmt(v) + "%" : fmt(v) + (m.unit || "");
    html += '<div class="stat-row"><span>' + m.name + "</span><b>" + txt + "</b></div>";
  }
  if (st.contactDmg) html += '<div class="stat-row"><span>反弹伤害</span><b>' + fmt(st.contactDmg) + "</b></div>";
  // HUD / 商店 / 升级三处共用
  ["shop-stats-list", "lu-stats-list"].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = html;
  });
}
/* 战斗中不再显示属性面板：Tab 给出提示 */
function toggleStats() {
  showToast("属性面板在波次结束后的商店 / 升级界面查看");
}
function toggleKeyLegend() {
  const p = $("key-legend");
  p.classList.toggle("hidden");
  showToast(p.classList.contains("hidden") ? "⌨ 键位图已关闭（按 H 重新打开）" : "⌨ 键位图已开启");
}
function togglePause() {
  if (G.screen === "playing") enterState("pause");
  else if (G.screen === "pause") enterState("playing");
}
function toggleMute() {
  G.muted = !G.muted;
  settings.sound = !G.muted;
  saveSettings();
  SFX.muted = G.muted;
  $("btn-mute").textContent = G.muted ? "音效：关" : "音效：开";
  showToast(G.muted ? "已关闭音效" : "已开启音效");
}

/* ============================================================
 * 按钮绑定
 * ============================================================ */
$("btn-start").onclick = () => { SFX.init(); SFX.resume(); SFX.click(); openModeSelect(); };
$("btn-howto-back").onclick = () => { SFX.click(); showScreen("screen-menu"); };
$("pause-btn").onclick = () => togglePause();
$("btn-resume").onclick = () => { SFX.click(); togglePause(); };
$("btn-mute").onclick = () => toggleMute();
$("btn-restart").onclick = () => { SFX.click(); toCharSelect(); };
$("btn-tomenu").onclick = () => { SFX.click(); toMenu(); };
$("btn-reroll").onclick = () => {
  const c = rerollCost();
  if (G.materials < c) { showToast("材料不足！"); return; }
  G.materials -= c; G.rerolls++;
  rollShop(); renderShop(); SFX.click();
};
$("btn-heal").onclick = () => {
  const c = healCost();
  if (G.materials < c || player.hp >= player.maxHp) return;
  G.materials -= c;
  player.hp = Math.min(player.maxHp, player.hp + 3);
  healFx(player.x, player.y);
  showToast("回复了 3 点生命");
  SFX.heal();
  renderShop();
};
$("btn-nextwave").onclick = () => { SFX.click(); startWave(); };
$("btn-spin").onclick = () => spinWheel();
$("btn-wheel-ok").onclick = () => { SFX.click(); enterState("playing"); renderHUD(); };
$("modal-ok").onclick = () => {
  SFX.click();
  const act = modalAction; modalAction = null;
  enterState(modalReturn === "playing" ? "playing" : modalReturn);
  if (act) act();
};
$("modal-cancel").onclick = () => {
  SFX.click();
  modalAction = null;
  enterState(modalReturn === "playing" ? "playing" : modalReturn);
};

/* ============================================================
 * 主菜单：展示主角 + 二级界面（图鉴/设置/战绩/制作人/新消息）
 * ============================================================ */
const menuHero = {
  charId: "azi", colors: CHARS[0].colors, acc: CHARS[0].acc,
  x: 0, y: 0, aim: -0.55, moving: false, invuln: 0, scale: 2.05,
  weapons: [
    { key: "sword", lv: 4, anim: 0, swingT: -1 },
    { key: "pistol", lv: 4, anim: 0 },
    { key: "shotgun", lv: 4, anim: 0 },
    { key: "wand", lv: 4, anim: 0 }
  ],
  floatPos: null
};
/* 菜单主角：不再自动挥剑，改为点击空白区域时朝点击方向挥一下 */
function menuHeroSwing(cx, cy) {
  const w0 = menuHero.weapons[0];
  if (w0.swingT === undefined) w0.swingT = -1;
  if (w0.swingT >= 0) return;                     // 上一刀还没收完
  if (typeof cx === "number" && typeof cy === "number") {
    menuHero.aim = Math.atan2(cy - menuHero.y, cx - menuHero.x);
  }
  w0.swingT = 0;
  w0.swingAng = menuHero.aim;
  SFX.melee();
}
function updateMenuHero(dt) {
  const w0 = menuHero.weapons[0];
  if (w0.swingT === undefined) w0.swingT = -1;
  if (w0.swingT >= 0) { w0.swingT += dt; if (w0.swingT >= SWING_DUR) w0.swingT = -1; }
  menuHero.weapons.forEach(w => { w.anim = Math.max(0, (w.anim || 0) - dt * 3); });
  const bob = Math.sin(G.time * 1.5) * 5;
  menuHero.x = VW / 2;
  menuHero.y = VH * 0.58 + bob;
  const hx = menuHero.x, hy = menuHero.y;
  menuHero.floatPos = [
    null,
    { x: hx - 86, y: hy - 30 + Math.sin(G.time * 1.9) * 4, ang: -2.35 },
    { x: hx + 86, y: hy - 38 + Math.cos(G.time * 1.7) * 4, ang: -0.75 },
    { x: hx + 82, y: hy + 24 + Math.sin(G.time * 2.2 + 1) * 4, ang: 0.95 }
  ];
}
/* 点击画布空白处 → 主角挥剑（菜单按钮是 DOM 层，点不到画布） */
canvas.addEventListener("pointerdown", (e) => {
  if (G.screen !== "menu") return;
  const r = canvas.getBoundingClientRect();
  menuHeroSwing(e.clientX - r.left, e.clientY - r.top);
});

/* ---------- 设置（本机保存） ---------- */
const settings = { sound: true, shake: true, dmgText: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem("azi_settings") || "{}")); } catch (e) { }
function saveSettings() { try { localStorage.setItem("azi_settings", JSON.stringify(settings)); } catch (e) { } }
function renderSetBtns() {
  const map = [["set-sound", settings.sound], ["set-shake", settings.shake], ["set-dmgtext", settings.dmgText]];
  map.forEach(m => {
    const b = $(m[0]);
    if (!b) return;
    b.textContent = m[1] ? "开" : "关";
    b.className = "act-btn" + (m[1] ? " green" : "");
  });
}
$("set-sound").onclick = () => { settings.sound = !settings.sound; saveSettings(); applySettings(); SFX.click(); };
$("set-shake").onclick = () => { settings.shake = !settings.shake; saveSettings(); renderSetBtns(); SFX.click(); };
$("set-dmgtext").onclick = () => { settings.dmgText = !settings.dmgText; saveSettings(); renderSetBtns(); SFX.click(); };
function applySettings() {
  G.muted = !settings.sound;
  SFX.muted = G.muted;
  $("btn-mute").textContent = G.muted ? "音效：关" : "音效：开";
  renderSetBtns();
}

/* ---------- 二级界面开关 ---------- */
/* 打开菜单级面板：先把所有 screen 都藏起来，避免上一层菜单叠在下面挡住点击 */
function openMenuPanel(id) {
  SFX.click();
  document.querySelectorAll(".screen").forEach(el => {
    if (el.id !== id) el.classList.add("hidden");
  });
  $(id).classList.remove("hidden");
}
function closeMenuPanel(id) {
  SFX.click();
  document.querySelectorAll(".screen").forEach(el => el.classList.add("hidden"));
  $("screen-menu").classList.remove("hidden");
}
$("btn-record").onclick = () => { openMenuPanel("screen-record"); showRecord(); };
$("btn-codex").onclick = () => { openMenuPanel("screen-codex"); renderCodex(); };
$("btn-settings").onclick = () => { openMenuPanel("screen-settings"); renderSetBtns(); };
$("btn-news").onclick = () => { openMenuPanel("screen-news"); };
$("btn-board").onclick = () => { openMenuPanel("screen-board"); loadBoard(); };
$("btn-board-back").onclick = () => closeMenuPanel("screen-board");
$("btn-board-refresh").onclick = () => { SFX.click(); loadBoard(); };
/* 匿名玩家开关：勾上才把未登录（匿名）成绩一起显示 */
$("board-show-anon").onchange = () => { SFX.click(); loadBoard(); };

/* ---- 隐藏我的名字：本地记住选择，上报成绩时带给服务端 ---- */
const HIDE_ME_KEY = "azi_hide_me";
function hideMeOn() {
  try { return localStorage.getItem(HIDE_ME_KEY) === "1"; } catch (e) { return false; }
}
function setHideMe(on) {
  try { on ? localStorage.setItem(HIDE_ME_KEY, "1") : localStorage.removeItem(HIDE_ME_KEY); } catch (e) { }
}
function syncHideMeBox() {
  const cb = $("board-hide-me"), row = $("board-hide-row");
  if (!cb) return;
  cb.checked = hideMeOn();
  if (row) row.classList.toggle("on", cb.checked);
}
$("board-hide-me").onchange = () => {
  SFX.click();
  setHideMe($("board-hide-me").checked);
  syncHideMeBox();
  showToast(hideMeOn() ? "已隐藏名字，之后上榜显示「隐藏玩家」" : "已恢复显示名字");
  loadBoard();
};
syncHideMeBox();
$("btn-board-play").onclick = () => { SFX.click(); closeMenuPanel("screen-board"); toCharSelect(); };
$("btn-auth-back").onclick = () => closeMenuPanel("screen-auth");
$("btn-exit").onclick = () => { SFX.click(); showModal("感谢游玩《阿紫幸存者》！<br><small>可以直接关闭浏览器标签页退出游戏</small>"); };
/* 恢复登录态 / 处理授权回调（刷新页面后保持登录） */
restoreSession();
$("btn-record-back").onclick = () => closeMenuPanel("screen-record");
$("btn-codex-back").onclick = () => closeMenuPanel("screen-codex");
$("btn-settings-back").onclick = () => closeMenuPanel("screen-settings");
$("cheat-bar-btn").onclick = () => { SFX.click(); enterCheatMatch(); };
$("cheat-bar").onclick = (e) => { if (e.target.id === "cheat-bar") enterCheatMatch(); };
$("btn-news-close").onclick = () => { SFX.click(); closeMenuPanel("screen-news"); };
$("btn-news-back").onclick = () => closeMenuPanel("screen-news");

/* 本机存档 */
function localBest() {
  try { return JSON.parse(localStorage.getItem("azi_best") || "null"); } catch (e) { return null; }
}
function statRows(rec, waveLabel) {
  return '<div><span>最高波次</span><b>第 ' + rec.wave + ' 波' + (waveLabel || "") + '</b></div>' +
    '<div><span>击杀数</span><b>' + rec.kills + '</b></div>' +
    '<div><span>材料</span><b>' + (rec.mats || 0) + '</b></div>' +
    '<div><span>存活时间</span><b>' + fmtTime(rec.time || 0) + '</b></div>';
}
const EMPTY_ROW = '<div style="grid-column:1/-1;text-align:center;color:var(--dim);border:none;padding:14px 0">还没有战绩记录，快去打一局吧！</div>';

/* 最佳战绩：登录了读云端最佳，没登录读本机 */
async function showRecord() {
  const sub = $("record-sub"), hint = $("record-hint"), box = $("record-stats");
  const local = localBest();
  const logged = !!(CloudLB.user && CloudLB.user.name);

  if (!logged) {
    sub.textContent = "本机存档";
    hint.textContent = "未登录，仅显示本机记录";
    hint.className = "record-hint";
    box.innerHTML = local ? statRows(local) : EMPTY_ROW;
    return;
  }

  sub.textContent = "云端战绩 · 已登录";
  hint.textContent = "已登录，展示云端最佳战绩";
  hint.className = "record-hint ok";
  box.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--dim);border:none;padding:14px 0">正在读取云端战绩…</div>';
  try {
    const best = await CloudLB.myBest();
    let html = best ? statRows({ wave: best.wave, kills: best.kills, mats: best.mats, time: best.survive_sec }) : EMPTY_ROW;
    if (local) html += '<div class="record-local">本机最佳：第 ' + local.wave + ' 波 · ' + local.kills + ' 杀</div>';
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = local ? statRows(local) : EMPTY_ROW;
    hint.textContent = "云端读取失败，已回退本机记录";
    hint.className = "record-hint";
  }
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* 排行榜行渲染：rows 已按「每人最佳一局」去重（服务端 leaderboard_top 或客户端兜底） */
function renderLBRows(box, rows) {
  const me = playerName();
  box.innerHTML = rows.map((r, i) => {
    const anon = !!r.anonymous;
    const mine = !anon && r.player_name === me;
    return '<div class="lb-row' + (mine ? " me" : "") + '">' +
      '<span class="lb-rank">' + (i + 1) + '</span>' +
      '<span class="lb-name">' + escHtml(r.player_name || (anon ? "匿名玩家" : "幸存者")) +
      (anon ? '<i class="lb-tag">匿名</i>' : "") + '</span>' +
      '<span class="lb-hero">' + escHtml(r.hero || "") + '</span>' +
      '<span class="lb-wave">第 ' + (r.wave | 0) + ' 波</span>' +
      '<span class="lb-kills">' + (r.kills | 0) + ' 杀</span></div>';
  }).join("");
}
async function loadLB(box, st, n, emptyText, includeAnon) {
  if (!box || !st) return;
  box.innerHTML = '<div class="lb-note">读取全球排行榜…</div>';
  st.textContent = ""; st.classList.remove("err");
  try {
    const rows = await CloudLB.topBest(n, includeAnon);
    if (!rows.length) {
      box.innerHTML = '<div class="lb-note">' +
        (includeAnon ? emptyText : emptyText + '（也可能只有匿名成绩，勾选下方开关查看）') + '</div>';
    } else renderLBRows(box, rows);
  } catch (e) {
    box.innerHTML = "";
    st.classList.add("err");
    st.textContent = "云端暂不可用：" + ((e && e.message) ? e.message : "网络异常") + "（本机战绩不受影响）";
  }
}
/* ---------- 排行榜页 ---------- */
let boardBusy = false;
function boardAnonOn() {
  const cb = $("board-show-anon");
  return !!(cb && cb.checked);
}
async function loadBoard() {
  if (boardBusy) return;
  boardBusy = true;
  const anon = boardAnonOn();
  const row = $("board-anon-row");
  if (row) row.classList.toggle("on", anon);
  const hint = $("board-hint");
  if (hint) {
    const ok = isLoggedIn() && !!(CloudLB.user && CloudLB.user.name);
    hint.textContent = (ok ? "已登录可上榜" : "未登录无法上榜") +
      (anon ? " · 已显示匿名玩家" : " · 匿名玩家已隐藏") +
      (hideMeOn() ? " · 我的名字已隐藏" : "");
    hint.className = "lb-hint" + (ok ? " ok" : "");
  }
  try { await loadLB($("board-list"), $("board-status"), 20, "还没有人上榜，打完一局来抢第一！", anon); }
  finally { boardBusy = false; }
}
/* ============================================================
 * 账号：登录 / 注册
 *  · 手机验证码（自动注册）
 *  · 邮箱验证码 / 邮箱密码
 *  · 微信登录 / WorkBuddy 账号登录（OAuth）
 * ============================================================ */
/* 登录标识归一化：邮箱统一小写并去空格，手机号去空格。
   否则 user@qq.com / User@qq.com 会被云端当成两个不同账号。 */
function normIdent(id) {
  const v = String(id || "").trim();
  return v.indexOf("@") >= 0 ? v.toLowerCase() : v.replace(/\s+/g, "");
}

function authStatus(msg, ok) {
  const el = $("auth-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (msg ? (ok ? " ok" : " err") : "");
}
/* tab: login / reg；method: phone / email */
function showAuthPane(tab, method) {
  document.querySelectorAll(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("pane-login").classList.toggle("hidden", tab !== "login");
  $("pane-reg").classList.toggle("hidden", tab !== "reg");
  const m = method || "phone";
  document.querySelectorAll("#pane-login .auth-segbtn").forEach(b => b.classList.toggle("active", b.dataset.m === m));
  document.querySelectorAll("#pane-reg .auth-segbtn").forEach(b => b.classList.toggle("active", b.dataset.m === m));
  $("m-login-phone").classList.toggle("hidden", m !== "phone");
  $("m-login-email").classList.toggle("hidden", m !== "email");
  $("m-reg-phone").classList.toggle("hidden", m !== "phone");
  $("m-reg-email").classList.toggle("hidden", m !== "email");
  authStatus("");
  syncAuthCodeBtns();
}
document.querySelectorAll(".auth-tab").forEach(b => { b.onclick = () => { SFX.click(); showAuthPane(b.dataset.tab); }; });
document.querySelectorAll(".auth-segbtn").forEach(b => {
  b.onclick = () => {
    SFX.click();
    const tab = document.querySelector(".auth-tab.active").dataset.tab;
    showAuthPane(tab, b.dataset.m);
  };
});
$("to-reg").onclick = () => { SFX.click(); showAuthPane("reg"); };
$("to-login").onclick = () => { SFX.click(); showAuthPane("login"); };

/* 验证码冷却：按"手机号/邮箱"记账并存本地，刷新/退出重登也不会丢 */
const OTP_COOLDOWN = 60;
const codeTimers = {};
const otpKey = (t) => "azi_otp_" + (t ? (t.phone || t.email || "") : "");
function otpLeft(t) {
  try { const end = +localStorage.getItem(otpKey(t)) || 0; return Math.max(0, Math.ceil((end - Date.now()) / 1000)); }
  catch (e) { return 0; }
}
function setOtpCooldown(t, sec) {
  try { localStorage.setItem(otpKey(t), String(Date.now() + sec * 1000)); } catch (e) { }
}
/* 按剩余冷却刷新某个按钮的显示与禁用状态 */
function syncCodeBtn(btn, target) {
  if (!btn) return;
  if (codeTimers[btn.id]) { clearInterval(codeTimers[btn.id]); delete codeTimers[btn.id]; }
  const left = target ? otpLeft(target) : 0;
  if (left <= 0) { btn.disabled = false; btn.textContent = "获取验证码"; return; }
  btn.disabled = true;
  btn.textContent = left + " 秒";
  codeTimers[btn.id] = setInterval(() => {
    const l = otpLeft(target);
    if (l <= 0) {
      clearInterval(codeTimers[btn.id]); delete codeTimers[btn.id];
      btn.disabled = false; btn.textContent = "获取验证码";
    } else {
      btn.textContent = l + " 秒";
    }
  }, 500);
}
/* 切页/进页时同步三个验证码按钮（修复"退出再注册看不到冷却"） */
function syncAuthCodeBtns() {
  const pairs = [
    ["btn-rpcode", { phone: ($("reg-phone") || {}).value ? $("reg-phone").value.trim() : "" }],
    ["btn-code", { email: ($("reg-email") || {}).value ? $("reg-email").value.trim() : "" }],
    ["btn-lpcode", { phone: ($("login-phone") || {}).value ? $("login-phone").value.trim() : "" }]
  ];
  pairs.forEach(([id, t]) => {
    const btn = $(id);
    if (!btn) return;
    const key = t.phone ? { phone: t.phone } : { email: t.email };
    syncCodeBtn(btn, (key.phone || key.email) ? key : null);
  });
}
function startCodeCountdown(btn, target) { syncCodeBtn(btn, target); }

const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
const phoneOk = (v) => /^1\d{10}$/.test(String(v || "").trim());

/* ---------- 获取验证码 ---------- */
/* 发送验证码。返回 CloudLB.pending（含 isExistingUser），供调用方即时校验 */
async function doSendCode(target, btn, okText, statusFn) {
  const say = statusFn || authStatus;
  const left = otpLeft(target);
  if (left > 0) {                       // 冷却中：直接拦，不再请求（避免"一分钟只能接收一条"）
    syncCodeBtn(btn, target);
    say("请 " + left + " 秒后再获取验证码");
    return null;
  }
  if (target.email) {                   // 临时邮箱：不注册、不发验证码
    await loadBannedDomains();
    if (isDisposableEmail(target.email)) {
      say("临时邮箱无法注册或接收验证码，请更换常用邮箱");
      btn.disabled = false; btn.textContent = "获取验证码";
      return null;
    }
  }
  btn.disabled = true;
  say("正在发送验证码…", true);
  try {
    const pending = await CloudLB.sendCode(target);
    setOtpCooldown(target, OTP_COOLDOWN);
    syncCodeBtn(btn, target);
    say(okText || ("验证码已发送" + (target.phone ? "，请查收短信" : "，请查收邮箱")), true);
    return pending;
  } catch (e) {
    const msg = (e && e.message) || "网络异常";
    if (/一分钟|频繁|rate|too many|稍后|limit/i.test(msg)) {   // 平台限流 → 补上冷却显示
      setOtpCooldown(target, OTP_COOLDOWN);
      syncCodeBtn(btn, target);
      say("发送过于频繁，一分钟只能接收一条，请 " + otpLeft(target) + " 秒后再试");
    } else {
      btn.disabled = false;
      btn.textContent = "获取验证码";
      say("发送失败：" + msg);
    }
    return null;
  }
}
/* 撤销倒计时并把按钮还原 */
function abortCodeSend(btn) {
  if (codeTimers[btn.id]) { clearInterval(codeTimers[btn.id]); delete codeTimers[btn.id]; }
  btn.disabled = false;
  btn.textContent = "获取验证码";
}
$("btn-rpcode").onclick = async () => {
  const phone = normIdent($("reg-phone").value);
  if (!phoneOk(phone)) { authStatus("请输入正确的 11 位手机号"); return; }
  const btn = $("btn-rpcode");
  const pending = await doSendCode({ phone }, btn, "验证码已发送，请查收短信");
  if (!pending) return;
  if (pending.isExistingUser === true) {      // 该号已注册 → 引导登录
    CloudLB.pending = null;
    syncCodeBtn(btn, { phone: phone });
    authStatus("该手机号已注册，请直接登录");
    setTimeout(() => showAuthPane("login", "phone"), 900);
    return;
  }
  authStatus("验证码已发送，请查收短信");
};
$("btn-code").onclick = () => {
  const email = normIdent($("reg-email").value);
  if (!emailOk(email)) { authStatus("请输入正确的邮箱地址"); return; }
  doSendCode({ email }, $("btn-code"));
};
$("btn-lpcode").onclick = async () => {
  const phone = normIdent($("login-phone").value);
  if (!phoneOk(phone)) { authStatus("请输入正确的 11 位手机号"); return; }
  const btn = $("btn-lpcode");
  const pending = await doSendCode({ phone }, btn, "验证码已发送，请查收短信");
  if (!pending) return;
  /* 关键：点发送后立刻判断该手机号是否已注册，未注册直接拦下 */
  if (pending.isExistingUser === false) {
    CloudLB.pending = null;
    syncCodeBtn(btn, { phone: phone });         // 短信已发出，保持 60 秒冷却显示
    $("login-pcode").value = "";
    authStatus("该账号未注册，请注册后重试");
    return;
  }
  authStatus("验证码已发送，请查收短信");
};

/* ---------- 注册：验证码 + 设置密码 ---------- */
async function doRegister(target, code, uname, p1, p2, label) {
  if (code.length < 4) { authStatus("请输入收到的验证码"); return; }
  if (!String(uname || "").trim()) { authStatus("请填写用户名（上榜显示的名字）"); return; }
  if (p1.length < 6) { authStatus("密码至少 6 位"); return; }
  if (p1 !== p2) { authStatus("两次输入的密码不一致"); return; }
  /* 同一邮箱 / 手机号只允许一个账号：云端判定已存在时不再重复建号 */
  if (CloudLB.pending && CloudLB.pending.isExistingUser) {
    authStatus("该" + (target.email ? "邮箱" : "手机号") + "已经注册过，请直接登录（不需要重复注册）");
    showAuthPane("login", target.email ? "email" : "phone");
    return;
  }
  authStatus("正在注册…", true);
  try {
    const u = await CloudLB.verifyCode(target, code, p1);
    setPlayerName(uname);                       // 用注册时填的用户名上榜
    authStatus("注册成功，已登录：" + (u && u.name ? u.name : label), true);
    applyAutoLogin($("rp-auto") ? $("rp-auto").checked : true);
    refreshAccountItem();
    showToast("注册成功，欢迎 " + playerName());
    afterAuth(target.phone ? "phone" : "email");
    setTimeout(() => closeMenuPanel("screen-auth"), 700);
  } catch (e) {
    authStatus("注册失败：" + ((e && e.message) || "网络异常"));
  }
}
$("btn-phone-reg").onclick = () => {
  if (!agreeOk()) return;
  const phone = normIdent($("reg-phone").value);
  if (!phoneOk(phone)) { authStatus("请输入正确的 11 位手机号"); return; }
  doRegister({ phone }, String($("reg-pcode").value || "").trim(), $("reg-puname").value,
    $("reg-ppwd").value, $("reg-ppwd2").value, phone);
};
$("btn-reg").onclick = () => {
  if (!agreeOk()) return;
  const email = normIdent($("reg-email").value);
  if (!emailOk(email)) { authStatus("请输入正确的邮箱地址"); return; }
  doRegister({ email }, String($("reg-code").value || "").trim(), $("reg-uname").value,
    $("reg-pwd").value, $("reg-pwd2").value, email);
};

/* ---------- 用户协议 / 隐私政策 ---------- */
const AGREEMENT_VERSION = "2026-10-25";
const AGREEMENT_KEY = "azi_agree_v";
const DOC_TERMS = `<h4>一、协议的接受与范围</h4>
<p>《阿紫幸存者》（以下简称「本游戏」）由开发者（以下称「我们」）独立开发并运营。你注册、登录或使用本游戏，即表示你已完整阅读并同意本协议全部内容。若你不同意，请停止注册与使用。</p>

<h4>二、账号注册与使用</h4>
<ol>
<li>你可以使用邮箱或手机号注册账号。你应保证所填信息真实、有效，并对该账号下的一切行为负责。</li>
<li>为完成注册与登录验证，我们可能会向你的邮箱或手机发送验证码。验证码仅限本人使用，不得转让、公开或出售。</li>
<li>账号所有权归我们所有，你在符合本协议的前提下取得使用权。账号不得出借、出租、赠与或买卖。</li>
<li>如发现账号被盗用，请立即联系我们；在此之前产生的一切后果由账号持有人承担。</li>
</ol>

<h4>三、用户行为规范</h4>
<p>你在使用本游戏时不得实施以下行为：</p>
<ol>
<li>使用外挂、加速器、修改器、脚本或任何非官方工具影响游戏公平性；</li>
<li>篡改、伪造游戏数据或排行榜成绩，或利用漏洞获取不正当利益；</li>
<li>发布违法、侵权、辱骂、色情、暴力或涉及政治敏感的内容；</li>
<li>以任何方式攻击、探测、干扰本游戏的服务器与网络服务；</li>
<li>其他违反法律法规、公序良俗或损害其他玩家权益的行为。</li>
</ol>
<p>违反上述规范的，我们有权视情节采取警告、清除成绩、限制功能、封禁账号等措施，且无需事先通知。</p>

<h4>四、游戏数据与虚拟物品</h4>
<ol>
<li>游戏内的角色、等级、道具、材料等均为游戏数据，仅在本游戏内有效，不具有现实货币价值，不可兑换现金。</li>
<li>排行榜成绩会公开展示你的昵称、角色、波次、击杀等数据。你可以选择不登录并以匿名身份游玩。</li>
<li>因你自身原因（清除浏览器数据、更换设备、卸载、忘记密码等）导致的数据丢失，我们不承担恢复义务，但会在能力范围内提供协助。</li>
</ol>

<h4>五、服务的变更、中断与终止</h4>
<ol>
<li>本游戏目前为免费提供，我们可能随时新增、调整或下线部分功能。</li>
<li>因服务器维护、网络故障、第三方服务异常、不可抗力等原因造成的服务中断，我们不承担赔偿责任。</li>
<li>若你严重违反本协议，我们有权终止向你提供服务。</li>
</ol>

<h4>六、免责声明</h4>
<p>本游戏按「现状」提供，我们不对其绝对无错误、不中断作出保证。因使用或无法使用本游戏而产生的任何间接损失，我们在法律允许的范围内不承担责任。</p>

<h4>七、知识产权</h4>
<p>本游戏的程序、美术、音效、文案等内容的知识产权归开发者所有。未经书面许可，任何人不得复制、修改、传播或用于商业用途。</p>

<h4>八、协议的修改</h4>
<p>我们可能根据运营需要修订本协议，修订后的协议将在游戏内公示。修订生效后你继续使用本游戏，即视为接受修订内容。</p>

<h4>九、法律适用与争议解决</h4>
<p>本协议适用中华人民共和国法律。因本协议产生的争议，双方应友好协商解决；协商不成的，可向开发者所在地有管辖权的人民法院提起诉讼。</p>

<h4>十、其他</h4>
<p>本协议未尽事宜，由我们另行制定补充规则，补充规则与本协议具有同等效力。<b>本协议的最终解释权归开发者所有。</b></p>`;
const DOC_PRIVACY = `<h4>一、我们收集哪些信息</h4>
<ol>
<li><b>账号信息</b>：你注册时填写的邮箱或手机号、用户名，以及登录密码（仅以加密摘要形式存储，我们无法看到明文）。</li>
<li><b>游戏数据</b>：排行榜成绩（昵称、角色、波次、击杀数、生存时长）与对局统计。</li>
<li><b>设备标识</b>：一个随机生成的本地设备编号，用于识别「新设备登录」与反作弊，不含你的硬件序列号或手机号。</li>
<li>我们<b>不会</b>收集你的通讯录、短信、相册、精确位置或通话记录。</li>
</ol>

<h4>二、我们如何使用这些信息</h4>
<ol>
<li>完成注册、登录与身份验证（包括发送验证码邮件或短信）；</li>
<li>展示排行榜、保存你的最佳战绩；</li>
<li>识别异常行为、维护游戏公平（反作弊）；</li>
<li>排查故障、改进游戏体验。</li>
</ol>
<p>我们不会将你的信息用于与上述目的无关的用途，也不会向你推送商业广告。</p>

<h4>三、信息的存储与保护</h4>
<ol>
<li>账号数据存储于云服务提供商的数据库中，传输过程使用 HTTPS 加密。</li>
<li>我们采取访问控制、最小权限等措施保护数据，但请理解：任何互联网传输与存储都无法保证绝对安全。</li>
<li>数据在账号存续期间保存；账号注销后，我们会在合理期限内删除或匿名化处理，法律法规另有要求的除外。</li>
</ol>

<h4>四、信息的共享与披露</h4>
<p>我们<b>不会</b>出售、出租你的个人信息。仅在以下情形下可能共享：</p>
<ol>
<li>为完成登录验证，向邮件或短信服务商提供必要的收件地址／号码；</li>
<li>依据法律法规、司法或行政机关的强制性要求；</li>
<li>为保护开发者、其他玩家或公众的合法权益所必需。</li>
</ol>

<h4>五、你的权利</h4>
<p>你有权查询、更正你的账号信息，或申请注销账号、删除个人数据。如需行使上述权利，可通过游戏内公告的联系方式与我们联系，我们会在合理期限内处理。</p>

<h4>六、未成年人保护</h4>
<p>若你未满 18 周岁，请在监护人陪同下阅读本政策并使用本游戏。我们不会主动收集未成年人的敏感个人信息。</p>

<h4>七、Cookie 与本地存储</h4>
<p>本游戏使用浏览器本地存储（localStorage）保存登录状态、自动登录期限、昵称与设置项。你可以随时通过浏览器设置清除这些数据，但清除后需要重新登录。</p>

<h4>八、第三方服务</h4>
<p>本游戏使用第三方云服务提供账号与数据存储。这些服务商按其自身隐私政策处理数据，建议你一并阅读。</p>

<h4>九、政策的更新</h4>
<p>本政策可能随功能调整而更新，更新后将在游戏内公示。重大变更时，我们会以显著方式提示你。</p>

<h4>十、联系我们</h4>
<p>如对本政策有任何疑问、意见或投诉，可通过游戏内公告的联系方式与我们联系。</p>

<h4>十一、其他</h4>
<p><b>本政策的最终解释权归开发者所有。</b></p>`;

function agreementAccepted() {
  try { return localStorage.getItem(AGREEMENT_KEY) === AGREEMENT_VERSION; } catch (e) { return false; }
}
function markAgreement(v) {
  try {
    if (v) localStorage.setItem(AGREEMENT_KEY, AGREEMENT_VERSION);
    else localStorage.removeItem(AGREEMENT_KEY);
  } catch (e) { }
}
function syncAgreeBox() {
  const cb = $("auth-agree"), row = $("auth-agree-row");
  if (!cb) return;
  cb.checked = agreementAccepted();
  if (row) row.classList.remove("need");
}
/* 登录/注册前的同意校验：未勾选则拦下并提示 */
function agreeOk() {
  const cb = $("auth-agree"), row = $("auth-agree-row");
  if (cb && cb.checked) { markAgreement(true); return true; }
  if (row) row.classList.add("need");
  authStatus("请先阅读并勾选同意《用户协议》与《隐私政策》");
  return false;
}
function openDoc(kind) {
  const isTerms = kind !== "privacy";
  $("doc-title").textContent = isTerms ? "用户协议" : "隐私政策";
  $("doc-sub").textContent = "最后更新：2026 年 10 月 25 日";
  $("doc-body").innerHTML = isTerms ? DOC_TERMS : DOC_PRIVACY;
  $("doc-body").scrollTop = 0;
  $("doc-foot").textContent = (isTerms ? "本协议" : "本政策") + "最终解释权归开发者所有。";
  openMenuPanel("screen-doc");
}
function closeDoc() {
  SFX.click();
  document.querySelectorAll(".screen").forEach(el => el.classList.add("hidden"));
  $("screen-auth").classList.remove("hidden");
  syncAgreeBox();
}
$("open-terms").onclick = () => openDoc("terms");
$("open-privacy").onclick = () => openDoc("privacy");
$("btn-doc-back").onclick = closeDoc;
$("auth-agree").onchange = () => markAgreement($("auth-agree").checked);
syncAgreeBox();

/* ---------- 登录 ---------- */
/* 手机验证码登录（仅限已注册手机号） */
$("btn-phone-login").onclick = async () => {
  if (!agreeOk()) return;
  const phone = normIdent($("login-phone").value);
  if (!phoneOk(phone)) { authStatus("请输入正确的 11 位手机号"); return; }
  const p0 = CloudLB.pending;
  if (!p0 || p0.phone !== phone) { authStatus("请先获取验证码"); return; }
  if (p0.isExistingUser === false) { authStatus("该账号未注册，请注册后重试"); return; }
  const code = String($("login-pcode").value || "").trim();
  if (code.length < 4) { authStatus("请输入收到的验证码"); return; }
  authStatus("正在登录…", true);
  try {
    const u = await CloudLB.verifyCode({ phone }, code);
    authStatus("登录成功：" + (u && u.name ? u.name : phone), true);
    refreshAccountItem();
    showToast("欢迎回来，" + playerName());
    afterAuth("phone");
    setTimeout(() => closeMenuPanel("screen-auth"), 700);
  } catch (e) {
    authStatus("登录失败：" + ((e && e.message) || "网络异常"));
  }
};
/* 邮箱 + 密码登录 */
$("btn-login").onclick = async () => {
  if (!agreeOk()) return;
  const email = normIdent($("login-email").value);
  const pwd = $("login-pwd").value;
  if (!emailOk(email)) { authStatus("请输入正确的邮箱地址"); return; }
  if (!pwd) { authStatus("请输入密码"); return; }
  authStatus("正在登录…", true);
  try {
    const u = await CloudLB.login(email, pwd);
    authStatus("登录成功：" + (u && u.name ? u.name : email), true);
    refreshAccountItem();
    showToast("欢迎回来，" + playerName());
    afterAuth("email");
    setTimeout(() => closeMenuPanel("screen-auth"), 700);
  } catch (e) {
    authStatus("登录失败：" + ((e && e.message) || "账号或密码错误"));
  }
};

/* ---------- 启动：恢复登录态（已关闭第三方授权登录） ---------- */
function stripCallbackParams() {
  const url = new URL(location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("state") && !url.searchParams.has("provider")) return;
  for (const k of ["code", "state", "provider"]) url.searchParams.delete(k);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
/* 勾选"7天内自动登录"时，把有效期记到本机；7 天后要求重新登录 */
function applyAutoLogin(checked) { setAutoLogin(checked ? 7 : 0); }

/* 登录/注册成功后的统一收尾：自动登录 + 新设备识别 */
async function afterAuth(kind) {
  const until = Date.now() + 7 * 86400000;
  applyAutoLogin(kind === "auto" ? true : (kind === "phone" ? $("lp-auto").checked : $("le-auto").checked));
  if (autoLoginUntil() < Date.now()) { setAutoLogin(0); }        // 没勾选就不免登录
  void until;
  const r = await CloudLB.checkDevice();
  await CloudLB.markDevice();
  if (r.known) return;                                          // 本机登录过 → 不是新设备
  const who = kind === "phone" ? "手机号" : "邮箱";
  showToast("新设备登录已记录，验证信息已发送至你的" + who);
}
async function restoreSession() {
  stripCallbackParams();          // 清掉历史上遗留的授权参数
  await CloudLB.restore();
  const until = autoLoginUntil();
  if (CloudLB.user && until && Date.now() > until) {
    // 超过 7 天自动登录有效期 → 要求重新登录
    await CloudLB.logout();
    setAutoLogin(0);
    showToast("登录已超过 7 天，请重新登录");
  } else if (!CloudLB.user && until > Date.now()) {
    // 有自动登录记录但会话已失效 → 尝试刷新
    await CloudLB.refreshSession();
  }
  refreshAccountItem();
  /* 反作弊：账号或设备被服务端标记 → 记下来，开局挂横条 */
  try {
    const st = await CloudLB.cheatStatus();
    if (st && st.banned) {
      Cheat.banned = true;
      showToast("该" + (st.device_banned ? "设备" : "账号") + "已被限制上榜");
    }
  } catch (e) { }
  /* 预拉一次临时邮箱黑名单 */
  loadBannedDomains();
}

/* ============================================================
 * 我的：账号与安全
 *  · 修改用户名 / 修改密码必须先通过"当前绑定手机号"验证码验证
 *  · 换绑邮箱 / 换绑手机号：云服务当前无此接口，界面明确标注暂不支持
 * ============================================================ */
const ME_VERIFY_TTL = 10 * 60 * 1000;      // 验证通过后 10 分钟内可操作
let meVerifiedUntil = 0;

const mePwdOk = () => !!CloudLB.user && Date.now() < meVerifiedUntil;
const last11 = (s) => String(s || "").replace(/\D/g, "").slice(-11);
function maskPhone(p) {
  const d = last11(p);
  return d.length === 11 ? d.slice(0, 3) + "****" + d.slice(7) : (p || "未绑定");
}
function maskEmail(e) {
  if (!e) return "未绑定";
  const i = e.indexOf("@");
  if (i <= 1) return e;
  return e.slice(0, 1) + "***" + e.slice(i);
}
function meStatus(msg, ok) {
  const el = $("me-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (msg ? (ok ? " ok" : " err") : "");
}
let meProfile = null;      // 云端账号档案（绑定邮箱等）

/* 当前账号手机号：会话 user.phone → 本地登录标识（按 uid 存）三级兜底 */
function mePhone() {
  const u = CloudLB.user || {};
  const a = last11(u.phone);
  if (a) return a;
  const id = CloudLB.loadIdent(u.id);
  const b = last11(id.phone);
  if (b) return b;
  return last11(meProfile && meProfile.contact_phone);
}
function meEmail() {
  const u = CloudLB.user || {};
  return u.email || CloudLB.loadIdent(u.id).email || (meProfile && meProfile.contact_email) || "";
}
function renderMe() {
  const u = CloudLB.user || {};
  const phone = mePhone();
  $("me-name-view").textContent = playerName();
  $("me-phone-view").textContent = phone ? maskPhone(phone) : "未绑定手机号";
  $("me-email-view").textContent = maskEmail(meEmail());
  $("me-vphone").value = phone;
  $("me-vphone").placeholder = phone ? "当前绑定手机号" : "当前账号未绑定手机号";
  $("me-new-name").value = playerName();
  const mail = meEmail();
  $("me-bind-email").value = (meProfile && meProfile.contact_email) || "";
  const mb = $("me-mail-badge");
  mb.textContent = (meProfile && meProfile.contact_email) ? "已绑定" : "未绑定";
  mb.className = "me-badge" + ((meProfile && meProfile.contact_email) ? " ok" : "");
  meStatus("");
  updateMeBadge();
}
function updateMeBadge() {
  const ok = mePwdOk();
  const b = $("me-vbadge");
  b.textContent = ok ? "已验证" : "未验证";
  b.className = "me-badge" + (ok ? " ok" : "");
  $("me-vtip").textContent = ok
    ? "已验证通过（10 分钟内有效），可以修改下面的信息"
    : "修改用户名 / 修改密码前，需先验证当前账号绑定的手机号";
}
function openMe() {
  if (!CloudLB.user) {
    showToast("请先登录后再进入「我的」");
    showAuthPane("login", "phone");
    openMenuPanel("screen-auth");
    return;
  }
  meVerifiedUntil = 0;
  renderMe();
  openMenuPanel("screen-me");
  /* 用服务端最新用户补全手机号/邮箱（会话里的 user 可能缺 phone） */
  CloudLB.refreshUser().then(() => renderMe());
  CloudLB.getProfile().then(p => { if (p) { meProfile = p; renderMe(); } });
}
$("btn-me").onclick = () => { SFX.click(); openMe(); };
$("btn-me-back").onclick = () => closeMenuPanel("screen-me");

/* 发送验证码（校验必须是当前账号绑定的手机号） */
$("me-send-code").onclick = async () => {
  const bound = mePhone();
  const phone = $("me-vphone").value.trim();
  if (!phoneOk(phone)) { meStatus("请输入正确的 11 位手机号"); return; }
  if (bound && bound !== phone) {
    meStatus("请填写当前账号绑定的手机号（" + maskPhone(bound) + "）");
    return;
  }
  if (!bound) {
    meStatus("当前账号未绑定手机号，无法完成手机号验证");
    return;
  }
  const btn = $("me-send-code");
  const pending = await doSendCode({ phone }, btn, "验证码已发送，请查收短信");
  if (!pending) return;
  if (pending.isExistingUser === false) {
    CloudLB.pending = null;
    syncCodeBtn(btn, { phone: phone });
    meStatus("该手机号未注册，无法用于验证");
    return;
  }
  meStatus("验证码已发送，请查收短信");
};

/* 提交验证 */
$("me-do-verify").onclick = async () => {
  const u = CloudLB.user || {};
  const bound = mePhone();
  const phone = $("me-vphone").value.trim();
  const code = String($("me-code").value || "").trim();
  if (!bound) { meStatus("当前账号未绑定手机号，无法完成手机号验证"); return; }
  if (bound !== phone) { meStatus("请填写当前账号绑定的手机号"); return; }
  const p = CloudLB.pending;
  if (!p || p.phone !== phone) { meStatus("请先获取验证码"); return; }
  if (code.length < 4) { meStatus("请输入验证码"); return; }
  meStatus("正在验证…", true);
  try {
    const nu = await CloudLB.verifyCode({ phone }, code);
    if (u.id && nu && nu.id && nu.id !== u.id) { meStatus("验证的账号与当前登录账号不一致"); return; }
    meVerifiedUntil = Date.now() + ME_VERIFY_TTL;
    $("me-code").value = "";
    meStatus("验证通过，现在可以修改账号信息了", true);
    updateMeBadge();
    SFX.pickup();
  } catch (e) {
    meStatus("验证失败：" + ((e && e.message) || "验证码不正确或已过期"));
  }
};

/* 修改用户名（未验证则拒绝） */
$("me-save-name").onclick = () => {
  if (!mePwdOk()) { meStatus("请先完成手机号验证"); showToast("请先完成手机号验证"); return; }
  const v = $("me-new-name").value.trim();
  if (!v) { meStatus("请输入新用户名"); return; }
  if (!setPlayerName(v)) { meStatus("用户名不合法"); return; }
  $("me-name-view").textContent = playerName();
  refreshAccountItem();
  meStatus("用户名已更新为「" + playerName() + "」，之后的排行榜将使用它", true);
  showToast("用户名已更新");
};

/* 修改密码（未验证则拒绝；实际修改走 resetPasswordForOld） */
$("me-save-pwd").onclick = async () => {
  if (!mePwdOk()) { meStatus("请先完成手机号验证"); showToast("请先完成手机号验证"); return; }
  const o = $("me-old-pwd").value, n1 = $("me-new-pwd").value, n2 = $("me-new-pwd2").value;
  if (!o) { meStatus("请输入当前密码"); return; }
  if (n1.length < 6) { meStatus("新密码至少 6 位"); return; }
  if (n1 !== n2) { meStatus("两次输入的新密码不一致"); return; }
  meStatus("正在修改密码…", true);
  try {
    await CloudLB.changePassword(o, n1);
    $("me-old-pwd").value = $("me-new-pwd").value = $("me-new-pwd2").value = "";
    meStatus("密码已修改，请牢记新密码", true);
    showToast("密码已修改");
  } catch (e) {
    meStatus("修改失败：" + ((e && e.message) || "当前密码可能不正确"));
  }
};

/* 绑定邮箱：先校验是否已被其他账号注册，再写入账号档案 */
$("me-bind-email-btn").onclick = async () => {
  if (!mePwdOk()) { meStatus("请先完成手机号验证"); showToast("请先完成手机号验证"); return; }
  const em = $("me-bind-email").value.trim();
  if (!emailOk(em)) { meStatus("请输入正确的邮箱地址"); return; }
  await loadBannedDomains();
  if (isDisposableEmail(em)) { meStatus("临时邮箱无法绑定，请更换常用邮箱"); return; }
  const cur = meEmail();
  if (cur && cur.toLowerCase() === em.toLowerCase()) { meStatus("该邮箱已绑定到当前账号"); return; }
  const btn = $("me-bind-email-btn");
  btn.disabled = true;
  meStatus("正在校验邮箱可用性…", true);
  try {
    const p = await CloudLB.sendCode({ email: em });   // 用下发结果判断该邮箱是否已注册
    CloudLB.pending = null;                            // 这个 challenge 不用于登录
    if (p && p.isExistingUser) {
      meStatus("该邮箱已注册过其他账号，无法绑定");
      btn.disabled = false;
      return;
    }
    await CloudLB.saveProfile({ contact_email: em });
    meProfile = Object.assign({}, meProfile, { contact_email: em });
    if (CloudLB.user && CloudLB.user.id) CloudLB.saveIdent(CloudLB.user.id, { email: em });
    meStatus("已绑定邮箱 " + em + "（用于通知与找回；平台暂不支持邮箱登录）", true);
    renderMe();
    showToast("邮箱绑定成功");
  } catch (e) {
    meStatus("绑定失败：" + ((e && e.message) || "网络异常"));
  } finally {
    btn.disabled = false;
  }
};

/* 退出登录：二次确认后执行 */
$("me-logout").onclick = () => {
  SFX.click();
  showConfirm(
    "确定要退出登录吗？<br><small>退出后需要重新验证手机号才能登录，本机战绩不受影响</small>",
    () => {
      CloudLB.logout().then(() => {
        meProfile = null;
        meVerifiedUntil = 0;
        refreshAccountItem();
        closeMenuPanel("screen-me");
        showToast("已退出登录");
      }).catch(e => showToast("退出失败：" + (e && e.message || "网络异常")));
    }, "退出登录", true);
};

/* 菜单里的账号入口 */
function refreshAccountItem() {
  const btn = $("btn-account");
  if (!btn) return;
  if (CloudLB.user) {
    btn.textContent = "已登录 · " + String(playerName()).slice(0, 10);
    btn.dataset.mode = "me";
  } else {
    btn.textContent = "登录 / 注册";
    btn.dataset.mode = "login";
  }
}
$("btn-account").onclick = () => {
  SFX.click();
  if ($("btn-account").dataset.mode === "me") { openMe(); return; }   // 退出登录只在「我的」里
  showAuthPane("login", "phone");
  openMenuPanel("screen-auth");
};

/* ---------- 图鉴 ---------- */
let codexTab = "w";
document.querySelectorAll(".cx-tab").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll(".cx-tab").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    codexTab = b.dataset.tab;
    renderCodex();
    SFX.click();
  };
});
function codexCard(icon, name, tag, desc, num, color) {
  return '<div class="codex-card" style="--rar:' + color + '">' + icon +
    '<div class="cx-name">' + name + '</div>' +
    '<div class="cx-tag">' + tag + '</div>' +
    '<div class="cx-desc">' + (desc || "") + '</div>' +
    '<div class="cx-num">' + num + '</div></div>';
}
function renderCodex() {
  let html = "";
  if (codexTab === "w") {
    for (const k in WEAPONS) {
      const W = WEAPONS[k];
      html += codexCard(iconHTML(W.icon || k, ""), W.name,
        (RARITY[W.rar || 1].name) + " · " + (W.type === "melee" ? "近战" : "远程"),
        W.desc, "伤害 " + W.dmg + " · 冷却 " + W.cd + "s · 射程 " + W.range,
        RARITY[W.rar || 1].color);
    }
  } else if (codexTab === "i") {
    for (const k in ITEMS) {
      const I = ITEMS[k];
      html += codexCard(iconHTML(I.icon, ""), I.name, RARITY[I.rar || 1].name,
        I.desc, "价格 " + I.price + " · 可叠 " + ITEM_MAX_STACK + " 层",
        RARITY[I.rar || 1].color);
    }
  } else if (codexTab === "e") {
    for (const k in ENEMIES) {
      const E = ENEMIES[k];
      html += codexCard(iconHTML(E.icon || "slime", ""), E.name,
        "生命 " + E.hp + " · 伤害 " + E.dmg, E.desc || "", "移速 " + E.speed, "#8b98aa");
    }
  } else {
    html = '<div class="codex-howto">' + $("howto").querySelector(".howto-body").innerHTML +
      '<p style="text-align:center;margin-top:14px"><button class="act-btn" id="btn-howto-from-codex">在新窗口查看完整说明</button></p></div>';
    // 重新绑定（innerHTML 重建后）
    setTimeout(() => {
      const b = $("btn-howto-from-codex");
      if (b) b.onclick = () => { SFX.click(); $("screen-codex").classList.add("hidden"); $("howto").classList.remove("hidden"); };
    }, 0);
  }
  $("codex-grid").innerHTML = html;
}
applySettings();
$("btn-goretry").onclick = () => { SFX.click(); toCharSelect(); };
$("btn-gomenu").onclick = () => { SFX.click(); toMenu(); };
$("btn-goroom").onclick = () => { SFX.click(); backToRoom(); };
$("btn-vicretry").onclick = () => { SFX.click(); toCharSelect(); };
$("btn-vicmenu").onclick = () => { SFX.click(); toMenu(); };
$("btn-vicroom").onclick = () => { SFX.click(); backToRoom(); };

/* HUD 图标注入 */
$("hicon-hp").innerHTML = ICONS.heart;
$("hicon-res").innerHTML = ICONS.gem;
$("hicon-kill").innerHTML = ICONS.skull;

/* ============================================================
 * 临时邮箱拦截：本地兜底名单 + 云端名单（banned_email_domains）
 * 云端名单可随时更新，不用重新发版；本地名单保证离线/首屏也能拦
 * ============================================================ */
const LOCAL_BANNED_DOMAINS = ["10minutemail.com","10minutemail.net","20minutemail.com","guerrillamail.com",
  "guerrillamail.net","guerrillamail.org","mailinator.com","mailinator.net","mailinator.org","mailinator2.com",
  "tempmail.com","temp-mail.com","temp-mail.org","temp-mail.ru","tempinbox.com","trashmail.com","trashmail.net",
  "trashmail.org","trashmail.de","trash-mail.com","trash-mail.de","yopmail.com","yopmail.fr","getnada.com",
  "getairmail.com","filzmail.com","mailnesia.com","throwawaymail.com","fakeinbox.com","dispostable.com",
  "sharklasers.com","spamgourmet.com","mytrashmail.com","mailsac.com","discard.email","discardmail.com",
  "jetable.org","jetable.net","wegwerfmail.de","spambox.us","emailondeck.com","grr.la","shitmail.me","moakt.com",
  "mohmal.com","mvrht.com","burnermail.io","inboxkitten.com","maildrop.cc","mail7.io","33mail.com"];
let bannedDomainCache = null, bannedDomainAt = 0;

async function loadBannedDomains(force) {
  if (!force && bannedDomainCache && Date.now() - bannedDomainAt < 86400000) return bannedDomainCache;
  let list = [];
  try { list = await CloudLB.bannedDomains(); } catch (e) { list = []; }
  bannedDomainCache = list && list.length ? list : LOCAL_BANNED_DOMAINS.slice();
  bannedDomainAt = Date.now();
  return bannedDomainCache;
}
function emailDomain(e) { const p = String(e || "").toLowerCase().split("@"); return p.length === 2 ? p[1] : ""; }
function isDisposableEmail(e) {
  const d = emailDomain(e);
  if (!d) return false;
  const list = bannedDomainCache || LOCAL_BANNED_DOMAINS;
  if (list.indexOf(d) >= 0) return true;
  /* 兜底：主域名相同也拦（如 a.mailinator.com） */
  const root = d.split(".").slice(-2).join(".");
  return list.some(x => x === root || d.endsWith("." + x));
}
/* ============================================================
 * 反作弊
 *  · 客户端做启发式检测（移速/传送/材料/击杀/伤害/等级速率）
 *  · 命中后：先回拉到上一个检查点 → 上报服务端 → 进入沙盒"外挂对局"
 *  · 成绩上传走服务端 submit_record()，越界数据在数据库层直接拒绝
 * 说明：本站为纯静态前端，无法做"服务端权威模拟"，这里做的是
 *      「检测 + 回拉 + 隔离 + 服务端复核」四层，不是绝对防御。
 * ============================================================ */
const Cheat = {
  flagged: false, sandbox: false, banned: false, reason: "",
  ck: null,                       // 检查点（用于回拉）
  rate: { t: 0, mats: 0, kills: 0, dmg: 0, x: 0, y: 0 },
  speedMax: 0
};

/* ---------- 检查点：每 1 秒存一次，命中外挂时回拉 ---------- */
function cheatSnapshot() {
  if (!player) return;
  Cheat.ck = {
    mats: G.materials, kills: G.kills, dmg: G.dmgDealt,
    level: player.level, xp: player.xp, hp: player.hp
  };
}
function cheatRollback() {
  const c = Cheat.ck;
  if (!c || !player) return;
  G.materials = c.mats; G.kills = c.kills; G.dmgDealt = c.dmg;
  player.level = c.level; player.xp = c.xp; player.hp = Math.min(player.hp, c.hp);
  /* 波次不回拉：G.wave 与 G.waveTime/G.waveCleared 是配套的，
     单独回退波次会让倒计时与波次号错位，出现"结算后又跳波"。 */
  showToast("⏪ 检测到异常，本局数据已回拉至上个检查点");
}

let cheatCkTimer = 0;
function cheatTick(dt) {
  if (Cheat.flagged || Cheat.sandbox || !player) return;
  cheatCkTimer += dt;
  if (cheatCkTimer >= 1) { cheatCkTimer = 0; cheatSnapshot(); }
}

/* ---------- 速率/位移检测 ---------- */
function cheatCheck(dt) {
  if (Cheat.flagged || Cheat.sandbox || !player || G.screen !== "playing") {
    Cheat.rate.x = 0; Cheat.rate.y = 0;      // 清位移基线，避免跨界面误判瞬移
    return;
  }
  const r = Cheat.rate;
  const speedCap = 200 * (1 + player.st.speed / 100) * 1.6 + 60;   // 理论移速 +60% 余量
  Cheat.speedMax = Math.max(Cheat.speedMax, speedCap);

  /* 传送/瞬移：一帧位移超过理论上限的 2.5 倍 */
  if (r.x || r.y) {
    const jumped = Math.hypot(player.x - r.x, player.y - r.y);
    if (jumped > speedCap * dt * 2.5 + 40) { cheatHit("teleport", "位移 " + Math.round(jumped) + "px/帧"); return; }
  }
  r.x = player.x; r.y = player.y;

  /* 每 1 秒统计一次产出速率 */
  r.t += dt;
  if (r.t < 1) return;
  const dm = G.materials - r.mats, dk = G.kills - r.kills, dd = G.dmgDealt - r.dmg;
  r.t = 0; r.mats = G.materials; r.kills = G.kills; r.dmg = G.dmgDealt;
  if (dm > 600) { cheatHit("mats_rate", "材料 +" + dm + "/秒"); return; }
  if (dk > 60) { cheatHit("kill_rate", "击杀 +" + dk + "/秒"); return; }
  if (dd > 30000) { cheatHit("dmg_rate", "伤害 +" + dd + "/秒"); return; }
  if (player.level > G.wave * 3 + 10) { cheatHit("level_rate", "等级 " + player.level + " @ 波次 " + G.wave); return; }
}

/* ---------- 命中外挂 ---------- */
function cheatHit(reason, detail) {
  if (Cheat.flagged) return;
  Cheat.flagged = true;
  Cheat.reason = reason;
  cheatRollback();                       // 1) 客户端回拉
  SFX.alarm ? SFX.alarm() : SFX.gameover();
  /* 2) 上报服务端（服务端累计 3 次自动封禁上榜） */
  /* 访客也上报：没有账号时服务端按设备指纹记录 */
  const p = CloudLB.reportCheat(reason, detail + " @第" + G.wave + "波", G.wave);
  p.then(r => {
    if (r && r.banned) { Cheat.banned = true; showToast("账号已被限制上榜"); }
  });
  /* 3) 展示横条，点击进入沙盒对局 */
  showCheatBar(reason, detail);
}

/* ---------- 横条 + 沙盒（外挂对局） ---------- */
function showCheatBar(reason, detail, atStart) {
  const bar = $("cheat-bar");
  if (!bar) return;
  $("cheat-bar-reason").textContent = atStart
    ? "有作弊者，点击加入对局"
    : "发现外挂（" + reason + "），点击前往外挂对局";
  bar.classList.remove("hidden");
}
function enterCheatMatch() {
  Cheat.sandbox = true;
  G.sandbox = true;
  const bar = $("cheat-bar");
  if (bar) bar.classList.add("hidden");
  showModal("已进入<b>外挂对局</b><br><small>本局中怪物无法对你造成伤害，你可以自由攻击它们；<br>本局不会获得材料与经验，成绩也不会上传排行榜。</small>", null, "知道了");
  showToast("已进入外挂对局（沙盒模式）");
}
/* 沙盒里：敌人打不到我们 */
function cheatImmunity() { return Cheat.sandbox || G.sandbox === true; }


/* ============================================================
 * 管理员后台
 *  · 账号密码在数据库里（只存 sha256 哈希），前端只把输入发给
 *    服务端函数 admin_login 校验，登录成功换 2 小时临时令牌
 *  · 所有后台操作都带令牌，服务端逐个校验，前端绕不过去
 * ============================================================ */
let admToken = "";
let admTab = "ov";

function admStatus(msg, ok) {
  const el = $("adm-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (msg ? (ok ? " ok" : " err") : "");
}
function admMsg(msg, ok) {
  const el = $("adm-msg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (msg ? (ok ? " ok" : " err") : "");
}
function openAdminLogin() {
  admToken = "";
  admStatus("");
  $("adm-user").value = "";
  $("adm-pass").value = "";
  openMenuPanel("screen-admin-login");
  setTimeout(() => { try { $("adm-user").focus(); } catch (e) { } }, 80);
}
async function doAdminLogin() {
  const u = $("adm-user").value.trim();
  const p = $("adm-pass").value;
  if (!u || !p) { admStatus("请输入用户名和密码"); return; }
  const btn = $("btn-adm-login");
  btn.disabled = true;
  admStatus("正在验证…", true);
  try {
    const r = await CloudLB.adminLogin(u, p);
    if (!r || r.ok !== true) { admStatus((r && r.reason) || "登录失败"); btn.disabled = false; return; }
    admToken = r.token;
    try { sessionStorage.setItem("azi_adm_tok", admToken); } catch (e) { }
    $("adm-pass").value = "";
    $("adm-sub").textContent = "已登录：" + (r.user || u) + " · 令牌 2 小时有效";
    await openAdminPanel();
  } catch (e) {
    admStatus("登录失败：" + ((e && e.message) || "网络异常"));
  }
  btn.disabled = false;
}
function openAdminPanel() {
  openMenuPanel("screen-admin");
  switchAdmTab("ov");
}
function switchAdmTab(tab) {
  admTab = tab;
  ["ov", "rec", "flag", "dom"].forEach(t => {
    const pane = $("adm-pane-" + t);
    if (pane) pane.classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".adm-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  admMsg("");
  if (tab === "ov") loadAdmOverview();
  if (tab === "rec") loadAdmRecords();
  if (tab === "flag") loadAdmFlags();
  if (tab === "dom") loadAdmDomains();
}
async function admGuard() {
  if (!admToken) { admMsg("登录已失效，请重新登录"); return false; }
  return true;
}

/* ---------- 概览 ---------- */
async function loadAdmOverview() {
  const box = $("adm-stats");
  box.innerHTML = '<div class="adm-empty">加载中…</div>';
  try {
    const r = await CloudLB.adminCall("admin_overview", { p_token: admToken });
    if (!r || r.ok !== true) { box.innerHTML = '<div class="adm-empty">' + ((r && r.reason) || "加载失败") + "</div>"; return; }
    const cells = [
      ["战绩记录", r.records], ["账号档案", r.profiles], ["登记设备", r.devices],
      ["异常记录", r.flags], ["受限账号", r.banned], ["受限设备", r.devbans],
      ["屏蔽域名", r.domains], ["在线后台", r.sessions]
    ];
    box.innerHTML = cells.map(c => '<div class="adm-cell"><b>' + c[1] + "</b><span>" + c[0] + "</span></div>").join("");
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">加载失败：' + ((e && e.message) || "网络异常") + "</div>";
  }
}

/* ---------- 战绩 ---------- */
async function loadAdmRecords() {
  const box = $("adm-rec-list");
  box.innerHTML = '<div class="adm-empty">加载中…</div>';
  try {
    const r = await CloudLB.adminCall("admin_records", { p_token: admToken, p_limit: 200 });
    if (!r || r.ok !== true) { box.innerHTML = '<div class="adm-empty">' + ((r && r.reason) || "加载失败") + "</div>"; return; }
    renderAdmRecords(r.rows || []);
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">加载失败：' + ((e && e.message) || "网络异常") + "</div>";
  }
}
function renderAdmRecords(rows) {
  const box = $("adm-rec-list");
  const kw = ($("adm-rec-filter").value || "").trim().toLowerCase();
  const list = rows.filter(r => !kw ||
    String(r.player_name || "").toLowerCase().indexOf(kw) >= 0 ||
    String(r.owner_id || "").toLowerCase().indexOf(kw) >= 0);
  if (!list.length) { box.innerHTML = '<div class="adm-empty">没有记录</div>'; return; }
  box.innerHTML = "";
  list.forEach(r => {
    const d = document.createElement("div");
    d.className = "adm-row";
    d.innerHTML = '<span class="adm-main">' + (r.player_name || "—") +
      ' <span class="adm-sub">第' + r.wave + '波 · 击杀' + r.kills + ' · 材料' + r.mats + ' · ' + Math.round(r.survive_sec / 60) + '分</span></span>' +
      '<span class="adm-sub">' + String(r.owner_id || "游客").slice(0, 8) + "</span>";
    const del = document.createElement("button");
    del.className = "act-btn";
    del.textContent = "删除";
    del.onclick = () => {
      showConfirm("确定删除「<b>" + (r.player_name || "") + "</b>」这条战绩？<br><small>不可恢复</small>", async () => {
        try {
          const res = await CloudLB.adminCall("admin_del_record", { p_token: admToken, p_id: r.id });
          if (res && res.ok) { showToast("已删除"); loadAdmRecords(); loadAdmOverview(); }
          else showToast("删除失败：" + ((res && res.reason) || ""));
        } catch (e) { showToast("删除失败：" + ((e && e.message) || "网络异常")); }
      }, "删除", true);
    };
    d.appendChild(del);
    box.appendChild(d);
  });
}

/* ---------- 异常 ---------- */
async function loadAdmFlags() {
  const box = $("adm-flag-list");
  box.innerHTML = '<div class="adm-empty">加载中…</div>';
  try {
    const r = await CloudLB.adminCall("admin_flags", { p_token: admToken });
    if (!r || r.ok !== true) { box.innerHTML = '<div class="adm-empty">' + ((r && r.reason) || "加载失败") + "</div>"; return; }
    const rows = r.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="adm-empty">暂无异常记录</div>'; return; }
    box.innerHTML = "";
    rows.forEach(f => {
      const guest = !f.owner_id;                       // 访客：没有账号，按设备封
      const isBanned = guest ? !!f.device_banned : !!f.banned;
      const who = guest ? ("访客 · " + String(f.device_id || "未知设备").slice(0, 14))
                        : ("账号 · " + String(f.owner_id).slice(0, 8));
      const d = document.createElement("div");
      d.className = "adm-row";
      d.innerHTML = '<span class="adm-main">' + f.reason +
        ' <span class="adm-sub">' + String(f.detail || "").slice(0, 34) + "</span></span>" +
        '<span class="adm-tag ' + (guest ? "warn" : "") + '">' + who + "</span>" +
        '<span class="adm-tag ' + (isBanned ? "bad" : "ok") + '">' + (isBanned ? "已封" : "正常") + "</span>";
      const btn = document.createElement("button");
      btn.className = "act-btn" + (isBanned ? "" : " red");
      btn.textContent = isBanned ? "解封" : "封禁";
      btn.onclick = async () => {
        try {
          const res = guest
            ? await CloudLB.adminCall("admin_ban_device", { p_token: admToken, p_device: f.device_id, p_banned: !isBanned })
            : await CloudLB.adminCall("admin_ban", { p_token: admToken, p_owner: f.owner_id, p_banned: !isBanned });
          if (res && res.ok) {
            showToast((isBanned ? "已解封" : "已封禁") + (guest ? "该设备" : "该账号"));
            loadAdmFlags(); loadAdmOverview();
          } else showToast("操作失败：" + ((res && res.reason) || ""));
        } catch (e) { showToast("操作失败：" + ((e && e.message) || "网络异常")); }
      };
      d.appendChild(btn);
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">加载失败：' + ((e && e.message) || "网络异常") + "</div>";
  }
}

/* ---------- 邮箱域名 ---------- */
async function loadAdmDomains() {
  const box = $("adm-dom-list");
  box.innerHTML = '<div class="adm-empty">加载中…</div>';
  try {
    const r = await CloudLB.adminCall("admin_domains", { p_token: admToken });
    if (!r || r.ok !== true) { box.innerHTML = '<div class="adm-empty">' + ((r && r.reason) || "加载失败") + "</div>"; return; }
    const rows = r.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="adm-empty">名单为空</div>'; return; }
    box.innerHTML = '<div class="adm-empty" style="padding:4px 0">共 ' + rows.length + " 个域名</div>";
    rows.forEach(x => {
      const d = document.createElement("div");
      d.className = "adm-row";
      d.innerHTML = '<span class="adm-main">' + x.domain + '</span><span class="adm-tag ' +
        (x.note === "manual" ? "bad" : "warn") + '">' + (x.note === "manual" ? "手动" : "内置") + "</span>";
      const btn = document.createElement("button");
      btn.className = "act-btn";
      btn.textContent = "移除";
      btn.onclick = async () => {
        try {
          const res = await CloudLB.adminCall("admin_del_domain", { p_token: admToken, p_domain: x.domain });
          if (res && res.ok) { showToast("已移除 " + x.domain); loadAdmDomains(); }
          else showToast("移除失败：" + ((res && res.reason) || ""));
        } catch (e) { showToast("移除失败：" + ((e && e.message) || "网络异常")); }
      };
      d.appendChild(btn);
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">加载失败：' + ((e && e.message) || "网络异常") + "</div>";
  }
}

/* ---------- 按钮绑定 ---------- */
$("btn-adm-back").onclick = () => closeMenuPanel("screen-admin-login");
$("btn-adm-back2").onclick = () => closeMenuPanel("screen-admin");
$("btn-adm-close").onclick = () => closeMenuPanel("screen-admin");
$("btn-adm-login").onclick = () => doAdminLogin();
$("adm-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doAdminLogin(); });
document.querySelectorAll(".adm-tab").forEach(b => {
  b.onclick = () => { SFX.click(); switchAdmTab(b.dataset.tab); };
});
$("btn-adm-reload-rec").onclick = () => loadAdmRecords();
$("adm-rec-filter").addEventListener("input", () => loadAdmRecords());
$("btn-adm-savepass").onclick = async () => {
  if (!await admGuard()) return;
  const np = $("adm-newpass").value;
  if (np.length < 4) { admMsg("新密码至少 4 位"); return; }
  try {
    const r = await CloudLB.adminCall("admin_set_pass", { p_token: admToken, p_new: np });
    if (r && r.ok) {
      admMsg("密码已修改，请重新登录", true);
      admToken = "";
      try { sessionStorage.removeItem("azi_adm_tok"); } catch (e) { }
      $("adm-newpass").value = "";
      setTimeout(() => { closeMenuPanel("screen-admin"); openAdminLogin(); }, 900);
    } else admMsg((r && r.reason) || "修改失败");
  } catch (e) { admMsg("修改失败：" + ((e && e.message) || "网络异常")); }
};
$("btn-adm-logout").onclick = async () => {
  if (admToken) { try { await CloudLB.adminCall("admin_logout", { p_token: admToken }); } catch (e) { } }
  admToken = "";
  try { sessionStorage.removeItem("azi_adm_tok"); } catch (e) { }
  closeMenuPanel("screen-admin");
  showToast("已退出后台");
};
$("btn-adm-ban").onclick = () => admBanToggle(true);
$("btn-adm-unban").onclick = () => admBanToggle(false);
async function admBanToggle(banned) {
  if (!await admGuard()) return;
  const key = $("adm-ban-owner").value.trim();
  if (!key) { admMsg("请输入账号ID或设备ID"); return; }
  const isDevice = /^d-[a-z0-9]+-[a-z0-9]+$/i.test(key);
  try {
    const r = isDevice
      ? await CloudLB.adminCall("admin_ban_device", { p_token: admToken, p_device: key, p_banned: banned })
      : await CloudLB.adminCall("admin_ban", { p_token: admToken, p_owner: key, p_banned: banned });
    if (r && r.ok) {
      admMsg((banned ? "已封禁 " : "已解封 ") + key + "（" + (isDevice ? "设备" : "账号") + "）", true);
      loadAdmFlags(); loadAdmOverview();
    } else admMsg((r && r.reason) || "操作失败");
  } catch (e) { admMsg("操作失败：" + ((e && e.message) || "网络异常")); }
}
$("btn-adm-add-domain").onclick = async () => {
  if (!await admGuard()) return;
  const d = $("adm-new-domain").value.trim();
  if (!d) { admMsg("请输入域名"); return; }
  try {
    const r = await CloudLB.adminCall("admin_add_domain", { p_token: admToken, p_domain: d });
    if (r && r.ok) { admMsg("已添加 " + r.domain, true); $("adm-new-domain").value = ""; loadAdmDomains(); }
    else admMsg((r && r.reason) || "添加失败");
  } catch (e) { admMsg("添加失败：" + ((e && e.message) || "网络异常")); }
};


/* ============================================================
 * 多人房间
 *  · 房间建在云数据库里（rooms / room_members），容量/房码/房主权限全在服务端校验
 *  · 客户端每 2 秒轮询一次房间状态
 *  · 说明：本站没有游戏服务器，所以"多人"= 同房间各自跑一局、赛后比分数，
 *    不是实时同屏联机。
 * ============================================================ */
const Room = { code: "", max: 4, host: "", status: "", members: [], hostKey: "", meKey: "", timer: 0, busy: false, runCode: "" };
let mpCount = 4;

function myMemberName() {
  return (playerName() || "玩家").slice(0, 12);
}
/* ---------- 联机登录门槛 ---------- */
/* 未登录不给用联机：房间/中继都依赖账号身份，访客共用一个 'anon' 身份会互踢 */
function isLoggedIn() {
  return !!(typeof CloudLB !== "undefined" && CloudLB.user && CloudLB.user.id);
}
function requireLogin(what) {
  if (isLoggedIn()) return true;
  showToast("未登录无法" + (what || "联机") + "，请先登录 / 注册");
  try { showAuthPane("login", "phone"); } catch (e) { }
  openMenuPanel("screen-auth");
  return false;
}
function roomMsg(msg, ok) {
  const el = $("room-msg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (msg ? (ok ? " ok" : " err") : "");
}

/* ---------- 模式选择 ---------- */
function openModeSelect() { openMenuPanel("screen-mode"); }
$("btn-mode-close").onclick = () => { SFX.click(); closeMenuPanel("screen-mode"); };
$("btn-mode-solo").onclick = () => { SFX.click(); nextRunEndless = false; Room.runCode = ""; closeMenuPanel("screen-mode"); toCharSelect(); };
$("btn-mode-endless").onclick = () => { SFX.click(); nextRunEndless = true; Room.runCode = ""; closeMenuPanel("screen-mode"); toCharSelect(); };
$("btn-mode-multi").onclick = () => {
  SFX.click();
  nextRunEndless = false;
  if (!requireLogin("联机")) return;          // 未登录 → 引导去登录，不进多人面板
  openMenuPanel("screen-mp");
};

/* ---------- 加入 / 创建 ---------- */
$("btn-mp-close").onclick = () => { SFX.click(); closeMenuPanel("screen-mp"); };
$("btn-mp-back").onclick = () => { SFX.click(); closeMenuPanel("screen-mp"); openModeSelect(); };
$("btn-mp-join").onclick = () => {
  SFX.click();
  if (!requireLogin("加入房间")) return;
  $("room-code-input").value = "";
  $("join-msg").textContent = "";
  openMenuPanel("screen-join");
  setTimeout(() => { try { $("room-code-input").focus(); } catch (e) { } }, 80);
};
$("btn-mp-create").onclick = () => {
  SFX.click();
  if (!requireLogin("创建房间")) return;
  $("create-msg").textContent = "";
  buildCountRow();
  openMenuPanel("screen-create");
};
$("btn-join-close").onclick = () => { SFX.click(); closeMenuPanel("screen-join"); };
$("btn-join-back").onclick = () => { SFX.click(); closeMenuPanel("screen-join"); openMenuPanel("screen-mp"); };
$("btn-create-close").onclick = () => { SFX.click(); closeMenuPanel("screen-create"); };
$("btn-create-back").onclick = () => { SFX.click(); closeMenuPanel("screen-create"); openMenuPanel("screen-mp"); };

function buildCountRow() {
  const box = $("count-row");
  box.innerHTML = "";
  for (let n = 2; n <= 6; n++) {
    const b = document.createElement("button");
    b.className = "count-chip" + (n === mpCount ? " active" : "");
    b.textContent = n;
    b.onclick = () => { SFX.click(); mpCount = n; buildCountRow(); };
    box.appendChild(b);
  }
  $("create-hint").textContent = "房间最多容纳 " + mpCount + " 人";
}

$("room-code-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
});
$("btn-join-submit").onclick = async () => {
  const code = $("room-code-input").value.trim();
  const msg = $("join-msg");
  if (!requireLogin("加入房间")) { msg.className = "auth-status err"; msg.textContent = "请先登录"; return; }
  if (!/^\d{6}$/.test(code)) { msg.className = "auth-status err"; msg.textContent = "请输入 6 位数字房码"; return; }
  const btn = $("btn-join-submit");
  btn.disabled = true;
  msg.className = "auth-status ok"; msg.textContent = "正在进入…";
  try {
    const r = await CloudLB.roomJoin(code, myMemberName());
    if (!r || r.ok !== true) { msg.className = "auth-status err"; msg.textContent = (r && r.reason) || "加入失败"; btn.disabled = false; return; }
    applyRoom(r);
    closeMenuPanel("screen-join");
    openMenuPanel("screen-room");
    startRoomPoll();
  } catch (e) {
    msg.className = "auth-status err"; msg.textContent = "加入失败：" + ((e && e.message) || "网络异常");
  }
  btn.disabled = false;
};
$("room-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join-submit").click(); });

$("btn-create-submit").onclick = async () => {
  const msg = $("create-msg");
  const btn = $("btn-create-submit");
  if (!requireLogin("创建房间")) { msg.className = "auth-status err"; msg.textContent = "请先登录"; return; }
  btn.disabled = true;
  msg.className = "auth-status ok"; msg.textContent = "正在创建房间…";
  try {
    const r = await CloudLB.roomCreate(mpCount, myMemberName());
    if (!r || r.ok !== true) { msg.className = "auth-status err"; msg.textContent = (r && r.reason) || "创建失败"; btn.disabled = false; return; }
    applyRoom(r);
    closeMenuPanel("screen-create");
    openMenuPanel("screen-room");
    startRoomPoll();
  } catch (e) {
    msg.className = "auth-status err"; msg.textContent = "创建失败：" + ((e && e.message) || "网络异常");
  }
  btn.disabled = false;
};

/* ---------- 房间状态 ---------- */
function applyRoom(r) {
  Room.code = r.code || "";
  Room.max = r.max || 4;
  Room.hostKey = r.host_key || "";
  Room.status = r.status || "waiting";
  Room.members = r.members || [];
  Room.meKey = myKeyGuess();
  renderRoom();
}
/* 本地推断自己的 member_key：登录了是账号ID，否则是设备ID */
function myKeyGuess() {
  if (typeof CloudLB !== "undefined" && CloudLB.user && CloudLB.user.id) return String(CloudLB.user.id);
  return getDeviceId();
}
function renderRoom() {
  $("room-code-show").textContent = Room.code || "------";
  const isHost = Room.meKey === Room.hostKey;
  const list = $("room-list");
  const playing = Room.status === "playing";
  const allDone = playing && Room.members.length > 0 && Room.members.every(m => m.done);
  const sorted = Room.members.slice().sort((a, b) => (b.wave - a.wave) || (b.kills - a.kills));
  list.innerHTML = "";
  sorted.forEach((m, i) => {
    const me = m.member_key === Room.meKey;
    const d = document.createElement("div");
    d.className = "room-row" + (me ? " me" : "");
    let tag = '<span class="rtag wait">未准备</span>';
    if (playing) {
      const rank = i + 1;
      tag = m.done
        ? '<span class="rtag rank' + (rank <= 3 ? rank : "x") + '">第 ' + rank + ' 名</span>'
        : '<span class="rtag wait">进行中</span>';
    } else if (m.ready) tag = '<span class="rtag ready">已准备</span>';
    d.innerHTML = '<span class="rname">' + (m.name || "玩家") + (me ? "（我）" : "") + "</span>" +
      (m.member_key === Room.hostKey ? '<span class="rtag host">房主</span>' : "") +
      (playing ? '<span class="rscore">第' + m.wave + "波 · " + m.kills + "杀 · " + m.mats + "材料</span>" : "") + tag;
    list.appendChild(d);
  });
  const readyCount = Room.members.filter(m => m.ready).length;
  if (playing) {
    $("room-sub").textContent = allDone
      ? "本局结束 · 共 " + Room.members.length + " 人"
      : "对局进行中… 已完成 " + Room.members.filter(m => m.done).length + "/" + Room.members.length;
  } else {
    $("room-sub").textContent = "等待开始 · " + Room.members.length + "/" + Room.max +
      " 人 · " + readyCount + " 人已准备";
  }
  // 按钮显隐
  const me = Room.members.find(m => m.member_key === Room.meKey);
  const readyBtn = $("btn-room-ready"), startBtn = $("btn-room-start"), resetBtn = $("btn-room-reset");
  readyBtn.classList.toggle("hidden", playing || isHost);
  if (me && me.ready) { readyBtn.textContent = "取 消 准 备"; readyBtn.classList.remove("green"); }
  else { readyBtn.textContent = "准 备 好 了"; readyBtn.classList.add("green"); }
  startBtn.classList.toggle("hidden", !(isHost && !playing));
  startBtn.disabled = playing || Room.members.length < 2 || readyCount < Room.members.length;
  resetBtn.classList.toggle("hidden", !(isHost && playing && allDone));
}
async function refreshRoom(showError) {
  if (!Room.code) return;
  try {
    const r = await CloudLB.roomState(Room.code);
    if (!r || r.ok !== true) {
      if (r && r.kicked) { stopRoomPoll(); Room.code = ""; closeMenuPanel("screen-room"); showToast("你已离开该房间"); }
      else if (showError) roomMsg((r && r.reason) || "房间已关闭");
      return;
    }
    const prev = Room.status;
    applyRoom(r);
    /* 房主点了开始 → 所有人自动进入选人 */
    if (prev === "waiting" && Room.status === "playing" && G.screen !== "playing") {
      Room.runCode = Room.code;
      stopRoomPoll();
      closeMenuPanel("screen-room");
      showToast("对局开始！");
      toCharSelect();
    }
  } catch (e) { if (showError) roomMsg("刷新失败：" + ((e && e.message) || "网络异常")); }
}
function startRoomPoll() {
  stopRoomPoll();
  Room.timer = setInterval(() => { if (G.screen !== "playing" && G.screen !== "dying") refreshRoom(false); }, 2000);
}
function stopRoomPoll() {
  if (Room.timer) { clearInterval(Room.timer); Room.timer = 0; }
}

$("btn-room-copy").onclick = () => {
  const code = Room.code;
  try {
    if (navigator.clipboard) navigator.clipboard.writeText(code);
    else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
    showToast("房码已复制：" + code);
  } catch (e) { showToast("房码：" + code); }
};
$("btn-room-ready").onclick = async () => {
  if (Room.busy) return;
  Room.busy = true;
  const me = Room.members.find(m => m.member_key === Room.meKey);
  const next = !(me && me.ready);
  try {
    const r = await CloudLB.roomSetReady(Room.code, next);
    if (r && r.ok) { applyRoom(r); showToast(next ? "已准备" : "已取消准备"); }
    else roomMsg((r && r.reason) || "操作失败");
  } catch (e) { roomMsg("操作失败：" + ((e && e.message) || "网络异常")); }
  Room.busy = false;
};
$("btn-room-start").onclick = async () => {
  if (Room.busy) return;
  Room.busy = true;
  try {
    const r = await CloudLB.roomStart(Room.code);
    if (r && r.ok) { applyRoom(r); Room.runCode = Room.code; stopRoomPoll(); closeMenuPanel("screen-room"); toCharSelect(); }
    else roomMsg((r && r.reason) || "无法开始");
  } catch (e) { roomMsg("操作失败：" + ((e && e.message) || "网络异常")); }
  Room.busy = false;
};
$("btn-room-reset").onclick = async () => {
  if (Room.busy) return;
  Room.busy = true;
  try {
    const r = await CloudLB.roomReset(Room.code);
    if (r && r.ok) { applyRoom(r); startRoomPoll(); showToast("已重置，可以再来一局"); }
    else roomMsg((r && r.reason) || "操作失败");
  } catch (e) { roomMsg("操作失败：" + ((e && e.message) || "网络异常")); }
  Room.busy = false;
};
$("btn-room-leave").onclick = async () => {
  SFX.click();
  if (Room.code) { try { await CloudLB.roomLeave(Room.code); } catch (e) { } }
  stopRoomPoll();
  Room.code = ""; Room.members = [];
  closeMenuPanel("screen-room");
  showToast("已离开房间");
};

/* 从结算界面回到房间看排名 */
function backToRoom() {
  Room.code = Room.runCode || Room.code;
  player = null;
  enemies = []; shots = []; eshots = []; pickups = []; chests = []; fx = []; parts = []; texts = [];
  cam.shake = 0; G.waveClearHold = 0;
  Net.endRun();          // 确保联机中继已断开
  enterState("menu");
  if (Room.code) {
    openMenuPanel("screen-room");
    refreshRoom(true);
    startRoomPoll();
  }
}

/* 结算时把成绩提交到房间 */
function roomSubmitResult() {
  if (!Room.runCode) return;                       // 单人局不写入房间
  CloudLB.roomSubmit(Room.runCode, G.wave, G.kills, G.materials, G.time)
    .then(r => { if (r && r.ok) applyRoom(r); })
    .catch(() => { });
}

/* ============================================================
 * 主循环
 * ============================================================ */
let last = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
  last = ts;
  update(dt);
  render();
  if (G.screen === "playing" || G.screen === "dying") renderHUD();
}
toMenu();
requestAnimationFrame(loop);

/* ---- 联机层绑定：net.js 在脚本作用域，看不到本 IIFE 内部，
   这里把运行期需要共享的状态与函数显式注入（ enemies/shots/eshots 可写，
   用 getter/setter 保持同一份引用）。发布构建平铺拼接后同样依赖此契约。 ---- */
if (typeof Net !== "undefined" && Net.__bind) Net.__bind({
  G, Room, ARENA, keys, IS_MOBILE, touch,
  get player() { return player; },
  get enemies() { return enemies; },
  set enemies(v) { enemies = v; },
  get shots() { return shots; },
  set shots(v) { shots = v; },
  get eshots() { return eshots; },
  set eshots(v) { eshots = v; },
  hurtEnemy, damageEnemy, killEnemy, die, showToast, showConfirm, nearestEnemy, myKeyGuess,
  segCircleHit,   // 房客本地子弹的扫掠命中检测
});

/* #test-hook-start  测试专用：仅 URL 带 ?test=1 时暴露，发布构建会整段移除 */
if (/[?&]test=1\b/.test(location.search)) window.__game = {
  G, Room, get player() { return player; },
  get enemies() { return enemies; },
  get chests() { return chests; },
  get shots() { return shots; },
  get fx() { return fx; },
  get wheel() { return wheel; },
  startGame, toCharSelect, toMenu,
  loadBoard,
  setBoardAnon: (v) => { const cb = $("board-show-anon"); if (cb) cb.checked = !!v; return loadBoard(); },
  debug: {
    endWave: () => endWave(),
    openWheel: () => openWheel(),
    spawn: (key) => spawnEnemy(key, false, true),
    dropAt: (x, y, val, fly) => dropMat(x, y, val, fly),
    /* 展示构图（仅截图用）：全部武器环绕成圈 + 全部怪物摆成爱心 */
    artShot: () => {
      G.artShot = true;
      player.artShot = true;
      player.hp = player.maxHp;
      player.scale = 1.95;                       // 主角放大一点
      player.floatBoost = 1.75;                  // 武器也放大，构图更清楚
      player.weapons = Object.keys(WEAPONS).map(k => ({ key: k, lv: 3, anim: 0, swingT: -1 }));
      enemies.length = 0;
      const types = ["slime", "bat", "golem", "spitter"];
      const N = 36;
      for (let i = 0; i < N; i++) spawnEnemy(types[i % types.length]);
      enemies.forEach((e, i) => {
        const t = (i / N) * Math.PI * 2;
        const hx = 16 * Math.pow(Math.sin(t), 3);
        const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        e.x = player.x + hx * 24;
        e.y = player.y - 70 + hy * 24;
        e.kx = 0; e.ky = 0; e.vx = 0; e.vy = 0;
      });
    },
    levelUp: () => openLevelUp(),
    giveMats: (n) => { G.materials += n; },
    setWave: (n) => { G.wave = n; },
    killAll: () => enemies.slice().forEach(e => killEnemy(e)),
    spawn: (t, elite) => spawnEnemy(t || "slime", !!elite),
    hurt: (n) => damagePlayer(n || 5),
    teleport: (x, y) => { player.x = x; player.y = y; cam.x = Math.max(0, Math.min(ARENA.w - VW, x - VW / 2)); cam.y = Math.max(0, Math.min(ARENA.h - VH, y - VH / 2)); },
    giveWeapon: (key) => {
      if (!WEAPONS[key]) return;
      const own = player.weapons.find(w => w.key === key);
      if (own) own.lv = Math.min(WEAPON_MAX_LV, own.lv + 1);
      else player.weapons.push({ key, lv: 1, t: 0 });
      player.weaponIcon = key;
    },
    giveItem: (key) => {
      if (!ITEMS[key]) return;
      player.items[key] = (player.items[key] || 0) + 1;
      recalc();
    },
    state: () => G.screen,
    menuHero: () => menuHero,
    cam: () => cam,
    player: () => player,
    pickups: () => pickups,
    verifyMe: (ms) => { meVerifiedUntil = Date.now() + (ms || 60000); return meVerifiedUntil; },
  }
};
/* #test-hook-end */

})();
