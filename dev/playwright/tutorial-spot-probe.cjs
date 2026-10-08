// Probe: tutorial step 'Noise & evolution' must scroll the panel so
// #noise-btn is visible and ring it with the spotlight.
// Replays the tour up to that step, then compares the spot rect with
// the button rect and screenshots the result.
// Run: NODE_PATH=node_modules node tutorial-spot-probe.cjs  (app on :9131)
const { launchBrowser, newProbePage, openApp } = require('./helpers.cjs');

(async () => {
  const browser = await launchBrowser();
  const { page } = await newProbePage(browser);
  await openApp(page);
  const title = page.locator('.tutorial-title');
  const step = async (t) => {
    await page.waitForFunction(
      (want) => document.querySelector('.tutorial-title')?.textContent.includes(want),
      t, { timeout: 15000 });
  };

  await page.click('#tutorial-btn');
  await step('Welcome to Evoloom');
  await page.click('#tut-next'); await step('atoms, states, bonds');
  await page.click('#tut-next'); await step('Tour of the panel');
  await page.click('#tut-next'); await step('pause the simulation');
  await page.keyboard.press(' '); await step('select some atoms');
  await page.keyboard.press('m');
  await page.click('#select-btn');
  await page.mouse.move(300, 200); await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 5 }); await page.mouse.up();
  await step('open the inspector');
  await page.keyboard.press('i'); await step('close the inspector');
  await page.keyboard.press('Escape'); await step('switch Select off');
  await page.click('#select-btn'); await step('A real protocell');
  await page.click('#tut-next'); await step('open the atom dictionary');
  await page.click('#dict-btn'); await step('close the dictionary');
  await page.keyboard.press('Escape'); await step('track the cell');
  await page.click('#follow-btn');
  await page.click('#tut-next'); await step('Genome copying');
  await page.click('#tut-next'); await step('paint atoms');
  await page.keyboard.press('b');
  await page.mouse.move(400, 300); await page.mouse.down();
  await page.mouse.move(500, 350, { steps: 4 }); await page.mouse.up();
  await step('drop some water');
  await page.keyboard.press('w');
  await page.mouse.click(450, 320); await step('release the lysin');
  await page.keyboard.press('p'); await step('Noise & evolution');
  await page.waitForTimeout(400);              // let the re-aim land

  const m = await page.evaluate(() => {
    const r = (id) => document.getElementById(id)?.getBoundingClientRect();
    const btn = r('noise-btn'), spot = r('tutorial-spot');
    const vis = btn && btn.top >= 0 && btn.bottom <= innerHeight;
    return { btn: btn && { t: btn.top, l: btn.left, w: btn.width, h: btn.height },
             spot: spot && { t: spot.top, l: spot.left, w: spot.width, h: spot.height },
             hidden: document.getElementById('tutorial-spot').hidden,
             btnVisible: vis, vh: innerHeight };
  });
  console.log('[SPOT]', JSON.stringify(m));
  const ok = m.btnVisible && !m.hidden &&
    Math.abs(m.spot.t - m.btn.t) < 12 && Math.abs(m.spot.l - m.btn.l) < 12;
  console.log(ok ? '[SPOT] PASS — noise button ringed + visible' : '[SPOT] FAIL');
  await page.screenshot({ path: 'test-results/spot-noise.png' });
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
