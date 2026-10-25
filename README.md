# 阿紫幸存者 · AZI SURVIVOR

一个纯前端的**多人联机幸存者类（roguelite）网页游戏**，单人一局约 5–15 分钟。
无框架、无打包器、零运行时依赖 —— 所有渲染走 Canvas 2D，游戏状态用一个 IIFE 收口。

> 打开网页就能玩，不注册也能玩（注册后成绩可上榜）。

---

## 特性

- **无尽波次 + 精英怪 + 幸运转盘**：波次上限 20，另有「无尽模式」不设上限
- **真·多人联机（2–6 人）**：房主权威（host-authoritative）架构，房客操作零延迟本地预测
- **人数血量倍率**：2 人 ×2、3 人 ×3、4 人 ×4（封顶 ×4），只在刷怪那一刻生效
- **最近敌人优先**：远程武器自动锁定离自己最近的敌人
- **排行榜**：每人只显示最佳一局，可匿名、可选择隐藏昵称
- **账号体系**：邮箱 / 手机号验证码登录，7 天自动登录，设备指纹识别新设备
- **反作弊**：客户端行为上报 + 服务端越界校验 + 设备/IP 封禁 + 独立管理后台
- **移动端适配**：触屏摇杆、单列布局、手机端面板不遮挡操作按钮

---

## 目录结构

```
game/
  src/            开发源码（直接可跑，未混淆）
    index.html    页面 + 全部样式
    js/
      icons.js    图标（SVG 字符串）
      data.js     角色 / 敌人 / 武器 / 波次数值
      audio.js    WebAudio 音效合成（无音频文件依赖）
      cloud.js    云服务接入（账号 / 排行榜 / 房间 / 反作弊）
      art.js      Canvas 绘制
      net.js      联机客户端（连接 / 快照插值 / 输入上报）
      game.js     主游戏逻辑（IIFE，收口全部状态）
    sdk/          云服务 SDK
  build/          构建脚本（拼接 + 混淆 → dist/）
  docs/           数据库结构、协议说明
  tests/          规则 / 数值类测试
net/
  server.js       联机中继（WebSocket，只转发不跑游戏逻辑）
  *.js            协议测试、双端对打测试、线上体检、构建校验
admin/
  index.html      独立管理后台（单文件，直连云数据库 RPC）
```

---

## 本地运行

源码无构建步骤，起一个静态服务器即可：

```bash
cd game/src
python -m http.server 8080
# 打开 http://127.0.0.1:8080
```

联机需要同时起中继：

```bash
cd net
npm install
node server.js          # 默认监听 9090
```

让前端连本机中继（浏览器控制台执行一次，会写进 localStorage）：

```js
localStorage.setItem("azi_net_url", "ws://127.0.0.1:9090");
```

---

## 配置你自己的云服务

账号、排行榜、房间、反作弊依赖一套云数据库（PostgREST 风格）。仓库里全是**占位符**，你需要替换成自己的：

| 位置 | 占位符 | 说明 |
|---|---|---|
| `game/src/js/cloud.js` | `endpoint` | 你的云服务地址 |
| 同文件 | `publishableKey`（`wbpk_...`） | 公开密钥，可放前端 |
| `admin/index.html` | `ACCESS_KEY` | 同上 |
| `net/server.js` | 端口 `9090` | 中继监听端口 |

数据库表与函数见 `game/docs/数据库结构.sql`，核心包括：
`leaderboard`、`account_profile`、`account_devices`、`cheat_flags`、
`banned_devices`、`banned_ips`、`banned_email_domains`、`admin_accounts`、`rooms`、`room_members`。

> 没有云服务也能玩：不登录时游戏自动按单人模式运行，只是不上榜。

---

## 部署

### 前端（纯静态）

```bash
node game/build/build-obfuscated.js 1.0.0     # 产出 game/dist
```

把 `game/dist` 丢到任意静态托管即可。构建脚本会：
拼接 7 个 js → 混淆成单文件 `app.min.js` → 剥离测试钩子 → 对旧路径写占位文件（防止源码泄漏）。

### 中继（需要 WebSocket + TLS）

前端是 `https`，浏览器会拦截 `ws://`（混合内容），所以中继必须走 `wss://`。两种方式：

1. **反向代理**：nginx 把 `443` 转发到 `127.0.0.1:9090`。注意 WebSocket 升级头必须在**同一个 location** 里声明：

```nginx
location / {
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;
    proxy_pass http://127.0.0.1:9090;
}
```

2. **隧道**：`cloudflared tunnel --url http://127.0.0.1:9090`，免证书拿到 `wss://` 地址。

> ⚠️ 踩过的坑：`location` 内只要出现任何 `proxy_set_header`，server 级的同名指令就**不再继承**，
> WebSocket 升级头会静默丢失，表现为客户端报「联机服务器连接失败」。

前端支持双地址兜底：`net.js` 的 `cfg.url` / `cfg.fallback` 依次尝试，并把上次成功的地址记在
`localStorage.azi_net_url_good` 里优先复用。

---

## 架构要点

- **IIFE + 显式绑定**：`game.js` 内部状态（`G` / `player` / `enemies`）不暴露为全局，
  通过 `Net.__bind({...})` 把 getter/setter 注入 `net.js`，后者一律走 `this._A.xxx`
- **房主权威**：房主跑完整战斗逻辑，10Hz 广播世界快照；房客 20Hz 上报输入并本地预测自己的移动
- **伤害必须过 `damageEnemy()`**：房客侧先 `Net.reportHit()` 上报，由房主权威结算，
  这样房客的伤害才真的作用在怪物身上
- **反作弊在数据库层**：成绩提交走 `submit_record` 服务端函数，越界数据直接拒绝

---

## 测试

```bash
cd net
node test-relay.js wss://your-relay.example.com 123456   # 中继协议 16 项
node mp-build-page.js && node mp-test.js                 # 双端真浏览器对打
node terms-test.js                                       # 登录协议勾选
node shop-mobile-test.js                                 # 手机端面板不遮挡
node dist-check.js                                       # 构建产物自检（测试钩子已剥离）
```

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方组件：`ws`（MIT）。云服务 SDK 由托管平台提供，不在本许可证覆盖范围内。
