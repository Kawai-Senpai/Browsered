/** Verify that config defaults and per-launch overrides reach Chromium itself. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserInstance } from '../dist/browser/instance.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { createStores } from '../dist/store/index.js';

const home = mkdtempSync(join(tmpdir(), 'browserd-launch-config-'));
const previousHome = process.env.AGENTBROWSER_HOME;
process.env.AGENTBROWSER_HOME = home;
const stores = createStores(join(home, 'test.sqlite'), join(home, 'blobs'));
try {
  for (const [configured, override, expected] of [
    [true, undefined, true],
    [false, undefined, false],
    [true, false, false],
    [false, true, true],
  ]) {
    let browser;
    try {
      browser = await BrowserInstance.launch({
        profile: `profile-${configured}-${override}`,
        headless: true,
        bundledExtensions: false,
        ...(override === undefined ? {} : { stealth: override }),
      }, stores, { ...DEFAULT_CONFIG, stealth: configured });
      assert.equal(browser.stealth, expected, 'reported mode must match resolved config');
      // Inspect the real spawned process, since JS patches can hide a missing
      // launch flag from page-level navigator.webdriver checks.
      assert.equal(browser.process.spawnargs.includes('--disable-blink-features=AutomationControlled'),
        expected, 'Chromium launch flag must match reported mode');
      console.log(`PASS config=${configured}, override=${override}, effective=${expected}`);
    } finally {
      await browser?.close();
    }
  }
} finally {
  stores.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.AGENTBROWSER_HOME;
  else process.env.AGENTBROWSER_HOME = previousHome;
}
