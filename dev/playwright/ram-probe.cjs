// Probe: do LIVE enemy loops still hunt and bite?
// Steers continuously toward the nearest-enemy bearing (rams the foe)
// so contact is sustained — a live loop must land bites; dead husks
// (no e+f loop) must not seek or bite.
// Run: NODE_PATH=node_modules node ram-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame,
        overlayTitle, statusText, canvasCenter, steerAlong,
        padBearing } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page, hits } = await newProbePage(browser, { bites: '[GAME] enemy bite' });
  await openApp(page);
  await startGame(page);
  const center = await canvasCenter(page);
  const t0 = Date.now();
  let steering = false;
  for (let i = 0; i < 30; i++) {
    const deg = await padBearing(page, 'fire-enemy');
    if (deg == null) {
      if (steering) { await page.mouse.up(); steering = false; }
      await page.waitForTimeout(1000);
      continue;
    }
    if (!steering) {
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      steering = true;
    }
    await steerAlong(page, center, deg, { dist: 400 });
    await page.waitForTimeout(1500);
    const overlay = await overlayTitle(page);
    const status = await statusText(page);
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[RAM] t=${el}s bearing=${deg.toFixed(0)} bites=${hits.bites.length} status="${status}" overlay="${overlay}"`);
    if (overlay || hits.bites.length >= 3) break;
  }
  if (steering) await page.mouse.up();
  console.log(`[RAM] result: ${hits.bites.length} bites in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await browser.close();
})();
