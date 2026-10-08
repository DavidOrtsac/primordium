// Visual check: 'a' membrane atoms render as visible gold dots
// (educational view). Walks the tutorial to the protocell paste step,
// then screenshots the pasted cell.
// Run:  PLAYWRIGHT_BROWSERS_PATH=/home/ruben/.playwright-browsers npx playwright test membrane-dots.spec.js --project=chromium
// Needs the app served on :9131

const { test, expect } = require('@playwright/test');
const { openApp, collectErrors } = require('./helpers.cjs');

test('a atoms render as visible dots', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  await page.click('#tutorial-btn');
  // advance through the info steps to the select task so the protocell
  // paste step is reached via its own actions
  await page.click('#tut-next'); // soup info
  await page.click('#tut-next'); // panel tour (opens itself)
  await expect(page.locator('.tutorial-title')).toContainText('Tour of the panel', { timeout: 8000 });
  await page.click('#tut-next'); // task: pause
  await page.keyboard.press(' ');
  await expect(page.locator('.tutorial-title')).toContainText('select some atoms', { timeout: 8000 });
  await page.keyboard.press('m'); // reopen panel (pause-step exit closed it)
  await page.click('#select-btn');
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.tutorial-title')).toContainText('open the inspector', { timeout: 8000 });
  await page.keyboard.press('i');
  await expect(page.locator('.tutorial-title')).toContainText('close the inspector', { timeout: 8000 });
  await page.keyboard.press('Escape'); // closes the inspector, not the tour
  await expect(page.locator('.tutorial-title')).toContainText('switch Select off', { timeout: 8000 });
  await page.click('#select-btn');
  await expect(page.locator('.tutorial-title')).toContainText('A real protocell', { timeout: 8000 });

  // leave the tour (pasted cell stays), clear the inspector, zoom in
  await page.keyboard.press('Escape');
  await page.keyboard.press('m'); // close panel if open
  await page.mouse.move(640, 360);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/membrane-dots.png' });

  expect(errors).toEqual([]);
});
