// Test: guided tutorial — info steps advance via Next, task steps only
// proceed after the real action (panel open, pause, select, paint, lysin,
// inspector, game mode) is performed on the app.
// Run:  PLAYWRIGHT_BROWSERS_PATH=/home/ruben/.playwright-browsers npx playwright test tutorial.spec.js --project=chromium
// Needs the app served on :9131 (bash run.sh or python3 -m http.server 9131 from repo root)

const { test, expect } = require('@playwright/test');
const { openApp, collectErrors } = require('./helpers.cjs');

const title = (page) => page.locator('.tutorial-title');

async function expectStep(page, text) {
  await expect(title(page)).toContainText(text, { timeout: 15000 });
}

test('guided tutorial gates task steps on real user actions', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  await page.click('#tutorial-btn');
  await expect(page.locator('#tutorial-card')).toBeVisible();
  await expectStep(page, 'Welcome to Primordium');

  await page.click('#tut-next');          // soup info
  await expectStep(page, 'atoms, states, bonds');

  await page.click('#tut-next');          // panel tour (opens itself)
  await expectStep(page, 'Tour of the panel');
  await expect(page.locator('#control-panel.open')).toBeVisible();

  // ── Task: pause ──
  await page.click('#tut-next');
  await expectStep(page, 'pause the simulation');
  await page.keyboard.press(' ');
  await expectStep(page, 'select some atoms');

  // ── Task: select atoms — needs the 🎯 brush from the panel ──
  await page.keyboard.press('m');          // open panel
  await page.click('#select-btn');
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 5 });
  await page.mouse.up();
  await expectStep(page, 'open the inspector');

  // ── Task: inspector open + close ──
  await page.keyboard.press('i');
  await expectStep(page, 'close the inspector');
  await page.keyboard.press('Escape');    // closes the inspector, not the tour
  await expectStep(page, 'switch Select off');
  await expect(page.locator('#tut-next')).toBeDisabled(); // gated
  await page.click('#select-btn');        // toggles back to pan
  await expectStep(page, 'A real protocell');              // demo step
  await page.screenshot({ path: 'test-results/gt-protocell.png' });

  // ── Task: open + close the atom dictionary (Learn card) ──
  await page.click('#tut-next');
  await expectStep(page, 'open the atom dictionary');
  await expect(page.locator('#tut-next')).toBeDisabled(); // gated
  await page.click('#dict-btn');
  await expect(page.locator('#lab-tab-dictionary')).toBeVisible();
  await expectStep(page, 'close the dictionary');
  await page.keyboard.press('Escape');    // closes the lab, not the tour
  await expectStep(page, 'track the cell');
  await expect(page.locator('#tut-next')).toBeDisabled(); // gated
  await page.click('#follow-btn');        // user enables Follow
  await expect(page.locator('#follow-btn')).toContainText('ON');
  await page.click('#tut-next');          // genome copying demo
  await expectStep(page, 'Genome copying');
  await page.waitForTimeout(1200);         // let replication tick a bit

  // ── Task: paint soup ──
  await page.click('#tut-next');
  await expectStep(page, 'paint atoms');
  await page.keyboard.press('b');
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 350, { steps: 4 });
  await page.mouse.up();
  await expectStep(page, 'drop some water');

  // ── Task: paint water ──
  await page.keyboard.press('w');
  await page.mouse.click(450, 320);
  await expectStep(page, 'release the lysin');

  // ── Task: lysin ──
  await page.keyboard.press('p');
  await expectStep(page, 'Noise & evolution');

  // ── Task: play mode ──
  await page.click('#tut-next');
  await expectStep(page, 'enter play mode');
  await page.keyboard.press('g');
  await expectStep(page, "You're playing now");
  await page.screenshot({ path: 'test-results/gt-final.png' });

  await page.click('#tut-next');           // Done ✓ closes the tour
  await expect(page.locator('#tutorial-overlay')).toHaveCount(0);
  await expect(page.locator('#game-overlay-title')).toBeHidden();

  expect(errors).toEqual([]);
});

test('Esc does not leave the tutorial — Skip tour does', async ({ page }) => {
  await openApp(page, { settle: 0 });
  await page.click('#tutorial-btn');
  await page.click('#tut-next');
  await page.keyboard.press('Escape');
  // Esc belongs to the app (inspector/lab/panel), never exits the tour.
  await expect(page.locator('#tutorial-card')).toBeVisible();
  await expectStep(page, 'atoms, states, bonds');
  await page.click('#tut-skip');
  await expect(page.locator('#tutorial-overlay')).toHaveCount(0);
});
