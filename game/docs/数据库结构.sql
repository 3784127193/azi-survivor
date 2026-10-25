-- ============================================================================
--  阿紫幸存者 · 云端数据库结构（v1.13.0）
-- ----------------------------------------------------------------------------
--  平台：腾讯云 CloudBase PostgreSQL（通过 PostgREST 暴露为 /rest/v1）
--  说明：
--   1. 所有业务逻辑都写在服务端函数里（SECURITY DEFINER），前端只调 RPC。
--   2. 访问控制表（admin_*/cheat_flags/banned_*/rooms/room_members）一律
--      开启 RLS 且【不建任何策略】→ 客户端无法直接读写，只能经函数访问。
--   3. 本文档为建库时的定义；线上以数据库为准，文末附核对查询。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- 提供 digest() / gen_random_bytes()


-- ============================================================================
--  一、公共辅助函数
-- ============================================================================

-- 取登录用户 ID，并把访客统一折叠成 NULL。
-- 【重要】访客的 auth.uid() 不是 NULL，而是共享字符串 'anon'，
-- 若直接使用会导致所有访客共用一个身份（误封全体游客），必须经此函数。
CREATE OR REPLACE FUNCTION _uid() RETURNS TEXT
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT CASE WHEN u IS NULL OR u = 'anon' OR u = '' THEN NULL ELSE u END
  FROM (SELECT auth.uid() AS u) s
$fn$;

-- 取客户端 IP（仅用于取证，不参与封禁决策）。
-- 注意：平台网关会替换真实客户端 IP，连续请求返回的可能是不同的出口 IP。
CREATE OR REPLACE FUNCTION _client_ip() RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE h JSON; v TEXT;
BEGIN
  BEGIN h := current_setting('request.headers', true)::json;
  EXCEPTION WHEN others THEN RETURN NULL; END;
  IF h IS NULL THEN RETURN NULL; END IF;
  v := coalesce(h->>'x-real-ip', split_part(coalesce(h->>'x-forwarded-for',''), ',', 1));
  v := trim(both from coalesce(v,''));
  IF v = '' THEN RETURN NULL; END IF;
  RETURN left(v, 45);
END $fn$;


-- ============================================================================
--  二、业务表
-- ============================================================================

-- 排行榜：每局结束由 submit_record() 写入
CREATE TABLE IF NOT EXISTS leaderboard (
  id          BIGINT NOT NULL DEFAULT nextval('leaderboard_id_seq'),
  player_name TEXT    NOT NULL,
  hero        TEXT,
  wave        INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  mats        INTEGER NOT NULL,
  survive_sec INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_id    TEXT,
  PRIMARY KEY (id)
);

