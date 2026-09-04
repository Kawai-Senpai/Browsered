/**
 * Live check for app.error_state and app.diagnose_interaction.
 *
 * The fixture reproduces the failure that motivated both tools: a Send button
 * whose handler throws inside an async-state callback, where the framework
 * catches the throw, rolls the optimistic update back and leaves the console
 * empty. Every classic instrument reads healthy; only the held state shows the
 * error.
 *
 * The fiber here is hand-built rather than produced by React. That is
 * deliberate: the probe shape-matches __reactFiber$ / memoizedState and must
 * not depend on a React version, so the fixture asserts the contract the probe
 * actually relies on.
 *
 *   node tests/hidden-error-check.mjs [--headed]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
const check = (label, ok, detail = '') => {
  results.push({ area: currentArea, label, ok });
  process.stdout.write(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` :: ${detail}` : ''}\n`);
};

/* -------------------------------- fixture -------------------------------- */

const PAGE = `<!doctype html>
<html><head><title>hidden-error fixture</title></head>
<body>
  <textarea id="draft">hello</textarea>
  <button id="dead">Send (dead)</button>
  <button id="live">Send (live)</button>
  <button id="nohandler">No handler</button>
  <script>
    // A mutation object shaped like the ones React Query stores on a hook.
    const failedMutation = {
      status: 'error',
      isPending: false,
      failureCount: 1,
      error: new TypeError('crypto.randomUUID is not a function'),
    };
    const okQuery = { status: 'success', isPending: false, error: null };

    // Minimal fiber: hooks are a linked list on memoizedState, components are
    // functions, and .return walks toward the root. That is all the probe reads.
    function Composer() {}
    const fiber = {
      type: Composer,
      memoizedState: { memoizedState: okQuery, next: { memoizedState: failedMutation, next: null } },
      return: null,
    };

    const dead = document.getElementById('dead');
    const live = document.getElementById('live');
    // Attach the fiber the way React does, so the probe finds it by key prefix.
    dead['__reactFiber\$abc'] = fiber;
    dead['__reactProps\$abc'] = {
      disabled: false,
      // Guard that always returns early, exactly like the real bug.
      onClick: () => { if (window.__blocked) return; fetch('/api/send', { method: 'POST' }); },
    };
    window.__blocked = true;

    live['__reactProps\$abc'] = {
      disabled: false,
      onClick: () => { document.getElementById('draft').value = ''; fetch('/api/send', { method: 'POST' }); },
    };

    dead.addEventListener('click', dead['__reactProps\$abc'].onClick);
    live.addEventListener('click', live['__reactProps\$abc'].onClick);
  </script>
</body></html>`;

/* --------------------------------- run ----------------------------------- */

let client;
let server;
let baseUrl;
const profileDir = mkdtempSync(join(tmpdir(), 'browserd-hidden-'));

// Other browsers may already be running on this machine; every call must name
// ours or the registry refuses to guess.
let browserId = null;
const call = async (name, args = {}) => {
  const scoped = browserId && !name.startsWith('guide.') && args.browser_id === undefined
    ? { ...args, browser_id: browserId }
    : args;
  const res = await client.callTool({ name, arguments: scoped });
  const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
};

