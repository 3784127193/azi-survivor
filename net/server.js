/**
 * azi-net — 阿紫幸存者实时联机中继服务器
 * 架构：host-authoritative（房主权威）
 *   · 服务器只做消息转发 + 房间生命周期管理，不跑任何游戏逻辑
 *   · host（房主客户端）跑完整战斗逻辑，每 ~100ms 广播世界快照
 *   · guest 发送自己的位置/输入，host 在自己本地驱动"影子玩家"
 *   · guest 对自己的角色做本地预测，对其他实体按快照插值渲染
 *
 * 消息协议（全部为 JSON，字段名压短）：
 *   C→S
 *     {t:'hi',   r:房码, role:'host'|'guest', k:身份key, n:昵称}
 *     {t:'snap', d:快照对象}            host → 服务器 → 所有 guest（原样转发，不解析）
 *     {t:'inp',  x,y,ax,ay,face,char}   guest → 服务器 → host
 *     {t:'hit',  id,d,c}                guest → 服务器 → host（房客命中，房主结算真实伤害）
 *     {t:'over', win, stats}            host 对局结束 → 所有 guest
 *     {t:'bye'}                         主动离开
 *     {t:'ping'}
 *   S→C
 *     {t:'welcome', role, peers:[{k,n,role}]}  加入成功，带回房间内其他人
 *     {t:'join',  k,n,role}         有人加入
 *     {t:'leave', k, reason}        有人离开（reason: bye|timeout|hostgone|kick）
 *     {t:'snap',  d}                host 快照（guest 收到）
 *     {t:'inp',   k, ...}           guest 输入（host 收到）
 *     {t:'hostgone'}                host 断线，房间解散
 *     {t:'over', win, stats}        host 对局结束（胜利/死亡）
 *     {t:'pong'}
 *     {t:'err', m}
 */

"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");
const { smtpSend } = require("./mailer");

const PORT = Number(process.env.PORT || 9090);
const MAX_ROOM = 6;            // 与游戏房间上限一致（2~6 人）
const MAX_MSG = 512 * 1024;     // 单条消息上限 512KB（快照较大）
const ROOM_TTL = 3 * 3600 * 1000;  // 房间最长存活 3 小时（与云端房间一致）
const IDLE_TIMEOUT = 90 * 1000;    // 90s 无任何消息判定掉线
const WS_PING = 25 * 1000;         // 服务端心跳间隔

/** @type {Map<string, {code, host: ws|null, guests: Map<key, ws>, born, lastAct}>} */
const rooms = new Map();
let connCount = 0;
const counters = { conns: 0, joins: 0, snapsIn: 0, snapsOut: 0, inpIn: 0, inpOut: 0, hitIn: 0, hitOut: 0, errs: 0 };

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- 房间操作 ---------------- */

function getRoom(code) {
  return rooms.get(code) || null;
}

function createRoom(code, hostWs) {
  const room = { code, host: hostWs, guests: new Map(), born: Date.now(), lastAct: Date.now() };
  rooms.set(code, room);
  log("room+", code, "rooms=", rooms.size);
  return room;
}

function destroyRoom(room, reason) {
  if (!room) return;
  rooms.delete(room.code);
  // 通知所有 guest
  for (const [k, ws] of room.guests) {
    send(ws, { t: "leave", k, reason: reason || "hostgone" });
    if (reason === "hostgone") send(ws, { t: "hostgone" });
  }
  room.guests.clear();
  room.host = null;
  log("room-", room.code, "reason=", reason || "hostgone", "rooms=", rooms.size);
}

function roomPeers(room, exceptWs) {
  const peers = [];
  if (room.host && room.host !== exceptWs) peers.push({ k: room.host.__key, n: room.host.__name, role: "host" });
  for (const [k, ws] of room.guests) {
    if (ws !== exceptWs) peers.push({ k, n: ws.__name, role: "guest" });
  }
  return peers;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    log("send error", e.message);
    return false;
  }
}
const send = safeSend;

