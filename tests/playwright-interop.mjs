/**
 * browserd's claims about Playwright, checked against Playwright.
 *
 * Four tools exist to be consumed by a Playwright-based test harness, and each
 * makes a claim browserd cannot verify on its own:
 *
 *   locator.candidates / locator.check  "this locator matches N elements"
 *   page.snapshot format:aria           "this parses as an aria expectation"
 *   storage.export format:playwright    "this loads as a storageState"
 *   network.export_har                  "this replays under routeFromHAR"
 *
 * Chrome's accessibility tree and Playwright's locator engine are independent
 * implementations, so agreement is a fact to measure rather than assume. This
 * drives one fixture through both and diffs the answers. It is worth its weight:
 * it caught format:aria emitting a tree that failed to parse at all, which every
 * assertion written inside browserd had called fine.
 *
 * Needs a Playwright browser: npx playwright install chromium
 *
 *   node tests/playwright-interop.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// expect works standalone for locator matchers; toMatchAriaSnapshot does not,
// which is why that one assertion is delegated to the runner (see ariaSuite).
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
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

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, ok: true, area: currentArea });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}\n`);
  } catch (err) {
    results.push({ label, ok: false, area: currentArea, err });
    const detail = String(err.message).split('\n').slice(0, 14).join('\n       ');
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${detail}\n`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* ------------------------------- fixtures -------------------------------- */

/**
 * Every case where a wrong count would cost a test: one name contained in
 * another, one name in two landmarks, and names computed from a label, an
 * aria-label or an aria-labelledby rather than from the element's own text.
 */
const LOCATOR_FIXTURE = [
  '<!doctype html><html lang=en><meta charset=utf-8><title>Interop Fixture</title>',
  '<body>',
  '<header>',
  '  <nav aria-label="Primary"><a href="/models">Models</a><a href="/pricing">Pricing</a></nav>',
  '</header>',
  '<main>',
  '  <h1>Account</h1>',
  '  <h2>Details</h2>',
  '  <form>',
  '    <label for=email>Email address</label>',
  '    <input id=email name=email>',
  '    <label>Postcode <input id=postcode name=postcode></label>',
  '    <input id=search type=search aria-label="Search products">',
  '    <label for=agree>I agree to the terms</label>',
  '    <input id=agree type=checkbox checked>',
  '    <span id=lbl>Delete account</span>',
  '    <button id=danger aria-labelledby=lbl></button>',
  '    <button id=save data-testid="save-btn">Save</button>',
  '    <button id=saveclose>Save and close</button>',
  '    <button id=archive disabled>Archive</button>',
  '  </form>',
  '  <ul><li>First item</li><li>Second item</li></ul>',
  '  <p id=ghost aria-hidden="true">Hidden from assistive technology</p>',
  '  <div id=plain>A plain div with text</div>',
  '</main>',
  '<footer>',
  '  <nav aria-label="Secondary"><a href="/models">Models</a></nav>',
  '</footer>',
  '</html>',
].join('\n');

/** A page with a subresource and an XHR, so a HAR has something to replay. */
const HAR_FIXTURE = [
  '<!doctype html><meta charset=utf-8><title>HAR Fixture</title>',
  '<link rel=stylesheet href="/style.css">',
  '<body><h1 id=title>HAR fixture</h1><p id=out>pending</p>',
  '<script>',
  "  fetch('/api/data').then(function (r) { return r.json(); }).then(function (d) {",
  "    document.getElementById('out').textContent = d.message;",
  '  });',
  '</script>',
].join('\n');

function serve(html) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'served from the recording' }));
      return;
    }
    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('#title { color: rgb(1, 2, 3); }');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/* ------------------------- the targets under test ------------------------ */

/** Elements whose recommended locator must be unique in Playwright too. */
const PROBES = [
  ['#save', 'button with a test id'],
  ['#saveclose', 'button whose name contains another button name'],
  ['#email', 'input labelled with label[for]'],
  ['#postcode', 'input inside a wrapping label'],
  ['#search', 'input named by aria-label'],
  ['#agree', 'checked checkbox'],
  ['#danger', 'button named by aria-labelledby'],
  ['h2', 'heading level 2'],
  ['header nav a[href="/models"]', 'link duplicated across two landmarks'],
  ['#plain', 'plain div'],
];

/** Targets whose match count both engines must report identically. */
const COUNTS = [
  { by: 'role', role: 'button', name: 'Save' },
  { by: 'role', role: 'button', name: 'Save', exact: true },
  { by: 'role', role: 'button', name: 'save' },
  { by: 'role', role: 'button', name: 'save', exact: true },
  { by: 'role', role: 'link', name: 'Models' },
  { by: 'role', role: 'link', name: 'Models', within: { role: 'navigation', name: 'Primary' } },
  { by: 'role', role: 'link', name: 'Models', within: { role: 'contentinfo' } },
  { by: 'role', role: 'heading', name: 'Details' },
  { by: 'role', role: 'textbox', name: 'Email address' },
  { by: 'role', role: 'textbox', name: 'Postcode' },
  { by: 'role', role: 'searchbox', name: 'Search products' },
  { by: 'role', role: 'checkbox', name: 'I agree to the terms' },
  { by: 'role', role: 'button', name: 'Delete account' },
  { by: 'role', role: 'button', name: 'Archive' },
  { by: 'role', role: 'listitem', name: 'First item' },
  { by: 'role', role: 'link', name: 'Nonexistent' },
  { by: 'label', label: 'Email address' },
  { by: 'label', label: 'Search products' },
  { by: 'testId', testId: 'save-btn' },
  { by: 'text', text: 'Second item' },
  { by: 'text', text: 'A plain div with text' },
  { by: 'text', text: 'Models' },
];