-- 账号档案（昵称 / 联系邮箱）
CREATE TABLE IF NOT EXISTS account_profile (
  owner_id      TEXT PRIMARY KEY,
  display_name  TEXT,
  contact_email TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 登录设备登记（"新设备登录"识别用）
CREATE TABLE IF NOT EXISTS account_devices (
  owner_id   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (owner_id, device_id)
);

-- 临时邮箱域名黑名单（玩家端注册/发码前校验；后台可增删，即时生效）
CREATE TABLE IF NOT EXISTS banned_email_domains (
  domain TEXT PRIMARY KEY,
  note   TEXT
);

-- 异常行为记录：owner_id 为空 = 访客（按 device_id 追责）
--   登录用户累计 3 次 → 封账号；访客累计 3 次 → 写 banned_devices
CREATE TABLE IF NOT EXISTS cheat_flags (
  owner_id   TEXT,
  reason     TEXT NOT NULL,
  detail     TEXT,
  wave       INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  banned     BOOLEAN DEFAULT false,
  ip         TEXT,
  device_id  TEXT
);

-- 被封禁的访客设备
CREATE TABLE IF NOT EXISTS banned_devices (
  device_id  TEXT PRIMARY KEY,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 管理员账号（只存 sha256(username:password)，明文永不入库）
CREATE TABLE IF NOT EXISTS admin_accounts (
  username   TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);

-- 管理员登录态（2 小时临时令牌）
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 管理员登录失败记录（60 秒内 6 次即锁定，无限流以外的手段）
CREATE TABLE IF NOT EXISTS admin_fails (
  id         BIGSERIAL PRIMARY KEY,
  username   TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 多人房间（房码 6 位数字，唯一；3 小时前的旧房会被自动清理）
CREATE TABLE IF NOT EXISTS rooms (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  host_key    TEXT NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 4,
  status      TEXT NOT NULL DEFAULT 'waiting',   -- waiting | playing
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 房间成员：member_key = 登录用户 ID，或访客的设备 ID
CREATE TABLE IF NOT EXISTS room_members (
  room_id     BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_key  TEXT NOT NULL,
  name        TEXT,
  ready       BOOLEAN DEFAULT false,
  wave        INTEGER DEFAULT 0,
  kills       INTEGER DEFAULT 0,
  mats        INTEGER DEFAULT 0,
  survive_sec INTEGER DEFAULT 0,
  done        BOOLEAN DEFAULT false,
  joined_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (room_id, member_key)
);


-- ============================================================================
--  三、行级安全（RLS）
-- ============================================================================

ALTER TABLE leaderboard          ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_profile      ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_devices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheat_flags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_fails          ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members         ENABLE ROW LEVEL SECURITY;

-- 公开可读：排行榜、临时邮箱名单（游戏需要）
CREATE POLICY leaderboard_read_all   ON leaderboard          FOR SELECT USING (true);
CREATE POLICY leaderboard_insert_any ON leaderboard          FOR INSERT WITH CHECK (true);
CREATE POLICY banned_domains_select  ON banned_email_domains FOR SELECT USING (true);

-- 仅本人可见/可写：档案、设备、异常记录
CREATE POLICY account_profile_select ON account_profile FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY account_profile_insert ON account_profile FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY account_profile_update ON account_profile FOR UPDATE USING (owner_id = auth.uid());
CREATE POLICY account_devices_select ON account_devices FOR SELECT USING (owner_id = auth.uid());
CREATE POLICY account_devices_insert ON account_devices FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY account_devices_update ON account_devices FOR UPDATE USING (owner_id = auth.uid());
CREATE POLICY cheat_flags_select     ON cheat_flags     FOR SELECT USING (owner_id = auth.uid());

-- 以下表【故意不建策略】→ 客户端完全无法直读，只能走服务端函数：
--   admin_accounts / admin_sessions / admin_fails / banned_devices / rooms / room_members

GRANT SELECT ON banned_email_domains TO anon;
GRANT SELECT ON banned_email_domains TO authenticated;


-- ============================================================================
--  四、成绩提交（服务端校验）
-- ============================================================================

-- 客户端先出画面，结算时把成绩交这里复核；越界一律拒绝并返回原因。
-- 校验项：未登录 / 已封禁 / 昵称长度 / 波次 1~20 / 击杀 ≤20000 /
--         材料 ≤200000 / 时长 ≤3600 / 每秒击杀 ≤25 / 每秒材料 ≤400
CREATE OR REPLACE FUNCTION submit_record(
  p_name TEXT, p_hero TEXT, p_wave INT, p_kills INT, p_mats INT, p_survive_sec INT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_uid TEXT := _uid();
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF EXISTS (SELECT 1 FROM cheat_flags WHERE owner_id = v_uid AND banned) THEN
    RETURN json_build_object('ok', false, 'reason', '账号因异常行为被限制上榜');
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 OR length(p_name) > 12 THEN
    RETURN json_build_object('ok', false, 'reason', '昵称不合法');
  END IF;
  IF p_wave < 1 OR p_wave > 20 THEN RETURN json_build_object('ok', false, 'reason', '波次数据异常'); END IF;
  IF p_kills < 0 OR p_kills > 20000 THEN RETURN json_build_object('ok', false, 'reason', '击杀数据异常'); END IF;
  IF p_mats < 0 OR p_mats > 200000 THEN RETURN json_build_object('ok', false, 'reason', '材料数据异常'); END IF;
  IF p_survive_sec < 0 OR p_survive_sec > 3600 THEN RETURN json_build_object('ok', false, 'reason', '时长数据异常'); END IF;
  IF p_survive_sec > 0 THEN
    IF p_kills::numeric / p_survive_sec > 25 THEN RETURN json_build_object('ok', false, 'reason', '击杀速率异常'); END IF;
    IF p_mats::numeric / p_survive_sec > 400 THEN RETURN json_build_object('ok', false, 'reason', '材料速率异常'); END IF;
  END IF;
  INSERT INTO leaderboard (player_name, hero, wave, kills, mats, survive_sec, owner_id)
  VALUES (left(trim(p_name),12), left(coalesce(p_hero,''),12), p_wave, p_kills, p_mats, p_survive_sec, v_uid);
  RETURN json_build_object('ok', true);
END $fn$;

-- 本人的云端最佳战绩
CREATE OR REPLACE FUNCTION my_best_record()
RETURNS TABLE (wave INT, kills INT, mats INT, survive_sec INT, created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT l.wave, l.kills, l.mats, l.survive_sec, l.created_at
  FROM leaderboard l
  WHERE l.owner_id = _uid()
  ORDER BY l.wave DESC, l.kills DESC
  LIMIT 1
$fn$;

-- 排行榜（每人只保留最佳一局；匿名/未登录成绩默认隐藏）
--   · 身份键：登录用户按 owner_id，匿名成绩按昵称归并
--   · 排序：波次 > 击杀 > 材料 > 存活时长 > 先达成
--   · p_include_anon=false 时过滤掉 owner_id 为空的行（匿名玩家）
--   · 输出不含 owner_id，避免把账号 ID 暴露给所有人
CREATE OR REPLACE FUNCTION leaderboard_top(p_limit INT DEFAULT 20, p_include_anon BOOLEAN DEFAULT false)
RETURNS TABLE (player_name TEXT, hero TEXT, wave INT, kills INT, mats INT,
               survive_sec INT, anonymous BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER AS $fn$
  WITH ranked AS (
    SELECT l.*,
           row_number() OVER (
             PARTITION BY COALESCE(l.owner_id, 'anon:' || lower(trim(l.player_name)))
             ORDER BY l.wave DESC, l.kills DESC, l.mats DESC, l.survive_sec DESC, l.created_at ASC
           ) AS rn
    FROM leaderboard l
  )
  SELECT r.player_name, r.hero, r.wave, r.kills, r.mats, r.survive_sec,
         (r.owner_id IS NULL) AS anonymous, r.created_at
  FROM ranked r
  WHERE r.rn = 1
    AND (COALESCE(p_include_anon, false) OR r.owner_id IS NOT NULL)
  ORDER BY r.wave DESC, r.kills DESC, r.mats DESC, r.survive_sec DESC, r.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
$fn$;


-- ============================================================================
--  五、反作弊
-- ============================================================================

-- 客户端上报异常；同原因 10 秒内去重。
-- 登录用户：按 owner_id 累计，≥3 次封账号
-- 访客    ：按 device_id 累计，≥3 次写入 banned_devices
CREATE OR REPLACE FUNCTION report_cheat(
  p_reason TEXT, p_detail TEXT, p_wave INT, p_device TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_uid TEXT := _uid(); v_ip TEXT := _client_ip();
  v_dev TEXT := left(trim(coalesce(p_device,'')), 64);
  v_cnt INT := 0; v_banned BOOLEAN := false; v_devban BOOLEAN := false;
BEGIN
  IF v_dev = '' THEN v_dev := NULL; END IF;
  IF v_dev IS NOT NULL THEN
    SELECT true INTO v_devban FROM banned_devices WHERE device_id = v_dev;
  END IF;
  IF coalesce(v_devban,false) THEN
    RETURN json_build_object('ok', true, 'flags', 0, 'banned', true, 'reason', 'device_banned', 'device', v_dev);
  END IF;
  IF v_uid IS NULL AND v_dev IS NULL THEN
    RETURN json_build_object('ok', false, 'reason', '无法识别来源');
  END IF;
  IF EXISTS (
    SELECT 1 FROM cheat_flags
    WHERE coalesce(owner_id,'') = coalesce(v_uid,'')
      AND coalesce(device_id,'') = coalesce(v_dev,'')
      AND reason = left(coalesce(p_reason,'unknown'),60)
      AND created_at > now() - interval '10 seconds'
  ) THEN
    RETURN json_build_object('ok', true, 'duplicate', true, 'banned', false);
  END IF;
  INSERT INTO cheat_flags (owner_id, reason, detail, wave, ip, device_id)
  VALUES (v_uid, left(coalesce(p_reason,'unknown'),60), left(coalesce(p_detail,''),200),
          greatest(0, coalesce(p_wave,0)), v_ip, v_dev);
  IF v_uid IS NOT NULL THEN
    SELECT count(*), coalesce(bool_or(banned), false) INTO v_cnt, v_banned
    FROM cheat_flags WHERE owner_id = v_uid;
    IF v_cnt >= 3 THEN
      UPDATE cheat_flags SET banned = true WHERE owner_id = v_uid;
      RETURN json_build_object('ok', true, 'flags', v_cnt, 'banned', true);
    END IF;
    RETURN json_build_object('ok', true, 'flags', v_cnt, 'banned', coalesce(v_banned,false));
  ELSE
    SELECT count(*) INTO v_cnt FROM cheat_flags WHERE owner_id IS NULL AND device_id = v_dev;
    IF v_cnt >= 3 THEN
      INSERT INTO banned_devices (device_id, note) VALUES (v_dev, '访客连续异常自动封禁')
      ON CONFLICT (device_id) DO NOTHING;
      RETURN json_build_object('ok', true, 'flags', v_cnt, 'banned', true, 'device', v_dev);
    END IF;
    RETURN json_build_object('ok', true, 'flags', v_cnt, 'banned', false, 'device', v_dev);
  END IF;
END $fn$;

-- 查询自己是否被封（账号维度 + 设备维度）。开局调用，决定是否挂"有作弊者"横条。
CREATE OR REPLACE FUNCTION cheat_status(p_device TEXT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_uid TEXT := _uid(); v_dev TEXT := left(trim(coalesce(p_device,'')), 64);
  v_cnt INT := 0; v_banned BOOLEAN := false; v_devban BOOLEAN := false;
BEGIN
  IF v_dev = '' THEN v_dev := NULL; END IF;
  IF v_uid IS NOT NULL THEN
    SELECT count(*), coalesce(bool_or(banned), false) INTO v_cnt, v_banned
    FROM cheat_flags WHERE owner_id = v_uid;
  ELSIF v_dev IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM cheat_flags WHERE owner_id IS NULL AND device_id = v_dev;
  END IF;
  IF v_dev IS NOT NULL THEN
    SELECT true INTO v_devban FROM banned_devices WHERE device_id = v_dev;
  END IF;
  RETURN json_build_object('ok', true, 'guest', (v_uid IS NULL), 'flags', coalesce(v_cnt,0),
    'banned', (coalesce(v_banned,false) OR coalesce(v_devban,false)),
    'device_banned', coalesce(v_devban,false), 'device', v_dev);
END $fn$;


-- ============================================================================
--  六、管理员后台
--  鉴权：admin_login 校验账号密码 → 发 2 小时令牌；其余函数都要带 p_token
-- ============================================================================

CREATE OR REPLACE FUNCTION _admin_ok(p_token TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_user TEXT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 10 THEN RETURN NULL; END IF;
  SELECT username INTO v_user FROM admin_sessions
  WHERE token = p_token AND expires_at > now();
  RETURN v_user;
END $fn$;

-- 登录：60 秒内失败 6 次锁定；成功发 24 字节随机令牌
CREATE OR REPLACE FUNCTION admin_login(p_user TEXT, p_pass TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_hash TEXT; v_tok TEXT; v_fails INT; v_exp TIMESTAMPTZ;
BEGIN
  IF coalesce(p_user,'') = '' OR coalesce(p_pass,'') = '' THEN
    RETURN json_build_object('ok', false, 'reason', '请输入用户名和密码');
  END IF;
  SELECT count(*) INTO v_fails FROM admin_fails WHERE created_at > now() - interval '60 seconds';
  IF v_fails >= 6 THEN
    RETURN json_build_object('ok', false, 'reason', '尝试过于频繁，请 1 分钟后再试');
  END IF;
  SELECT pass_hash INTO v_hash FROM admin_accounts WHERE username = p_user;
  IF v_hash IS NULL OR v_hash <> encode(digest(p_user || ':' || p_pass, 'sha256'), 'hex') THEN
    INSERT INTO admin_fails (username) VALUES (left(p_user, 40));
    RETURN json_build_object('ok', false, 'reason', '用户名或密码错误');
  END IF;
  v_tok := encode(gen_random_bytes(24), 'hex');
  v_exp := now() + interval '2 hours';
  INSERT INTO admin_sessions (token, username, expires_at) VALUES (v_tok, p_user, v_exp);
  UPDATE admin_accounts SET last_login = now() WHERE username = p_user;
  DELETE FROM admin_sessions WHERE expires_at < now() - interval '1 day';
  RETURN json_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp);
END $fn$;

CREATE OR REPLACE FUNCTION admin_logout(p_token TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  DELETE FROM admin_sessions WHERE token = p_token;
  RETURN json_build_object('ok', true);
END $fn$;

-- 概览统计
CREATE OR REPLACE FUNCTION admin_overview(p_token TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token);
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  RETURN json_build_object('ok', true, 'user', u,
    'records',  (SELECT count(*) FROM leaderboard),
    'profiles', (SELECT count(*) FROM account_profile),
    'devices',  (SELECT count(*) FROM account_devices),
    'flags',    (SELECT count(*) FROM cheat_flags),
    'banned',   (SELECT count(DISTINCT owner_id) FROM cheat_flags WHERE banned),
    'devbans',  (SELECT count(*) FROM banned_devices),
    'domains',  (SELECT count(*) FROM banned_email_domains),
    'sessions', (SELECT count(*) FROM admin_sessions WHERE expires_at > now()));
END $fn$;

-- 战绩列表 / 删除
CREATE OR REPLACE FUNCTION admin_records(p_token TEXT, p_limit INT DEFAULT 100) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v JSON;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  SELECT coalesce(json_agg(t), '[]'::json) INTO v FROM (
    SELECT id, player_name, hero, wave, kills, mats, survive_sec, owner_id, created_at
    FROM leaderboard ORDER BY created_at DESC
    LIMIT greatest(1, least(coalesce(p_limit,100), 500))
  ) t;
  RETURN json_build_object('ok', true, 'rows', v);
END $fn$;

CREATE OR REPLACE FUNCTION admin_del_record(p_token TEXT, p_id BIGINT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); n INT;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  DELETE FROM leaderboard WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted', n);
END $fn$;

-- 异常记录列表（含设备封禁状态）
CREATE OR REPLACE FUNCTION admin_flags(p_token TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v JSON;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  SELECT coalesce(json_agg(t), '[]'::json) INTO v FROM (
    SELECT owner_id, reason, detail, wave, banned, ip, device_id, created_at,
           (device_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM banned_devices bd WHERE bd.device_id = cheat_flags.device_id
           )) AS device_banned
    FROM cheat_flags ORDER BY created_at DESC LIMIT 300
  ) t;
  RETURN json_build_object('ok', true, 'rows', v);
END $fn$;

-- 封禁 / 解封【账号】（必须拒绝 anon，否则会封掉全体游客）
CREATE OR REPLACE FUNCTION admin_ban(p_token TEXT, p_owner TEXT, p_banned BOOLEAN) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v_exists INT;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  IF coalesce(p_owner,'') IN ('', 'anon') THEN
    RETURN json_build_object('ok', false, 'reason', '匿名为公共身份，请改用设备封禁');
  END IF;
  SELECT count(*) INTO v_exists FROM cheat_flags WHERE owner_id = p_owner;
  IF v_exists = 0 THEN
    INSERT INTO cheat_flags (owner_id, reason, detail, wave, banned)
    VALUES (p_owner, 'manual',
            CASE WHEN p_banned THEN '管理员手动封禁' ELSE '管理员手动解封' END, 0, p_banned);
  ELSE
    UPDATE cheat_flags SET banned = p_banned WHERE owner_id = p_owner;
  END IF;
  RETURN json_build_object('ok', true, 'banned', p_banned);
END $fn$;

-- 封禁 / 解封【访客设备】
CREATE OR REPLACE FUNCTION admin_ban_device(p_token TEXT, p_device TEXT, p_banned BOOLEAN) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v TEXT := left(trim(coalesce(p_device,'')), 64);
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  IF v = '' THEN RETURN json_build_object('ok', false, 'reason', '缺少设备ID'); END IF;
  IF p_banned THEN
    INSERT INTO banned_devices (device_id, note) VALUES (v, '管理员手动封禁')
    ON CONFLICT (device_id) DO NOTHING;
  ELSE
    DELETE FROM banned_devices WHERE device_id = v;
  END IF;
  RETURN json_build_object('ok', true, 'device', v, 'banned', p_banned);
END $fn$;

CREATE OR REPLACE FUNCTION admin_banned_devices(p_token TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v JSON;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  SELECT coalesce(json_agg(t), '[]'::json) INTO v FROM (
    SELECT device_id, note, created_at FROM banned_devices ORDER BY created_at DESC LIMIT 300
  ) t;
  RETURN json_build_object('ok', true, 'rows', v);
END $fn$;

-- 临时邮箱名单 增 / 删 / 查
CREATE OR REPLACE FUNCTION admin_domains(p_token TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); v JSON;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  SELECT coalesce(json_agg(t), '[]'::json) INTO v FROM (
    SELECT domain, note FROM banned_email_domains ORDER BY domain
  ) t;
  RETURN json_build_object('ok', true, 'rows', v);
END $fn$;

CREATE OR REPLACE FUNCTION admin_add_domain(p_token TEXT, p_domain TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token);
        d TEXT := lower(trim(coalesce(p_domain,'')));
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  IF d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
    RETURN json_build_object('ok', false, 'reason', '域名格式不正确');
  END IF;
  INSERT INTO banned_email_domains (domain, note) VALUES (d, 'manual')
  ON CONFLICT (domain) DO NOTHING;
  RETURN json_build_object('ok', true, 'domain', d);
END $fn$;

CREATE OR REPLACE FUNCTION admin_del_domain(p_token TEXT, p_domain TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token); n INT;
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  DELETE FROM banned_email_domains WHERE domain = lower(trim(coalesce(p_domain,'')));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted', n);
END $fn$;

-- 改密码（改完立刻注销全部后台登录态）
CREATE OR REPLACE FUNCTION admin_set_pass(p_token TEXT, p_new TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE u TEXT := _admin_ok(p_token);
BEGIN
  IF u IS NULL THEN RETURN json_build_object('ok', false, 'reason', '登录已失效'); END IF;
  IF length(coalesce(p_new,'')) < 4 THEN
    RETURN json_build_object('ok', false, 'reason', '新密码太短（至少 4 位）');
  END IF;
  UPDATE admin_accounts
  SET pass_hash = encode(digest(username || ':' || p_new, 'sha256'), 'hex')
  WHERE username = u;
  DELETE FROM admin_sessions WHERE username = u;
  RETURN json_build_object('ok', true);
END $fn$;


-- ============================================================================
--  七、多人房间
--  说明：本站无游戏服务器，房间只做"组队 + 赛后比分"，不做实时同步。
-- ============================================================================

CREATE OR REPLACE FUNCTION _room_state(p_code TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE r rooms%ROWTYPE; v JSON;
BEGIN
  SELECT * INTO r FROM rooms WHERE code = trim(p_code);
  IF r.id IS NULL THEN
    RETURN json_build_object('ok', false, 'reason', '房间不存在（房码 ' || coalesce(p_code,'') || '）');
  END IF;
  SELECT coalesce(json_agg(t ORDER BY t.done, t.joined_at), '[]'::json) INTO v FROM (
    SELECT member_key, name, ready, wave, kills, mats, survive_sec, done, joined_at
    FROM room_members WHERE room_id = r.id
  ) t;
  RETURN json_build_object('ok', true, 'code', r.code, 'host_key', r.host_key,
    'max', r.max_players, 'status', r.status, 'members', v);
END $fn$;

-- 建房：房码 6 位随机，最多重试 30 次；顺手清理 3 小时前的空房
CREATE OR REPLACE FUNCTION room_create(p_max INT, p_name TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; v_name TEXT; v_code TEXT; v_id BIGINT; i INT;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  IF v_key IS NULL THEN RETURN json_build_object('ok', false, 'reason', '无法识别身份'); END IF;
  v_name := left(coalesce(nullif(trim(coalesce(p_name,'')),''), '玩家'), 12);
  IF p_max IS NULL OR p_max < 2 OR p_max > 6 THEN
    RETURN json_build_object('ok', false, 'reason', '人数需 2~6 人');
  END IF;
  DELETE FROM room_members WHERE member_key = v_key
    AND room_id IN (SELECT id FROM rooms WHERE created_at > now() - interval '3 hours');
  DELETE FROM rooms WHERE created_at < now() - interval '3 hours'
    AND NOT EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = rooms.id);
  FOR i IN 1..30 LOOP
    v_code := lpad((floor(random()*1000000))::int::text, 6, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM rooms WHERE code = v_code);
  END LOOP;
  INSERT INTO rooms (code, host_key, max_players, status, updated_at)
  VALUES (v_code, v_key, p_max, 'waiting', now()) RETURNING id INTO v_id;
  INSERT INTO room_members (room_id, member_key, name, ready) VALUES (v_id, v_key, v_name, true);
  RETURN _room_state(v_code);
END $fn$;

-- 加入：房码格式 / 房间存在 / 未开局 / 未满员
CREATE OR REPLACE FUNCTION room_join(p_code TEXT, p_name TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; v_name TEXT; r rooms%ROWTYPE; v_cnt INT;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  IF v_key IS NULL THEN RETURN json_build_object('ok', false, 'reason', '无法识别身份'); END IF;
  v_name := left(coalesce(nullif(trim(coalesce(p_name,'')),''), '玩家'), 12);
  IF coalesce(trim(p_code),'') !~ '^[0-9]{6}$' THEN
    RETURN json_build_object('ok', false, 'reason', '请输入 6 位数字房码');
  END IF;
  SELECT * INTO r FROM rooms WHERE code = trim(p_code);
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间不存在，请确认房码'); END IF;
  IF r.status = 'playing' THEN RETURN json_build_object('ok', false, 'reason', '该房间已开始游戏'); END IF;
  SELECT count(*) INTO v_cnt FROM room_members WHERE room_id = r.id;
  IF NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = r.id AND member_key = v_key)
     AND v_cnt >= r.max_players THEN
    RETURN json_build_object('ok', false, 'reason', '房间已满（' || r.max_players || ' 人）');
  END IF;
  DELETE FROM room_members WHERE member_key = v_key AND room_id <> r.id
    AND room_id IN (SELECT id FROM rooms WHERE created_at > now() - interval '3 hours');
  INSERT INTO room_members (room_id, member_key, name, ready, wave, kills, mats, survive_sec, done)
  VALUES (r.id, v_key, v_name, false, 0, 0, 0, 0, false)
  ON CONFLICT (room_id, member_key) DO UPDATE SET name = EXCLUDED.name;
  UPDATE rooms SET updated_at = now() WHERE id = r.id;
  RETURN _room_state(r.code);
END $fn$;

-- 只读轮询（兼判断是否已被移出房间）
CREATE OR REPLACE FUNCTION room_poll(p_code TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间已关闭'); END IF;
  IF NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = r.id AND member_key = v_key) THEN
    RETURN json_build_object('ok', false, 'reason', '你不在该房间', 'kicked', true);
  END IF;
  RETURN _room_state(r.code);
END $fn$;

CREATE OR REPLACE FUNCTION room_ready(p_code TEXT, p_device TEXT, p_ready BOOLEAN) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间不存在'); END IF;
  IF r.host_key = v_key THEN RETURN _room_state(r.code); END IF;
  UPDATE room_members SET ready = coalesce(p_ready,false)
  WHERE room_id = r.id AND member_key = v_key;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', '你不在该房间'); END IF;
  UPDATE rooms SET updated_at = now() WHERE id = r.id;
  RETURN _room_state(r.code);
END $fn$;

-- 开始：仅房主，≥2 人，全员准备
CREATE OR REPLACE FUNCTION room_start(p_code TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE; v_cnt INT; v_notready INT;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间不存在'); END IF;
  IF r.host_key <> v_key THEN RETURN json_build_object('ok', false, 'reason', '只有房主能开始'); END IF;
  IF r.status <> 'waiting' THEN RETURN _room_state(r.code); END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT ready) INTO v_cnt, v_notready
  FROM room_members WHERE room_id = r.id;
  IF v_cnt < 2 THEN RETURN json_build_object('ok', false, 'reason', '至少需要 2 人才能开始'); END IF;
  IF v_notready > 0 THEN
    RETURN json_build_object('ok', false, 'reason', '还有 ' || v_notready || ' 人未准备');
  END IF;
  UPDATE room_members SET wave = 0, kills = 0, mats = 0, survive_sec = 0, done = false
  WHERE room_id = r.id;
  UPDATE rooms SET status = 'playing', updated_at = now() WHERE id = r.id;
  RETURN _room_state(r.code);
END $fn$;

CREATE OR REPLACE FUNCTION room_submit(
  p_code TEXT, p_device TEXT, p_wave INT, p_kills INT, p_mats INT, p_time INT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间不存在'); END IF;
  UPDATE room_members SET
    wave = greatest(0, least(20, coalesce(p_wave,0))),
    kills = greatest(0, coalesce(p_kills,0)),
    mats = greatest(0, coalesce(p_mats,0)),
    survive_sec = greatest(0, coalesce(p_time,0)),
    done = true
  WHERE room_id = r.id AND member_key = v_key;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', '你不在该房间'); END IF;
  RETURN _room_state(r.code);
END $fn$;

-- 离开：房主离开自动移交给最早进房的人；人走光则删房
CREATE OR REPLACE FUNCTION room_leave(p_code TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE; v_next TEXT;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', true); END IF;
  DELETE FROM room_members WHERE room_id = r.id AND member_key = v_key;
  SELECT member_key INTO v_next FROM room_members
  WHERE room_id = r.id ORDER BY joined_at LIMIT 1;
  IF v_next IS NULL THEN
    DELETE FROM rooms WHERE id = r.id;
    RETURN json_build_object('ok', true, 'closed', true);
  ELSIF r.host_key = v_key THEN
    UPDATE rooms SET host_key = v_next, updated_at = now() WHERE id = r.id;
    RETURN json_build_object('ok', true, 'new_host', true);
  END IF;
  UPDATE rooms SET updated_at = now() WHERE id = r.id;
  RETURN json_build_object('ok', true);
END $fn$;

-- 房主重开：清分数回到等待状态
CREATE OR REPLACE FUNCTION room_reset(p_code TEXT, p_device TEXT) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE v_key TEXT; r rooms%ROWTYPE;
BEGIN
  v_key := coalesce(_uid(), nullif(trim(coalesce(p_device,'')),''));
  SELECT * INTO r FROM rooms WHERE code = trim(coalesce(p_code,''));
  IF r.id IS NULL THEN RETURN json_build_object('ok', false, 'reason', '房间不存在'); END IF;
  IF r.host_key <> v_key THEN RETURN json_build_object('ok', false, 'reason', '只有房主能重开'); END IF;
  UPDATE room_members SET wave = 0, kills = 0, mats = 0, survive_sec = 0, done = false,
    ready = (member_key = r.host_key) WHERE room_id = r.id;
  UPDATE rooms SET status = 'waiting', updated_at = now() WHERE id = r.id;
  RETURN _room_state(r.code);
END $fn$;


-- ============================================================================
--  八、初始数据
-- ============================================================================

-- 管理员账号（用户名 000000000，密码请用后台"修改管理员密码"自行更改）
INSERT INTO admin_accounts (username, pass_hash)
VALUES ('000000000', encode(digest('000000000:' || '【此处填你自己的密码】', 'sha256'), 'hex'))
ON CONFLICT (username) DO NOTHING;

-- 临时邮箱域名（节选，完整 130 条见线上库）
INSERT INTO banned_email_domains (domain, note) VALUES
  ('mailinator.com','temp-mail'), ('10minutemail.com','temp-mail'),
  ('guerrillamail.com','temp-mail'), ('tempmail.com','temp-mail'),
  ('temp-mail.org','temp-mail'), ('trashmail.com','temp-mail'),
  ('yopmail.com','temp-mail'), ('getnada.com','temp-mail'),
  ('sharklasers.com','temp-mail'), ('mailsac.com','temp-mail'),
  ('maildrop.cc','temp-mail'), ('33mail.com','temp-mail')
ON CONFLICT (domain) DO NOTHING;


-- ============================================================================
--  九、核对查询（部署后跑一遍，确认与线上一致）
-- ============================================================================

-- 表与策略
--   SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public' ORDER BY 1,2;
-- 函数清单
--   SELECT proname, pg_get_function_identity_arguments(oid) AS args
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--     AND proname !~ '^(armor|crypt|dearmor|decrypt|decrypt_iv|digest|encrypt|encrypt_iv|gen_|hmac|pgp_|my_best)'
--   ORDER BY 1;
-- 导出线上函数体（需替换函数名）
--   SELECT pg_get_functiondef('submit_record(text,text,integer,integer,integer,integer)'::regprocedure);
