/* v1.10.0：反作弊（检测/回拉/横条/沙盒）+ 临时邮箱拦截 */
const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true, args: ["--no-sandbox", "--disable-gpu", "--mute-audio"]
  });
  const out = {};
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const net = [];
  await page.route("**/v1/verification", async route => {
    net.push("verification");
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ verification_id: "v1", is_user: false }) });
  });
  await page.goto("file:///E:/WorkBuddy111/2026-10-17-16-32-43/potato-survivor-src/index.html?test=1");
  await page.waitForTimeout(1800);

  // ---------- 1) 临时邮箱：不能发验证码 ----------
  await page.click("#btn-account");
  await page.waitForTimeout(400);
  await page.click('.auth-tab[data-tab="reg"]');
  await page.waitForTimeout(300);
  await page.click('#pane-reg .auth-segbtn[data-m="email"]');
  await page.waitForTimeout(300);
  const reqBefore = net.length;
  await page.fill("#reg-email", "abc@mailinator.com");
  await page.click("#btn-code");
  await page.waitForTimeout(1200);
  out.tempMail = await page.evaluate(() => ({
    status: document.getElementById("auth-status").textContent.trim(),
    btnText: document.getElementById("btn-code").textContent.trim(),
    disabled: document.getElementById("btn-code").disabled
  }));
  out.tempMail.noRequest = net.length === reqBefore;

  // 正常邮箱应该放过（会走到发码 → mock 返回未注册）
  await page.fill("#reg-email", "normal@qq.com");
  await page.click("#btn-code");
  await page.waitForTimeout(1200);
  out.normalMail = await page.evaluate(() => document.getElementById("auth-status").textContent.trim());
  out.normalMail.sent = net.length > reqBefore;

  // ---------- 2) 反作弊：瞬移检测 ----------
  await page.click("#btn-auth-back");
  await page.waitForTimeout(300);
  await page.click("#btn-start"); await page.waitForTimeout(450); await page.click("#btn-mode-solo"); await page.waitForTimeout(400);
  await page.click("#char-cards .char-card:nth-child(1)"); await page.waitForTimeout(900);
  const cheat = await page.evaluate(async () => {
    const g = window.__game;
    const before = { mats: g.G.materials, lv: g.player.level };
    // 等一个检查点
    await new Promise(r => setTimeout(r, 1200));
    const ck = { mats: g.G.materials, lv: g.player.level };
    // 模拟瞬移
    g.player.x += 4000;
    await new Promise(r => setTimeout(r, 400));
    return {
      before, ck,
      barVisible: !document.getElementById("cheat-bar").classList.contains("hidden"),
      barText: document.getElementById("cheat-bar-reason").textContent,
      afterMats: g.G.materials
    };
  });
  out.cheatDetect = cheat;
  await page.screenshot({ path: "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/420-cheat-bar.png" });

  // ---------- 3) 点击横条 → 进入沙盒 ----------
  await page.click("#cheat-bar-btn");
  await page.waitForTimeout(700);
  out.sandbox = await page.evaluate(() => ({
    modalOpen: !document.getElementById("modal").classList.contains("hidden"),
    modalText: document.getElementById("modal-msg").innerText.slice(0, 40),
    barHidden: document.getElementById("cheat-bar").classList.contains("hidden")
  }));
  await page.click("#modal-ok");
  await page.waitForTimeout(400);

  // ---------- 4) 沙盒里：怪物打不到我们 ----------
  const imm = await page.evaluate(async () => {
    const g = window.__game;
    g.player.hp = g.player.maxHp;
    for (let i = 0; i < 5; i++) g.debug.spawn("slime");
    g.enemies.forEach(e => { e.x = g.player.x + 6; e.y = g.player.y + 6; });
    const hp0 = g.player.hp, mats0 = g.G.materials;
    await new Promise(r => setTimeout(r, 1500));
    return { hp0, hp1: g.player.hp, mats0, mats1: g.G.materials, enemies: g.enemies.length };
  });
  out.sandboxImmunity = imm;
  await page.screenshot({ path: "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/421-sandbox.png" });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error("FATAL", e); process.exit(1); });
