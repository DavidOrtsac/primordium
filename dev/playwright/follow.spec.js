// Test: camera follow mode — after selecting atoms, the 🎥 Follow button
// tracks the selection centroid; a manual pan hands the camera back.
// Run:  PLAYWRIGHT_BROWSERS_PATH=/home/ruben/.playwright-browsers npx playwright test follow.spec.js --project=chromium
// Needs the app served on :9131 (bash run.sh or python3 -m http.server 9131 from repo root)

const { test, expect } = require('@playwright/test');
const { openApp, collectErrors } = require('./helpers.cjs');

test('follow mode tracks selection and yields to manual pan', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  // Follow with nothing selected → button is disabled.
  await page.keyboard.press('m');
  await expect(page.locator('#follow-btn')).toBeDisabled();

  // Select across the whole visible canvas — at the initial fit-zoom the
  // entire arena is on screen, so a full-canvas box catches the rigged
  // cells wherever the fluid layout places them (an empty box selects
  // nothing and Follow refuses to start).
  const box = await page.locator('#canvas').boundingBox();
  await page.click('#select-btn');
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.locator('#follow-btn')).toBeEnabled();
  await page.click('#follow-btn');
  await expect(page.locator('#follow-btn')).toContainText('ON');

  // Back to pan: deselectAll fires, but Follow still tracks the
  // captured atoms.
  await page.click('#select-btn');
  await expect(page.locator('#follow-btn')).toContainText('ON');

  // Zooming keeps the track — the camera stays locked on the atoms.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  await expect(page.locator('#follow-btn')).toContainText('ON');

  // Manual pan takes the camera back → Follow releases.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 140, box.y + box.height / 2 - 60, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#follow-btn')).toContainText('OFF');

  expect(errors).toEqual([]);
});
