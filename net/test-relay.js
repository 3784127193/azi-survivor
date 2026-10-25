/**
 * test-relay.js — 联机中继双端握手测试
 * 模拟 host + guest 两个客户端，验证：
 *   1. host 建房 / guest 加入 / 双向 join 通知
 *   2. guest 输入 → host 收到
 *   3. host 快照 → guest 收到
 *   4. 主动离开 → 对方收到 leave
 * 用法: node test-relay.js [wssURL] [roomCode]
 */

const WS_URL = process.argv[2] || "wss://YOUR-TUNNEL.trycloudflare.com";
const ROOM = process.argv[3] || "924362";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, extra) {
  if (cond) { console.log("  PASS", name, extra || ""); }
  else { failures++; console.log("  FAIL", name, extra || ""); }
}

class Client {
  constructor(role, key, name) {
    this.role = role; this.key = key; this.name = name;
    this.inbox = [];
    this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () => {
      this._res();
      this.ws.send(JSON.stringify({ t: "hi", r: ROOM, role, k: key, n: name }));
    };
    this.ws.onerror = (e) => this._rej(new Error("ws error " + (e && e.message)));
    this.ws.onmessage = (ev) => {
      try { this.inbox.push(JSON.parse(ev.data)); } catch (e) {}
    };
  }
  async send(obj) { await this.ready; this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch (e) {} }
  /** 等待满足条件的消息，超时返回 null */
  async waitFor(pred, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const found = this.inbox.find(pred);
      if (found) return found;
      await sleep(100);
    }
    return null;
  }
  clear() { this.inbox.length = 0; }
}

