// Probe: die passively, then restart via Enter — a new match must
// begin (enemy tick back, overlay gone, bites reset).
// Run: NODE_PATH=node_modules node restart-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp, startGame } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page } = await newProbePage(browser);
  await openApp(page);
  await startGame(page);
  // Wait for death overlay (passive player dies in ~60 s).
  await page.waitForSelector('#game-overlay', { state: 'visible', timeout: 150000 });
  const title = await page.locator('#game-overlay-title').textContent();
  const btns = await page.locator('#game-overlay-buttons').isVisible();
  console.log(`[RESTART] dead at overlay="${title}", buttons visible=${btns}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({
    overlay: getComputedStyle(document.getElementById('game-overlay')).display,
    tick: document.getElementById('fire-enemy').className,
    status: document.getElementById('status')?.textContent,
  }));
  console.log(`[RESTART] after Enter: overlay=${after.overlay} tick="${after.tick}" status="${after.status}"`);
  console.log(after.overlay === 'none' && after.tick.includes('shown') ? '[RESTART] PASS' : '[RESTART] FAIL');
  await browser.close();
})();
