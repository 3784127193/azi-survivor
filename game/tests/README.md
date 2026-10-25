# 测试脚本说明

基于 Playwright（`playwright-core` + 本机 Edge / Chrome 无头模式）。

## 准备

```bash
npm install playwright-core
```

两个前置条件（脚本里目前是写死的，换机器要改）：

1. **浏览器路径**：`executablePath` 指向本机 Edge
   `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
2. **页面路径**：脚本加载 `file:///.../src/index.html?test=1`
   - `?test=1` 是必需的：`window.__game` 只在带这个参数时暴露，测试靠它驱动内部状态
   - 路径换成你解压后的实际目录

## 三个脚本

| 脚本 | 覆盖 | 跑法 |
|---|---|---|
| `smoke.js` | 单人主流程：开局 → 战斗 → 升级选卡 → 死亡 → 结算 → 回主菜单；含 45 怪压力帧率统计 | `node tests/smoke.js` |
| `mp-flow.js` | 多人房间双实例全流程：建房 → 输错房码被拒 → 输对房码进入 → 准备 → 房主开始 → 双方自动进选角 → 各自结算 → 房间排名 | `node tests/mp-flow.js` |
| `anti-cheat.js` | 临时邮箱拦截（含"零网络请求"断言）、瞬移检测触发横条、沙盒对局免疫（血量/材料双零变化） | `node tests/anti-cheat.js` |

## 期望结果

- `smoke.js`：`errors: []`，`stress.fps` ≥ 55
- `mp-flow.js`：`errors: []`，`ranking.rows` 两人且名次正确
- `anti-cheat.js`：`tempMail.noRequest === true`、`sandboxImmunity.hp0 === hp1`

## 注意

- `mp-flow.js` 会真实往云端建房间，跑完请在数据库清理 `rooms` 表（房主 key 以 `d-mp-` 开头）。
- 三个脚本都不依赖后端账号；建房间用的是访客设备指纹。
- 发布版（`potato-survivor/`）**没有** `window.__game`，这些脚本只能测 `src/`。
