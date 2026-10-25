/* ============================================================
 * net.js — 实时联机层（host-authoritative 架构）
 * ============================================================
 * 角色：
 *   host  房主。本地跑完整战斗逻辑，维护每个 guest 的"影子玩家"，
 *         每 snapHz 向服务器广播世界快照，服务器转发给所有 guest。
 *   guest 房客。本地预测自己的移动与攻击（保证操作零延迟），
 *         敌人/子弹/其他玩家/波次/自身血量以 host 快照为权威，
 *         每 inpHZ 向服务器发送输入，服务器转发给 host。
 *
 * 与服务器的消息协议见 azi-net/server.js 头部注释。
 *
 * 作用域说明（重要）：
 *   game.js 整体包在 IIFE 里，它的内部状态（G/player/enemies/keys/Room/…）
 *   对其它脚本不可见；而本文件在脚本作用域，game.js 反而能看到本文件的 Net。
 *   因此这里用"显式绑定"解决：game.js 加载末尾调用 Net.__bind(api)，
 *   把内部状态（含 getter/setter 与工具函数）注入进来，之后所有方法
 *   统一通过 this._A 访问。发布构建把各文件平铺拼接后同样依赖这个契约。
 *   data.js 顶层的 ENEMIES / CHARS / ELITE / waveHpMul 在脚本作用域，
 *   本文件可直接引用，无需绑定。
 * ============================================================ */

