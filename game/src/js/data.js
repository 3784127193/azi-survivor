/* ============================================================
 * data.js — 游戏数值配置：角色 / 武器 / 道具 / 升级 / 敌人
 * ============================================================ */
"use strict";

const WAVE_TOTAL = 20;              // 通关波数
const STAT_META = {                 // 属性显示名与类型（pct=百分比，flat=固定值）
  maxHp:    { name: "最大生命", pct: false },
  hpRegen:  { name: "生命回复", pct: false, unit: "/秒" },
  lifeSteal:{ name: "吸血",     pct: true },
  dmg:      { name: "伤害",     pct: true },
  meleeDmg: { name: "近战伤害", pct: true },
  rangedDmg:{ name: "远程伤害", pct: true },
  atkSpeed: { name: "攻击速度", pct: true },
  crit:     { name: "暴击率",   pct: true },
  range:    { name: "攻击范围", pct: true },
  armor:    { name: "护甲",     pct: false },
  speed:    { name: "移动速度", pct: true },
  harvest:  { name: "收获",     pct: true },
  magnet:   { name: "磁力范围", pct: true }
};

/* ---------------- 角色（同一主角的 4 套换皮服装） ----------------
 * colors: 发色/肤色/卫衣/裤/鞋配色；acc: 配件（bolt 闪电 / band 发带 / hat 巫师帽）
 */
const CHARS = [
  { id: "azi", name: "阿紫", hp: 12, start: "pistol", desc: "紫发绿卫衣的主角，均衡型新手友好",
    colors: { hair: "#a58bd4", hairLine: "#7d5cb0", skin: "#ffd9b3", skin2: "#f0bd8f",
      hoodie: "#a9d6a3", hoodie2: "#8bc78b", hood: "#8fc489", line: "#5f9c62",
      pants: "#8d7f72", shoe: "#4a7fd4" },
    mods: {}, stats: [["生命", "12"], ["武器", "手枪"]] },
  { id: "flash", name: "小闪", hp: 8, start: "smg", desc: "黄色闪电款，高攻速高移速，脆皮",
    colors: { hair: "#a58bd4", hairLine: "#7d5cb0", skin: "#ffd9b3", skin2: "#f0bd8f",
      hoodie: "#ffd966", hoodie2: "#f5c542", hood: "#f2c94c", line: "#c99a1f",
      pants: "#7d7268", shoe: "#4a7fd4" },
    mods: { speed: 12, atkSpeed: 18, dmg: -8 }, acc: "bolt", stats: [["攻速", "+18%"], ["移速", "+12%"]] },
  { id: "iron", name: "阿铁", hp: 22, start: "hammer", desc: "灰色铁头款，高生命高护甲，势大力沉",
    colors: { hair: "#a58bd4", hairLine: "#7d5cb0", skin: "#ffd9b3", skin2: "#f0bd8f",
      hoodie: "#b8c4cc", hoodie2: "#9aa8b2", hood: "#a4b0b8", line: "#6e7c86",
      pants: "#6f675f", shoe: "#4a7fd4" },
    mods: { armor: 4, speed: -10, dmg: 5 }, acc: "band", stats: [["生命", "22"], ["护甲", "+4"]] },
  { id: "wizard", name: "小巫", hp: 10, start: "wand", desc: "紫袍巫师款，高伤害远程，攻击较慢",
    colors: { hair: "#a58bd4", hairLine: "#7d5cb0", skin: "#ffd9b3", skin2: "#f0bd8f",
      hoodie: "#8e6fd0", hoodie2: "#7355b8", hood: "#7e5cc4", line: "#5a4295",
      pants: "#5d5468", shoe: "#4a7fd4" },
    mods: { dmg: 20, rangedDmg: 20, range: 20, atkSpeed: -10 }, acc: "hat", stats: [["伤害", "+20%"], ["范围", "+20%"]] }
];

/* ---------------- 武器 ----------------
 * type: melee(近战) / ranged(远程)
 * melee: arc=扇形角度, aoe=周围圆形, line=直线突刺
 * ranged: speed=弹速, pellets/spread=霰弹, return=回旋镖, homing=追踪
 */
