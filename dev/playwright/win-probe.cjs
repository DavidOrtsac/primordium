// Probe: can the match be WON? Aggressive play — steer toward the
// enemy tick until inside ~400 units, fire along the bearing on
// reload, flee briefly on proximity/bite, rearm at the amber dot.
// Run: NODE_PATH=node_modules node win-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame, canvasCenter,
        padBearing, padState, padFireAt, steerAlong,
        overlayTitle } = require('./helpers.cjs');

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

  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(400);
    const enemyDeg = await padBearing(page, 'fire-enemy');
    const lysinDeg = await padBearing(page, 'fire-lysin');
    const { cd, empty, enemyDist } = await padState(page);
    const overlay = await overlayTitle(page);
    if (overlay) {
      console.log(`[WIN] t=${((Date.now() - t0) / 1000).toFixed(0)}s shots=${shots} bites=${hits.bites.length} RESULT: ${overlay}`);
      break;
    }
    const bittenRecently = hits.bites.length && Date.now() - hits.bites[hits.bites.length - 1] < 4000;
    if (bittenRecently && enemyDeg !== null) await steerAlong(page, c, enemyDeg, { away: true });
    else if (empty && lysinDeg !== null) await steerAlong(page, c, lysinDeg);
    else if (enemyDeg !== null) await steerAlong(page, c, enemyDeg, { away: enemyDist < 220 });

    if (cd === '0.000' && !empty && enemyDeg !== null && enemyDist < 450) {
      await page.mouse.up();
      await padFireAt(page, enemyDeg);
      shots++;
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
    }
    if (i % 25 === 24) {
      console.log(`[WIN] t=${((Date.now() - t0) / 1000).toFixed(0)}s shots=${shots} bites=${hits.bites.length} dist=${enemyDist}`);
    }
  }
  console.log('[WIN] kills/pickups:\n' + logs.filter((l) => l.includes('Enemy down') || l.includes('lysin collected') || l.includes('lysovirus detonated')).slice(-20).join('\n'));
  await browser.close();
})();