const Net = {
  cfg: {
    /* 联机中继地址。测试期为 cloudflared 快速隧道（重启会变），
       正式上线后换成固定域名 wss。localStorage 可热覆盖，便于调试。 */
    url: "wss://YOUR-TUNNEL.trycloudflare.com",
    /* 兜底地址：自有域名 + Let's Encrypt 证书（nginx 反代到本机 9090）。
       隧道失效或域名漂移时自动切到这里，保证还能联机。 */
    fallback: "wss://relay.example.com",
    activeUrl: "",
    /* 单个地址的握手超时：跨境隧道首包经常 10s 以上，别给太短 */
    connectTimeout: 13000,
    /* 两个地址都失败时，整体再重试几轮（跨境链路偶发握手失败很常见） */
    connectRounds: 3,
    snapHz: 10,   // host 快照频率（每秒帧数）
    inpHZ: 20,    // guest 输入发送频率
  },

  /* ---- 运行状态 ---- */
  mode: "solo",          // solo | host | guest
  ws: null,
  code: "",              // 房码
  key: "",               // 我的身份 key（与云端房间一致）
  name: "",
  ready: false,          // 已收到 welcome
  dead: false,           // 本局已结束（避免重复弹窗）

  peers: [],             // 房间内其他人 [{k,n,role}]
  remotes: [],           // guest 视角：其他玩家渲染对象
  shadows: new Map(),    // host 视角：影子玩家 Map<key, shadow>
  enemyMap: new Map(),   // guest 视角：id → enemy 对象
  tick: 0,

  snapAcc: 0, inpAcc: 0,
  lastAx: 0, lastAy: 0, lastFace: 1,

  stats: { sent: 0, recv: 0, snaps: 0, inps: 0, hitsSent: 0, hitsRecv: 0, guestKills: 0 },
  _hitWin: new Map(),    // host：每个 guest 的伤害上报速率窗口（防刷伤害）
  _rate: null,           // guest：自己上报命中的速率窗口
  onHostGone: null,      // guest: 房主消失回调
  onOver: null,          // guest: 对局结束回调

  /* ============================================================
   * 绑定：由 game.js 在加载末尾调用，注入 IIFE 内部状态
   * api = { G, Room, ARENA, keys, IS_MOBILE, touch,
   *         get player(), get/set enemies, get/set shots, get/set eshots,
   *         hurtEnemy, die, showToast, nearestEnemy, myKeyGuess }
   * ============================================================ */
  _A: null,
  __bind(api) {
    this._A = api || null;
    return this;
  },

  /* 内部统一取绑定对象；未绑定（net.js 被单独使用）时返回安全空值 */
  _api() { return this._A; },
  _toast(msg) { const A = this._A; if (A && A.showToast) A.showToast(msg); },

  /* 房间人数（含房主）→ 怪物血量倍率：2 人 ×2，3 人 ×3，4 人 ×4。
     房主侧刷怪时用；房客不刷怪，恒为 1。 */
  coopMul() {
    if (this.mode !== "host") return 1;
    let n = 1;
    for (const p of this.peers) if (p && p.role === "guest") n++;
    return Math.max(1, Math.min(4, n));
  },

  /* ============================================================
   * 连接管理
   * ============================================================ */
  connect(mode, code, key, name) {
    this.mode = mode; this.code = code; this.key = key; this.name = name || "";
    this.ready = false; this.dead = false;
    this.peers = []; this.remotes = []; this.shadows.clear(); this.enemyMap.clear();
    this.tick = 0; this.snapAcc = 0; this.inpAcc = 0;
    this.stats = { sent: 0, recv: 0, snaps: 0, inps: 0, hitsSent: 0, hitsRecv: 0, guestKills: 0 };
    this._hitWin.clear();
    this._rate = null;
    this.lastConnectErrors = [];

    /* 上次连成功过的地址排最前，避免每次都先撞坏掉的那条 */
    const order = [];
    const push = (u) => { if (u && order.indexOf(u) < 0) order.push(u); };
    let good = "";
    try { good = localStorage.getItem("azi_net_url_good") || ""; } catch (e) { }
    push(good);
    push(this.cfg.url);
    push(this.cfg.fallback);

    const rounds = Math.max(1, this.cfg.connectRounds | 0 || 3);
    const timeoutMs = Math.max(4000, this.cfg.connectTimeout | 0 || 13000);

    return new Promise((resolve, reject) => {
      let round = 0, idx = 0;
      const triedAll = () => round >= rounds;

      const attempt = () => {
        if (idx >= order.length) {
          idx = 0; round++;
          if (triedAll()) {
            const detail = this.lastConnectErrors.slice(-4).join("；");
            reject(new Error("联机服务器连接失败" + (detail ? "（" + detail + "）" : "")));
            return;
          }
        }
        const url = order[idx++];
        let settled = false, opened = false, ws;
        try { ws = new WebSocket(url); } catch (e) {
          this.lastConnectErrors.push("无法创建连接");
          attempt(); return;
        }
        this.ws = ws;

        const fail = (why) => {
          if (settled) return;
          settled = true;
          this.lastConnectErrors.push(why);
          try { ws.close(); } catch (e) { }
          attempt();
        };
        const done = (ok, val) => {
          if (settled) return;
          settled = true;
          if (ok) {
            this.cfg.activeUrl = url;
            try { localStorage.setItem("azi_net_url_good", url); } catch (e) { }
            resolve(val);
          } else {
            try { ws.close(); } catch (e) { }
            attempt();
          }
        };

        const timer = setTimeout(() => {
          fail(opened ? "服务器无响应" : "连接超时");
        }, timeoutMs);

        /* 只有"当前这条" socket 的事件才算数：切到下一个地址后，旧 socket
           稍后才触发的 close/error 必须忽略，否则会误判断线并触发重连，
           房间内会多出一个同名房客（实测导致 3 人、怪物血量 ×3）。 */
        const isCurrent = () => this.ws === ws;

        ws.onopen = () => {
          if (!isCurrent()) return;
          opened = true;
          this._send({ t: "hi", r: code, role: mode, k: key, n: name });
        };
        ws.onmessage = (ev) => {
          if (!isCurrent()) return;
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          this.stats.recv++;
          try { this._handle(m, done, timer); } catch (e) { console.warn("net handler", e); }
        };
        ws.onerror = () => { if (isCurrent()) fail("连接被拒绝"); };
        ws.onclose = () => {
          clearTimeout(timer);
          if (!isCurrent()) return;
          if (!settled) { fail(opened ? "握手后断开" : "连接被关闭"); return; }
          if (this.mode !== "solo") this._onClose();
        };
      };
      attempt();
    });
  },

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); this.stats.sent++; return true; }
    catch (e) { return false; }
  },

  _handle(m, done, timer) {
    switch (m.t) {
      case "welcome":
        clearTimeout(timer);
        this.ready = true;
        this.peers = m.peers || [];
        if (done) done(true, this.peers);
        return;
      case "err":
        clearTimeout(timer);
        if (done) done(false, new Error(m.m || "联机服务器拒绝了请求"));
        return;
      case "join":
        this.peers.push({ k: m.k, n: m.n, role: m.role });
        if (this.mode !== "solo" && m.k !== this.key) {
          this._toast((m.n || "玩家") + " 进入房间");
        }
        return;
      case "leave": {
        this.peers = this.peers.filter(p => p.k !== m.k);
        if (this.mode === "host") {
          this.shadows.delete(m.k);
          this._toast("有玩家离开房间");
        } else if (m.k !== this.key) {
          this._toast("有玩家离开房间");
        }
        return;
      }
      case "snap":
        if (this.mode === "guest") { this.stats.snaps++; this._applySnap(m.d); }
        return;
      case "inp":
        if (this.mode === "host") { this.stats.inps++; this._onInput(m); }
        return;
      case "hit":
        /* 房客上报的一次命中（真实伤害）→ 房主在自己权威的敌人身上结算 */
        if (this.mode === "host") this._onHit(m);
        return;
      case "over":
        if (this.mode === "guest" && this.onOver) this.onOver(m);
        return;
      case "hostgone":
        if (this.mode === "guest" && this.onHostGone) this.onHostGone();
        return;
      case "pong": return;
      default: return;
    }
  },

  _onClose() {
    if (this.mode === "solo") return;
    if (this.dead) return;
    /* guest 闪断自动重连；host 断线由服务器直接散房，无需重连 */
    if (this.mode === "guest") {
      this._toast("联机断开，正在重连…");
      setTimeout(() => {
        if (this.mode !== "guest" || this.dead) return;
        this.connect("guest", this.code, this.key, this.name)
          .then(() => this._toast("已重连"))
          .catch(() => {
            this._toast("重连失败，本局结束");
            if (this.onHostGone) this.onHostGone();
          });
      }, 2000);
    }
  },

  close() {
    this._send({ t: "bye" });
    this.mode = "solo";
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
  },

  /* ============================================================
   * host：影子玩家 + 快照广播
   * ============================================================ */
  _onInput(m) {
    let sh = this.shadows.get(m.k);
    if (!sh) {
      /* 首次收到某 guest 的输入 → 创建影子（charId 由 guest 选人时随输入带上） */
      const c = CHARS.find(c => c.id === m.char) || CHARS[0];
      sh = {
        k: m.k, name: m.k, charId: c.id, colors: c.colors, acc: c.acc, r: 14,
        x: m.x, y: m.y, hp: c.hp, maxHp: c.hp,
        ax: 0, ay: 0, face: 1, moving: false,
        atkCd: 0.3, hurtCd: 0, invuln: 0, dead: false,
        level: 1, xp: 0,
      };
      this.shadows.set(m.k, sh);
      this._toast((this.peers.find(p => p.k === m.k) || {}).n + " 已就绪");
    }
    /* 以输入位置做校正（带插值，避免瞬移感） */
    sh.x += (m.x - sh.x) * 0.5;
    sh.y += (m.y - sh.y) * 0.5;
    sh.ax = m.ax; sh.ay = m.ay; sh.face = m.face;
  },

  updateHost(dt) {
    const A = this._A; if (!A) return;
    const ARENA = A.ARENA, enemies = A.enemies;

    /* ---- 影子玩家：移动 + 自动攻击 + 承伤 ---- */
    for (const sh of this.shadows.values()) {
      if (sh.dead) continue;
      sh.invuln = Math.max(0, sh.invuln - dt);
      sh.hurtCd = Math.max(0, sh.hurtCd - dt);
      sh.moving = !!(sh.ax || sh.ay);
      if (sh.moving) {
        const l = Math.hypot(sh.ax, sh.ay) || 1;
        sh.x += (sh.ax / l) * 200 * dt;
        sh.y += (sh.ay / l) * 200 * dt;
      }
      sh.x = Math.max(ARENA.wall + sh.r, Math.min(ARENA.w - ARENA.wall - sh.r, sh.x));
      sh.y = Math.max(ARENA.wall + sh.r, Math.min(ARENA.h - ARENA.wall - sh.r, sh.y));
      /* 影子不再自带固定伤害自动攻击：房客的每一发子弹/每一刀都会
         通过 damageEnemy → {t:'hit'} 报到房主这里结算，伤害取决于
         房客自己的武器与升级，两人输出才是真实对等的。 */
      /* 敌人接触伤害 */
      if (sh.hurtCd <= 0) {
        for (const e of enemies) {
          if (e.dead) continue;
          if (Math.hypot(e.x - sh.x, e.y - sh.y) < e.size * 0.75 + sh.r * 0.8) {
            sh.hurtCd = 0.85;
            sh.invuln = 0.12;
            sh.hp -= e.dmg;
            if (sh.hp <= 0) { sh.hp = 0; sh.dead = true; this._toast("有玩家阵亡"); }
            break;
          }
        }
      }
    }

    /* ---- 快照广播 ---- */
    this.snapAcc += dt;
    const interval = 1 / this.cfg.snapHz;
    if (this.snapAcc >= interval) {
      this.snapAcc = 0;
      this._send({ t: "snap", d: this._buildSnap() });
    }
  },

  _buildSnap() {
    const A = this._A; if (!A) return null;
    const p = A.player;
    const players = [];
    if (p) players.push([this.key, Math.round(p.x), Math.round(p.y), Math.round(p.hp), p.charId, p.dead ? 1 : 0]);
    for (const sh of this.shadows.values()) {
      players.push([sh.k, Math.round(sh.x), Math.round(sh.y), Math.round(sh.hp), sh.charId, sh.dead ? 1 : 0]);
    }
    return {
      tick: ++this.tick,
      wave: A.G.wave,
      waveT: Math.round(A.G.waveTime * 10) / 10,
      me: {
        hp: Math.round(p ? p.hp : 0),
        maxHp: p ? p.maxHp : 0,
        kills: A.G.kills,     // 团队击杀（房客的伤害也在 host 侧结算，已含在内）
        mats: A.G.materials,
        dead: p ? p.dead : false,
      },
      n: this.coopMul(),                                   // 房间人数（= 怪物血量倍率）
      players,
      /* 第 7 位是 maxHp：房客要拿它画血条（含人数倍率），本地推算不准 */
      enemies: A.enemies.filter(e => !e.dead).map(e =>
        [e.id, Math.round(e.x), Math.round(e.y), Math.round(e.hp), e.type, e.elite ? 1 : 0, Math.round(e.maxHp || 0)]),
      shots: A.shots.map(s =>
        [Math.round(s.x), Math.round(s.y), Math.round((s.ang || 0) * 100) / 100, s.kind || "bullet"]),
      eshots: A.eshots.map(s =>
        [Math.round(s.x), Math.round(s.y), Math.round(s.vx), Math.round(s.vy)]),
    };
  },

  /* ============================================================
   * guest：输入发送 + 快照应用
   * ============================================================ */
  updateGuest(dt) {
    const A = this._A; if (!A) return;
    this.inpAcc += dt;
    if (this.inpAcc < 1 / this.cfg.inpHZ) return;
    this.inpAcc = 0;
    const p = A.player;
    if (!p) return;
    /* 输入向量与本地预测保持一致（复制 updatePlayer 的键盘/摇杆逻辑） */
    let mx = 0, my = 0;
    const keys = A.keys;
    if (keys["w"] || keys["arrowup"]) my -= 1;
    if (keys["s"] || keys["arrowdown"]) my += 1;
    if (keys["a"] || keys["arrowleft"]) mx -= 1;
    if (keys["d"] || keys["arrowright"]) mx += 1;
    if (A.IS_MOBILE && A.touch.active) {
      const tm = Math.hypot(A.touch.dx, A.touch.dy);
      if (tm > 0.18) { mx = A.touch.dx; my = A.touch.dy; }
    }
    this._send({
      t: "inp", x: Math.round(p.x), y: Math.round(p.y),
      ax: mx, ay: my, face: p.face || 1, char: p.charId,
    });
  },

  _applySnap(d) {
    const A = this._A; if (!A) return;
    if (!d) return;
    const p = A.player;
    if (!p) return;

    /* ---- 波次与全局 ---- */
    if (d.wave !== A.G.wave) {
      A.G.wave = d.wave;
      A.G.waveCleared = false;
      A.G.waveClearHold = 0.9;
    }
    A.G.waveTime = d.waveT;

    /* ---- 自身状态以 host 为权威 ---- */
    if (d.me) {
      p.maxHp = d.me.maxHp || p.maxHp;
      p.hp = Math.min(d.me.hp, p.maxHp);
      A.G.kills = d.me.kills;
      A.G.materials = d.me.mats;
      if (d.me.dead && !p.dead) A.die();
    }

    /* ---- 敌人：按 id 合并，快照里没有的即死亡 ---- */
    const seen = new Set();
    for (const arr of d.enemies || []) {
      const [id, x, y, hp, type, elite, mhp] = arr;
      seen.add(id);
      let e = this.enemyMap.get(id);
      if (!e) {
        const T = ENEMIES[type];
        if (!T) continue;
        const hpMul = waveHpMul(A.G.wave) * (d.n || 1);   // 含人数倍率，优先用快照给的 maxHp
        const base = mhp || Math.round(T.hp * hpMul * (elite ? ELITE.hpMul : 1));
        e = {
          id, type, x, y, tx: x, ty: y, vx: 0, vy: 0, kx: 0, ky: 0,
          hp, maxHp: base,
          size: T.size * (elite ? ELITE.sizeMul : 1),
          speed: T.speed, dmg: T.dmg, xp: T.xp, mat: T.mat,
          color: T.color, color2: T.color2, erratic: T.erratic, ranged: T.ranged,
          keepDist: T.keepDist, fireCd: T.fireCd || 0, shotSpeed: T.shotSpeed || 0, shotDmg: T.shotDmg || 0,
          fireT: 2, ph: Math.random() * 6, aim: 0, hitCd: 0, flash: 0,
          elite: !!elite, dead: false,
        };
        this.enemyMap.set(id, e);
        A.enemies.push(e);
      } else {
        e.tx = x; e.ty = y; e.hp = hp;
        if (Math.hypot(x - e.x, y - e.y) > 160) { e.x = x; e.y = y; }   // 瞬移（重生/传送）直接跟上
        if (mhp) e.maxHp = mhp;
        if (hp > 0) e.dead = false;   // 本地判死但房主说还活着 → 复活继续打
      }
    }
    /* 快照里没有的即已死：无条件清理（不能靠"长度恰好相等"来判断） */
    A.enemies = A.enemies.filter(e => seen.has(e.id));
    for (const id of [...this.enemyMap.keys()]) if (!seen.has(id)) this.enemyMap.delete(id);

    /* ---- 子弹与敌方弹幕：全量重建（数量少）
       但"自己刚打出来的子弹"要留着（没 net 标记的就是本地生成的），
       否则房客的弹道每 100ms 被清空一次，等于看不见自己开火 ---- */
    const mineShots = A.shots.filter(s => s && !s.net);
    A.shots = (d.shots || []).map(a => ({
      x: a[0], y: a[1], ang: a[2], kind: a[3], net: 1,
      vx: Math.cos(a[2]) * 520, vy: Math.sin(a[2]) * 520,
      spd: 520, dmg: 0, crit: false, life: 1, rot: 0,
    })).concat(mineShots);
    A.eshots = (d.eshots || []).map(a => ({
      x: a[0], y: a[1], vx: a[2], vy: a[3], dmg: 0, life: 3,
    }));

    /* ---- 其他玩家（含房主） ---- */
    this.remotes = (d.players || [])
      .filter(a => a[0] !== this.key)
      .map(a => {
        const c = CHARS.find(c => c.id === a[4]) || CHARS[0];
        return {
          k: a[0], x: a[1], y: a[2], hp: a[3], maxHp: c.hp,
          charId: c.id, colors: c.colors, acc: c.acc,
          aim: 0, moving: false, invuln: 0, dead: !!a[5], r: 14, scale: 1.25,
          /* drawPlayer 需要：weapons 空 + artShot=true → 走展示模式（不画手持武器，只画人+饰品） */
          weapons: [], items: [], artShot: true, level: 1, xp: 0,
        };
      });
  },

  /* ============================================================
   * guest：自己的子弹本地推进 + 命中上报（真实伤害交给 host 结算）
   * ============================================================ */
  updateGuestShots(dt) {
    const A = this._A; if (!A) return;
    if (!A.shots || !A.shots.length) return;
    let changed = false;
    for (const s of A.shots) {
      if (s.gone) continue;
      /* 房主（及其他房客）的子弹：只做本地插值，绝不结算伤害 */
      if (s.net) {
        s.x += (s.vx || 0) * dt; s.y += (s.vy || 0) * dt;
        if (s.x < 0 || s.y < 0 || s.x > A.ARENA.w || s.y > A.ARENA.h) s.gone = true;
        continue;
      }
      changed = true;
      s.life -= dt;
      if (s.kind === "missile") {           // 追踪弹朝最近敌人转向
        const tg = A.nearestEnemy(s.x, s.y, 320);
        if (tg) {
          const want = Math.atan2(tg.y - s.y, tg.x - s.x);
          let da = want - s.ang;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          s.ang += Math.max(-4 * dt, Math.min(4 * dt, da * 6 * dt));
          s.vx = Math.cos(s.ang) * s.spd; s.vy = Math.sin(s.ang) * s.spd;
        }
        s.rot = (s.rot || 0) + dt * 10;
      } else if (s.kind === "boomerang") {
        s.rot = (s.rot || 0) + dt * 16;
      }
      const px0 = s.x, py0 = s.y;
      s.x += s.vx * dt; s.y += s.vy * dt;
      /* 命中：扫掠检测（整段飞行轨迹都参与，避免高速穿透） */
      for (const e of A.enemies) {
        if (e.dead || e.hp <= 0) continue;
        if (!A.segCircleHit(px0, py0, s.x, s.y, e.x, e.y, e.size + 6)) continue;
        const dmg = Math.max(1, Math.min(99999, Math.round(s.dmg || 1)));
        if (s.kind === "boomerang") {
          if (s.hit && s.hit.includes(e.id)) continue;
          (s.hit = s.hit || []).push(e.id);
        } else {
          s.life = 0;
        }
        /* 本地先出观感（飘字/闪白/爆点/经验），血量最终仍以 host 快照为准；
           damageEnemy 内部同时把真实伤害上报房主结算 */
        A.damageEnemy(e, dmg, !!s.crit, s.ang, s.kind === "boomerang" ? 0 : 40);
        break;
      }
      if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > A.ARENA.w || s.y > A.ARENA.h) s.gone = true;
    }
    if (changed) A.shots = A.shots.filter(s => !s.gone);
  },

  /* guest：把敌人从上一帧位置插值到快照目标位置（10Hz 快照 → 60fps 平滑） */
  updateGuestWorld(dt) {
    const A = this._A; if (!A) return;
    const k = Math.min(1, dt * 14);
    for (const e of A.enemies) {
      if (e.tx === undefined) continue;
      e.x += (e.tx - e.x) * k;
      e.y += (e.ty - e.y) * k;
      e.flash = Math.max(0, (e.flash || 0) - dt);
    }
  },

  /* ============================================================
   * host：结算房客上报的命中（限速，防止房客刷伤害）
   * ============================================================ */
  /* guest：上报一次真实命中，由房主在自己的权威敌人身上结算。
     客户端也限速，避免网络抖动时瞬间堆消息；服务端另有一道闸。 */
  reportHit(id, dmg, crit) {
    if (this.mode !== "guest" || !this.ready) return;
    dmg = Math.round(dmg || 0);
    if (!id || dmg <= 0) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    let w = this._rate;
    if (!w || now - w.t > 1000) { w = this._rate = { t: now, n: 0 }; }
    if (++w.n > 150) return;
    this.stats.hitsSent++;
    this._send({ t: "hit", id: id | 0, d: Math.min(dmg, 99999), c: crit ? 1 : 0 });
  },

  _onHit(m) {
    const A = this._A; if (!A) return;
    const id = m.id | 0;
    let dmg = m.d | 0;
    if (!id || dmg <= 0) return;
    dmg = Math.min(dmg, 9999);
    const now = Date.now();
    let w = this._hitWin.get(m.k);
    if (!w || now - w.t > 1000) { w = { t: now, n: 0, d: 0 }; this._hitWin.set(m.k, w); }
    w.n++; w.d += dmg;
    if (w.n > 90 || w.d > 30000) return;          // 超速：丢弃（正常玩家远达不到）
    const e = A.enemies.find(x => x.id === id && !x.dead);
    if (!e) return;
    const wasAlive = e.hp > 0;
    this.stats.hitsRecv++;
    A.hurtEnemy(e, dmg, !!m.c, 0, 0);             // knock=0：击退效果房客本地演，host 不重复推
    if (wasAlive && e.hp <= 0) this.stats.guestKills++;
  },

  /* ============================================================
   * 生命周期钩子（由 game.js 调用）
   * ============================================================ */
  beginRun(mode) {
    /* mode: 'host' | 'guest' */
    const A = this._A; if (!A) return Promise.resolve(false);
    if (!A.Room.runCode) return Promise.resolve(false);
    const key = A.myKeyGuess();
    return this.connect(mode, A.Room.runCode, key, "")
      .then(() => true)
      .catch((e) => {
        /* 连不上（房间不存在/被拒/超时）：必须复位 mode，否则会卡在
           "没有连接的 guest" 状态——本地不模拟敌人，玩家干站着 */
        this.close();
        this._toast("联机服务器不可用：" + (e.message || "连接失败"));
        return false;
      });
  },

  endRun() {
    this.close();
    this.remotes = [];
    this.shadows.clear();
    this.enemyMap.clear();
    this.peers = [];
    this.dead = true;
  },

  broadcastOver(win) {
    if (this.mode !== "host") return;
    const A = this._A;
    this._send({ t: "over", win: !!win, stats: A ? { wave: A.G.wave, kills: A.G.kills } : null });
    this.dead = true;
  },
};

/* 允许通过 localStorage 热覆盖中继地址（调试用） */
try {
  const override = localStorage.getItem("azi_net_url");
  if (override) Net.cfg.url = override;
  const ov2 = localStorage.getItem("azi_net_url2");
  if (ov2) Net.cfg.fallback = ov2;
} catch (e) {}
