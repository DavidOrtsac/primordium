// Test: Primordium web app — serves nothing itself; expects the app on :9131
// Run:  npx playwright install chromium && npx playwright test tutorial.spec.js --project=chromium
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 120000,
  outputDir: 'test-results',
  use: {
    headless: true,
    screenshot: 'on',
    trace: 'on-first-retry',
    // Pre-seed the first-visit intro flag so specs see the plain app.
    storageState: 'storage-state.json',
    launchOptions: {
      args: ['--no-sandbox'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
