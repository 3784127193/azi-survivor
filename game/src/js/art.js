/* ============================================================
 * art.js — 全部美术资源由代码逐像素手绘（Canvas 2D 矢量绘制）
 *   场景背景 / 土豆主角 x4 / 敌人 x4 + 精英 / 掉落物 / 宝箱
 *   武器 x9 / 弹道 / 全部特效 / 粒子 / 伤害文字
 * ============================================================ */
"use strict";

/* ---------- 小工具 ---------- */
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexLerp(h1, h2, k) {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const a = p(h1), b = p(h2);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}

/* ============================================================
 * 场景背景（离屏画布，只生成一次）
 * ============================================================ */
const Art = {
  bg: null,

  makeBackground(w, h) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    const rnd = mulberry32(20261017);

    // 草地基底
    const grad = g.createLinearGradient(0, 0, w * 0.3, h);
    grad.addColorStop(0, "#a9d79b");
    grad.addColorStop(0.5, "#9ccd90");
    grad.addColorStop(1, "#8fc185");
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // 大块有机色斑（替代棋盘格，草地更自然）
    for (let i = 0; i < 90; i++) {
      const x = rnd() * w, y = rnd() * h, r = 90 + rnd() * 240;
      const light = rnd() > 0.5;
      const rg = g.createRadialGradient(x, y, 2, x, y, r);
      rg.addColorStop(0, light ? "rgba(200,236,180,.28)" : "rgba(90,150,86,.16)");
      rg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    // 泥土斑块
    for (let i = 0; i < 22; i++) {
      const x = rnd() * w, y = rnd() * h, r = 34 + rnd() * 62;
      g.fillStyle = "rgba(133,102,74,.10)";
      g.beginPath(); g.ellipse(x, y, r, r * 0.6, rnd() * 3, 0, Math.PI * 2); g.fill();
    }

    // 草丛（多层，错落）
    for (let i = 0; i < 460; i++) {
      const x = rnd() * w, y = rnd() * h;
      const tall = 5 + rnd() * 8;
      g.strokeStyle = rnd() > 0.55 ? "rgba(56,138,62,.26)" : "rgba(78,160,72,.20)";
      g.lineWidth = 1.6 + rnd() * 1.2; g.lineCap = "round";
      g.beginPath();
      g.moveTo(x, y); g.quadraticCurveTo(x - 2 + rnd() * 4, y - tall * 0.6, x - 4 + rnd() * 8, y - tall);
      g.moveTo(x + 3, y); g.quadraticCurveTo(x + 4 + rnd() * 3, y - tall * 0.5, x + 6 + rnd() * 4, y - tall * 0.8);
      g.stroke();
    }

    // 小野花
    const petals = ["#ffffff", "#fff59d", "#f8bbd0", "#c5e1f7"];
    for (let i = 0; i < 60; i++) {
      const x = rnd() * w, y = rnd() * h, r = 2.6 + rnd() * 2.4, c = petals[(rnd() * petals.length) | 0];
      g.strokeStyle = "rgba(46,125,50,.45)"; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x, y + 6); g.lineTo(x, y); g.stroke();
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        g.fillStyle = c;
        circle(g, x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, r * 0.55);
        g.fill();
      }
      g.fillStyle = "#ffb300"; circle(g, x, y, r * 0.42); g.fill();
    }

    // 小石子
    for (let i = 0; i < 34; i++) {
      const x = rnd() * w, y = rnd() * h, r = 2.2 + rnd() * 3;
      g.fillStyle = "rgba(118,120,128,.4)";
      g.beginPath(); g.ellipse(x, y, r, r * 0.75, rnd() * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(255,255,255,.3)";
      g.beginPath(); g.ellipse(x - r * 0.3, y - r * 0.3, r * 0.4, r * 0.3, 0, 0, Math.PI * 2); g.fill();
    }

    // 边缘暗角（画面更聚焦）
    const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(20,40,24,.28)");
    g.fillStyle = vg; g.fillRect(0, 0, w, h);

    // 四周石墙（砖缝只画在墙体范围内）
    const wall = 46;
    g.fillStyle = "#6d4c41";
    g.fillRect(0, 0, w, wall); g.fillRect(0, h - wall, w, wall);
    g.fillRect(0, 0, wall, h); g.fillRect(w - wall, 0, wall, h);
    g.fillStyle = "rgba(0,0,0,.22)";
    const brick = (bx, by, bw, bh) => {
      for (let y = by; y < by + bh; y += 22) {
        g.fillRect(bx, y, bw, 1.6);
        const off = (((y - by) / 22) | 0) % 2 ? 24 : 0;
        for (let x = bx + off; x < bx + bw; x += 48) g.fillRect(x, y, 1.6, 22);
      }
    };
    brick(0, 0, w, wall);
    brick(0, h - wall, w, wall);
    brick(0, wall, wall, h - wall * 2);
    brick(w - wall, wall, wall, h - wall * 2);
    // 墙顶高光 & 内侧阴影
    g.fillStyle = "rgba(255,255,255,.14)";
    g.fillRect(0, 0, w, 5); g.fillRect(0, h - 5, w, 5); g.fillRect(0, 0, 5, h); g.fillRect(w - 5, 0, 5, h);
    g.fillStyle = "rgba(0,0,0,.22)";
    g.fillRect(0, wall, w, 7); g.fillRect(0, h - wall - 7, w, 7);
    g.fillRect(wall, 0, 7, h); g.fillRect(w - wall - 7, 0, 7, h);

    this.bg = cv;
    return cv;
  },

  /* ============================================================
   * 主角：紫发绿卫衣少年（按用户提供的主角图绘制，Q版站姿）
   * ============================================================ */
  drawPlayer(ctx, p, t) {
    const C = p.colors || {
      hair: "#a58bd4", hairLine: "#7d5cb0", skin: "#ffd9b3", skin2: "#f0bd8f",
      hoodie: "#a9d6a3", hoodie2: "#8bc78b", hood: "#8fc489", line: "#5f9c62",
      pants: "#8d7f72", shoe: "#4a7fd4"
    };
    const hurt = p.invuln > 0 && Math.floor(t * 14) % 2 === 0;
    const cl = (c) => (hurt ? "#ffffff" : c);
    const moving = p.moving;
    const bob = moving ? Math.sin(t * 13) * 1.5 : Math.sin(t * 2.2) * 0.7;
    const swing = moving ? Math.sin(t * 13) * 0.16 : 0;          // 双腿摆动
    const armSw = moving ? Math.sin(t * 13 + Math.PI) * 3.2 : 0; // 左臂摆动

    // 影子（脚底）
    const ps = p.scale || 1.25;                     // 主角整体缩放
    const wsc = ps / 1.25;                          // 漂浮武器相对缩放
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 32 * ps, 15 * ps, 5.8 * ps, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.scale(ps, ps);

    /* ---- 腿 + 运动鞋 ---- */
    const leg = (lx, rot) => {
      ctx.save(); ctx.translate(lx, 4); ctx.rotate(rot);
      ctx.fillStyle = cl(C.pants); ctx.strokeStyle = "#564a42"; ctx.lineWidth = 1.7;
      rr(ctx, -3.6, 0, 7.2, 13, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,.13)";                       // 裤线暗部
      rr(ctx, 1.2, 1, 2.4, 11, 1.2); ctx.fill();
      ctx.fillStyle = cl(C.shoe); ctx.strokeStyle = "#2b5391"; ctx.lineWidth = 1.6;   // 蓝鞋身
      rr(ctx, -4.4, 11.5, 9.2, 5.6, 2.4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffffff";                                                        // 白鞋头 + 白鞋底
      rr(ctx, -4.4, 11.5, 9.2, 2.6, 1.3); ctx.fill();
      rr(ctx, -4.4, 15.6, 9.2, 1.6, 0.8); ctx.fill();
      ctx.strokeStyle = "rgba(43,83,145,.45)"; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(-3.4, 14.4); ctx.lineTo(3.4, 14.4); ctx.stroke();
      ctx.restore();
    };
    leg(-4.6, swing);
    leg(4.6, -swing);

    /* ---- 左臂（躯干后方，走路时摆动） ---- */
    ctx.save();
    ctx.translate(-12, -4);
    ctx.strokeStyle = cl(C.hoodie2); ctx.lineWidth = 5.6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 8 + armSw * 0.35); ctx.stroke();
    ctx.fillStyle = cl(C.skin); ctx.strokeStyle = cl(C.skin2); ctx.lineWidth = 1.4;
    circle(ctx, 0, 9 + armSw * 0.35, 3.1); ctx.fill(); ctx.stroke();
    ctx.restore();

    /* ---- 卫衣躯干 ---- */
    const bg = ctx.createLinearGradient(-8, -9, 10, 7);
    bg.addColorStop(0, cl(C.hoodie)); bg.addColorStop(1, cl(C.hoodie2));
    ctx.fillStyle = bg; ctx.strokeStyle = cl(C.line); ctx.lineWidth = 2;
    rr(ctx, -11, -9, 22, 16, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,.10)";                                 // 右侧暗部（体积）
    rr(ctx, 4, -8, 6, 15, 4); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.14)"; ctx.lineWidth = 1.2;          // 腋下接缝
    ctx.beginPath(); ctx.moveTo(-7.5, -3); ctx.lineTo(-7.5, 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(7.5, -3); ctx.lineTo(7.5, 4); ctx.stroke();
    ctx.strokeStyle = cl(C.line); ctx.lineWidth = 1.5;                 // 袋鼠兜
    rr(ctx, -6, -2.5, 12, 7.5, 2.5); ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,.06)"; rr(ctx, -6, -2.5, 12, 7.5, 2.5); ctx.fill();
    ctx.fillStyle = cl(C.hoodie2);                                     // 领口
    rr(ctx, -5.5, -10, 11, 4, 2); ctx.fill();
    ctx.strokeStyle = "#6f6f74"; ctx.lineWidth = 1.3; ctx.lineCap = "round";   // 抽绳
    ctx.beginPath(); ctx.moveTo(-2.4, -8); ctx.quadraticCurveTo(-2.8, -3, -2.2, 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2.4, -8); ctx.quadraticCurveTo(2.8, -3, 2.2, 0.5); ctx.stroke();
    ctx.fillStyle = "#b9b9bf";
    rr(ctx, -3.1, 0.2, 1.8, 2.4, 0.9); ctx.fill();
    rr(ctx, 1.3, 0.2, 1.8, 2.4, 0.9); ctx.fill();

    /* ---- 帽兜（垂在颈后、肩后） ---- */
    ctx.fillStyle = cl(C.hood); ctx.strokeStyle = cl(C.line); ctx.lineWidth = 1.9;
    rr(ctx, -14, -21, 28, 15, 9); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,.12)";
    rr(ctx, -14, -13, 28, 7, 4); ctx.fill();

    /* ---- 脖子 ---- */
    ctx.fillStyle = cl(C.skin2); rr(ctx, -3, -12, 6, 4, 1.5); ctx.fill();

    /* ---- 头 ---- */
    const hg = ctx.createRadialGradient(-3.5, -22.5, 2, 0, -19, 12.5);
    hg.addColorStop(0, cl("#ffe7c9")); hg.addColorStop(0.65, cl(C.skin)); hg.addColorStop(1, cl(C.skin2));
    ctx.fillStyle = hg; ctx.strokeStyle = "#cf9d6d"; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.ellipse(0, -19, 10, 10.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    /* ---- 表情：自信坏笑（会眨眼） ---- */
    const blink = (t % 4.2) < 0.12;
    if (blink) {
      ctx.strokeStyle = "#3a2e4a"; ctx.lineWidth = 1.7; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-6.6, -18.5); ctx.lineTo(-2.6, -18.5);
      ctx.moveTo(2.6, -18.5); ctx.lineTo(6.6, -18.5); ctx.stroke();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.ellipse(-4.5, -18.5, 2.9, 3.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(4.5, -18.5, 2.9, 3.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3a2e4a";
      circle(ctx, -4.5, -18.5, 2.15); ctx.fill();
      circle(ctx, 4.5, -18.5, 2.15); ctx.fill();
      ctx.fillStyle = "#ffffff";
      circle(ctx, -5.2, -19.5, 0.85); ctx.fill();
      circle(ctx, 3.8, -19.5, 0.85); ctx.fill();
    }
    ctx.strokeStyle = "#8a68c0"; ctx.lineWidth = 1.4; ctx.lineCap = "round";   // 眉
    ctx.beginPath(); ctx.moveTo(-7.0, -22.3); ctx.lineTo(-3.0, -21.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3.0, -21.7); ctx.lineTo(7.0, -22.3); ctx.stroke();
    ctx.strokeStyle = "#b5563f"; ctx.lineWidth = 1.5;                           // 小坏笑
    ctx.beginPath(); ctx.arc(1.0, -13.6, 2.2, 0.25, Math.PI - 0.5); ctx.stroke();
    ctx.fillStyle = "rgba(244,143,177,.32)";                                    // 腮红
    circle(ctx, -7.6, -15.0, 2.0); ctx.fill();
    circle(ctx, 8.4, -15.0, 2.0); ctx.fill();

    /* ---- 呆毛 + 紫色短发（锯齿刘海止于眼睛上方） ---- */
    if (p.acc !== "bolt") {
      ctx.strokeStyle = cl(C.hair); ctx.lineWidth = 2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(1.5, -29.5); ctx.quadraticCurveTo(4.5, -34, 1, -36.5); ctx.stroke();
      ctx.fillStyle = cl("#d9f2d9"); ctx.strokeStyle = cl("#a5d6a7"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0.5, -37.4, 2.5, 1.6, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = cl(C.hair); ctx.strokeStyle = cl(C.hairLine); ctx.lineWidth = 1.9;
    ctx.beginPath();
    ctx.arc(0, -20, 10.6, Math.PI, 0, false);        // 沿头顶（经上方）到右侧
    const fringe = [[9.4, -21.6], [7.8, -24.6], [5.6, -22.0], [3.6, -24.4], [1.4, -21.4],
      [-0.8, -24.2], [-3.0, -21.6], [-5.0, -24.4], [-7.2, -22.0], [-9.2, -24.2]];
    for (const f of fringe) ctx.lineTo(f[0], f[1]);  // 锯齿刘海
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.30)"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(0, -20, 7.4, Math.PI * 1.15, Math.PI * 1.5); ctx.stroke();   // 高光

    /* ---- 角色配件 ---- */
    if (p.acc === "bolt") {                            // 小闪：闪电呆毛
      ctx.fillStyle = "#ffd54f"; ctx.strokeStyle = "#f57f17"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(2, -29); ctx.lineTo(-3, -36); ctx.lineTo(0.5, -36.5); ctx.lineTo(-2, -43);
      ctx.lineTo(4.5, -35); ctx.lineTo(1, -34.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (p.acc === "band") {                     // 阿铁：运动发带
      ctx.fillStyle = cl("#90a4ae"); ctx.strokeStyle = cl("#546e7a"); ctx.lineWidth = 1.5;
      rr(ctx, -10.6, -25.5, 21.2, 4.6, 2.2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#eceff1"; rr(ctx, -2, -25.5, 4, 4.6, 1.5); ctx.fill();
    } else if (p.acc === "hat") {                      // 小巫：巫师帽
      ctx.fillStyle = cl(C.hoodie2); ctx.strokeStyle = cl(C.line); ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-10, -24); ctx.quadraticCurveTo(-3, -30, 3, -40);
      ctx.quadraticCurveTo(7, -31, 10, -24); ctx.closePath(); ctx.fill(); ctx.stroke();
      rr(ctx, -11, -25.5, 22, 3.6, 1.8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffd54f"; ctx.strokeStyle = "#f57f17"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 1.4 : 3;
        i ? ctx.lineTo(3 + Math.cos(a) * r, -41 + Math.sin(a) * r) : ctx.moveTo(3 + Math.cos(a) * r, -41 + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    /* ---- 近战武器：持于右手（挥砍 / 突刺 / 砸击动画） ---- */
    let holdIdx = -1;
    if (!p.artShot) {                          // 展示模式：全部武器都走环形悬浮
      for (let i = p.weapons.length - 1; i >= 0; i--) {
        if (WEAPONS[p.weapons[i].key] && WEAPONS[p.weapons[i].key].type === "melee") { holdIdx = i; break; }
      }
    }
    const right = Math.cos(p.aim) >= 0;
    if (holdIdx >= 0) {
      const wpn = p.weapons[holdIdx];
      ctx.save();
      ctx.translate(right ? 9.5 : -9.5, -5);
      if (!right) ctx.scale(-1, 1);
      const ang = right ? p.aim : Math.PI - p.aim;
      let swingOff = 0, reach = 0;
      // 挥砍时间轴：举起 → 劈下 → 收招（命中时刻刀锋正对目标）
      const sw = wpn.swingT === undefined ? -1 : wpn.swingT;
      if (sw >= 0) {
        const c = meleeSwingCurve(wpn.key, sw / SWING_DUR);
        swingOff = c.ang;
        reach = c.reach;
      } else if (wpn.anim > 0) {               // 兼容菜单展示等旧用法
        const s = 1 - wpn.anim;
        swingOff = -1.25 * (1 - s) + 0.55 * s;
      }
      ctx.rotate(ang + swingOff);              // 整条手臂转向目标，再叠加劈砍偏转
      ctx.strokeStyle = cl(C.hoodie); ctx.lineWidth = 6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9 + reach * 0.4, 0); ctx.stroke();
      ctx.fillStyle = cl(C.skin); ctx.strokeStyle = cl(C.skin2); ctx.lineWidth = 1.4;
      circle(ctx, 10.5 + reach * 0.4, 0, 3.1); ctx.fill(); ctx.stroke();
      ctx.save();
      ctx.translate(10.5 + reach * 0.4, 0);
      this.drawWeapon(ctx, wpn.key, 1);
      ctx.restore();
      ctx.restore();
    } else {
      // 空手：右臂自然垂放
      ctx.save();
      ctx.translate(12, -4);
      ctx.strokeStyle = cl(C.hoodie2); ctx.lineWidth = 5.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 8 - armSw * 0.35); ctx.stroke();
      ctx.fillStyle = cl(C.skin); ctx.strokeStyle = cl(C.skin2); ctx.lineWidth = 1.4;
      circle(ctx, 0, 9 - armSw * 0.35, 3.1); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    /* ---- 其余近战武器：斜挎在背后（不会被手持的那把覆盖掉） ---- */
    if (!p.artShot) {
      const extras = [];
      for (let i = 0; i < p.weapons.length; i++) {
        if (i === holdIdx) continue;
        const W = WEAPONS[p.weapons[i].key];
        if (W && W.type === "melee") extras.push(p.weapons[i].key);
      }
      extras.forEach((key, i) => {
        ctx.save();
        if (!right) ctx.scale(-1, 1);                       // 跟随朝向镜像
        ctx.translate((i % 2 ? 5 : -5), -33 + (i % 2) * 3); // 肩后位置，多把上下错开
        ctx.rotate(-0.95 - i * 0.42);                       // 扇形斜挎
        this.drawWeapon(ctx, key, 0.52);
        ctx.restore();
      });
    }

    ctx.restore();   // 结束 1.25 缩放坐标系

    /* ---- 远程武器：环绕漂浮，指向敌人 ---- */
    if (p.floatPos) {
      p.weapons.forEach((w, i) => {
        const W = WEAPONS[w.key];
        if (!W) return;
        if (!p.artShot && W.type !== "ranged") return;   // 展示模式下近战武器也环形悬浮
        const fp = p.floatPos[i];
        if (!fp) return;
        const anim = w.anim || 0;
        if (p.artShot) {                                  // 展示构图：深色圆盘衬底，武器更醒目
          ctx.fillStyle = "rgba(8,12,18,.30)";
          circle(ctx, fp.x, fp.y, 24); ctx.fill();
        }
        const gr = ctx.createRadialGradient(fp.x, fp.y + 11, 1, fp.x, fp.y + 11, 12);   // 漂浮光晕
        gr.addColorStop(0, "rgba(242,185,61,.30)");
        gr.addColorStop(1, "rgba(242,185,61,0)");
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.ellipse(fp.x, fp.y + 11, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
        let wx = fp.x, wy = fp.y, sc = 1;
        if (anim > 0) {                        // 开火：后坐力后退 + 垂直抖动（不位移、不绕圈）
          const kick = anim * 8;
          wx -= Math.cos(fp.ang) * kick;
          wy -= Math.sin(fp.ang) * kick;
          const jitter = Math.sin(anim * 52) * anim * 1.9;
          wx += Math.cos(fp.ang + Math.PI / 2) * jitter;
          wy += Math.sin(fp.ang + Math.PI / 2) * jitter;
          sc = 1 + anim * 0.08;
          if (w.key === "wand") sc = 1 + anim * 0.3;
        }
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(fp.ang);
        ctx.translate(-6, 0);                  // 以武器中心为轴旋转
        this.drawWeapon(ctx, w.key, 0.85 * sc * wsc * (p.floatBoost || 1));
        ctx.restore();
      });
    }
  },

  /* 单把武器的手持绘制 */
  drawWeapon(ctx, id, s) {
    ctx.save();
    ctx.scale(s, s);
    ctx.lineWidth = 1.6;
    const steel = (a, b) => { const g = ctx.createLinearGradient(0, -3, 0, 3); g.addColorStop(0, "#eceff1"); g.addColorStop(1, "#90a4ae"); ctx.fillStyle = a || g; ctx.strokeStyle = b || "#37474f"; };
    switch (id) {
      case "knife":
        ctx.fillStyle = "#cfd8dc"; ctx.strokeStyle = "#455a64";
        ctx.beginPath(); ctx.moveTo(0, -2.5); ctx.lineTo(17, -1.5); ctx.lineTo(19, 0); ctx.lineTo(17, 1.5); ctx.lineTo(0, 2.5); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#8d6e63"; rr(ctx, -7, -2.2, 7, 4.4, 2); ctx.fill(); ctx.stroke();
        break;
      case "sword":
        steel();
        ctx.beginPath(); ctx.moveTo(2, -3); ctx.lineTo(24, -2); ctx.lineTo(27, 0); ctx.lineTo(24, 2); ctx.lineTo(2, 3); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#ffb300"; ctx.strokeStyle = "#e08e00"; rr(ctx, -3, -5, 5, 10, 1.5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#8d6e63"; rr(ctx, -10, -2, 7, 4, 1.8); ctx.fill(); ctx.stroke();
        break;
      case "spear":
        ctx.strokeStyle = "#a1887f"; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(22, 0); ctx.stroke();
        ctx.fillStyle = "#cfd8dc"; ctx.strokeStyle = "#455a64";
        ctx.beginPath(); ctx.moveTo(20, -3.4); ctx.lineTo(29, 0); ctx.lineTo(20, 3.4); ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      case "hammer":
        ctx.strokeStyle = "#a1887f"; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(18, 0); ctx.stroke();
        ctx.fillStyle = "#90a4ae"; ctx.strokeStyle = "#37474f";
        rr(ctx, 16, -8, 13, 16, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#b0bec5"; rr(ctx, 16, -8, 13, 5, 2.5); ctx.fill();
        break;
      case "pistol": case "smg": case "shotgun": {
        const long = id === "shotgun" ? 26 : id === "smg" ? 18 : 16;
        ctx.fillStyle = id === "pistol" ? "#546e7a" : "#455a64";
        ctx.strokeStyle = "#263238";
        rr(ctx, -6, -4.5, long + 8, 6, 2); ctx.fill(); ctx.stroke();
        rr(ctx, long - 2, -3, 8, 3.4, 1.5); ctx.fill(); ctx.stroke();     // 枪管
        ctx.fillStyle = "#37474f";
        rr(ctx, -5, 1.5, 5, 8, 2); ctx.fill(); ctx.stroke();               // 握把
        if (id === "smg") { rr(ctx, 3, 2, 4, 8, 1.5); ctx.fill(); ctx.stroke(); }
        break;
      }
      case "boomerang":
        ctx.fillStyle = "#c08a4a"; ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-12, -5); ctx.lineTo(16, -5); ctx.lineTo(16, 2); ctx.lineTo(-2, 2); ctx.lineTo(-2, 12); ctx.lineTo(-9, 12); ctx.lineTo(-9, 2); ctx.lineTo(-12, 2);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      case "wand":
        ctx.strokeStyle = "#8d6e63"; ctx.lineWidth = 3.4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-8, 2); ctx.lineTo(14, -4); ctx.stroke();
        ctx.fillStyle = "#ffeb3b"; ctx.strokeStyle = "#f9a825"; ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2, r = i % 2 ? 2 : 4.6;
          i ? ctx.lineTo(16 + Math.cos(a) * r, -5 + Math.sin(a) * r) : ctx.moveTo(16 + Math.cos(a) * r, -5 + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      default: // 空手（拳头已由手臂绘制）
      break;
    }
    ctx.restore();
  },

  /* ============================================================
   * 敌人
   * ============================================================ */
  drawEnemy(ctx, e, t) {
    const S = e.size;
    const flash = e.flash > 0 ? Math.min(1, e.flash * 5) : 0;
    const col = hexLerp(e.color, "#ffffff", flash * 0.75);
    const col2 = hexLerp(e.color2, "#ffe0e0", flash * 0.75);

    // 影子
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath(); ctx.ellipse(e.x, e.y + S * 0.9, S * 0.85, S * 0.34, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(e.x, e.y);

    if (e.type === "bat") {
      const flap = Math.sin(t * 18 + e.ph);
      // 翅膀
      ctx.fillStyle = hexLerp("#7e57c2", "#ffffff", flash * 0.7);
      [-1, 1].forEach(d => {
        ctx.beginPath();
        ctx.moveTo(d * S * 0.4, -S * 0.2);
        ctx.quadraticCurveTo(d * S * (1.5 + flap * 0.5), -S * (0.9 + flap * 0.4), d * S * (1.7 + flap * 0.4), S * 0.15);
        ctx.quadraticCurveTo(d * S * 1.1, S * 0.1, d * S * 0.45, S * 0.45);
        ctx.closePath(); ctx.fill();
      });
      // 身体
      const g = ctx.createRadialGradient(-S * 0.3, -S * 0.3, 1, 0, 0, S);
      g.addColorStop(0, col); g.addColorStop(1, col2);
      ctx.fillStyle = g; circle(ctx, 0, 0, S * 0.85); ctx.fill();
      ctx.strokeStyle = "#4a148c"; ctx.lineWidth = 2; ctx.stroke();
      // 耳朵
      ctx.fillStyle = col2;
      [-1, 1].forEach(d => { ctx.beginPath(); ctx.moveTo(d * S * 0.45, -S * 0.6); ctx.lineTo(d * S * 0.75, -S * 1.35); ctx.lineTo(d * S * 0.95, -S * 0.55); ctx.closePath(); ctx.fill(); });
      // 眼（怒）
      ctx.fillStyle = "#fff";
      circle(ctx, -S * 0.32, -S * 0.12, S * 0.24); ctx.fill();
      circle(ctx, S * 0.32, -S * 0.12, S * 0.24); ctx.fill();
      ctx.fillStyle = "#d32f2f";
      circle(ctx, -S * 0.32, -S * 0.1, S * 0.12); ctx.fill();
      circle(ctx, S * 0.32, -S * 0.1, S * 0.12); ctx.fill();
      // 牙
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.moveTo(-S * 0.2, S * 0.35); ctx.lineTo(-S * 0.1, S * 0.62); ctx.lineTo(0, S * 0.35); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, S * 0.35); ctx.lineTo(S * 0.1, S * 0.62); ctx.lineTo(S * 0.2, S * 0.35); ctx.closePath(); ctx.fill();
    } else if (e.type === "golem") {
      const bobY = Math.sin(t * 5 + e.ph) * 1.5;
      ctx.translate(0, bobY);
      // 脚
      ctx.fillStyle = "#5d5d6e";
      rr(ctx, -S * 0.62, S * 0.62, S * 0.42, S * 0.3, 4); ctx.fill();
      rr(ctx, S * 0.2, S * 0.62, S * 0.42, S * 0.3, 4); ctx.fill();
      // 身体（圆角方块岩石）
      const g = ctx.createLinearGradient(0, -S, 0, S);
      g.addColorStop(0, col); g.addColorStop(1, col2);
      ctx.fillStyle = g; ctx.strokeStyle = "#4e4e5e"; ctx.lineWidth = 2.4;
      rr(ctx, -S * 0.8, -S * 0.75, S * 1.6, S * 1.45, S * 0.35); ctx.fill(); ctx.stroke();
      // 裂纹
      ctx.strokeStyle = "rgba(50,50,64,.55)"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(-S * 0.4, -S * 0.5); ctx.lineTo(-S * 0.15, 0); ctx.lineTo(-S * 0.45, S * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(S * 0.45, -S * 0.4); ctx.lineTo(S * 0.2, S * 0.1); ctx.stroke();
      // 眼
      ctx.fillStyle = "#ffca28";
      circle(ctx, -S * 0.28, -S * 0.22, S * 0.14); ctx.fill();
      circle(ctx, S * 0.28, -S * 0.22, S * 0.14); ctx.fill();
      ctx.fillStyle = "#3e2723";
      circle(ctx, -S * 0.28, -S * 0.2, S * 0.07); ctx.fill();
      circle(ctx, S * 0.28, -S * 0.2, S * 0.07); ctx.fill();
    } else if (e.type === "spitter") {
      const wob = Math.sin(t * 7 + e.ph);
      // 背刺
      ctx.fillStyle = "#a04000";
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * S * 0.42 - 3, -S * 0.55);
        ctx.lineTo(i * S * 0.42, -S * (1.0 + wob * 0.1));
        ctx.lineTo(i * S * 0.42 + 3, -S * 0.55);
        ctx.closePath(); ctx.fill();
      }
      const g = ctx.createRadialGradient(-S * 0.3, -S * 0.35, 2, 0, 0, S * 1.1);
      g.addColorStop(0, col); g.addColorStop(1, col2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, S * 0.95, S * 0.85, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#8d3b00"; ctx.lineWidth = 2; ctx.stroke();
      // 嘴（炮口）
      ctx.save();
      ctx.rotate(e.aim);
      ctx.fillStyle = "#5d1a00";
      circle(ctx, S * 0.7, 0, S * 0.3); ctx.fill();
      ctx.fillStyle = "#ff8f00";
      circle(ctx, S * 0.82, 0, S * 0.13); ctx.fill();
      ctx.restore();
      // 眼
      ctx.fillStyle = "#fff";
      circle(ctx, -S * 0.25, -S * 0.3, S * 0.22); ctx.fill();
      circle(ctx, S * 0.3, -S * 0.32, S * 0.2); ctx.fill();
      ctx.fillStyle = "#212121";
      circle(ctx, -S * 0.22, -S * 0.28, S * 0.1); ctx.fill();
      circle(ctx, S * 0.33, -S * 0.3, S * 0.09); ctx.fill();
    } else {
      /* 史莱姆（默认） */
      const wob = Math.sin(t * 6 + e.ph);
      const rx = S * (1.02 + wob * 0.09), ry = S * (0.95 - wob * 0.09);
      const g = ctx.createRadialGradient(-S * 0.3, -S * 0.4, 2, 0, 0, S * 1.2);
      g.addColorStop(0, col); g.addColorStop(1, col2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, S * 0.12, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#1b5e20"; ctx.lineWidth = 2.2; ctx.stroke();
      // 高光
      ctx.fillStyle = "rgba(255,255,255,.4)";
      ctx.beginPath(); ctx.ellipse(-S * 0.35, -S * 0.35, S * 0.28, S * 0.18, -0.5, 0, Math.PI * 2); ctx.fill();
      // 眼
      ctx.fillStyle = "#fff";
      circle(ctx, -S * 0.3, -S * 0.15, S * 0.24); ctx.fill();
      circle(ctx, S * 0.3, -S * 0.15, S * 0.24); ctx.fill();
      ctx.strokeStyle = "#1b5e20"; ctx.lineWidth = 1;
      circle(ctx, -S * 0.3, -S * 0.15, S * 0.24); ctx.stroke();
      circle(ctx, S * 0.3, -S * 0.15, S * 0.24); ctx.stroke();
      ctx.fillStyle = "#111";
      circle(ctx, -S * 0.3 + Math.cos(e.aim) * S * 0.08, -S * 0.13 + Math.sin(e.aim) * S * 0.08, S * 0.11); ctx.fill();
      circle(ctx, S * 0.3 + Math.cos(e.aim) * S * 0.08, -S * 0.13 + Math.sin(e.aim) * S * 0.08, S * 0.11); ctx.fill();
      // 嘴
      ctx.strokeStyle = "#1b5e20"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(0, S * 0.22, S * 0.22, 0.15, Math.PI - 0.15); ctx.stroke();
    }

    /* 精英皇冠 */
    if (e.elite) {
      ctx.fillStyle = "#ffd54f"; ctx.strokeStyle = "#e65100"; ctx.lineWidth = 2;
      const cy = -S * 0.95, cw = S * 0.55;
      ctx.beginPath();
      ctx.moveTo(-cw, cy + 6); ctx.lineTo(-cw, cy - 3); ctx.lineTo(-cw * 0.45, cy + 1); ctx.lineTo(0, cy - 6);
      ctx.lineTo(cw * 0.45, cy + 1); ctx.lineTo(cw, cy - 3); ctx.lineTo(cw, cy + 6);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#e53935"; circle(ctx, 0, cy + 1, 2.2); ctx.fill();
      // 精英红光
      ctx.strokeStyle = "rgba(229,57,53," + (0.35 + Math.sin(t * 6 + e.ph) * 0.15) + ")";
      ctx.lineWidth = 3;
      circle(ctx, 0, 0, S + 5); ctx.stroke();
    }
    ctx.restore();

    /* 血条（受伤后显示） */
    if (e.hp < e.maxHp) {
      const w = Math.max(26, S * 2.2), h = 4.5;
      const bx = e.x - w / 2, by = e.y - S - (e.elite ? 16 : 11);
      ctx.fillStyle = "rgba(0,0,0,.55)"; rr(ctx, bx - 1, by - 1, w + 2, h + 2, 3); ctx.fill();
      const pct = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = pct > 0.5 ? "#66bb6a" : pct > 0.25 ? "#ffa726" : "#ef5350";
      rr(ctx, bx, by, w * pct, h, 2.5); ctx.fill();
    }
  },

  /* ============================================================
   * 掉落物 / 宝箱
   * ============================================================ */
  drawPickup(ctx, pk, t) {
    const bob = Math.sin(t * 4 + pk.ph) * 2;
    ctx.save();
    ctx.translate(pk.x, pk.y + bob);
    ctx.rotate(Math.sin(t * 2 + pk.ph) * 0.25);
    if (pk.fly) {                      // 飞行中：金色光环 + 尺寸略大
      const fg = ctx.createRadialGradient(0, 0, 2, 0, 0, 16);
      fg.addColorStop(0, "rgba(255,224,130,.55)");
      fg.addColorStop(1, "rgba(255,224,130,0)");
      ctx.fillStyle = fg;
      circle(ctx, 0, 0, 16 + Math.sin(t * 9 + pk.ph) * 2); ctx.fill();
    }
    // 光晕
    ctx.fillStyle = "rgba(102,187,106,.25)";
    circle(ctx, 0, 0, 9 + Math.sin(t * 5 + pk.ph) * 1.5); ctx.fill();
    // 宝石
    ctx.fillStyle = "#66bb6a"; ctx.strokeStyle = "#1b5e20"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5.5, -1); ctx.lineTo(0, 7); ctx.lineTo(-5.5, -1);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(2.5, -1); ctx.lineTo(0, 1); ctx.lineTo(-2.5, -1);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  },

  drawChest(ctx, c, t) {
    ctx.save();
    ctx.translate(c.x, c.y);
    if (!c.opened) {
      ctx.fillStyle = "rgba(0,0,0,.25)";
      ctx.beginPath(); ctx.ellipse(0, 16, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#8d6e63"; ctx.strokeStyle = "#4e342e"; ctx.lineWidth = 2;
      rr(ctx, -16, -8, 32, 24, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#6d4c41"; rr(ctx, -16, -8, 32, 9, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffca28"; rr(ctx, -16, 0, 32, 4, 1); ctx.fill();
      rr(ctx, -3, -3, 6, 8, 1.5); ctx.fill(); ctx.stroke();
      // 诱惑闪光
      ctx.fillStyle = "rgba(255,255,255," + (0.4 + Math.sin(t * 6) * 0.3) + ")";
      ctx.beginPath(); ctx.moveTo(-12, -6); ctx.lineTo(-6, -6); ctx.lineTo(-10, 2); ctx.lineTo(-14, 0); ctx.closePath(); ctx.fill();
    } else {
      // 打开：金光
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
      g.addColorStop(0, "rgba(255,235,130,.9)"); g.addColorStop(1, "rgba(255,235,130,0)");
      ctx.fillStyle = g; circle(ctx, 0, 0, 30); ctx.fill();
      ctx.fillStyle = "#6d4c41"; ctx.strokeStyle = "#4e342e";
      rr(ctx, -16, 2, 32, 12, 3); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.rotate(-0.5); ctx.fillStyle = "#8d6e63"; rr(ctx, -18, -12, 36, 10, 4); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    ctx.restore();
  },

  /* ============================================================
   * 弹道
   * ============================================================ */
  drawShot(ctx, s) {
    ctx.save();
    ctx.translate(s.x, s.y);
    if (s.kind === "bullet" || s.kind === "pellet") {
      ctx.rotate(s.ang);
      const big = s.kind === "bullet";
      ctx.fillStyle = big ? "#ffd54f" : "#ffb74d";
      ctx.strokeStyle = "#e65100"; ctx.lineWidth = 1.4;
      rr(ctx, big ? -7 : -5, big ? -2.4 : -1.8, big ? 14 : 10, big ? 4.8 : 3.6, big ? 2.4 : 1.8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.75)";
      rr(ctx, big ? -5 : -3.5, big ? -1.6 : -1.2, big ? 5 : 3.5, big ? 1.6 : 1.2, 0.8); ctx.fill();
    } else if (s.kind === "boomerang") {
      ctx.rotate(s.rot);
      ctx.fillStyle = "#c08a4a"; ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-9, -4); ctx.lineTo(9, -4); ctx.lineTo(9, 2); ctx.lineTo(-1, 2); ctx.lineTo(-1, 10); ctx.lineTo(-6, 10); ctx.lineTo(-6, 2); ctx.lineTo(-9, 2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-6, -2.5); ctx.lineTo(6, -2.5); ctx.stroke();
    } else if (s.kind === "missile") {
      ctx.rotate(s.rot || s.ang);
      // 尾焰
      ctx.fillStyle = "rgba(206,147,216,.5)";
      circle(ctx, -8, 0, 4 + Math.random() * 1.5); ctx.fill();
      ctx.fillStyle = "#ce93d8"; ctx.strokeStyle = "#6a1b9a"; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, r = i % 2 ? 2.2 : 5;
        i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; circle(ctx, 0, 0, 1.6); ctx.fill();
    }
    ctx.restore();
  },

  drawEnemyShot(ctx, s) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "rgba(239,83,80,.3)";
    circle(ctx, 0, 0, 8); ctx.fill();
    ctx.fillStyle = "#ef5350"; ctx.strokeStyle = "#b71c1c"; ctx.lineWidth = 1.6;
    circle(ctx, 0, 0, 5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.6)";
    circle(ctx, -1.5, -1.5, 1.6); ctx.fill();
    ctx.restore();
  },

  /* ============================================================
   * 特效
   * ============================================================ */
  drawFx(ctx, f, t) {
    const p = Math.min(1, f.t / f.dur);
    ctx.save();
    ctx.translate(f.x, f.y);
    switch (f.kind) {
      case "slash": { // 近战扇形刀光（随挥砍方向扫过）
        ctx.rotate(f.ang + (p - 0.5) * f.arc * 0.85);
        const r = f.r * (0.75 + p * 0.35);
        ctx.globalAlpha = (1 - p) * 0.95;
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 10 * (1 - p * 0.55); ctx.lineCap = "round";
        ctx.beginPath(); ctx.arc(0, 0, r, -f.arc / 2, f.arc / 2); ctx.stroke();
        ctx.strokeStyle = "rgba(255,235,150," + (1 - p) * 0.8 + ")"; ctx.lineWidth = 4 * (1 - p * 0.5);
        ctx.beginPath(); ctx.arc(0, 0, r * 0.92, -f.arc / 2, f.arc / 2); ctx.stroke();
        break;
      }
      case "stab": { // 长矛直线突刺
        ctx.rotate(f.ang);
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 7 * (1 - p * 0.6); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(f.r * 0.25, 0); ctx.lineTo(f.r * (0.55 + p * 0.5), 0); ctx.stroke();
        break;
      }
      case "smash": { // 锤击冲击环
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = "#ffe082"; ctx.lineWidth = 8 * (1 - p);
        circle(ctx, 0, 0, f.r * (0.4 + p * 0.8)); ctx.stroke();
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3 * (1 - p);
        circle(ctx, 0, 0, f.r * (0.3 + p * 0.65)); ctx.stroke();
        break;
      }
      case "boom": { // 爆炸
        const rr0 = f.r * (0.25 + p * 0.85);
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, rr0);
        g.addColorStop(0, "rgba(255,255,255," + (1 - p) + ")");
        g.addColorStop(0.5, "rgba(255,193,7," + (1 - p) * 0.9 + ")");
        g.addColorStop(1, "rgba(239,83,80,0)");
        ctx.fillStyle = g; circle(ctx, 0, 0, rr0); ctx.fill();
        break;
      }
      case "ring": { // 通用扩散环
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = f.color || "#ffffff"; ctx.lineWidth = 4 * (1 - p) + 1;
        circle(ctx, 0, 0, f.r * (0.2 + p)); ctx.stroke();
        break;
      }
      case "portal": { // 敌人出场传送门
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = "#ab47bc"; ctx.lineWidth = 3;
        circle(ctx, 0, 0, f.r * (1 - p * 0.4)); ctx.stroke();
        ctx.fillStyle = "rgba(171,71,188,.35)";
        circle(ctx, 0, 0, f.r * (1 - p) * 0.7); ctx.fill();
        break;
      }
      case "beam": { // 升级金光柱
        ctx.globalAlpha = (1 - p) * 0.85;
        const g = ctx.createLinearGradient(0, -60, 0, 20);
        g.addColorStop(0, "rgba(255,241,118,0)");
        g.addColorStop(1, "rgba(255,241,118," + (1 - p) + ")");
        ctx.fillStyle = g;
        rr(ctx, -16, -60, 32, 80, 14); ctx.fill();
        break;
      }
      case "muzzle": {
        ctx.globalAlpha = 1 - p;
        ctx.rotate(f.ang);
        ctx.fillStyle = "#fff59d";
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2, r = i % 2 ? 2 : 6;
          i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
        break;
      }
      case "heal": {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = "#a5d6a7";
        const s = 7;
        ctx.fillRect(-s / 2, -s * 1.6, s, s * 3.2);
        ctx.fillRect(-s * 1.6, -s / 2, s * 3.2, s);
        break;
      }
    }
    ctx.restore();
  },

  /* ============================================================
   * 主菜单氛围：夜空明月 + 远山 + 地面剪影 + 浮尘
   * 静态层预渲染到离屏画布，每帧只画动画部分
   * ============================================================ */
  buildMenuBg(w, h, dpr) {
    dpr = dpr || 1;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 夜空
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#080e1c");
    sky.addColorStop(0.42, "#101a2e");
    sky.addColorStop(0.72, "#16243c");
    sky.addColorStop(1, "#0a1120");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // 星星（固定伪随机，保证每次进菜单一致）
    let s = 20260922;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 110; i++) {
      const x = rnd() * w, y = rnd() * h * 0.62, r = rnd() * 1.5 + 0.35;
      g.fillStyle = "rgba(255,255,255," + (0.12 + rnd() * 0.55).toFixed(2) + ")";
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    // 月亮 + 光晕
    const mx = w * 0.79, my = h * 0.17, mr = Math.min(w, h) * 0.072;
    const halo = g.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 7);
    halo.addColorStop(0, "rgba(255,247,214,.20)");
    halo.addColorStop(0.3, "rgba(255,247,214,.07)");
    halo.addColorStop(1, "rgba(255,247,214,0)");
    g.fillStyle = halo;
    g.beginPath(); g.arc(mx, my, mr * 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff7dc";
    g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(206,188,142,.5)";
    [[0.32, -0.18, 0.2], [-0.26, 0.24, 0.15], [0.08, 0.44, 0.11], [-0.34, -0.36, 0.08]].forEach(k => {
      g.beginPath(); g.arc(mx + k[0] * mr, my + k[1] * mr, k[2] * mr, 0, Math.PI * 2); g.fill();
    });

    // 远山两层
    const hill = (base, amp, color, off) => {
      g.fillStyle = color;
      g.beginPath(); g.moveTo(0, h);
      let s2 = Math.floor(off * 1000) + 5;
      const r2 = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let x = 0; x <= w + 12; x += 22) {
        const y = base + Math.sin(x * 0.0042 + off) * amp + Math.sin(x * 0.011 + off * 2) * amp * 0.35 + (r2() - 0.5) * amp * 0.35;
        g.lineTo(x, y);
      }
      g.lineTo(w, h); g.closePath(); g.fill();
    };
    hill(h * 0.60, 30, "#0c1424", 1.3);
    hill(h * 0.70, 22, "#09101d", 3.9);

    // 地面
    const gr = g.createLinearGradient(0, h * 0.68, 0, h);
    gr.addColorStop(0, "#0f1c14");
    gr.addColorStop(0.5, "#0b1510");
    gr.addColorStop(1, "#060c08");
    g.fillStyle = gr;
    g.fillRect(0, h * 0.68, w, h * 0.32);
    // 地面高光带
    const gl = g.createLinearGradient(0, h * 0.68, 0, h * 0.8);
    gl.addColorStop(0, "rgba(120,160,110,.10)");
    gl.addColorStop(1, "rgba(120,160,110,0)");
    g.fillStyle = gl;
    g.fillRect(0, h * 0.68, w, h * 0.12);

    // 草叶 / 石头剪影（前景）
    const tuft = (x, y, r, dark) => {
      g.strokeStyle = dark ? "rgba(4,8,6,.9)" : "rgba(8,16,11,.85)";
      g.lineWidth = Math.max(1.6, r * 0.14);
      g.lineCap = "round";
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(x + i * r * 0.22, y);
        g.quadraticCurveTo(x + i * r * 0.34, y - r * 0.55, x + i * r * 0.62, y - r * (0.85 + Math.abs(i) * 0.16));
        g.stroke();
      }
    };
    const rock = (x, y, r) => {
      g.fillStyle = "rgba(6,10,14,.92)";
      g.beginPath();
      g.moveTo(x - r, y);
      g.lineTo(x - r * 0.45, y - r * 0.72);
      g.lineTo(x + r * 0.25, y - r * 0.9);
      g.lineTo(x + r, y - r * 0.3);
      g.lineTo(x + r * 0.7, y);
      g.closePath(); g.fill();
      g.fillStyle = "rgba(255,255,255,.06)";
      g.beginPath();
      g.moveTo(x - r * 0.45, y - r * 0.72);
      g.lineTo(x + r * 0.25, y - r * 0.9);
      g.lineTo(x - r * 0.05, y - r * 0.2);
      g.closePath(); g.fill();
    };
    let s3 = 991;
    const r3 = () => (s3 = (s3 * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 26; i++) {
      const x = r3() * w, y = h * (0.74 + r3() * 0.24), r = 10 + r3() * 22;
      if (r3() > 0.32) tuft(x, y, r, r3() > 0.6); else rock(x, y, r * 0.5);
    }
    // 主角脚下的一圈暗色地面，让人更突出
    const vg = g.createRadialGradient(w * 0.5, h * 0.6, 10, w * 0.5, h * 0.6, Math.min(w, h) * 0.5);
    vg.addColorStop(0, "rgba(0,0,0,.42)");
    vg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);

    return c;
  },

  drawMenuScene(ctx, w, h, t, dpr) {
    dpr = dpr || 1;
    if (!this.menuBg || this.menuBgW !== w || this.menuBgH !== h || this.menuBgDpr !== dpr) {
      this.menuBg = this.buildMenuBg(w, h, dpr);
      this.menuBgW = w; this.menuBgH = h; this.menuBgDpr = dpr;
    }
    ctx.drawImage(this.menuBg, 0, 0, w, h);

    // 怪物剪影（站在远山与地面上）
    const sil = (x, y, r, kind, ph) => {
      const bob = Math.sin(t * 1.3 + ph) * r * 0.07;
      ctx.fillStyle = "rgba(4,7,12,.9)";
      ctx.strokeStyle = "rgba(255,255,255,.06)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (kind === 1) ctx.ellipse(x, y + bob, r * 0.55, r * 0.72, 0, 0, Math.PI * 2);
      else if (kind === 2) ctx.ellipse(x, y + bob, r * 0.98, r * 0.8, 0, 0, Math.PI * 2);
      else ctx.ellipse(x, y + bob, r, r * 0.92, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (kind === 1) {   // 蝙蝠翅膀
        ctx.beginPath();
        ctx.moveTo(x - r * 0.5, y + bob);
        ctx.quadraticCurveTo(x - r * 1.6, y + bob - r * 0.6, x - r * 1.15, y + bob + r * 0.35);
        ctx.quadraticCurveTo(x - r * 0.8, y + bob + r * 0.1, x - r * 0.5, y + bob + r * 0.35);
        ctx.moveTo(x + r * 0.5, y + bob);
        ctx.quadraticCurveTo(x + r * 1.6, y + bob - r * 0.6, x + r * 1.15, y + bob + r * 0.35);
        ctx.quadraticCurveTo(x + r * 0.8, y + bob + r * 0.1, x + r * 0.5, y + bob + r * 0.35);
        ctx.fill();
      }
      if (kind === 2) {   // 石头人裂纹
        ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.3, y + bob - r * 0.4); ctx.lineTo(x, y + bob); ctx.lineTo(x + r * 0.2, y + bob + r * 0.4);
        ctx.stroke();
      }
      const ey = y + bob - r * 0.2;
      ctx.fillStyle = "rgba(255,255,255,.85)";
      circle(ctx, x - r * 0.28, ey, Math.max(1.7, r * 0.14)); ctx.fill();
      circle(ctx, x + r * 0.28, ey, Math.max(1.7, r * 0.14)); ctx.fill();
    };
    const list = [
      [0.06, 0.30, 30, 0, 0.5], [0.18, 0.24, 22, 1, 1.7], [0.30, 0.33, 34, 2, 2.9],
      [0.50, 0.22, 26, 1, 0.9], [0.66, 0.31, 32, 3, 3.6], [0.82, 0.25, 24, 0, 1.2],
      [0.93, 0.33, 30, 2, 2.1], [0.10, 0.88, 38, 2, 4.2], [0.87, 0.90, 34, 3, 0.3],
      [0.28, 0.94, 26, 1, 5.0], [0.64, 0.95, 28, 0, 3.1], [0.45, 0.28, 20, 3, 1.4]
    ];
    list.forEach(s => sil(s[0] * w, s[1] * h, s[2], s[3], s[4]));

    // 月光斜束
    ctx.save();
    const ray = ctx.createLinearGradient(w * 0.79, 0, w * 0.35, h);
    ray.addColorStop(0, "rgba(255,247,214,.10)");
    ray.addColorStop(1, "rgba(255,247,214,0)");
    ctx.fillStyle = ray;
    ctx.beginPath();
    ctx.moveTo(w * 0.79 - 40, -20);
    ctx.lineTo(w * 0.79 + 40, -20);
    ctx.lineTo(w * 0.30, h);
    ctx.lineTo(w * 0.12, h);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // 浮尘
    for (let i = 0; i < 34; i++) {
      const px = ((i * 137.5) % w) + Math.sin(t * 0.35 + i) * 26;
      const py = (h * 0.25 + ((i * 71.3) % (h * 0.7)) - t * 9) % (h * 0.72);
      const yy = h * 0.2 + py;
      const a = 0.10 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.1 + i * 0.7));
      ctx.fillStyle = "rgba(255,236,180," + a.toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(px, yy, 1.1 + (i % 3) * 0.5, 0, Math.PI * 2); ctx.fill();
    }

    // 主角聚光灯（脚下光圈）
    const cx2 = w * 0.5, cy2 = h * 0.60;
    const sp = ctx.createRadialGradient(cx2, cy2, 8, cx2, cy2, h * 0.4);
    sp.addColorStop(0, "rgba(255,240,190,.16)");
    sp.addColorStop(0.5, "rgba(255,240,190,.05)");
    sp.addColorStop(1, "rgba(255,240,190,0)");
    ctx.fillStyle = sp;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w * 0.3, h * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(242,185,61,.30)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, 96, 30, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([6, 10]);
    ctx.strokeStyle = "rgba(242,185,61,.16)";
    ctx.beginPath(); ctx.ellipse(cx2, cy2, 130, 42, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  },

  /* ============================================================
   * 幸运转盘（Canvas 手绘，指针在正上方）
   * size 为 CSS 像素尺寸；调用方需按 devicePixelRatio 放大位图
   * ============================================================ */
  /* 盘面（扇区 + 外圈，不含中心轴与指针）——预渲染到离屏画布 */
  drawWheelBase(ctx, prizes, size) {
    size = size || 330;
    const n = prizes.length;
    const secs = wheelSectors(prizes);            // 扇区按权重划分
    const cx = size / 2, cy = size / 2, R = size / 2 - 11;
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < n; i++) {
      const a0 = secs[i].a0, a1 = secs[i].a1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = prizes[i].color;
      ctx.fill();
      const g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
      g.addColorStop(0, "rgba(255,255,255,.5)");
      g.addColorStop(0.45, "rgba(255,255,255,.05)");
      g.addColorStop(1, "rgba(0,0,0,.12)");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.stroke();
      // 奖品名：扇区越窄字号越小，避免压到隔壁
      ctx.save();
      const mid = secs[i].mid;
      ctx.rotate(mid);
      const spanDeg = secs[i].span * 180 / Math.PI;
      const fs = Math.max(9, Math.min(R * 0.108, R * 0.108 * (spanDeg / 26)));
      ctx.font = "900 " + Math.round(fs) + 'px "Microsoft YaHei","PingFang SC",sans-serif';
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      const ty2 = fs * 0.05, px2 = R - 15;
      const flip = Math.cos(mid) < 0;
      if (flip) { ctx.rotate(Math.PI); ctx.textAlign = "left"; }
      else { ctx.textAlign = "right"; }
      const lx = flip ? -px2 : px2;
      ctx.lineWidth = Math.max(3, fs * 0.26); ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.strokeText(prizes[i].name, lx, ty2);
      ctx.fillStyle = "#3b2a08";
      ctx.fillText(prizes[i].name, lx, ty2);
      ctx.restore();
    }
    // 外圈
    ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 5;
    circle(ctx, 0, 0, R + 2); ctx.stroke();
    ctx.fillStyle = "#8d6e63";
    for (let i = 0; i < 12; i++) {   // 外圈灯珠
      const a = (i / 12) * Math.PI * 2;
      circle(ctx, Math.cos(a) * (R + 2), Math.sin(a) * (R + 2), R * 0.022); ctx.fill();
    }
    ctx.restore();
  },

  /* 中心轴 + 顶部指针（不随盘面旋转） */
  drawWheelOverlay(ctx, size) {
    size = size || 330;
    const cx = size / 2, cy = size / 2, R = size / 2 - 11;
    ctx.fillStyle = "#fff8e7"; ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 3;
    circle(ctx, cx, cy, R * 0.16); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#ffb300";
    circle(ctx, cx, cy, R * 0.085); ctx.fill();
    ctx.fillStyle = "#e08e00";
    circle(ctx, cx, cy, R * 0.035); ctx.fill();
    // 顶部指针（尖端朝下，指向盘面）
    ctx.fillStyle = "#e53935"; ctx.strokeStyle = "#b71c1c"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, R * 0.155);
    ctx.lineTo(cx - R * 0.088, R * 0.012);
    ctx.lineTo(cx + R * 0.088, R * 0.012);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff8e7"; circle(ctx, cx, R * 0.055, R * 0.024); ctx.fill();
  },

  /* ---------- 粒子 ---------- */
  drawParticle(ctx, p) {
    const k = p.life / p.max;
    ctx.globalAlpha = Math.max(0, k);
    ctx.fillStyle = p.color;
    if (p.shape === "square") {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    } else {
      circle(ctx, p.x, p.y, p.size * (0.4 + k * 0.6));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  /* ---------- 浮动文字（伤害数字等） ---------- */
  drawText(ctx, tx) {
    const k = tx.life / tx.max;
    ctx.globalAlpha = Math.min(1, k * 1.6);
    ctx.font = (tx.crit ? "900 21px " : "800 15px ") + '"Microsoft YaHei",sans-serif';
    ctx.textAlign = "center";
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = "rgba(0,0,0,.75)";
    const y = tx.y - (1 - k) * 42;
    ctx.strokeText(tx.txt, tx.x, y);
    ctx.fillStyle = tx.color;
    ctx.fillText(tx.txt, tx.x, y);
    ctx.globalAlpha = 1;
  }
};
