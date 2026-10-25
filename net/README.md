# net — 阿紫幸存者实时联机中继服务器

VPS 上跑的 WebSocket 中继：**只做房间管理与消息转发，不跑游戏逻辑**。
战斗全部由房主客户端计算，按 10Hz 广播世界快照；房客按 20Hz 上送输入。

架构与协议说明见 `../game/docs/交接文档.md` 第 5.4 / 第 7 章。

## 文件

| 文件 | 作用 |
|---|---|
| `server.js` | 中继服务器本体（`ws` 库，约 300 行）。房间生命周期、心跳、单 IP 限流、`/health` `/stats` |
| `azi-net.service` | systemd 单元（VPS 上用） |
| `test-relay.js` | 中继协议自测，16 项（双端对打、命中转发、身份不可伪造、房主离线、畸形消息、限流…） |
| `mp-build-page.js` | 从 `../game/src/index.html` 生成联机测试页 `test-mp.html` |
| `mp-test.js` | 双端真浏览器联机测试（两个 headless Chrome 对打 + 断言） |
| `mp-debug.js` | 单端诊断（打印某一端的 mode/ready/stats/timeline） |
| `cdp-exec.js` | 通用 CDP 执行器（往页面里注入一段 JS 并取回结果） |
| `gate-test.js` | 联机登录门槛验证（未登录被拦 / 伪造登录放行） |
| `ui-test.js` | 逐面板 emoji 扫描 + 截图到 `shots/`（布局回归） |
| `dist-check.js` | 混淆产物 `dist/` 是否独立可跑、测试钩子是否已剥离 |
| `live-check.js` | 线上页面真浏览器体检（异常 / emoji / 可交互 / 钩子已剥离） |
| `live-board.js` | 线上排行榜 UI 验证（真实点击：每人最佳 + 匿名开关） |
| `board-test.js` | 本地 `src` 排行榜验证（走 `?test=1` 钩子，线上不可用） |
| `endless-test.js` | 无尽模式行为验证（第 20 波不结算，对照组普通局仍正常通关） |
| `shots/` | `ui-test.js` 输出：12 个面板的截图 |

## 本机跑法

```bash
cd D:/阿紫幸存者/net

# 1) 起中继（9090）
node server.js

# 2) 另一终端：协议自测
node test-relay.js --url ws://127.0.0.1:9090

# 3) 双端联机测试（会自动起静态服务器 8898 + 两个 Chrome）
node mp-test.js --secs 12 --net ws://127.0.0.1:9090 --room 777001
```

`mp-test.js` 输出 `PASS ✅` 表示：快照下行、输入上行、影子代打、世界同步、零报错全部达标。

`mp-test.js` 的执行链同时验证「真·共同打怪」四项：
房客命中上报（`hitsSent > 0`）→ 房主权威结算（`hitsRecv > 0`）→
人数血量倍率（2 人房怪物 `maxHp` 恰为基础值 ×2，`hpRatio ≈ 2`）→ 团队击杀共享。

其余体检脚本：

```bash
node gate-test.js                 # 联机登录门槛
node ui-test.js                   # 界面 emoji / 布局（截图在 shots/）
node endless-test.js              # 无尽模式：第 20 波不结算 / 普通局正常结算
node dist-check.js                # 混淆产物可跑性 + 钩子已剥离
node live-check.js --url "https://YOUR-APP.app.workbuddy.host/?sharecode=R5DIXA73QA"
node live-board.js --url "https://YOUR-APP.app.workbuddy.host/?sharecode=R5DIXA73QA"
```

> 联机要求登录后，`test-mp.html` 会注入假账号 `zz-mp-<role>-<room>` 绕过门槛，
> 否则两端都会按单人模式跑（mode=solo）。

> 改了 `index.html` 的 DOM 结构后，先跑 `node mp-build-page.js` 重新生成测试页，
> 否则游戏可能卡在升级界面（缺 `#upgrade-cards` 这类节点）。

## VPS 部署

```bash
# 从本机推上去（示例）
scp -i ~/.ssh/your-key.pem server.js package.json ubuntu@203.0.113.10:~/azi-net/
ssh -i ~/.ssh/your-key.pem ubuntu@203.0.113.10 \
  "cd ~/azi-net && npm install --omit=dev && sudo cp azi-net.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart azi-net"

# 隧道（不是 systemd 服务，重启机器后要手动拉起）
ssh ... "nohup cloudflared tunnel --url http://localhost:9090 --no-autoupdate > /tmp/cf.log 2>&1 &"
```

健康检查：`curl -s localhost:9090/health`、`curl -s localhost:9090/stats`。

## 协议速查（与 `server.js` 头部注释一致）

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `hi{r,role,k,n}` | 进房；房码必须 6 位数字 |
| C→S | `snap{d}` | 仅房主可发，服务端原样转发给所有房客 |
| C→S | `inp{x,y,ax,ay,face,char}` | 仅房客可发，转发给房主 |
| C→S | `hit{id,d,c}` | 仅房客可发；**服务端注入 `k`**，房客无法伪造身份；转发给房主结算 |
| C→S | `over{win,stats}` `bye` `ping` | 对局结束 / 主动离开 / 心跳 |
| S→C | `welcome{role,peers}` `join` `leave` `snap` `inp` `hit` `over` `hostgone` `pong` `err` | |

`hit` 是「共同打怪」的核心：房客只上报"打了谁、多少伤害"，
敌人的血量、死亡、掉落、团队击杀全部由房主结算，再通过快照回传。

## 注意

- 隧道域名 `*.trycloudflare.com` **每次重启都会变**，变了要改 `game/src/js/net.js` 的 `cfg.url`，
  然后重新构建（`node game/build/build-obfuscated.js 1.15.x`）并发布 `game/dist`——**线上站点根是 dist，不是 src**。
- 发布器**叠加写入、不删除旧文件**：老路径 `js/game.js`、`test-mp.html` 会残留可下载。
  构建脚本第 3.5 步会写同路径占位文件覆盖它们，所以**改完必须重新构建 + 重新发布**。
  自查：`curl -s -o /dev/null -w "%{size_download}\n" "https://<域名>/js/game.js?sharecode=<码>"` 应为 10。
- 房间码是 6 位数字，即口令，无鉴权。
- 服务器不落地任何对局数据。