/* ---------------- 连接处理 ---------------- */

/* ============================================================
 * 欢迎邮件 —— 注册成功后由前端触发
 *   · 模板固定，不接受任意主题/正文，降低被当垃圾邮件中转的风险
 *   · 三重限频：单 IP 3 次/小时、单收件地址 1 次/小时、全局 60 次/小时
 *   · 收件地址必须是合法邮箱；QQ 邮箱 SMTP（465 隐式 TLS）
 * ============================================================ */
const MAIL_USER = process.env.MAIL_USER || "";
const MAIL_PASS = process.env.MAIL_PASS || "";
const MAIL_ON = !!(MAIL_USER && MAIL_PASS);
const MAIL_OK_ORIGIN = (process.env.MAIL_ALLOW_ORIGIN ||
  "https://YOUR-APP.app.workbuddy.host").split(",").map(x => x.trim());

const mailHits = { ip: new Map(), to: new Map(), global: [] };
function rateHit(map, key, limit, winMs) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter(t => now - t < winMs);
  if (arr.length >= limit) { map.set(key, arr); return false; }
  arr.push(now); map.set(key, arr);
  if (map.size > 5000) map.clear();
  return true;
}
function mailGlobalOk(limit, winMs) {
  const now = Date.now();
  mailHits.global = mailHits.global.filter(t => now - t < winMs);
  if (mailHits.global.length >= limit) return false;
  mailHits.global.push(now);
  return true;
}
function clientIpOf(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || "?";
}
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let n = 0, chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
function welcomeText(name) {
  return [
    "你好，" + (name || "幸存者") + "：",
    "",
    "欢迎加入《阿紫幸存者》。你的账号已经创建成功，现在可以：",
    "",
    "  · 打完一局自动上传成绩，参与全球排行榜",
    "  · 在「选择模式 → 多人模式」和朋友开一个房间一起打",
    "  · 在设置里调整音效、画面与操作手感",
    "",
    "小提示：",
    "  · 排行榜每人只展示最好的一局；如果你不想露名字，可以在榜单下方勾选「隐藏我的名字」",
    "  · 未登录也能玩，只是成绩不会上榜",
    "",
    "祝你在末日里活得久一点。",
    "",
    "—— 阿紫幸存者 开发组",
    "（本邮件由系统自动发送，请勿直接回复）"
  ].join("\n");
}

