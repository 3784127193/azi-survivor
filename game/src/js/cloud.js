/* ============================================================
 * cloud.js — 云服务接入（全球排行榜 + 账号体系）
 * 云端环境：wbapp_REPLACE_WITH_YOUR_APP_ID__
 * 只用 publicConfig 里的三个公开值，不含任何密钥
 * ============================================================ */
"use strict";

const CLOUD_CFG = {
  endpoint: "https://YOUR-APP.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_REPLACE_WITH_YOUR_OWN_PUBLISHABLE_KEY_000000000000000"
};

/* 单例客户端：Auth / Database 共用 */
function cloudClient() {
  if (CloudLB.client) return CloudLB.client;
  const wbc = window.WorkBuddyCloud;
  if (!wbc || typeof wbc.createWorkBuddyCloud !== "function") return null;
  CloudLB.client = wbc.createWorkBuddyCloud({
    endpoint: CLOUD_CFG.endpoint,
    oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
    publishableKey: CLOUD_CFG.publishableKey
  });
  return CloudLB.client;
}

/* 云端用户对象 → 本地映射（含手机号，供"我的"页展示与校验） */
function mapUser(u) {
  if (!u) return null;
  return {
    id: u.id || "",
    name: u.name || u.email || u.phone || "幸存者",
    email: u.email || "",
    phone: u.phone || ""
  };
}

/* ---------- 设备指纹（用于"是否新设备"判断） ---------- */
const DEVICE_KEY = "azi_device_id";
function getDeviceId() {
  let id = "";
  try { id = localStorage.getItem(DEVICE_KEY) || ""; } catch (e) { }
  if (!id) {
    id = "d-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { }
  }
  return id;
}
/* ---------- 7 天自动登录 ---------- */
const AUTO_KEY = "azi_autologin_until";
function autoLoginUntil() { try { return +localStorage.getItem(AUTO_KEY) || 0; } catch (e) { return 0; } }
function setAutoLogin(days) {
  try {
    if (days > 0) localStorage.setItem(AUTO_KEY, String(Date.now() + days * 86400000));
    else localStorage.removeItem(AUTO_KEY);
  } catch (e) { }
}

