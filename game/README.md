# 阿紫幸存者 · 源码交接包 v1.13.0

类《土豆兄弟》2D 割草生存游戏。纯前端（零运行时依赖）+ 云端轻后端（Postgres + 服务端函数）。

**线上地址**：https://azi-survivor.app.workbuddy.host/

---

## 这个包里有什么

| 目录 | 内容 | 先看哪个 |
|---|---|---|
| `src/` | 游戏源码，**双击 `src/index.html` 即可运行** | `src/index.html`、`src/js/game.js` |
| `docs/` | 交接文档、数据库结构 SQL、变更日志 | **`docs/交接文档.md`** |
| `build/` | 构建脚本（合并 + 混淆 + 剥离测试接口） | 需要发版时看 |
| `tests/` | Playwright 自动化测试（3 个关键流程） | 改战斗/房间逻辑后跑 |

---

## 三步跑起来

```bash
# 1. 最省事：直接双击（只能玩单机部分，登录/排行/多人会连不上后端）
open src/index.html

# 2. 要完整功能：需要云端后端
#    按 docs/数据库结构.sql 建表建函数（需平台提供 PostgreSQL + PostgREST）
#    然后把 src/sdk/ 换成你项目的 SDK，js/cloud.js 里的项目配置改成你的

# 3. 发版
npm install javascript-obfuscator
node build/build-obfuscated.js 1.13.0
# 产物在 potato-survivor/，纯静态，丢到任何静态托管即可
```

---

## 账号

| 角色 | 入口 | 说明 |
|---|---|---|
| 玩家 | 主菜单 → 账号 | 邮箱/手机号 + 验证码，邮件由平台发出 |
| 管理员 | 设置页底部「管理员入口」 | 用户名 `000000000`，密码见交付说明 |

> 管理员密码**不在代码里**，数据库只存 `sha256(用户名:密码)`。拿到密码后建议立刻在后台改成 12 位以上。

---

## 三个必须知道的坑

1. **访客的 `auth.uid()` 是 `'anon'`（共享值），不是 NULL** —— 任何身份判断都要走 `_uid()`，否则会误封全体游客。
2. **`endWave()` 有幂等锁** —— 别删 `waveCleared` 相关逻辑，删了会重现"一波跳好几波"。
3. **构建会整段剥离 `#test-hook` 注释块** —— 别删注释标记，否则调试接口会跟着发上线。

详细说明见 `docs/交接文档.md` 第 5 节。

---

## 已知限制

- 没有游戏服务器 → 拦不住透视/自瞄，多人也不是实时同屏（是"房间内各自跑一局比分数"）
- 平台拿不到真实客户端 IP → 封禁用的是设备指纹，清缓存可绕过
- 混淆产物不可直接改 → 任何修改都回到 `src/` 重新构建

---

## 文件清单

```
README.md                    本文件
docs/交接文档.md              架构 / 后端 / 设计决策 / 交接清单（主文档）
docs/数据库结构.sql           11 张表 + 28 个服务端函数，可重建后端
docs/变更日志.md              v1.9~v1.13 改了什么、踩了什么坑
src/index.html                页面 + 全部样式
src/js/data.js                数值配置
src/js/game.js                核心引擎
src/js/art.js                 Canvas 美术
src/js/cloud.js               云端封装
src/js/audio.js               音效合成
src/js/icons.js               SVG 图标
src/sdk/                      平台 SDK
build/build-obfuscated.js     构建脚本
tests/smoke.js                单人主流程
tests/mp-flow.js              多人房间
tests/anti-cheat.js           反作弊
```
