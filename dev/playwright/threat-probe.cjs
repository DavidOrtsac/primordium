// Probe: how threatening is the enemy seek/bite pressure?
// Starts a match, never steers, samples membrane integrity + bite logs
// every 5s for up to 90s and reports survival.
// Run: NODE_PATH=node_modules node threat-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame,
        overlayTitle, statusText } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page, logs, hits } = await newProbePage(browser, { bites: '[GAME] enemy bite' });
  await openApp(page);
  await startGame(page);
  const t0 = Date.now();
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(5000);
    const overlay = await overlayTitle(page);
    const status = await statusText(page);
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[PROBE] t=${el}s bites=${hits.bites.length} status="${status}" overlay="${overlay}"`);
    if (overlay) { console.log('[PROBE] match ended:', overlay); break; }
  }
  const weaponLogs = logs.filter((l) => l.includes('[WEAPON]') || l.includes('[GAME]'));
  console.log(`[PROBE] result: ${hits.bites.length} bites in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('[PROBE] last events:\n' + weaponLogs.slice(-8).join('\n'));
  await browser.close();
})();
