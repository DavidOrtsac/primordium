// Probe: realistic play — flee the red enemy tick, fire at it when
// reloaded, and steer to the amber lysin dot when the magazine runs
// dry. Measures survival + kills for a competently-played match.
// Run: NODE_PATH=node_modules node fight-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame, canvasCenter,
        padBearing, padState, padFireAt, steerAlong,
        overlayTitle, statusText } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page, logs, hits } = await newProbePage(browser, { bites: '[GAME] enemy bite' });
  await openApp(page);
  await startGame(page);

  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  const t0 = Date.now();
  let shots = 0;

  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    const enemyDeg = await padBearing(page, 'fire-enemy');
    const lysinDeg = await padBearing(page, 'fire-lysin');
    const { cd, empty } = await padState(page);

    if (empty && lysinDeg !== null) {
      await steerAlong(page, c, lysinDeg);          // rearm at the amber dot
    } else if (enemyDeg !== null) {
      await steerAlong(page, c, enemyDeg, { away: true }); // kite
    }
    // Fire along the enemy bearing when ready and loaded.
    if (cd === '0.000' && !empty && enemyDeg !== null) {
      await page.mouse.up();
      await padFireAt(page, enemyDeg);
      shots++;
      await steerAlong(page, c, enemyDeg, { away: true });
      await page.mouse.down();
    }
    if (i % 20 === 19) {
      const overlay = await overlayTitle(page);
      const status = await statusText(page);
      console.log(`[FIGHT] t=${((Date.now() - t0) / 1000).toFixed(0)}s shots=${shots} bites=${hits.bites.length} status="${status}" overlay="${overlay}"`);
      if (overlay) break;
    }
  }
  console.log('[FIGHT] kills/pickups:\n' + logs.filter((l) => l.includes('Enemy down') || l.includes('lysin collected')).join('\n'));
  await page.mouse.up().catch(() => {});
  await browser.close();
})();