const WEAPONS = {
  knife:   { name:"小刀",   type:"melee",  dmg:4,  cd:0.42, range:62,  arc:2.2, price:12, tier:1, rar:1,
             desc:"快速小幅挥砍" },
  sword:   { name:"木剑",   type:"melee",  dmg:7,  cd:0.68, range:80,  arc:2.6, price:18, tier:1, rar:1,
             desc:"扇形范围挥砍" },
  spear:   { name:"长矛",   type:"melee",  dmg:10, cd:0.85, range:118, arc:0.55, line:true, price:26, tier:2, rar:2,
             desc:"直线突刺，攻击距离远" },
  hammer:  { name:"铁锤",   type:"melee",  dmg:15, cd:1.25, range:92,  aoe:96, price:36, tier:2, rar:3,
             desc:"猛砸周围全部敌人" },
  pistol:  { name:"手枪",   type:"ranged", dmg:5,  cd:0.55, range:430, speed:540, price:15, tier:1, rar:1,
             desc:"射击最近敌人" },
  smg:     { name:"冲锋枪", type:"ranged", dmg:3,  cd:0.13, range:380, speed:580, price:23, tier:2, rar:2,
             desc:"超高射速持续输出" },
  shotgun: { name:"霰弹枪", type:"ranged", dmg:4,  cd:0.95, range:280, speed:500, pellets:5, spread:0.42, price:33, tier:2, rar:3,
             desc:"近距离五连散射" },
  boomerang:{name:"回旋镖",type:"ranged", dmg:6,  cd:1.05, range:310, speed:430, return:true, price:30, tier:2, rar:3,
             desc:"抛出后飞回，来回切割" },
  wand:    { name:"魔杖",   type:"ranged", dmg:8,  cd:0.8,  range:420, speed:330, homing:true, price:28, tier:2, rar:2,
             desc:"发射追踪魔法弹" }
};
const WEAPON_MAX_LV = 4;

/* ---------------- 道具（最多持有 6 个） ---------------- */
const ITEMS = {
  glasses:  { name:"眼镜",   icon:"glasses",  stat:{ dmg: 8 },        price:14, rar:1, desc:"伤害 +8%" },
  bandage:  { name:"绷带",   icon:"bandage",  stat:{ hpRegen: 0.4 },  price:16, rar:1, desc:"每秒回复 0.4 生命" },
  wing:     { name:"翅膀",   icon:"wing",     stat:{ speed: 8 },      price:18, rar:1, desc:"移动速度 +8%" },
  armor:    { name:"盔甲",   icon:"armor",    stat:{ armor: 2 },      price:20, rar:2, desc:"护甲 +2" },
  whetstone:{ name:"磨刀石", icon:"whetstone",stat:{ meleeDmg: 12 },  price:16, rar:1, desc:"近战伤害 +12%" },
  scope:    { name:"瞄准器", icon:"scope",    stat:{ rangedDmg: 12 }, price:16, rar:1, desc:"远程伤害 +12%" },
  clock:    { name:"时钟",   icon:"clock",    stat:{ atkSpeed: 8 },   price:20, rar:2, desc:"攻击速度 +8%" },
  clover:   { name:"四叶草", icon:"clover",   stat:{ crit: 7 },       price:18, rar:2, desc:"暴击率 +7%" },
  magnet:   { name:"磁铁",   icon:"magnet",   stat:{ harvest: 10, magnet: 25 }, price:16, rar:2, desc:"收获 +10%，磁力 +25%" },
  spikes:   { name:"尖刺",   icon:"spikes",   stat:{ armor: 1 }, contactDmg: 5, price:22, rar:3, desc:"护甲 +1，反弹 5 点接触伤害" },
  battery:  { name:"电池",   icon:"battery",  stat:{ atkSpeed: 5, speed: 4 }, price:18, rar:2, desc:"攻速 +5%，移速 +4%" },
  heart:    { name:"红心",   icon:"heart",    stat:{ maxHp: 3 },      price:22, rar:3, desc:"最大生命 +3 并立即回复" }
};
const ITEM_MAX_STACK = 6;
const ITEM_SLOTS_BASE = 6;         // 物品栏基础格数（转盘可扩容，上限 ITEM_SLOTS_MAX）
const ITEM_SLOTS_MAX = 8;

