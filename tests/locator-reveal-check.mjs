/**
 * Live check for locator and login robustness (2026-11-15):
 *
 *  A. Input actions (click/hover/type/press/select) prefer the first VISIBLE
 *     match when no nth is given; read tools (dom.inspect, extract_text) keep
 *     the old "match 0"; an explicit nth is honoured exactly.
 *  B. A control that only appears on hover is clicked by hovering its nearest
 *     visible ancestor first (revealed_by_hovering).
 *  C. page.click{x,y} clicks a viewport point and still verifies.
 *  D. credentials.login on two-step pages: password-only page skips the hidden
 *     identifier; identifier-only page fills and submits the username only.
 *  E. Unchanged behaviour: a hidden-only match still resolves (upload to a
 *     hidden file input works), and nothing visible at all still errors.
 *
 * Runs against a throwaway AGENTBROWSER_HOME, never the real profiles.
 *
 *   node tests/locator-reveal-check.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m-- ${name} ${'-'.repeat(Math.max(0, 56 - name.length))}\x1b[0m\n`);
};

let client;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (res.isError) {
    const err = new Error(`${name}: ${payload.message ?? text}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function check(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ area: currentArea, label, ok: true });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label} \x1b[90m(${Date.now() - started}ms)${detail ? ` ${detail}` : ''}\x1b[0m\n`);
  } catch (err) {
    results.push({ area: currentArea, label, ok: false, error: err.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n         ${err.message}\n`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

const js = async (expression) => (await call('js.evaluate', { expression, return_by_value: true })).value;

/* ------------------------------ fixtures --------------------------------- */

const MAIN_HTML = `<!doctype html><html><head><title>Locator Fixture</title>
<style>
  body { font-family: system-ui; margin: 0; padding: 16px; }
  .mobile { display: none; }
  .row { display: flex; gap: 8px; align-items: center; width: 320px; padding: 8px; border: 1px solid #ccc; }
  .row .pencil { display: none; }
  .row:hover .pencil { display: inline-block; }
  #point { position: absolute; left: 400px; top: 300px; width: 80px; height: 40px; }
  #upload { display: none; }
</style></head><body>
  <nav class="mobile"><button class="save" onclick="window.hits.push('hidden')">Save</button>
    <input class="name" placeholder="Name"></nav>
  <main>
    <button class="save" onclick="window.hits.push('visible')">Save</button>
    <input class="name" placeholder="Name">
    <select class="pick"><option value="a">A</option><option value="b">B</option></select>
    <div class="row" id="row"><span>Location</span><button class="pencil" aria-label="Edit location" onclick="window.hits.push('pencil')">edit</button></div>
    <button id="point" onclick="window.hits.push('point')">Point</button>
    <input id="upload" type="file">
    <p class="ghost" style="display:none">Ghost only</p>
  </main>
  <script>window.hits = [];</script>
</body></html>`;

const PASSWORD_PAGE = `<!doctype html><html><head><title>Password step</title></head><body>
  <form onsubmit="event.preventDefault(); window.submitted = true;">
    <input type="email" name="identifier" id="hiddenEmail" value="me@example.com" style="display:none" tabindex="-1" aria-hidden="true">
    <input type="password" name="Passwd" id="pw">
    <button type="submit">Next</button>
  </form></body></html>`;

const IDENTIFIER_PAGE = `<!doctype html><html><head><title>Identifier step</title></head><body>
  <form onsubmit="event.preventDefault(); window.submitted = document.getElementById('em').value;">
    <input type="email" name="identifier" id="em">
    <button type="submit">Next</button>
  </form></body></html>`;

