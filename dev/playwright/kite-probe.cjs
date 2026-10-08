// Probe: can a MOVING player escape the enemy drag-seek?
// Steers AWAY from the #fire-enemy bearing tick (press-and-hold
// steering opposite the nearest enemy), re-aiming every second.
// Compare against the ~60 s idle baseline from threat-probe.cjs.
// Run: NODE_PATH=node_modules node kite-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame, canvasCenter,
        padBearing, steerAlong, overlayTitle, statusText } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page, logs, hits } = await newProbePage(browser, { bites: '[GAME] enemy bite' });
  await openApp(page);
  await startGame(page);

  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down(); // hold — press-and-hold steering
  const t0 = Date.now();

  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    // Nearest-enemy bearing from the rim tick; flee opposite.
    const deg = await padBearing(page, 'fire-enemy');
    if (deg !== null) await steerAlong(page, c, deg, { away: true });
    if (i % 5 === 4) {
      const overlay = await overlayTitle(page);
      const status = await statusText(page);
      console.log(`[KITE] t=${((Date.now() - t0) / 1000).toFixed(0)}s bites=${hits.bites.length} status="${status}" overlay="${overlay}"`);
      if (overlay) break;
    }
  }
  const dists = logs.filter((l) => l.includes('nearest enemy')).slice(-8);
  console.log('[KITE] last distances:\n' + dists.join('\n'));
  await page.mouse.up().catch(() => {});
  await browser.close();
})();
