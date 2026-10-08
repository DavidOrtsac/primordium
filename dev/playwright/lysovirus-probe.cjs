// Probe: fire a lysovirus and verify the spawn clearance hugs the membrane
// edge along the fire axis, plus screenshot the two-line HUD weapon readout.
// Run: NODE_PATH=node_modules node lysovirus-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame, padPress } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page, logs } = await newProbePage(browser);
  await openApp(page);
  await startGame(page);
  await page.waitForTimeout(4000); // player cell grows

  await padPress(page, 0.9, 0); // fire east
  await page.waitForTimeout(300);
  console.log('FIRE:', logs.find((l) => l.includes('[WEAPON] lysovirus fired')));

  // Screenshot HUD corner (fire pad + stats box).
  await page.screenshot({ path: '/var/tmp/devin/lysovirus-hud.png', clip: { x: 0, y: 0, width: 420, height: 320 } });

  // Second shot after cooldown to check spawn distances per direction.
  await page.waitForTimeout(1800);
  await padPress(page, 0, -0.9); // fire north
  await page.waitForTimeout(300);
  console.log('ALL SHOTS:', logs.filter((l) => l.includes('[WEAPON] lysovirus fired')));
  await page.screenshot({ path: '/var/tmp/devin/lysovirus-hud2.png', clip: { x: 0, y: 0, width: 420, height: 320 } });

  await browser.close();
})();