const CloudLB = {
  client: null,
  lastError: "",
  lastUpload: "",
  pending: null,        // 待验证的邮箱验证码 { email, verificationId, isExistingUser }
  user: null,           // 当前登录用户 { name, email }

  init() { return cloudClient(); },

  /* ---- 登录标识（手机号/邮箱）持久化：会话里的 user 有时不带 phone，用于"我的"页显示 ---- */
  saveIdent(uid, patch) {
    if (!uid) return;
    try {
      const k = "azi_ident_" + uid;
      const cur = JSON.parse(localStorage.getItem(k) || "{}");
      localStorage.setItem(k, JSON.stringify(Object.assign(cur, patch)));
    } catch (e) { }
  },
  loadIdent(uid) {
    try { return JSON.parse(localStorage.getItem("azi_ident_" + uid) || "{}"); } catch (e) { return {}; }
  },
  _merge(u) {
    if (!u) return null;
    const i = this.loadIdent(u.id);
    if (!u.phone && i.phone) u.phone = i.phone;
    if (!u.email && i.email) u.email = i.email;
    return u;
  },

  /* ---- 账号档案（绑定的联系邮箱等，跨设备） ---- */
  async getProfile() {
    const c = cloudClient();
    if (!c) return null;
    try {
      const { data, error } = await c.database
        .from("account_profile").select("display_name, contact_email").maybeSingle();
      if (error) return null;
      return data || null;
    } catch (e) { return null; }
  },
  async saveProfile(patch) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    /* 先更新自己那一行（RLS 已限定 owner_id = auth.uid()，这里给个显式过滤条件） */
    const up = await c.database.from("account_profile")
      .update(patch).not("owner_id", "is", null)
      .select("display_name, contact_email");
    if (!up.error && up.data && up.data.length) return up.data[0];
    /* 没有行 → 首次插入（owner_id 由 DEFAULT auth.uid() 填充，客户端不传） */
    const ins = await c.database.from("account_profile")
      .insert(patch).select("display_name, contact_email");
    if (ins.error) throw ins.error;
    return ins.data && ins.data[0];
  },

  /* 这台设备在该账号下是否登录过（false = 新设备） */
  async checkDevice() {
    const c = cloudClient();
    if (!c) return { known: true };
    try {
      const { data, error } = await c.database.from("account_devices")
        .select("device_id").eq("device_id", getDeviceId()).maybeSingle();
      if (error) return { known: true };        // 查不到别误报成新设备
      return { known: !!data };
    } catch (e) { return { known: true }; }
  },
  async markDevice() {
    const c = cloudClient();
    if (!c) return;
    const dev = getDeviceId();
    try {
      const up = await c.database.from("account_devices")
        .update({ last_seen: new Date().toISOString() }).eq("device_id", dev).select("device_id");
      if (up.data && up.data.length) return;
      await c.database.from("account_devices").insert({ device_id: dev });
    } catch (e) { }
  },

  /* 从服务端拉最新用户（含 phone / email） */
  async refreshUser() {
    const c = cloudClient();
    if (!c) return this.user;
    try {
      const { data } = await c.auth.getUser();
      const u = this._merge(mapUser(data && (data.user || data)));
      if (u) this.user = u;
    } catch (e) { }
    return this.user;
  },

  /* ---------------- 排行榜（Database） ---------------- */
  async submit(rec) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.from("leaderboard").insert({
      player_name: String(rec.name || "幸存者").slice(0, 12),
      hero: rec.hero || null,
      wave: Math.max(0, Math.min(20, rec.wave | 0)),
      kills: Math.max(0, rec.kills | 0),
      mats: Math.max(0, rec.mats | 0),
      survive_sec: Math.max(0, rec.time | 0)
    }).select();
    if (error) throw error;
    this.lastUpload = "ok";
    return data && data[0];
  },

  async top(n) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database
      .from("leaderboard")
      .select("player_name, hero, wave, kills, survive_sec, created_at")
      .order("wave", { ascending: false })
      .order("kills", { ascending: false })
      .limit(n || 10);
    if (error) throw error;
    return data || [];
  },

  /* 排行榜（每人只保留最佳一局；includeAnon=false 时隐藏匿名/未登录的成绩）
   * 优先走服务端函数 leaderboard_top：去重 + 排序 + 匿名过滤一次算完，最多返回 100 行；
   * 服务端函数不可用时回退客户端去重（多拉一些原始行自己算），保证榜单不至于打不开。 */
  async topBest(n, includeAnon) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const lim = Math.max(1, Math.min(n || 20, 100));
    try {
      const { data, error } = await c.database.rpc("leaderboard_top", {
        p_limit: lim, p_include_anon: !!includeAnon
      });
      if (error) throw error;
      if (Array.isArray(data)) {
        return data.map(r => ({
          player_name: r.player_name, hero: r.hero,
          wave: r.wave | 0, kills: r.kills | 0, mats: r.mats | 0,
          survive_sec: r.survive_sec | 0,
          anonymous: !!r.anonymous, created_at: r.created_at
        }));
      }
    } catch (e) { /* 服务端函数不可用 → 客户端兜底 */ }
    return this.topBestLocal(lim, includeAnon);
  },

  /* 客户端兜底：拉原始记录后按「玩家」取最佳一局
   * 身份键：登录用户用 owner_id，匿名成绩按昵称归并（owner_id 为空） */
  async topBestLocal(n, includeAnon) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database
      .from("leaderboard")
      .select("player_name, hero, wave, kills, mats, survive_sec, owner_id, created_at")
      .order("wave", { ascending: false })
      .order("kills", { ascending: false })
      .limit(500);
    if (error) throw error;
    const seen = Object.create(null), out = [];
    for (const r of (data || [])) {
      const anon = !r.owner_id;
      if (anon && !includeAnon) continue;
      const key = anon
        ? "a:" + String(r.player_name || "").trim().toLowerCase()
        : "u:" + r.owner_id;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({
        player_name: r.player_name, hero: r.hero,
        wave: r.wave | 0, kills: r.kills | 0, mats: r.mats | 0,
        survive_sec: r.survive_sec | 0,
        anonymous: anon, created_at: r.created_at
      });
      if (out.length >= n) break;
    }
    return out;
  },

  /* ---------------- 反作弊：服务端校验 / 上报 / 状态 ---------------- */
  /* 成绩上传改为走服务端函数 submit_record：越界数据在数据库层直接拒绝 */
  async submitRecord(rec) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("submit_record", {
      p_name: String(rec.name || "幸存者").slice(0, 12),
      p_hero: String(rec.hero || "").slice(0, 12),
      p_wave: Math.max(0, Math.min(20, rec.wave | 0)),
      p_kills: Math.max(0, rec.kills | 0),
      p_mats: Math.max(0, rec.mats | 0),
      p_survive_sec: Math.max(0, rec.time | 0)
    });
    if (error) throw error;
    return data || { ok: false, reason: "服务端无响应" };
  },
  /* 上报异常行为；服务端去重 + 累计 3 次自动封禁上榜 */
  async reportCheat(reason, detail, wave) {
    const c = cloudClient();
    if (!c) return null;
    try {
      const { data, error } = await c.database.rpc("report_cheat", {
        p_reason: String(reason || "unknown").slice(0, 60),
        p_detail: String(detail || "").slice(0, 200),
        p_wave: Math.max(0, wave | 0),
        p_device: getDeviceId()          // 访客没有账号，用设备指纹识别
      });
      if (error) return null;
      return data || null;
    } catch (e) { return null; }
  },
  async cheatStatus() {
    const c = cloudClient();
    if (!c) return null;
    try {
      const { data, error } = await c.database.rpc("cheat_status", { p_device: getDeviceId() });
      if (error) return null;
      return data || null;
    } catch (e) { return null; }
  },
  /* 临时邮箱域名黑名单（云端可随时更新，无需重新发版） */
  async bannedDomains() {
    const c = cloudClient();
    if (!c) return [];
    try {
      const { data, error } = await c.database.from("banned_email_domains").select("domain");
      if (error) return [];
      return (data || []).map(r => String(r.domain || "").toLowerCase()).filter(Boolean);
    } catch (e) { return []; }
  },

  /* ---------------- 多人房间（服务端函数保证容量/房码/权限） ---------------- */
  async roomCreate(maxPlayers, name) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_create", {
      p_max: maxPlayers | 0, p_name: String(name || ""), p_device: getDeviceId()
    });
    if (error) throw error;
    return data || { ok: false, reason: "服务端无响应" };
  },
  async roomJoin(code, name) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_join", {
      p_code: String(code || "").trim(), p_name: String(name || ""), p_device: getDeviceId()
    });
    if (error) throw error;
    return data || { ok: false, reason: "服务端无响应" };
  },
  async roomState(code) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_poll", {
      p_code: String(code || ""), p_device: getDeviceId()
    });
    if (error) throw error;
    return data || { ok: false };
  },
  async roomSetReady(code, ready) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_ready", {
      p_code: String(code || ""), p_device: getDeviceId(), p_ready: !!ready
    });
    if (error) throw error;
    return data || { ok: false };
  },
  async roomStart(code) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_start", { p_code: code, p_device: getDeviceId() });
    if (error) throw error;
    return data || { ok: false };
  },
  async roomSubmit(code, wave, kills, mats, time) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_submit", {
      p_code: code, p_device: getDeviceId(),
      p_wave: wave | 0, p_kills: kills | 0, p_mats: mats | 0, p_time: time | 0
    });
    if (error) throw error;
    return data || { ok: false };
  },
  async roomLeave(code) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_leave", { p_code: code, p_device: getDeviceId() });
    if (error) throw error;
    return data || { ok: false };
  },
  async roomReset(code) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("room_reset", { p_code: code, p_device: getDeviceId() });
    if (error) throw error;
    return data || { ok: false };
  },

  /* ---------------- 管理员后台（全部走服务端函数校验） ---------------- */
  async adminLogin(user, pass) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc("admin_login", { p_user: user, p_pass: pass });
    if (error) throw error;
    return data || { ok: false, reason: "服务端无响应" };
  },
  async adminCall(fn, params) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database.rpc(fn, params || {});
    if (error) throw error;
    return data || { ok: false, reason: "服务端无响应" };
  },

  /* 本人的云端最佳战绩（服务端按 auth.uid() 过滤，只返回自己的行） */
  async myBest() {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.database
      .rpc("my_best_record")
      .select("wave, kills, mats, survive_sec, created_at")
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },

  /* ---------------- 账号（Auth） ---------------- */
  /* 发送验证码。target 二选一：{ email } 或 { phone } */
  async sendCode(target) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { data, error } = await c.auth.sendOtp(target);
    if (error) throw error;
    this.pending = {
      email: target.email || null,
      phone: target.phone || null,
      verificationId: data.verificationId,
      isExistingUser: !!data.isExistingUser
    };
    return this.pending;
  },

  /* 校验验证码；新用户注册时带上密码（isExistingUser 时不带，直接进登录态） */
  async verifyCode(target, code, password) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const p = this.pending;
    const sameTarget = p && ((target.email && p.email === target.email) || (target.phone && p.phone === target.phone));
    if (!sameTarget) throw new Error("请先获取验证码");
    const { data, error } = await c.auth.verifyOtp({
      email: p.email || undefined,
      phone: p.phone || undefined,
      verificationId: p.verificationId,
      isExistingUser: p.isExistingUser,
      token: code,
      password: p.isExistingUser ? undefined : (password || undefined)
    });
    if (error) throw error;
    this.pending = null;
    this.user = this._merge(mapUser(data && data.user));
    if (this.user && this.user.id) {
      if (target.phone) this.saveIdent(this.user.id, { phone: target.phone });
      if (target.email) this.saveIdent(this.user.id, { email: target.email });
    }
    return this.user;
  },

  /* 邮箱或手机 + 密码登录 */
  async login(id, password) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const cred = id.includes("@") ? { email: id, password } : { phone: id, password };
    const { data, error } = await c.auth.signInWithPassword(cred);
    if (error) throw error;
    this.user = this._merge(mapUser(data && data.user)) || { name: id, email: "", phone: "" };
    if (this.user && this.user.id) {
      this.saveIdent(this.user.id, id.includes("@") ? { email: id } : { phone: id });
    }
    return this.user;
  },

  /* 已登录状态下修改密码（需原密码；调用方负责先做手机号验证） */
  async changePassword(oldPassword, newPassword) {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { error } = await c.auth.resetPasswordForOld({ oldPassword, newPassword });
    if (error) throw error;
    return true;
  },

  async refreshSession() {
    const c = cloudClient();
    if (!c) return this.user;
    try { const { data } = await c.auth.refreshSession(); if (data && data.user) this.user = this._merge(mapUser(data.user)); }
    catch (e) { }
    return this.user;
  },

  async logout() {
    const c = cloudClient();
    if (!c) throw new Error("云服务 SDK 未加载");
    const { error } = await c.auth.signOut();
    if (error) throw error;
    this.user = null;
  },

  /* 恢复登录态（进页面时调用） */
  async restore() {
    const c = cloudClient();
    if (!c) return null;
    try {
      const { data } = await c.auth.getSession();
      if (data && data.user) {
        this.user = this._merge(mapUser(data.user));
      }
    } catch (e) { /* 未登录或会话失效，忽略 */ }
    return this.user;
  }
};

/* ---------- 玩家昵称（注册时填的用户名优先，其次账号名，最后随机） ---------- */
function playerName() {
  let n = "";
  try { n = localStorage.getItem("azi_name") || ""; } catch (e) { }
  if (n) return n.slice(0, 12);                       // 注册或手动设置过的用户名
  if (CloudLB.user && CloudLB.user.name) return String(CloudLB.user.name).slice(0, 12);
  return "幸存者" + (Math.floor(Math.random() * 9000) + 1000);   // 未设置时不写入本机
}
function setPlayerName(n) {
  const v = String(n || "").trim().slice(0, 12);
  if (!v) return false;
  try { localStorage.setItem("azi_name", v); } catch (e) { }
  return true;
}
