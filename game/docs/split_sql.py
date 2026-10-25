# -*- coding: utf-8 -*-
"""把 docs/数据库结构.sql 拆成单条语句清单（exec_sql 一次只能跑一条）。
- 函数块按 $fn$; 边界整体识别
- 补 CREATE SEQUENCE leaderboard_id_seq（原 SQL 缺失）
- account_profile / account_devices 补 owner_id DEFAULT auth.uid()（平台约定，原 SQL 缺失）
- 补客户端直连表所需 GRANT（原 SQL 依赖旧平台默认授权）
- 管理员账号密码用随机生成值（原 SQL 是占位符）
"""
import re, json, hashlib, secrets, string

SRC = r'D:\WorkBuddy666\2026-10-24-13-35-14\az-survivor\阿紫幸存者-源码交接包-v1.13.0\docs\数据库结构.sql'
OUT = r'D:\WorkBuddy666\2026-10-24-13-35-14\az-survivor\sql_statements.json'

text = open(SRC, encoding='utf-8').read()

# ---- 1. 抽出函数块，用占位符标记位置 ----
fn_re = re.compile(r'CREATE OR REPLACE FUNCTION.*?\$fn\$;', re.S)
funcs = []
def _stash(m):
    funcs.append(m.group(0))
    return f'\n@@FUNC{len(funcs)-1}@@\n'
text = fn_re.sub(_stash, text)

# ---- 2. 去注释（整行 + 行尾），按 ; 切分 ----
lines = []
for ln in text.split('\n'):
    s = ln.strip()
    if s.startswith('--'):
        continue
    # 行尾注释（本文件字符串字面量中不含 --，安全）
    idx = ln.find('--')
    if idx >= 0:
        ln = ln[:idx]
    if ln.strip():
        lines.append(ln)
body = '\n'.join(lines)

stmts = [s.strip() for s in body.split(';') if s.strip()]

# ---- 3. 按原顺序重组（函数块放回占位符位置；占位符相邻时二次拆分） ----
ordered = []
for s in stmts:
    parts = re.split(r'(@@FUNC\d+@@)', s)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r'@@FUNC(\d+)@@', part)
        if m:
            ordered.append(('function', funcs[int(m.group(1))]))
        else:
            ordered.append(('stmt', part))

# ---- 4. 生成管理员随机密码（只在本轮对话交付一次，不落任何文件） ----
alphabet = string.ascii_letters + string.digits
admin_pass = ''.join(secrets.choice(alphabet) for _ in range(12))
admin_user = '000000000'
admin_hash = hashlib.sha256(f'{admin_user}:{admin_pass}'.encode('utf-8')).hexdigest()

# ---- 5. 过滤/替换/插入 ----
final = []
inserted_seq = False
for kind, s in ordered:
    if kind == 'stmt' and re.match(r'CREATE EXTENSION', s, re.I):
        continue  # 已单独执行过
    if kind == 'stmt' and s.upper().startswith('INSERT INTO ADMIN_ACCOUNTS'):
        continue  # 占位符版本丢弃，下面用真密码重建
    if kind == 'stmt' and re.match(r'CREATE TABLE IF NOT EXISTS leaderboard\b', s, re.I):
        if not inserted_seq:
            final.append(('migrate', 'CREATE SEQUENCE IF NOT EXISTS leaderboard_id_seq'))
            inserted_seq = True
    if kind == 'stmt' and re.match(r'INSERT INTO banned_email_domains', s, re.I):
        final.append(('write', s))
        continue
    final.append(('migrate', s))

# owner_id 默认值（平台约定：DEFAULT auth.uid()，客户端不传 owner_id）
final.append(('migrate', 'ALTER TABLE account_profile ALTER COLUMN owner_id SET DEFAULT auth.uid()'))
final.append(('migrate', 'ALTER TABLE account_devices ALTER COLUMN owner_id SET DEFAULT auth.uid()'))

# 客户端直连表所需 GRANT（RLS 仍是安全门，这里只补旧平台默认给的表级授权）
final.append(('migrate', 'GRANT SELECT ON TABLE leaderboard TO authenticated, anon'))
final.append(('migrate', 'GRANT SELECT, INSERT, UPDATE ON TABLE account_profile TO authenticated, anon'))
final.append(('migrate', 'GRANT SELECT, INSERT, UPDATE ON TABLE account_devices TO authenticated, anon'))
final.append(('migrate', 'GRANT SELECT ON TABLE banned_email_domains TO authenticated, anon'))
final.append(('migrate', 'GRANT USAGE, SELECT ON SEQUENCE leaderboard_id_seq TO authenticated, anon'))

# 管理员账号（sha256 十六进制，与 admin_login() 的 digest 算法一致）
final.append(('write',
    "INSERT INTO admin_accounts (username, pass_hash) VALUES "
    f"('{admin_user}', '{admin_hash}') ON CONFLICT (username) DO NOTHING"))

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'admin_user': admin_user, 'admin_pass': admin_pass,
               'statements': final}, f, ensure_ascii=False, indent=1)

print(f'total statements: {len(final)}')
for i, (mode, s) in enumerate(final):
    head = ' '.join(s.split())[:90]
    print(f'{i:3d} [{mode:7s}] {head}')