/* ---------------- 稀有度（UI 配色用） ---------------- */
const RARITY = {
  1: { name: "普通", color: "#9aa5b1" },
  2: { name: "精良", color: "#5ec16a" },
  3: { name: "稀有", color: "#4a90e2" },
  4: { name: "史诗", color: "#a878e6" },
  5: { name: "传说", color: "#f2884b" }
};

/* ---------------- 幸运转盘奖品（权重越低越稀有） ---------------- */
const WHEEL_PRIZES = [
  { id: "mat200",  name: "材料 x200",  weight: 30, color: "#c8e6c9", desc: "普通绿材料 +200" },
  { id: "mat500",  name: "材料 x500",  weight: 20, color: "#fff59d", desc: "绿材料 +500" },
  { id: "heal",    name: "全额治疗",   weight: 15, color: "#ef9a9a", desc: "生命值完全恢复" },
  { id: "mat1000", name: "材料 x1000", weight: 10, color: "#ffe082", desc: "绿材料 +1000" },
  { id: "slot1",   name: "物品栏 +1",  weight: 10, color: "#90caf9", desc: "物品栏扩容 1 格（上限 8）" },
  { id: "upall",   name: "全体升级",   weight: 7,  color: "#ce93d8", desc: "所有武器 +1 级，所有道具 +1 层" },
  { id: "slot2",   name: "物品栏 +2",  weight: 5,  color: "#64b5f6", desc: "物品栏扩容 2 格（上限 8）" },
  { id: "mat3000", name: "材料 x3000", weight: 3,  color: "#ffd54f", desc: "巨额绿材料 +3000！" }
];

/* 按权重计算每个扇区的角度范围（绘制与抽奖共用，保证指针停的扇区 = 实际奖品） */
function wheelSectors(prizes) {
  const total = prizes.reduce((s, p) => s + (p.weight || 1), 0);
  let a = 0;
  return prizes.map(p => {
    const span = ((p.weight || 1) / total) * Math.PI * 2;
    const sec = { a0: a, a1: a + span, mid: a + span / 2, span };
    a += span;
    return sec;
  });
}

/* ============================================================
 * 近战挥砍时间轴（绘制与伤害结算共用）
 * 一次挥砍总时长 SWING_DUR，刀锋在 SWING_HIT 时刻正对目标方向
 * → 起手时刻 = 命中时刻 - SWING_DUR*SWING_HIT，用于预判提前量
 * ============================================================ */
const SWING_DUR = 0.36, SWING_HIT = 0.6;

/* 返回 { ang: 相对瞄准方向的偏转, reach: 手臂前伸像素 } */
function meleeSwingCurve(key, t) {
  t = Math.max(0, Math.min(1, t));
  if (key === "spear") {            // 突刺：先微收再直线刺出
    return { ang: -0.1 + 0.2 * t, reach: Math.sin(Math.PI * t) * 21 };
  }
  const up = key === "hammer" ? -2.15 : key === "knife" ? -1.15 : -1.55;   // 举起角度
  const dn = key === "hammer" ? 0.95 : key === "knife" ? 0.7 : 0.9;        // 劈下终点
  const t0 = 0.42, t1 = 0.66;       // 起手结束 / 劈下结束
  if (t < t0) {                     // 起手：缓慢举起（easeOut）
    const k = t / t0;
    return { ang: up * (2 * k - k * k), reach: -2.2 * k };
  }
  if (t < t1) {                     // 劈下：越来越快（easeIn）
    const k = (t - t0) / (t1 - t0);
    return { ang: up + (dn - up) * k * k, reach: 7.5 * k };
  }
  const k = (t - t1) / (1 - t1);    // 收招：回落
  return { ang: dn * (1 - k) * (1 - k), reach: 7.5 * (1 - k) };
}