(async () => {
  console.log("== azi-net relay test ==");
  console.log("url:", WS_URL, "room:", ROOM);

  // 1. host 加入
  const host = new Client("host", "test-host-001", "房主");
  const hWelcome = await host.waitFor((m) => m.t === "welcome");
  check("host welcome", !!hWelcome, hWelcome ? "role=" + hWelcome.role : "timeout");
  if (!hWelcome) { console.log("FATAL: host 未接入"); process.exit(1); }
  check("host welcome.role", hWelcome.role === "host");

  // 2. guest 加入，host 应收到 join
  const guest = new Client("guest", "test-guest-001", " guest".trim());
  const gWelcome = await guest.waitFor((m) => m.t === "welcome");
  check("guest welcome", !!gWelcome);
  check("guest welcome.peers 含 host",
    !!(gWelcome && gWelcome.peers && gWelcome.peers.some((p) => p.role === "host")));
  const hJoin = await host.waitFor((m) => m.t === "join" && m.k === "test-guest-001");
  check("host 收到 guest join", !!hJoin);

  // 3. guest 输入 → host
  await guest.send({ t: "inp", x: 123, y: 456, ax: 0.5, ay: -0.5, face: -1 });
  const hInp = await host.waitFor((m) => m.t === "inp" && m.k === "test-guest-001");
  check("host 收到 guest 输入", !!hInp,
    hInp ? `x=${hInp.x} y=${hInp.y} ax=${hInp.ax} face=${hInp.face}` : "timeout");
  check("输入数值保真", !!hInp && hInp.x === 123 && hInp.y === 456 && hInp.face === -1);

  // 3.5 guest 上报命中 → host 结算（k 由服务端注入，房客伪造无效）
  await guest.send({ t: "hit", id: 7, d: 42, c: 1, k: "FORGED" });
  const hHit = await host.waitFor((m) => m.t === "hit" && m.id === 7);
  check("host 收到 guest 命中", !!hHit, hHit ? "id=" + hHit.id + " d=" + hHit.d + " k=" + hHit.k : "timeout");
  check("命中数值保真", !!hHit && hHit.id === 7 && hHit.d === 42 && hHit.c === 1);
  check("命中身份不可伪造", !!hHit && hHit.k === "test-guest-001", hHit ? "k=" + hHit.k : "");
  // 房主自己发 hit 应被忽略（不回流给 guest）
  guest.clear();
  await host.send({ t: "hit", id: 8, d: 999 });
  const leaked = await guest.waitFor((m) => m.t === "hit" && m.id === 8, 1200);
  check("host 发 hit 不被转发", !leaked);

  // 4. host 快照 → guest
  host.clear();
  const snapPayload = { t: "snap", d: { tick: 1, players: [{ k: "test-host-001", x: 10, y: 20, hp: 100 }], enemies: [{ id: 1, x: 100, y: 100, hp: 50 }] } };
  await host.send(snapPayload);
  const gSnap = await guest.waitFor((m) => m.t === "snap");
  check("guest 收到 host 快照", !!gSnap);
  check("快照内容保真",
    !!gSnap && gSnap.d && gSnap.d.players && gSnap.d.players[0] && gSnap.d.players[0].hp === 100 && gSnap.d.enemies[0].x === 100,
    gSnap ? "players=" + JSON.stringify(gSnap.d.players) : "");

  // 5. 房码校验：非法房码应被拒
  const bad = new Client("host", "bad-room-key", "X");
  await bad.send({ t: "hi", r: "ABC", role: "host", k: "bad-room-key", n: "X" });
  const badErr = await bad.waitFor((m) => m.t === "err", 6000);
  check("非法房码被拒绝", !!badErr, badErr ? badErr.m : "timeout");
  bad.close();

  // 6. guest 主动离开 → host 收到 leave
  await guest.send({ t: "bye" });
  const hLeave = await host.waitFor((m) => m.t === "leave" && m.k === "test-guest-001", 6000);
  check("host 收到 guest 离开", !!hLeave, hLeave ? "reason=" + hLeave.reason : "timeout");

  // 7. 快照频率压力：模拟 10Hz × 100 帧（≈游戏 10 秒）
  host.clear();
  const t0 = Date.now();
  let sent = 0;
  let received = 0;
  for (let i = 0; i < 100; i++) {
    const big = { t: "snap", d: { tick: i, enemies: Array.from({ length: 150 }, (_, j) => ({ id: j, x: j * 3, y: j * 2, hp: 30 })) } };
    await host.send(big);
    sent++;
    await sleep(100);
  }
  const guest2 = new Client("guest", "test-guest-002", "压测");
  await guest2.waitFor((m) => m.t === "welcome");
  let sent2 = 0;
  for (let i = 0; i < 100; i++) {
    await host.send({ t: "snap", d: { tick: 1000 + i, enemies: Array.from({ length: 150 }, (_, j) => ({ id: j, x: j, y: j, hp: 30 })) } });
    sent2++;
    await sleep(100);
  }
  await sleep(500);
  received = guest2.inbox.filter((m) => m.t === "snap").length;
  const dur = (Date.now() - t0) / 1000;
  console.log(`  INFO 快照压力: guest 离开前 ${sent} 帧(无人可收) + guest2 在线 ${sent2} 帧(150敌人/帧), guest2 实收 ${received} 帧, 用时 ${dur.toFixed(1)}s`);
  check("guest2 到达率 ≥ 95%", received >= Math.floor(sent2 * 0.95), `${received}/${sent2}`);

  host.close(); guest2.close();
  await sleep(500);

  // 8. 服务器计数器核对（区分网络层丢弃 vs 服务端问题）
  try {
    const st = await (await fetch(WS_URL.replace("wss://", "https://").replace("ws://", "http://") + "/stats")).json();
    console.log("  INFO 服务器计数器:", JSON.stringify(st.counters));
    check("服务器快照转发数 ≥ 客户端实收", st.counters.snapsOut >= received,
      `snapsOut=${st.counters.snapsOut} vs 客户端实收=${received}, 差 ${st.counters.snapsOut - received} 帧为网络层丢弃`);
  } catch (e) { console.log("  SKIP stats 拉取失败:", e.message); }

  console.log("== 结果:", failures === 0 ? "全部通过 ✓" : failures + " 项失败 ✗", "==");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
