/** page.screenshot mode:sheet, on a real page with known bands of colour. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'browserd-sheet-'));
const previousHome = process.env.AGENTBROWSER_HOME;
process.env.AGENTBROWSER_HOME = home;

const { BrowserRegistry } = await import('../dist/browser/registry.js');
const { DEFAULT_CONFIG } = await import('../dist/config.js');
const { createStores } = await import('../dist/store/index.js');
const { parseAspect, screenshot, sheetColumns } = await import('../dist/ops/page.js');

assert.equal(parseAspect(undefined), 1.6);
assert.equal(parseAspect('4:3'), 4 / 3);
assert.equal(parseAspect('16/9'), 16 / 9);
assert.equal(parseAspect(2), 2);
assert.throws(() => parseAspect('wide'), /aspect must look like/);
assert.equal(sheetColumns(320, 6000, 1.6), 5);
assert.equal(sheetColumns(1280, 3200, 1.6), 2);
assert.equal(sheetColumns(1280, 600, 1.6), 1);
assert.equal(sheetColumns(320, 900000, 1.6), 12);
console.log('PASS the column maths');

const stores = createStores(join(home, 'test.sqlite'), join(home, 'blobs'));
const registry = new BrowserRegistry(stores, { ...DEFAULT_CONFIG, autoLaunchHeadless: true, autoLaunchProfile: 'sheet' });
try {
  const browser = await registry.resolve();
  const ctx = { stores, registry, config: DEFAULT_CONFIG };
  const page = (height) =>
    `data:text/html,<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0"><div id=w></div><div style="height:${height}px;background:linear-gradient(red,blue)"></div>`;

  const session = browser.targets.list().find((t) => t.type === 'page').session;

  await session.send('Page.navigate', { url: page(6000) });
  await new Promise((r) => setTimeout(r, 600));

  const before = await session.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true });
  const phone = await screenshot(ctx, { mode: 'sheet', width: 320 });
  assert.equal(phone.mode, 'sheet');
  assert.equal(phone.page_size.width, 320);
  assert.equal(phone.columns, sheetColumns(320, phone.page_size.height, 1.6));
  assert.ok(phone.columns >= 4, `a tall phone page takes several columns, got ${phone.columns}`);
  assert.ok(phone._image.data.length > 1000, 'an image came back');
  const shape = phone.sheet_size.width / phone.sheet_size.height;
  assert.ok(shape > 1.1 && shape < 2.3, `close to 16:10, got ${shape}`);
  const after = await session.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true });
  assert.equal(after.result.value, before.result.value, 'the viewport is put back');
  console.log(`PASS phone sheet: ${phone.columns} columns, ${phone.sheet_size.width}x${phone.sheet_size.height}`);

  const set = await screenshot(ctx, { mode: 'sheet', width: 1280, columns: 3, return_image: false, label: 'desk' });
  assert.equal(set.columns, 3);
  assert.equal(set._image, undefined, 'return_image:false is honoured');
  assert.ok(set.sheet_size.width <= 2000, `capped at 2000, got ${set.sheet_size.width}`);
  assert.ok(set.scaled < 1, 'a wide page is scaled to fit');
  console.log(`PASS desktop sheet: ${set.columns} columns, scaled ${set.scaled}`);

  const targets = await browser.browserSession.send('Target.getTargets');
  assert.equal(targets.targetInfos.filter((t) => t.type === 'page').length, 1, 'the scratch tab is gone');
  console.log('PASS no scratch tab left behind');

  await session.send('Page.navigate', { url: page(30000) });
  await new Promise((r) => setTimeout(r, 600));
  const tall = await screenshot(ctx, { mode: 'sheet', width: 320, return_image: true });
  assert.equal(tall.columns, 12, 'a very long page uses the column limit');
  const bytes = Buffer.from(tall._image.data, 'base64');
  assert.equal(bytes[0], 0xff, 'a real JPEG');
  console.log(`PASS 30000px page: ${tall.sheet_size.width}x${tall.sheet_size.height}`);

  const full = await screenshot(ctx, { mode: 'full_page', format: 'jpeg', return_image: false });
  assert.match(String(full.hint), /mode:"sheet"/, 'a tall full_page points at the sheet');
  console.log('PASS a tall full_page suggests the sheet');
  await browser.close();
} finally {
  await registry.closeAll();
  stores.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (previousHome === undefined) delete process.env.AGENTBROWSER_HOME;
  else process.env.AGENTBROWSER_HOME = previousHome;
}