/* ---------------- 升级卡片（升级时三选一） ---------------- */
const UPGRADES = [
  { name:"大力水手", icon:"u_fist",   desc:"伤害 +10%",        stat:{ dmg: 10 } },
  { name:"锋利刀刃", icon:"u_knife",  desc:"近战伤害 +15%",    stat:{ meleeDmg: 15 } },
  { name:"精准射击", icon:"u_scope",  desc:"远程伤害 +15%",    stat:{ rangedDmg: 15 } },
  { name:"疾风步",   icon:"u_boot",   desc:"移动速度 +10%",    stat:{ speed: 10 } },
  { name:"闪电连击", icon:"u_clock",  desc:"攻击速度 +12%",    stat:{ atkSpeed: 12 } },
  { name:"铁布衫",   icon:"u_shield", desc:"护甲 +2",          stat:{ armor: 2 } },
  { name:"巨力土豆", icon:"u_heart",  desc:"最大生命 +4 并立即回复", stat:{ maxHp: 4 } },
  { name:"回春术",   icon:"u_cross",  desc:"每秒回复 +0.5",    stat:{ hpRegen: 0.5 } },
  { name:"吸血伯爵", icon:"u_drop",   desc:"击杀有 3% 概率回复 1 生命", stat:{ lifeSteal: 3 } },
  { name:"聚宝盆",   icon:"u_gem",    desc:"收获 +15%",        stat:{ harvest: 15 } },
  { name:"暴击之心", icon:"u_star",   desc:"暴击率 +8%",       stat:{ crit: 8 } },
  { name:"远视眼",   icon:"u_eye",    desc:"攻击范围 +20%",    stat:{ range: 20 } },
  { name:"超级磁铁", icon:"u_magnet", desc:"磁力范围 +35%",    stat:{ magnet: 35 } },
  { name:"荆棘甲",   icon:"u_spike",  desc:"护甲 +1，反弹 6 点伤害", stat:{ armor: 1 }, contactDmg: 6 }
];

/* ---------------- 敌人 ----------------
 * erratic=蛇形走位, ranged=远程保持距离
 */
const ENEMIES = {
  slime:  { name:"史莱姆", hp:9,  speed:66, dmg:1, size:17, color:"#6fcf6f", color2:"#3f9f5f", xp:1, mat:1, weight: 10,
            icon:"slime", desc:"最常见的小怪，成群结队慢慢逼近" },
  bat:    { name:"小蝙蝠", hp:7,  speed:118, dmg:1, size:13, color:"#b388e0", color2:"#7e57c2", xp:1, mat:1, weight: 6, erratic: true,
            icon:"bat", desc:"飞行极快、走位飘忽，最难瞄准" },
  golem:  { name:"石头人", hp:28, speed:44, dmg:2, size:28, color:"#9e9eae", color2:"#6d6d80", xp:3, mat:3, weight: 4,
            icon:"golem", desc:"血厚攻高但缓慢，早期就要留意" },
  spitter:{ name:"吐刺怪", hp:12, speed:54, dmg:1, size:16, color:"#ef8a50", color2:"#c85a2a", xp:2, mat:2, weight: 4,
            ranged: true, keepDist: 250, fireCd: 2.1, shotSpeed: 220, shotDmg: 1,
            icon:"spitter", desc:"远程怪，保持距离朝你吐刺，优先击杀" }
};
const ELITE = { hpMul: 3.5, sizeMul: 1.9, dmgMul: 1.6, matMul: 5, xpMul: 3 };

/* 敌人等级（波次）强度曲线 */
function waveHpMul(w){ return 1 + (w - 1) * 0.26; }
function waveDmgMul(w){ return 1 + (w - 1) * 0.15; }
function waveSpeedMul(w){ return 1 + (w - 1) * 0.03; }
function waveDuration(w){ return Math.min(90, 20 + w * 2); }
function xpNeed(level){ return 4 + (level - 1) * 4; }