async function handleWelcome(req, res, origin) {
  const allowOrigin = MAIL_OK_ORIGIN.indexOf(origin) >= 0 ? origin : "";
  const cors = {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
    "cache-control": "no-store"
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (!allowOrigin) { res.writeHead(403, { "content-type": "application/json" }); res.end('{"ok":false,"reason":"origin not allowed"}'); return; }
  if (req.method !== "POST") { res.writeHead(405, cors); res.end(); return; }
  if (!MAIL_ON) { res.writeHead(503, Object.assign({ "content-type": "application/json" }, cors)); res.end('{"ok":false,"reason":"mail not configured"}'); return; }

  const body = await readBody(req, 2048);
  const to = String((body && body.email) || "").trim().toLowerCase();
  const name = String((body && body.name) || "").slice(0, 12);
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{2,64}\.[a-z]{2,12}$/.test(to)) {
    res.writeHead(400, Object.assign({ "content-type": "application/json" }, cors));
    res.end('{"ok":false,"reason":"bad email"}');
    return;
  }
  const ip = clientIpOf(req);
  if (!rateHit(mailHits.ip, ip, 3, 3600e3) || !rateHit(mailHits.to, to, 1, 3600e3) || !mailGlobalOk(60, 3600e3)) {
    res.writeHead(429, Object.assign({ "content-type": "application/json" }, cors));
    res.end('{"ok":false,"reason":"rate limited"}');
    return;
  }

  try {
    await smtpSend({
      user: MAIL_USER, pass: MAIL_PASS, fromName: "阿紫幸存者",
      to, subject: "欢迎加入《阿紫幸存者》", text: welcomeText(name)
    });
    counters.welcomeMailed = (counters.welcomeMailed || 0) + 1;
    log("welcome mail ->", to.replace(/^(.).*(@.*)$/, "$1***$2"));
    res.writeHead(200, Object.assign({ "content-type": "application/json" }, cors));
    res.end('{"ok":true}');
  } catch (e) {
    log("welcome mail failed:", e.message);
    res.writeHead(502, Object.assign({ "content-type": "application/json" }, cors));
    res.end(JSON.stringify({ ok: false, reason: "send failed" }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url.indexOf("/api/welcome") === 0) {
    handleWelcome(req, res, String(req.headers.origin || ""));
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, conns: connCount, uptime: process.uptime() }));
    return;
  }
  if (req.url === "/stats") {
    const s = [];
    for (const [code, r] of rooms) {
      s.push({ code, host: r.host ? r.host.__key : null, guests: r.guests.size, age: Date.now() - r.born });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rooms: s, counters }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

wss.on("connection", (ws, req) => {
  ws.__key = "";
  ws.__name = "";
  ws.__role = "";
  ws.__room = null;
  ws.__lastSeen = Date.now();
  ws.__alive = true;
  connCount++;
  counters.conns++;
  log("conn+", req.socket.remoteAddress, "conns=", connCount);

  ws.on("pong", () => { ws.__alive = true; });

  ws.on("message", (raw, isBinary) => {
    ws.__lastSeen = Date.now();
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }  // 畸形消息直接丢弃
    if (!m || typeof m.t !== "string") return;

    try {
      switch (m.t) {

        case "hi": {
          if (ws.__room) return; // 已在房间，忽略重复 hi
          const code = String(m.r || "").trim();
          const role = m.role === "host" ? "host" : "guest";
          const key = String(m.k || "").slice(0, 64);
          const name = String(m.n || "").slice(0, 12) || "玩家";
          if (!/^[0-9]{6}$/.test(code)) return send(ws, { t: "err", m: "房码格式不正确" });
          if (!key) return send(ws, { t: "err", m: "缺少身份标识" });

          let room = getRoom(code);
          if (role === "host") {
            if (room && room.host && room.host !== ws && room.host.readyState === 1) {
              return send(ws, { t: "err", m: "该房间已有房主" });
            }
            if (!room) room = createRoom(code, ws);
            else { room.host = ws; room.lastAct = Date.now(); }
          } else {
            if (!room || !room.host || room.host.readyState !== 1) {
              return send(ws, { t: "err", m: "房间不存在或房主已离开" });
            }
            if (room.guests.size >= MAX_ROOM - 1 && !room.guests.has(key)) {
              return send(ws, { t: "err", m: "房间已满" });
            }
          }

          ws.__key = key; ws.__name = name; ws.__role = role; ws.__room = room.code;
          if (role === "guest") room.guests.set(key, ws);
          room.lastAct = Date.now();

          send(ws, { t: "welcome", role, peers: roomPeers(room, ws) });
          // 广播有人加入
          if (role === "host") {
            for (const [, g] of room.guests) send(g, { t: "join", k: key, n: name, role });
          } else {
            send(room.host, { t: "join", k: key, n: name, role });
            for (const [k2, g] of room.guests) if (k2 !== key) send(g, { t: "join", k: key, n: name, role });
          }
          log("join", code, role, key, "peers=", roomPeers(room, null).length);
          counters.joins++;
          return;
        }

        case "snap": {
          const room = getRoom(ws.__room || "");
          if (!room || ws.__role !== "host") return;
          if (m.d === undefined) return;
          counters.snapsIn++;
          const payload = JSON.stringify({ t: "snap", d: m.d });
          let out = 0;
          for (const [, g] of room.guests) {
            if (g.readyState === 1) { try { g.send(payload); out++; counters.snapsOut++; } catch (e) {} }
          }
          room.lastAct = Date.now();
          return;
        }

        case "inp": {
          const room = getRoom(ws.__room || "");
          if (!room || ws.__role !== "guest") return;
          if (!room.host || room.host.readyState !== 1) return;
          counters.inpIn++;
          send(room.host, {
            t: "inp", k: ws.__key,
            x: +m.x || 0, y: +m.y || 0,
            ax: +m.ax || 0, ay: +m.ay || 0,
            face: +m.face || 1,
            char: typeof m.char === "string" ? m.char.slice(0, 16) : undefined,
          });
          counters.inpOut++;
          room.lastAct = Date.now();
          return;
        }

        case "hit": {
          /* 房客上报的真实伤害 → 转给房主结算（房主权威）。
             k 由服务端注入，房客无法伪造他人身份。 */
          const room = getRoom(ws.__room || "");
          if (!room || ws.__role !== "guest") return;
          if (!room.host || room.host.readyState !== 1) return;
          counters.hitIn++;
          send(room.host, {
            t: "hit", k: ws.__key,
            id: (m.id | 0),
            d: Math.max(0, Math.min(99999, m.d | 0)),
            c: m.c ? 1 : 0,
          });
          counters.hitOut++;
          room.lastAct = Date.now();
          return;
        }

        case "over": {
          // host 对局结束（胜利或死亡）→ 广播给所有 guest
          const room = getRoom(ws.__room || "");
          if (!room || ws.__role !== "host") return;
          const payload = JSON.stringify({ t: "over", win: !!m.win, stats: m.stats || null });
          for (const [, g] of room.guests) {
            if (g.readyState === 1) { try { g.send(payload); } catch (e) {} }
          }
          log("over", room.code, "win=", !!m.win);
          return;
        }

        case "bye": {
          leaveRoom(ws, "bye");
          return;
        }

        case "ping": {
          send(ws, { t: "pong" });
          return;
        }

        default: return;
      }
    } catch (e) {
      log("handler error", e.message);
    }
  });

  ws.on("close", () => leaveRoom(ws, "closed"));
  ws.on("error", (e) => log("ws error", e.message));
});