try {
  server = createServer((req, res) => {
    if (req.url.startsWith('/api/send')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;

  client = new Client({ name: 'hidden-error-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'dist', 'cli.js'), 'serve', '--stdio'],
      env: { ...process.env, BROWSERD_PROFILE_DIR: profileDir },
    }),
  );

  const launched = await call('browser.launch', { headless: !HEADED, profile: 'hidden-error-check' });
  browserId = launched.browser_id;
  await call('page.navigate', { url: baseUrl });

  /* ---------------------------------------------------------------- */
  area('the console is empty but the app holds an error');

  const exceptions = await call('console.exceptions', {});
  check(
    'console.exceptions reports nothing (this is the trap)',
    (exceptions.count ?? 0) === 0,
    `count=${exceptions.count}`,
  );

  const state = await call('app.error_state', {});
  const errs = state.framework_errors ?? [];
  check('app.error_state finds the held error', errs.length > 0, `found=${errs.length}`);
  check(
    'the error message is the real cause',
    errs.some((e) => String(e.error || '').includes('crypto.randomUUID')),
    errs[0]?.error ?? 'none',
  );
  check(
    'it names the component holding it',
    errs.some((e) => e.component === 'Composer'),
    errs[0]?.component ?? 'none',
  );

  /* ---------------------------------------------------------------- */
  area('secure context is reported');

  check(
    'app.error_state reports capabilities',
    state.capabilities != null && typeof state.capabilities.is_secure_context === 'boolean',
    JSON.stringify(state.capabilities?.is_secure_context),
  );
  const status = await call('browser.status', {});
  check(
    'browser.status reports secure_context',
    status.secure_context != null && typeof status.secure_context.is_secure_context === 'boolean',
    JSON.stringify(status.secure_context?.is_secure_context),
  );
  // 127.0.0.1 is a trustworthy origin, so this fixture IS secure. The gated-API
  // list is what proves the detector works; asserting false here would only
  // prove the fixture is not deployed.
  check(
    'gated API list is populated',
    Array.isArray(state.capabilities?.missing_apis),
    JSON.stringify(state.capabilities?.missing_apis),
  );

  /* ---------------------------------------------------------------- */
  area('a dead button reports as dead');

  const dead = await call('app.diagnose_interaction', { selector: '#dead' });
  check('handler is seen as attached', dead.handler_attached === true, String(dead.handler_attached));
  check('no request was initiated', (dead.requests_initiated ?? []).length === 0);
  check(
    'verdict says it returned early rather than "12 DOM mutations"',
    /early-return guard|guard/i.test(dead.verdict ?? '') || /holding an error/i.test(dead.verdict ?? ''),
    dead.verdict,
  );
  check('handler source is returned for reading the guard', typeof dead.handler_source === 'string', dead.handler_source?.slice(0, 60));

  /* ---------------------------------------------------------------- */
  area('a working button reports as working');

  const live = await call('app.diagnose_interaction', { selector: '#live' });
  check('request was initiated', (live.requests_initiated ?? []).length > 0, JSON.stringify(live.requests_initiated));
  check('verdict reflects the request', /initiated 1 request/.test(live.verdict ?? ''), live.verdict);
  check('input consumption is detected', live.inputs_changed === true, String(live.inputs_changed));

  /* ---------------------------------------------------------------- */
  area('a button with no handler is distinguished');

  const none = await call('app.diagnose_interaction', { selector: '#nohandler' });
  check(
    'verdict names the missing handler',
    /no click handler/i.test(none.verdict ?? ''),
    none.verdict,
  );

  /* ---------------------------------------------------------------- */
  area('guidance is discoverable');

  const topic = await call('guide.topic', { name: 'hidden-errors' });
  const body = JSON.stringify(topic);
  check('hidden-errors topic exists', !/No topic named/.test(body));
  check('it teaches reading the fiber', /fiber/i.test(body));
  check('it teaches patching the running page', /patch the running page/i.test(body));
  check('it explains the secure context', /secure context/i.test(body));

  const search = await call('guide.search', { query: 'empty console' });
  check('searching "empty console" finds it', /hidden-errors/.test(JSON.stringify(search)));

  area('guide.orient orients');
  const orient = await call('guide.orient', {});
  const orientBody = JSON.stringify(orient);
  check('reports every family', Array.isArray(orient.capabilities) && orient.capabilities.length > 15, String(orient.capabilities?.length));
  check('counts the tools', typeof orient.tool_count === 'number' && orient.tool_count > 100, String(orient.tool_count));
  check('documents the app family', orient.capabilities?.some((c) => c.family === 'app' && c.what_it_is_for));
  check('names app.diagnose_interaction for a dead control', /app\.diagnose_interaction/.test(orientBody));
  check('teaches the fiber technique', /fiber/i.test(orientBody));
  check('teaches patching the running page', /Patch the running page/i.test(orientBody));
  check('warns about secure context', /secure_context|secure context/i.test(orientBody));
} finally {
  try {
    await call('browser.close', {});
  } catch { /* best effort */ }
  try {
    await client?.close();
  } catch { /* best effort */ }
  server?.close();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) {
  process.stdout.write(`\x1b[31m${failed.length} failed\x1b[0m\n`);
  for (const f of failed) process.stdout.write(`  - [${f.area}] ${f.label}\n`);
  process.exit(1);
}