/** The scenario-target shape, resolved as a real Playwright locator. */
function locatorFor(page, target) {
  const root = target.within
    ? page.getByRole(target.within.role, target.within.name ? { name: target.within.name } : {})
    : page;
  switch (target.by) {
    case 'role':
      return root.getByRole(target.role, {
        name: target.name,
        ...(target.exact ? { exact: true } : {}),
      });
    case 'label':
      return root.getByLabel(target.label, target.exact ? { exact: true } : undefined);
    case 'text':
      return root.getByText(target.text, target.exact ? { exact: true } : undefined);
    case 'testId':
      return root.getByTestId(target.testId);
    default:
      throw new Error(`unsupported target: ${JSON.stringify(target)}`);
  }
}

/* --------------------------------- main ---------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-interop-'));
const outDir = mkdtempSync(join(tmpdir(), 'browserd-interop-out-'));
let client;
let transport;
let browser;
let fixture;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (res.isError) throw new Error(`${name}: ${payload.message ?? text}`);
  return payload;
}

async function main() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: {
      ...process.env,
      AGENTBROWSER_HOME: home,
      AGENTBROWSER_LOG_LEVEL: 'warn',
      AGENTBROWSER_HEADLESS: HEADED ? '0' : '1',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'interop', version: '1.0.0' });
  await client.connect(transport);
  browser = await chromium.launch({ headless: !HEADED });
  process.stdout.write('browserd connected, playwright chromium launched\n');

  await locatorSuite();
  await ariaSuite();
  await storageStateSuite();
  await harSuite();
}

async function locatorSuite() {
  fixture = await serve(LOCATOR_FIXTURE);
  await call('page.navigate', { url: `${fixture.base}/` });
  await call('page.wait_for', { selector: '#save', timeout_ms: 5000 });

  const page = await browser.newPage();
  await page.goto(`${fixture.base}/`);

  area('locator counts against the real engine');

  await check('every match count agrees with Playwright', async () => {
    const disagreements = [];
    for (const target of COUNTS) {
      const mine = await call('locator.check', { target });
      const theirs = await locatorFor(page, target).count();
      if (mine.matches !== theirs) {
        disagreements.push(`${mine.compiles_to}: browserd=${mine.matches} playwright=${theirs}`);
      }
    }
    assert(
      disagreements.length === 0,
      `${disagreements.length}/${COUNTS.length} disagreed:\n       ${disagreements.join('\n       ')}`,
    );
    return `${COUNTS.length}/${COUNTS.length} agree`;
  });

  await check('every recommended locator is unique in Playwright, not just here', async () => {
    const wrong = [];
    let named = 0;
    for (const [selector, note] of PROBES) {
      const res = await call('locator.candidates', { selector });
      if (!res.recommended) {
        wrong.push(`${selector} (${note}): browserd recommended nothing`);
        continue;
      }
      named++;
      const count = await locatorFor(page, res.recommended).count();
      if (count !== 1) {
        wrong.push(`${selector} (${note}): ${JSON.stringify(res.recommended)} matched ${count}`);
      }
    }
    assert(wrong.length === 0, `not unique in Playwright:\n       ${wrong.join('\n       ')}`);
    return `${named}/${PROBES.length} elements named uniquely`;
  });

  await check('an element with no accessibility node is reported, not guessed at', async () => {
    const res = await call('locator.candidates', { selector: '#ghost' });
    assert(res.role_note, 'no role_note for an aria-hidden element');
    assert(
      !(res.candidates ?? []).some((c) => c.target.by === 'role'),
      'a role candidate was offered for an element outside the accessibility tree',
    );
    // Playwright must agree the element is unreachable by role.
    const byRole = await page.getByRole('paragraph').count();
    assert(byRole === 0, `Playwright found ${byRole} paragraphs; the fixture element is not hidden`);
    return 'both engines see nothing';
  });

  await page.close();
}

/**
 * Runs the one delegated assertion.
 *
 * This must not be spawnSync. The fixture server lives in this process, so
 * blocking the event loop stops it answering the child, and the spec times out
 * navigating to a page that serves fine a moment before and after - which
 * looks exactly like a browserd bug and is not one.
 */
function runPlaywright(handoffPath) {
  return new Promise((resolve) => {
    // The CLI entry directly rather than npx: no .cmd shim, no shell quoting.
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        join(ROOT, 'tests', 'interop', 'playwright.config.mjs'),
      ],
      {
        cwd: ROOT,
        env: { ...process.env, ARIA_HANDOFF: handoffPath, INTEROP_HEADED: HEADED ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (err) =>
      resolve({ status: -1, output: `could not start the runner: ${err.message}` }),
    );
    child.on('close', (status) => resolve({ status, output }));
  });
}

