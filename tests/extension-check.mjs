/**
 * Verify the bundled Context Capsule extension actually loads into a headed
 * browser launched by browserd, and that its stripped export path is intact.
 *
 *   node tests/extension-check.mjs [--keep]
 */
import { BrowserRegistry } from '../dist/browser/registry.js';
import { loadConfig } from '../dist/config.js';
import { createStores } from '../dist/store/index.js';
import { bundledExtensions } from '../dist/util/paths.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEEP = process.argv.includes('--keep');
const home = mkdtempSync(join(tmpdir(), 'browserd-ext-'));
process.env.AGENTBROWSER_HOME = home;

let pass = 0;
let fail = 0;
const ok = (l, d = '') => {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`);
};
const no = (l, e) => {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${l}\n        ${e}`);
};
const test = async (l, fn) => {
  try {
    ok(l, await fn());
  } catch (e) {
    no(l, e.message);
  }
};
const must = (c, m) => {
  if (!c) throw new Error(m);
};

const config = { ...loadConfig(), autoLaunchProfile: 'ext-check' };
const stores = createStores();
const registry = new BrowserRegistry(stores, config);

console.log('\n\x1b[1mBundled extension\x1b[0m\n');

let instance;
try {
  await test('bundled extension is present on disk', async () => {
    const dirs = bundledExtensions();
    must(dirs.length >= 1, 'no bundled extensions found');
    const manifest = JSON.parse(readFileSync(join(dirs[0], 'manifest.json'), 'utf8'));
    must(manifest.name === 'Context Capsule', `unexpected name: ${manifest.name}`);
    must(!manifest.permissions.includes('nativeMessaging'), 'nativeMessaging still requested');
    return `${manifest.name} v${manifest.version}, ${manifest.permissions.length} permissions`;
  });

  await test('native messaging is fully stripped from the vendored code', async () => {
    const dir = bundledExtensions()[0];
    const src = readFileSync(join(dir, 'sidepanel.js'), 'utf8');
    for (const banned of ['connectNative', 'com.contextcapsule', 'describeNativeError']) {
      must(!src.includes(banned), `${banned} still present`);
    }
    must(src.includes('writeCapsuleToDownload'), 'download replacement missing');
    return 'downloads-only export path';
  });

  // Headed on purpose: extensions are skipped headless, and this is the case
  // a human actually gets.
  await test('headed launch loads the extension', async () => {
    instance = await registry.launch({ profile: 'ext-check', headless: false });
    must(instance.extensions.length >= 1, 'launcher reported no extensions loaded');
    return instance.extensions.map((p) => p.split(/[\\/]/).pop()).join(', ');
  });

  /*
   * Chrome ships its own component extensions, and more than one of them uses a
   * background.js service worker, so matching on the URL alone picks the wrong
   * extension. Ask each candidate worker what its manifest name is instead:
   * only ours answers "Context Capsule".
   */
  async function capsuleWorker() {
    for (const t of instance.targets.list()) {
      if (!String(t.info.url).startsWith('chrome-extension://')) continue;
      try {
        const { result } = await t.session.send('Runtime.evaluate', {
          expression: `chrome.runtime.getManifest().name`,
          returnByValue: true,
        });
        if (result.value === 'Context Capsule') return t;
      } catch {
        // Not an extension context we can evaluate in; keep looking.
      }
    }
    return undefined;
  }

  await test('Chromium attaches the extension service worker as a target', async () => {
    // The service worker registers asynchronously after the browser is up.
    const deadline = Date.now() + 15_000;
    let found;
    while (Date.now() < deadline) {
      found = await capsuleWorker();
      if (found) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    must(found, 'Context Capsule service worker not attached within 15s');
    return `${found.type} ${found.info.url.slice(0, 58)}`;
  });

  await test('the extension id is stable and its pages are reachable', async () => {
    const target = await capsuleWorker();
    must(target, 'Context Capsule service worker not found');
    const id = new URL(target.info.url).host;
    must(id.length === 32, `unexpected extension id: ${id}`);

    /*
     * Open the panel through the extension's own tabs API rather than
     * navigating an existing tab: Chrome refuses cross-origin navigation to a
     * chrome-extension:// URL and serves ERR_FILE_NOT_FOUND, which looks
     * exactly like a broken bundle but is not one.
     */
    await target.session.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html'), active: false })`,
    });

    const deadline = Date.now() + 10_000;
    let panel;
    while (Date.now() < deadline) {
      panel = instance.targets.list().find((t) => String(t.info.url).endsWith('/sidepanel.html'));
      if (panel) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    must(panel, 'side panel target never appeared');
    await new Promise((r) => setTimeout(r, 1200));

    const { result } = await panel.session.send('Runtime.evaluate', {
      expression: `({ title: document.title, buttons: document.querySelectorAll('button').length })`,
      returnByValue: true,
    });
    must(
      result.value.buttons > 0,
      `side panel rendered no buttons: ${JSON.stringify(result.value)}`,
    );
    must(result.value.title === 'Context Capsule', `unexpected title: ${result.value.title}`);
    return `id=${id.slice(0, 8)}… panel: ${result.value.buttons} controls`;
  });

  await test('export button reflects the downloads-only build', async () => {
    const panel = instance.targets
      .list()
      .find((t) => String(t.info.url).endsWith('/sidepanel.html'));
    must(panel, 'side panel not open');
    const { result } = await panel.session.send('Runtime.evaluate', {
      expression: `document.getElementById('exportButton')?.textContent.trim()`,
      returnByValue: true,
    });
    must(String(result.value).includes('Downloads'), `label was "${result.value}"`);
    return `"${result.value}"`;
  });

  await test('headless launch skips the extension', async () => {
    const headless = await registry.launch({ profile: 'ext-check-headless', headless: true });
    const count = headless.extensions.length;
    await headless.close();
    must(count === 0, `headless loaded ${count} extensions`);
    return 'no extensions headless';
  });
} catch (err) {
  no('harness', err.stack ?? err.message);
} finally {
  await registry.closeAll().catch(() => {});
  stores.close();
  // Windows keeps a handle on the profile for a moment after Chromium exits, so
  // an immediate rmSync throws EPERM and hides the actual result. Retry briefly.
  if (!KEEP) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(home, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}
