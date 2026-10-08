// End-to-end smoke test for the Capacitor app pipeline.
// Rebuilds the web bundle, assembles www/, re-syncs the native projects
// (cap copy) and asserts that every file the WebView needs actually
// landed in android/ and ios/.
// Run: npm test
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
  console.log(`[TEST] $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
};

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`[TEST] PASS ${name}`);
  } catch (err) {
    console.error(`[TEST] FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

const file = (p) => join(root, p);
const isNonEmpty = (p, minBytes = 1024) =>
  existsSync(file(p)) && statSync(file(p)).size > minBytes;

console.log('[TEST] building web bundle and assembling www/');
run('npm', ['run', 'build:app']);

console.log('[TEST] syncing web assets into native projects');
run('npx', ['cap', 'copy']);

const webAssets = ['index.html', 'dist/bundle.js', 'dist/worker.js'];

check('dist/bundle.js built', () => assert.ok(isNonEmpty('dist/bundle.js', 50_000)));
check('dist/worker.js built', () => assert.ok(isNonEmpty('dist/worker.js', 30_000)));

for (const asset of webAssets) {
  check(`www/${asset}`, () => assert.ok(isNonEmpty(`www/${asset}`)));
}

check('index.html loads dist/bundle.js', () => {
  const html = readFileSync(file('www/index.html'), 'utf8');
  assert.ok(html.includes('dist/bundle.js'), 'no bundle.js reference found');
});

check('capacitor.config.ts appId', () => {
  const cfg = readFileSync(file('capacitor.config.ts'), 'utf8');
  assert.ok(cfg.includes("appId: 'net.transcendiant.primordium'"));
});

check('android capacitor.config.json appId', () => {
  const cfg = JSON.parse(readFileSync(file('android/app/src/main/assets/capacitor.config.json'), 'utf8'));
  assert.equal(cfg.appId, 'net.transcendiant.primordium');
});

for (const asset of webAssets) {
  check(`android asset ${asset}`, () =>
    assert.ok(isNonEmpty(`android/app/src/main/assets/public/${asset}`)));
}

for (const asset of webAssets) {
  check(`ios asset ${asset}`, () =>
    assert.ok(isNonEmpty(`ios/App/App/public/${asset}`)));
}

if (process.exitCode) {
  console.error('[TEST] some checks failed');
} else {
  console.log(`[TEST] all ${passed} checks passed`);
}