async function ariaSuite() {
  area('page.snapshot format:aria');

  const page = await browser.newPage();
  await page.goto(`${fixture.base}/`);
  const res = await call('page.snapshot', { format: 'aria' });

  await check('the snapshot parses and matches as a Playwright expectation', async () => {
    assert(res.snapshot && res.snapshot.length > 0, 'the snapshot is empty');
    /*
     * toMatchAriaSnapshot refuses to run outside the Playwright runner, so the
     * one assertion that actually proves the dialect is correct lives in
     * tests/interop/aria.spec.mjs and runs there. The fixture server is still
     * up, so the spec sees the same page this snapshot was taken from.
     */
    const handoffPath = join(outDir, 'aria-handoff.json');
    writeFileSync(
      handoffPath,
      JSON.stringify({ url: `${fixture.base}/`, snapshot: res.snapshot }),
      'utf8',
    );
    const run = await runPlaywright(handoffPath);
    if (run.status !== 0) {
      const output = run.output
        .split('\n')
        .filter((line) => line.trim())
        .slice(0, 16)
        .join('\n       ');
      throw new Error(`the runner rejected the snapshot (exit ${run.status}):\n       ${output}`);
    }
    return `${res.node_count} nodes accepted by toMatchAriaSnapshot`;
  });

  await check('it invents no role Playwright would not emit', async () => {
    const theirs = await page.locator('body').ariaSnapshot();
    const roles = (text) =>
      new Set(
        text
          .split('\n')
          .map((line) => /^\s*- ([a-zA-Z]+)/.exec(line)?.[1])
          .filter(Boolean),
      );
    const mine = roles(res.snapshot);
    const known = roles(theirs);
    const invented = [...mine].filter((role) => !known.has(role));
    assert(invented.length === 0, `roles Playwright never emits: ${invented.join(', ')}`);
    return `${mine.size} role kinds, all known to Playwright`;
  });

  await page.close();
  await fixture.close();
  fixture = undefined;
}

async function storageStateSuite() {
  area('storage.export format:playwright');

  const local = await serve(LOCATOR_FIXTURE);
  await call('page.navigate', { url: `${local.base}/` });
  await call('storage.set', { key: 'seen-tour', value: 'yes' });
  await call('storage.set_cookie', { name: 'sid', value: 'abc123', url: `${local.base}/` });
  const statePath = join(outDir, 'storage-state.json');
  await call('storage.export', { format: 'playwright', save_path: statePath });

  await check('Playwright loads the exported state and keeps both halves', async () => {
    const context = await browser.newContext({ storageState: statePath });
    try {
      const state = await context.storageState();
      assert(
        state.cookies.some((c) => c.name === 'sid' && c.value === 'abc123'),
        `the cookie did not survive: ${JSON.stringify(state.cookies)}`,
      );
      const origin = state.origins.find((o) => o.localStorage.some((e) => e.name === 'seen-tour'));
      assert(origin, `localStorage did not survive: ${JSON.stringify(state.origins)}`);
      return `${state.cookies.length} cookies, ${origin.localStorage.length} localStorage entries`;
    } finally {
      await context.close();
    }
  });

  await local.close();
}

async function harSuite() {
  area('network.export_har');

  const local = await serve(HAR_FIXTURE);
  await call('recording.reset', {});
  await call('page.navigate', { url: `${local.base}/` });
  await call('page.wait_for', { text: 'served from the recording', timeout_ms: 5000 });
  const harPath = join(outDir, 'export.har');
  const exported = await call('network.export_har', { save_path: harPath, include_bodies: true });
  const { base } = local;
  // Shut the origin down: anything that loads now provably came from the file.
  await local.close();

  await check('the HAR replays under routeFromHAR with the origin gone', async () => {
    const context = await browser.newContext();
    try {
      await context.routeFromHAR(harPath, { url: '**/*', notFound: 'abort' });
      const page = await context.newPage();
      await page.goto(`${base}/`);
      await expect(page.locator('#title')).toHaveText('HAR fixture');
      // A stylesheet entry: non-document resources replay too.
      await expect(page.locator('#title')).toHaveCSS('color', 'rgb(1, 2, 3)');
      // An XHR entry with a body, the case a scenario's har field exists for.
      await expect(page.locator('#out')).toHaveText('served from the recording');
      return `${exported.entry_count} entries: document, css and xhr all served`;
    } finally {
      await context.close();
    }
  });
}

function report() {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`,
  );
  for (const f of failed) process.stdout.write(`  \x1b[31m${f.area}: ${f.label}\x1b[0m\n`);
  return failed.length;
}

let exitCode = 1;
try {
  await main();
  exitCode = report() === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`\nHARNESS ERROR: ${err.stack ?? err}\n`);
  report();
  exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { await fixture?.close(); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  try { rmSync(outDir, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
