/** Exercise the shipped screenshot popup, overlay, and preview in headed Chromium. */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { BrowserRegistry } from '../dist/browser/registry.js';
import { loadConfig } from '../dist/config.js';
import { createStores } from '../dist/store/index.js';
import { bundledExtensions } from '../dist/util/paths.js';

const home = await mkdtemp(join(tmpdir(), 'browserd-screenshot-'));
process.env.AGENTBROWSER_HOME = home;
const stores = createStores();
const registry = new BrowserRegistry(stores, loadConfig());
const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><title>Screenshot fixture</title>
    <style>
      body { margin: 0; height: 2200px; background: rgb(24, 70, 120); }
      #sample { position: absolute; left: 40px; top: 700px; width: 210px; height: 180px; background: rgb(184, 65, 32); }
      #bottom { position: absolute; top: 2100px; inset-inline: 0; height: 100px; background: rgb(42, 142, 75); }
    </style>
    <button type="button">Keep focus</button><div id="sample"></div><div id="bottom"></div>`);
});

async function eventually(check, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(target, expression) {
  const { result, exceptionDetails } = await target.session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

function color(image, x, y) {
  const offset = (image.width * y + x) * 4;
  return [...image.data.subarray(offset, offset + 3)];
}

try {
  await new Promise((resolve, reject) => fixture.listen(0, '127.0.0.1', resolve).once('error', reject));
  const source = bundledExtensions().find((dir) => dir.split(/[\\/]/).at(-1) === 'screenshot');
  assert.ok(source, 'Screenshot extension was not bundled');
  const extension = join(home, 'test-extension');
  await cp(source, extension, { recursive: true });
  // The test drives the popup over CDP in its own browser and profile.
  // captureVisibleTab requires this grant when there's no toolbar gesture.
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const browser = await registry.launch({
    profile: 'screenshots', headless: false, bundledExtensions: false, extensions: [extension],
    windowSize: { width: 900, height: 650 },
  });
  const page = await browser.resolvePageOrOpen();
  await page.session.send('Page.navigate', { url: `http://127.0.0.1:${fixture.address().port}/` });
  await eventually(() => evaluate(page, 'document.title === "Screenshot fixture"'), 'fixture page');

  const worker = await eventually(async () => {
    for (const target of browser.targets.list()) {
      if (target.type !== 'service_worker' || !target.info.url.startsWith('chrome-extension://')) continue;
      const name = await evaluate(target, 'chrome.runtime.getManifest().name').catch(() => null);
      if (name === 'Browsered Screenshot') return target;
    }
  }, 'screenshot service worker');
  const popupUrl = new URL('popup.html', worker.info.url).href;
  async function choose(mode) {
    const tabId = await evaluate(worker, `chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false }).then(tab => tab.id)`);
    const popup = await eventually(() => browser.targets.listPages().find((target) => target.info.url === popupUrl), 'screenshot popup');
    await eventually(() => evaluate(popup, 'document.readyState === "complete" && document.querySelectorAll("button[data-mode]").length === 3'), 'popup controls');
    if (mode === 'visible') {
      await popup.session.send('Emulation.setDeviceMetricsOverride', { width: 120, height: 560, deviceScaleFactor: 1, mobile: false });
      const layout = await evaluate(popup, `({
        width: document.body.getBoundingClientRect().width,
        heading: document.querySelector('h1').getBoundingClientRect().height,
      })`);
      assert.ok(layout.width >= 270 && layout.heading < 30, `popup collapsed at its initial width: ${JSON.stringify(layout)}`);
      await popup.session.send('Emulation.clearDeviceMetricsOverride');
    }
    await evaluate(popup, `document.querySelector('[data-mode="${mode}"]').click()`);
    return async () => evaluate(worker, `chrome.tabs.remove(${tabId}).catch(() => {})`);
  }
  const previewUrl = new URL('preview.html', worker.info.url).href;
  const [sourceTab] = await evaluate(worker, 'chrome.tabs.query({ active: true, lastFocusedWindow: true })');
  async function capturePreview() {
    const tab = await eventually(async () => {
      const title = await evaluate(worker, `chrome.action.getTitle({ tabId: ${sourceTab.id} })`);
      assert.equal(title, 'Browsered Screenshot', title);
      return browser.targets.listPages().find((target) => target.info.url.startsWith(`${previewUrl}#`));
    }, 'screenshot preview tab');
    await eventually(() => evaluate(tab, '!document.querySelector("#copy")?.disabled && document.querySelector("#capture")?.naturalWidth'), 'decoded image');
    const bytes = await evaluate(tab, `fetch(document.querySelector('#capture').src).then(r => r.blob()).then(blob => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    }))`);
    return { tab, bytes, image: PNG.sync.read(Buffer.from(bytes, 'base64')) };
  }
  async function closePreview(tab) {
    await browser.browserSession.send('Target.closeTarget', { targetId: tab.cdpTargetId });
    await browser.browserSession.send('Target.activateTarget', { targetId: page.cdpTargetId });
  }

  const viewport = await evaluate(page, '({height: window.innerHeight * window.devicePixelRatio})');
  const dismissVisible = await choose('visible');
  const visible = await capturePreview();
  await dismissVisible();
  assert.ok(visible.image.width >= 500 && Math.abs(visible.image.height - viewport.height) <= 1,
    `expected the visible viewport, got ${visible.image.height}px for ${viewport.height}px`);
  assert.deepEqual(color(visible.image, 10, 120), [24, 70, 120]);
  assert.equal(await evaluate(visible.tab, 'document.activeElement.id'), 'copy');
  // Intercept the final OS write so this check never replaces the user's real
  // clipboard. The button still builds and submits a real image ClipboardItem.
  await evaluate(visible.tab, `Object.defineProperty(navigator.clipboard, 'write', {
    value: async ([item]) => {
      const blob = await item.getType('image/png');
      window.copiedScreenshot = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
    }
  }); document.querySelector('#copy').click()`);
  assert.equal(await eventually(() => evaluate(visible.tab, 'window.copiedScreenshot'), 'clipboard image'), visible.bytes);
  assert.equal(await evaluate(visible.tab, 'document.querySelector("#status").textContent'), 'Image copied to clipboard.');
  await evaluate(visible.tab, `window.copiedScreenshot = null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))`);
  assert.equal(await eventually(() => evaluate(visible.tab, 'window.copiedScreenshot'), 'keyboard clipboard image'), visible.bytes);
  console.log('PASS visible capture opens a preview and Copy submits its exact PNG');
  await evaluate(visible.tab, 'document.querySelector("#save").click()');
  const saved = await eventually(async () => {
    const files = await readdir(join(home, 'capsules'));
    return files.find((name) => name.endsWith('.png'));
  }, 'saved PNG');
  assert.deepEqual(await readFile(join(home, 'capsules', saved)), Buffer.from(visible.bytes, 'base64'));
  console.log('PASS Save PNG exports the preview image');

  await evaluate(visible.tab, 'document.querySelector("#draw").click()');
  const box = await evaluate(visible.tab, 'document.querySelector("#ink").getBoundingClientRect().toJSON()');
  const drawY = box.top + Math.min(90, box.height / 3);
  const drawStart = box.left + box.width / 4;
  const drawEnd = box.left + box.width / 2;
  const bendX = (drawStart + drawEnd) / 2;
  const bendY = drawY - 26;
  for (const [type, x, y, buttons] of [
    ['mousePressed', drawStart, drawY, 1], ['mouseMoved', bendX, bendY, 1],
    ['mouseMoved', drawEnd, drawY, 1], ['mouseReleased', drawEnd, drawY, 0],
  ]) {
    await visible.tab.session.send('Input.dispatchMouseEvent', {
      type, x, y, buttons, button: 'left', clickCount: 1,
    });
    await delay(50);
  }
  await eventually(() => evaluate(visible.tab, '!document.querySelector("#undo").disabled'), 'drawn stroke');
  await evaluate(visible.tab, 'window.copiedScreenshot = null; document.querySelector("#copy").click()');
  const annotation = await eventually(() => evaluate(visible.tab, 'window.copiedScreenshot'), 'annotated clipboard image');
  const marked = PNG.sync.read(Buffer.from(annotation, 'base64'));
  assert.equal(marked.width, visible.image.width);
  assert.equal(marked.height, visible.image.height);
  const inkAt = color(marked, Math.round(marked.width * 0.375), Math.round((bendY - box.top) * marked.height / box.height));
  assert.deepEqual(inkAt, [224, 43, 50], 'the freehand stroke must include its bend');
  await evaluate(visible.tab, 'document.querySelector("#save").click()');
  const annotatedSave = await eventually(async () => {
    const files = await readdir(join(home, 'capsules'));
    return files.find((name) => name !== saved && name.endsWith('.png'));
  }, 'saved annotated image');
  assert.deepEqual(await readFile(join(home, 'capsules', annotatedSave)), Buffer.from(annotation, 'base64'));
  await evaluate(visible.tab, 'document.querySelector("#undo").click(); window.copiedScreenshot = null; document.querySelector("#copy").click()');
  assert.equal(await eventually(() => evaluate(visible.tab, 'window.copiedScreenshot'), 'clipboard image after Undo'), visible.bytes);
  await closePreview(visible.tab);
  console.log('PASS Draw, Copy, Save PNG and Undo preserve the original pixel dimensions');

  await evaluate(page, 'window.scrollTo(0, 620)');
  const dismissFull = await choose('full');
  const full = await capturePreview();
  await dismissFull();
  assert.ok(full.image.height >= 2200, `expected the scrollable document, got ${full.image.height}px`);
  assert.deepEqual(color(full.image, 10, full.image.height - 20), [42, 142, 75],
    'the bottom section must appear in the PNG');
  const fullRatio = full.image.height / 2200;
  assert.deepEqual(color(full.image, Math.round(100 * fullRatio), Math.round(760 * fullRatio)),
    [184, 65, 32], 'the middle section must appear in the PNG');
  await closePreview(full.tab);
  assert.equal(await evaluate(page, 'window.scrollY'), 620);
  console.log('PASS full page saves below-fold content and preserves scroll');

  const overlay = 'document.querySelector("[popover][role=group]")';
  const dismissCancelled = await choose('region');
  await eventually(() => evaluate(page, `!!${overlay}`), 'selection overlay');
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await eventually(() => evaluate(page, `!${overlay}`), 'Escape cancellation');
  await dismissCancelled();
  assert.ok(!browser.targets.listPages().some((target) => target.info.url.startsWith(`${previewUrl}#`)),
    'Escape should not open a preview');
  console.log('PASS Escape dismisses selection without exporting');

  const dismissRegion = await choose('region');
  await eventually(() => evaluate(page, `!!${overlay}`), 'selection overlay');
  const pointer = (type, x, y, buttons) => page.session.send('Input.dispatchMouseEvent', {
    type, x, y, buttons, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1,
  });
  await pointer('mousePressed', 180, 200, 1);
  await pointer('mouseMoved', 68, 105, 1);
  await pointer('mouseReleased', 68, 105, 0);
  const region = await capturePreview();
  await dismissRegion();
  const dpr = await evaluate(page, 'window.devicePixelRatio');
  const { image } = region;
  assert.ok(Math.abs(image.width - 112 * dpr) <= 1, `unexpected region width ${image.width}`);
  assert.ok(Math.abs(image.height - 95 * dpr) <= 1, `unexpected region height ${image.height}`);
  assert.deepEqual(color(image, 3, 3), [184, 65, 32]);
  assert.deepEqual(color(image, image.width - 4, image.height - 4), [184, 65, 32]);
  await closePreview(region.tab);
  assert.equal(await evaluate(page, `!!${overlay}`), false);
  console.log('PASS reverse drag crops the right part of a scrolled page without the overlay');
} finally {
  await registry.closeAll();
  stores.close();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