function leaveRoom(ws, reason) {
  const code = ws.__room;
  const key = ws.__key;
  const role = ws.__role;
  if (!code) return;
  const room = getRoom(code);
  ws.__room = null; ws.__key = ""; ws.__role = "";
  if (!room) return;
  if (room.host === ws) {
    destroyRoom(room, "hostgone");
    return;
  }
  if (role === "guest" && room.guests.has(key)) room.guests.delete(key);
  if (room.host && room.host.readyState === 1) {
    send(room.host, { t: "leave", k: key, reason });
  }
  for (const [, g] of room.guests) send(g, { t: "leave", k: key, reason });
  log("leave", code, reason, "key=", key, "guests=", room.guests.size);
  // host 已不在则散房
  if (!room.host || room.host.readyState !== 1) destroyRoom(room, "hostgone");
}

/* ---------------- 心跳与清理 ---------------- */

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.__alive === false) { ws.terminate(); continue; }
    ws.__alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, WS_PING);

const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.__lastSeen > IDLE_TIMEOUT) {
      log("idle kick", ws.__key || ws.__room);
      ws.terminate();
    }
  }
  for (const [code, room] of rooms) {
    if (now - room.born > ROOM_TTL) destroyRoom(room, "expired");
  }
}, 15 * 1000);

wss.on("close", () => { clearInterval(pingTimer); clearInterval(idleTimer); });

server.listen(PORT, () => {
  log("azi-net listening on :" + PORT, "pid=" + process.pid);
});

process.on("uncaughtException", (e) => log("uncaughtException", e.message));
process.on("unhandledRejection", (e) => log("unhandledRejection", String(e)));
