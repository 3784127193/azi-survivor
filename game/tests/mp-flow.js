/* 多人房间全流程：两个浏览器实例，房主建房 → 玩家输码加入 → 准备 → 开始 */
const { chromium } = require("playwright-core");
const URL = "file:///E:/WorkBuddy111/2026-10-17-16-32-43/potato-survivor-src/index.html?test=1";
(async () => {
  const b = await chromium.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true, args: ["--no-sandbox", "--disable-gpu", "--mute-audio"]
  });
  const out = {};
  const errsAll = [];

  const mk = async (dev, tag) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", e => errsAll.push(tag + ": " + e.message));
    await p.addInitScript((d) => { try { localStorage.setItem("azi_device_id", d); } catch (e) { } }, dev);
    await p.goto(URL);
    await p.waitForTimeout(1700);
    return p;
  };

  const host = await mk("d-mp-host1", "host");
  const guest = await mk("d-mp-guest1", "guest");

  // ---------- 房主：开始 → 多人 → 创建房间 → 选 3 人 ----------
  await host.click("#btn-start"); await host.waitForTimeout(400);
  out.modeScreen = await host.evaluate(() => !document.getElementById("screen-mode").classList.contains("hidden"));
  await host.click("#btn-mode-multi"); await host.waitForTimeout(400);
  out.mpScreen = await host.evaluate(() => !document.getElementById("screen-mp").classList.contains("hidden"));
  await host.click("#btn-mp-create"); await host.waitForTimeout(400);
  await host.click('.count-chip:nth-child(2)');           // 选 3 人
  await host.waitForTimeout(150);
  await host.click("#btn-create-submit");
  await host.waitForTimeout(3200);
  const code = await host.evaluate(() => document.getElementById("room-code-show").textContent.trim());
  out.created = { code, roomVisible: await host.evaluate(() => !document.getElementById("screen-room").classList.contains("hidden")) };
  await host.screenshot({ path: "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/460-room-host.png" });

  // ---------- 访客：加入房间 → 输码 ----------
  await guest.click("#btn-start"); await guest.waitForTimeout(350);
  await guest.click("#btn-mode-multi"); await guest.waitForTimeout(350);
  await guest.click("#btn-mp-join"); await guest.waitForTimeout(350);
  out.joinScreen = await guest.evaluate(() => !document.getElementById("screen-join").classList.contains("hidden"));
  await guest.fill("#room-code-input", "000000");
  await guest.click("#btn-join-submit"); await guest.waitForTimeout(2200);
  out.badCode = await guest.evaluate(() => document.getElementById("join-msg").textContent.trim());
  await guest.fill("#room-code-input", code);
  await guest.click("#btn-join-submit");
  await guest.waitForTimeout(3000);
  out.joined = await guest.evaluate(() => ({
    roomVisible: !document.getElementById("screen-room").classList.contains("hidden"),
    code: document.getElementById("room-code-show").textContent.trim(),
    members: document.querySelectorAll("#room-list .room-row").length
  }));
  await guest.screenshot({ path: "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/461-room-guest.png" });

  // 房主轮询应看到 2 人
  await host.waitForTimeout(2600);
  out.hostSees = await host.evaluate(() => ({
    sub: document.getElementById("room-sub").textContent.trim(),
    members: document.querySelectorAll("#room-list .room-row").length
  }));

  // 房主未等准备就点开始 → 应提示
  out.beforeStart = await host.evaluate(() => ({
    sub: document.getElementById("room-sub").textContent.trim(),
    startDisabled: document.getElementById("btn-room-start").disabled,
    rows: [...document.querySelectorAll("#room-list .room-row")].map(r => r.textContent.trim())
  }));
  out.guestAfterJoin = await guest.evaluate(() => ({
    sub: document.getElementById("room-sub").textContent.trim(),
    readyBtnText: document.getElementById("btn-room-ready").textContent.trim(),
    rows: [...document.querySelectorAll("#room-list .room-row")].map(r => r.textContent.trim())
  }));

  // 访客准备 → 房主开始
  await guest.click("#btn-room-ready"); await guest.waitForTimeout(1800);
  out.guestAfterReady = await guest.evaluate(() => ({
    sub: document.getElementById("room-sub").textContent.trim(),
    rows: [...document.querySelectorAll("#room-list .room-row")].map(r => r.textContent.trim())
  }));
  await host.waitForTimeout(2600);
  out.hostAfterReady = await host.evaluate(() => ({
    sub: document.getElementById("room-sub").textContent.trim(),
    startDisabled: document.getElementById("btn-room-start").disabled,
    rows: [...document.querySelectorAll("#room-list .room-row")].map(r => r.textContent.trim())
  }));
  const canStart = await host.evaluate(() => !document.getElementById("btn-room-start").disabled);
  if (!canStart) { out.STUCK = true; console.log(JSON.stringify(out, null, 2)); await b.close(); return; }
  await host.click("#btn-room-start");
  await host.waitForTimeout(800);
  out.hostStarted = await host.evaluate(() => ({
    charScreen: !document.getElementById("screen-char").classList.contains("hidden"),
    roomHidden: document.getElementById("screen-room").classList.contains("hidden")
  }));
  // 访客应自动被拉进选人（轮询 2s）
  await guest.waitForTimeout(3200);
  out.guestPulled = await guest.evaluate(() => ({
    charScreen: !document.getElementById("screen-char").classList.contains("hidden"),
    roomHidden: document.getElementById("screen-room").classList.contains("hidden")
  }));

  // 两边各自开局并直接结算
  for (const [p, tag, mats] of [[host, "host", 900], [guest, "guest", 500]]) {
    await p.click("#char-cards .char-card:nth-child(1)");
    await p.waitForTimeout(1000);
    await p.evaluate((m) => {
      const g = window.__game;
      g.G.materials = m; g.G.kills = 120;
      g.G.wave = 20; g.G.waveCleared = false; g.G.waveTime = 0.02;   // 直接触发胜利结算
    }, mats);
    await p.waitForTimeout(2500);
  }
  out.scores = {
    host: await host.evaluate(() => ({ screen: window.__game.debug.state(), roomBtn: !document.getElementById("btn-vicroom").classList.contains("hidden") })),
    guest: await guest.evaluate(() => ({ screen: window.__game.debug.state(), roomBtn: !document.getElementById("btn-vicroom").classList.contains("hidden") }))
  };

  // 房主点"返回房间看排名"
  await host.click("#btn-vicroom");
  await host.waitForTimeout(3200);
  out.ranking = await host.evaluate(() => ({
    inRoom: !document.getElementById("screen-room").classList.contains("hidden"),
    sub: document.getElementById("room-sub").textContent.trim(),
    rows: [...document.querySelectorAll("#room-list .room-row")].map(r => r.textContent.trim())
  }));
  await host.screenshot({ path: "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/462-room-ranking.png" });

  out.errors = errsAll;
  out.code = code;
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
