// Shared helpers for every Evoloom Playwright spec and probe (DRY).
// Specs (npx playwright test) use the page fixture and helpers like
// openApp/startGame/padPress; standalone probes (node x-probe.cjs) use
// launchBrowser/newProbePage on top of the same page helpers.
// Run specs:  PLAYWRIGHT_BROWSERS_PATH=/home/ruben/.playwright-browsers npx playwright test
// Run probes: NODE_PATH=node_modules node <probe>.cjs   (app on :9131)

const { chromium } = require('playwright');

const BASE = 'http://localhost:9131/';
const VIEWPORT = { width: 1920, height: 1080 };
// Pinned chromium build — the cache holds 1217; newer playwright
// revisions resolve via the chromium_headless_shell-1208 symlink.
const CHROMIUM = '/home/ruben/.playwright-browsers/chromium-1217/chrome-linux64/chrome';
// storageState pre-seeds the first-visit intro flag so the modal never
// covers the app under test.
const STORAGE_STATE = require('path').join(__dirname, 'storage-state.json');

// ── Browser/page plumbing (probes) ─────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}

// Fresh context + page with console capture. matchers: { name: needle }
// collects timestamped hits, e.g. collect bites via '[GAME] enemy bite'.
async function newProbePage(browser, matchers = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, storageState: STORAGE_STATE });
  const page = await ctx.newPage();
  const logs = [];
  const hits = {};
  for (const k of Object.keys(matchers)) hits[k] = [];
  page.on('console', (m) => {
    const t = m.text();
    logs.push(t);
    for (const [k, needle] of Object.entries(matchers)) {
      if (t.includes(needle)) hits[k].push(Date.now());
    }
  });
  return { page, logs, hits };
}

// ── App navigation ─────────────────────────────────────────────────────────

// Load the app and wait for the sim to settle.
async function openApp(page, { settle = 2500 } = {}) {
  await page.goto(BASE);
  await page.waitForSelector('#canvas', { timeout: 15000 });
  await page.waitForTimeout(settle);
}

// Collect console errors + pageerrors; assert `errors` is empty at the end.
function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

// Open the controls panel (idempotent-ish: safe when already open).
async function openPanel(page) {
  const open = await page.locator('#control-panel.open').count();
  if (!open) await page.click('#menu-toggle');
  await page.waitForSelector('#control-panel.open', { timeout: 8000 });
}

// Enter a match: panel → game button → fire pad shown.
async function startGame(page) {
  await openPanel(page);
  await page.click('#game-btn');
  await page.waitForSelector('#fire-pad.shown', { timeout: 10000 });
}

// ── Canvas steering (press & hold) ─────────────────────────────────────────

async function canvasCenter(page) {
  const b = await page.locator('#canvas').boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

// Rim indicators use 0deg = up; atan2 math wants 0rad = east.
function bearingToRad(deg) { return (deg - 90) * Math.PI / 180; }

// Move the (held-down) pointer toward/away from a rim bearing.
// away=false steers toward the bearing, away=true flees it.
async function steerAlong(page, center, deg, { away = false, dist = 350 } = {}) {
  const rad = bearingToRad(deg);
  const s = away ? -1 : 1;
  await page.mouse.move(center.x + s * Math.cos(rad) * dist,
                        center.y + s * Math.sin(rad) * dist, { steps: 3 });
}

// ── Fire pad ───────────────────────────────────────────────────────────────

// Press the pad at fractional offset (fx,fy from center, e.g. 0.85,0 = east).
async function padPress(page, fx, fy) {
  const box = await page.locator('#fire-pad').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + fx * box.width / 2,
                         box.y + box.height / 2 + fy * box.height / 2);
  return box;
}

// Fire along a rim bearing (e.g. the enemy tick) — aims at 40% pad radius.
async function padFireAt(page, deg) {
  const rad = bearingToRad(deg);
  const box = await page.locator('#fire-pad').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + Math.cos(rad) * box.width * 0.4,
                         box.y + box.height / 2 + Math.sin(rad) * box.height * 0.4);
  return box;
}

// Rotation in degrees of a rim indicator ('fire-enemy' | 'fire-lysin')
// or null when hidden/not rotated.
async function padBearing(page, id) {
  return page.evaluate((eid) => {
    const el = document.getElementById(eid);
    const m = /rotate\((-?[\d.]+)deg\)/.exec(el?.style.transform || '');
    return el?.classList.contains('shown') && m ? parseFloat(m[1]) : null;
  }, id);
}

// Pad state: cooldown fraction, empty-magazine flag, enemy distance.
async function padState(page) {
  return page.evaluate(() => ({
    cd: document.getElementById('fire-pad')?.style.getPropertyValue('--cd').trim(),
    empty: document.getElementById('fire-pad')?.classList.contains('empty'),
    enemyDist: parseFloat(document.getElementById('fire-enemy')?.dataset.dist || '0'),
  }));
}

// Overlay title — display-aware: a hidden overlay keeps stale text and
// would fake a match end (threat-probe bug).
async function overlayTitle(page) {
  return page.evaluate(() => {
    const o = document.getElementById('game-overlay');
    return o && getComputedStyle(o).display !== 'none'
      ? (document.getElementById('game-overlay-title')?.textContent || '') : '';
  });
}

async function statusText(page) {
  return page.evaluate(() => document.getElementById('status')?.textContent || '');
}

// ── Polling ────────────────────────────────────────────────────────────────

// Plain poll for probes (specs have expect.poll). Returns the truthy
// value or null on timeout.
async function pollUntil(fn, { timeout = 10000, interval = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Wait for the pad reload to ENGAGE then drain — the snapshot lags the
// worker log, so a stale 0.000 from the previous reload must be skipped.
async function waitReload(page, { engageTimeout = 5000, drainTimeout = 15000 } = {}) {
  const cd = () => page.evaluate(
    () => document.getElementById('fire-pad')?.style.getPropertyValue('--cd').trim());
  const engaged = await pollUntil(async () => (await cd()) !== '0.000', { timeout: engageTimeout });
  if (!engaged) return false;
  return !!(await pollUntil(async () => (await cd()) === '0.000', { timeout: drainTimeout }));
}

module.exports = {
  BASE, VIEWPORT, CHROMIUM, STORAGE_STATE,
  launchBrowser, newProbePage,
  openApp, collectErrors, openPanel, startGame,
  canvasCenter, bearingToRad, steerAlong,
  padPress, padFireAt, padBearing, padState,
  overlayTitle, statusText, pollUntil, waitReload,
};
