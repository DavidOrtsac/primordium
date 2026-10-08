// Probe: dump fire-pad internals (cooldown var, rim tick transforms)
// for debugging aim/bearing rendering.
// Run: NODE_PATH=node_modules node pad-debug.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page } = await newProbePage(browser);
  page.on('console', (m) => { if (m.text().includes('nearest enemy')) console.log('  ' + m.text()); });
  await openApp(page);
  await startGame(page);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({
      cd: document.getElementById('fire-pad')?.style.getPropertyValue('--cd'),
      empty: document.getElementById('fire-pad')?.className,
      enemy: document.getElementById('fire-enemy')?.className + ' | ' + document.getElementById('fire-enemy')?.style.transform,
      lysin: document.getElementById('fire-lysin')?.className + ' | ' + document.getElementById('fire-lysin')?.style.transform,
    }));
    console.log(`[DBG] ${JSON.stringify(s)}`);
  }
  await browser.close();
})();