async function startFixture() {
  const pages = { '/': MAIN_HTML, '/password': PASSWORD_PAGE, '/identifier': IDENTIFIER_PAGE };
  const server = createServer((req, res) => {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[path]);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/* -------------------------------- main ----------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-locator-'));
let fixture;
let transport;

async function main() {
  fixture = await startFixture();
  process.stdout.write(`fixture ${fixture.base}\ndaemon home ${home}\n`);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'warn', AGENTBROWSER_HEADLESS: HEADED ? '0' : '1' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'browserd-locator-test', version: '1.0.0' });
  await client.connect(transport);

  const url = `${fixture.base}/`;
  await call('page.navigate', { url });

  area('A: input actions prefer the visible match');
  await check('page.click text=Save hits the visible button, not the hidden first one', async () => {
    await js('window.hits = []');
    const r = await call('page.click', { text: 'Save' });
    const hits = await js('window.hits');
    must(JSON.stringify(hits) === '["visible"]', `hits ${JSON.stringify(hits)}`);
    must(r.matched_count === 2, `matched_count ${r.matched_count}`);
  });
  await check('page.click selector=.save (CSS) also lands on the visible one', async () => {
    await js('window.hits = []');
    await call('page.click', { selector: '.save' });
    must(JSON.stringify(await js('window.hits')) === '["visible"]', 'wrong button');
  });
  await check('page.click xpath matching text nodes resolves to the visible element', async () => {
    await js('window.hits = []');
    await call('page.click', { xpath: "//button[normalize-space(.)='Save']" });
    must(JSON.stringify(await js('window.hits')) === '["visible"]', 'wrong button');
  });
  await check('page.type selector=.name fills the visible input', async () => {
    await call('page.type', { selector: '.name', text: 'Ugibo' });
    const values = await js("[...document.querySelectorAll('.name')].map(i => i.value)");
    must(JSON.stringify(values) === '["","Ugibo"]', `values ${JSON.stringify(values)}`);
  });
  await check('page.select_option still works on the only (visible) select', async () => {
    await call('page.select_option', { selector: '.pick', values: ['b'] });
    must((await js("document.querySelector('.pick').value")) === 'b', 'not selected');
  });
  await check('explicit nth:0 is honoured exactly (hidden match -> not_visible)', async () => {
    try {
      await call('page.click', { selector: '.save', nth: 0 });
    } catch (err) {
      must(/visible/i.test(err.message), `unexpected error ${err.message}`);
      return 'errored as before';
    }
    throw new Error('nth:0 clicked something instead of failing on the hidden match');
  });
  await check('read tools keep match 0: dom.inspect selector=.save is the hidden nav button', async () => {
    const r = await call('dom.inspect', { selector: '.save' });
    const text = JSON.stringify(r);
    must(/nav|mobile|hidden|display: none|none/i.test(text) || r.visible === false || text.includes('"visible":false'),
      `dom.inspect no longer reports the first (hidden) match: ${text.slice(0, 300)}`);
  });

  area('B: hover-only controls');
  await check('page.click on a pencil shown only on :hover reveals it and clicks', async () => {
    await call('page.hover', { selector: 'h1, body' }).catch(() => {});
    await js('window.hits = []');
    const r = await call('page.click', { selector: '.pencil' });
    must(JSON.stringify(await js('window.hits')) === '["pencil"]', `hits ${JSON.stringify(await js('window.hits'))}`);
    must(typeof r.revealed_by_hovering === 'string', 'no revealed_by_hovering in result');
    return `revealed by ${r.revealed_by_hovering}`;
  });
  await check('page.hover on the hidden pencil also reveals it', async () => {
    const r = await call('page.hover', { selector: '.pencil' });
    must(r.hovered, 'no hovered element');
  });

  area('C: click at a point');
  await check('page.click{x,y} clicks the element under the point and verifies', async () => {
    await js('window.hits = []');
    const box = await js("(() => { const r = document.getElementById('point').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    const r = await call('page.click', { x: box.x, y: box.y });
    must(JSON.stringify(await js('window.hits')) === '["point"]', `hits ${JSON.stringify(await js('window.hits'))}`);
    must(r.clicked && r.clicked.includes('#point'), `clicked ${r.clicked}`);
  });

  area('E: unchanged behaviour');
  await check('upload to a hidden file input still resolves (hidden-only match falls back to it)', async () => {
    const file = join(home, 'upload.txt');
    writeFileSync(file, 'hello');
    await call('page.upload_files', { selector: '#upload', files: [file] });
    must((await js("document.getElementById('upload').files.length")) === 1, 'no file set');
  });
  await check('a selector whose only match is hidden still errors not_visible on click', async () => {
    try {
      await call('page.click', { selector: '.ghost' });
    } catch (err) {
      must(/visible/i.test(err.message), `unexpected error ${err.message}`);
      return 'errored';
    }
    throw new Error('clicked a display:none element with no visible ancestor trigger');
  });

  area('D: two-step logins');
  await call('credentials.save', {
    site: 'fixture', origin: fixture.base, username: 'me@example.com', password: 'correct horse battery',
  });
  await check('password-only page: skips the hidden identifier, fills the password, submits', async () => {
    await call('page.navigate', { url: `${fixture.base}/password` });
    const r = await call('credentials.login', { site: 'fixture' });
    const steps = r.filled;
    must(steps.some((s) => s.field === 'username' && s.skipped), `username not skipped: ${JSON.stringify(steps)}`);
    must(steps.some((s) => s.field === 'password' && s.landed === 21), `password not filled: ${JSON.stringify(steps)}`);
    must((await js('document.getElementById("pw").value.length')) === 21, 'password field empty');
  });
  await check('identifier-only page: fills the username, submits, and says to call again', async () => {
    await call('page.navigate', { url: `${fixture.base}/identifier` });
    const r = await call('credentials.login', { site: 'fixture' });
    must(r.next && /password page/i.test(r.next), `no next hint: ${JSON.stringify(r)}`);
    must((await js('window.submitted')) === 'me@example.com', 'identifier not submitted');
  });
  await check('normal one-page login (both visible) still fills both', async () => {
    await call('page.navigate', { url: `${fixture.base}/identifier` });
    await js(`(() => { const p = document.createElement('input'); p.type = 'password'; p.id = 'pw2'; document.querySelector('form').prepend(p); })()`);
    const r = await call('credentials.login', { site: 'fixture', submit: false });
    must(r.filled.length === 2 && r.filled.every((s) => s.landed > 0), `filled ${JSON.stringify(r.filled)}`);
  });

  await call('browser.close').catch(() => {});
}

main()
  .catch((err) => {
    process.stdout.write(`\n\x1b[31mfatal: ${err.stack ?? err.message}\x1b[0m\n`);
    results.push({ area: 'fatal', label: String(err.message), ok: false });
  })
  .finally(async () => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the profile open a moment longer. */
    }
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`);
    for (const f of failed) process.stdout.write(`  \x1b[31m${f.area} / ${f.label}\x1b[0m\n`);
    process.exit(failed.length ? 1 : 0);
  });
