/* 最终回归测试：完整流程 + 战斗节奏 + 截图 */
const { chromium } = require("playwright-core");

(async () => {
  const shots = "E:/WorkBuddy111/2026-10-17-16-32-43/game-test/shots/";
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto("file:///E:/WorkBuddy111/2026-10-17-16-32-43/potato-survivor-src/index.html?test=1");
  await page.waitForTimeout(1200);
  await page.click("#btn-start"); await page.waitForTimeout(450); await page.click("#btn-mode-solo");
  await page.waitForTimeout(400);
  await page.click("#char-cards .char-card:nth-child(3)");   // 铁墩墩（铁锤）
  await page.waitForTimeout(400);

  // 真实战斗节奏：不干预，让波次自己刷怪，走位 12 秒
  await page.keyboard.down("d"); await page.waitForTimeout(1500); await page.keyboard.up("d");
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.keyboard.down("a"); await page.waitForTimeout(1500); await page.keyboard.up("a");
  await page.keyboard.down("s"); await page.waitForTimeout(1500); await page.keyboard.up("s");
  const paced = await page.evaluate(() => ({
    wave: window.__game.G.wave, kills: window.__game.G.kills,
    enemies: window.__game.enemies.length, mats: window.__game.G.materials,
    hp: window.__game.player.hp, lv: window.__game.player.level
  }));
  await page.screenshot({ path: shots + "20-pacing.png" });

  // 高压场景：40 只怪同屏性能测试
  await page.evaluate(() => {
    const g = window.__game;
    ["slime", "bat", "golem", "spitter"].forEach((t, i) => { for (let j = 0; j < 10; j++) setTimeout(() => g.debug.spawn(t), i * 200 + j * 40); });
  });
  await page.waitForTimeout(2500);
  const stress = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(f); else res({ fps: Math.round(n / 1.5), enemies: window.__game.enemies.length }); };
    requestAnimationFrame(f);
  }));
  await page.screenshot({ path: shots + "21-stress.png" });

  // 完整收尾流程：重开新局 → 打死 → 验证失败结算
  await page.goto("file:///E:/WorkBuddy111/2026-10-17-16-32-43/potato-survivor-src/index.html?test=1");
  await page.waitForTimeout(1000);
  await page.click("#btn-start"); await page.waitForTimeout(450); await page.click("#btn-mode-solo");
  await page.waitForTimeout(300);
  await page.click("#char-cards .char-card");
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__game.debug.hurt(99999));
  await page.waitForTimeout(2400);
  const goVisible = await page.evaluate(() => !document.getElementById("screen-gameover").classList.contains("hidden"));
  await page.screenshot({ path: shots + "22-gameover-final.png" });

  console.log(JSON.stringify({ errors, errorCount: errors.length, paced, stress, goVisible }, null, 2));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
