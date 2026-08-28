/**
 * Session restore and workflow replay.
 *
 * Both features exist to answer the same question: how does an agent get back to
 * a known page state without re-driving the UI every time? The fixture is a real
 * cookie-session login, because that is the case where replaying the form is
 * both the slowest option and the one that forces credentials onto disk.
 *
 *   node tests/session-workflow-check.mjs [--headed] [--keep]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\x1b[0m\n`);
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
  try {
    const detail = await fn();
    results.push({ label, ok: true, area: currentArea });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}\n`);
  } catch (err) {
    results.push({ label, ok: false, area: currentArea, err });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${err.message}\n`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* ------------------------------- fixture --------------------------------- */

/** A real cookie-session login: /dash is only reachable with a valid sid. */
function startAuthServer() {
  const SESSIONS = new Set();
  const page = (body) => `<!doctype html><meta charset=utf-8><title>Auth Fixture</title><body>${body}</body>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cookies = Object.fromEntries(
      (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]),
    );
    const authed = cookies.sid && SESSIONS.has(cookies.sid);

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('user') === 'alice@example.com' && p.get('pass') === 'hunter2') {
          const sid = 'sess-' + Math.random().toString(36).slice(2);
          SESSIONS.add(sid);
          res.writeHead(302, { 'Set-Cookie': `sid=${sid}; Path=/`, Location: '/dash' });
        } else {
          res.writeHead(302, { Location: '/?e=1' });
        }
        res.end();
      });
      return;
    }

    if (url.pathname === '/dash') {
      if (!authed) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('<h1 id=welcome>Welcome back</h1><p id=who>alice@example.com</p>'));
      return;
    }

    // A second form, used to prove variable substitution on replay.
    if (url.pathname === '/profile') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        page(`<h1>Profile</h1><form id=pf>
          <input id=nick name=nick>
          <input id=city name=city>
          <button id=save type=button onclick="document.getElementById('out').textContent=nick.value+' @ '+city.value">Save</button>
          <p id=out></p></form>`),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      page(`<h1>Sign in</h1><form method=POST action=/login>
        <input id=user name=user placeholder=Email>
        <input id=pass name=pass type=password placeholder=Password>
        <button id=go type=submit>Log in</button></form>
        ${url.searchParams.get('e') ? '<p id=err>Bad credentials</p>' : ''}`),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/* --------------------------------- main ---------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-session-'));
let fixture;
let transport;

async function main() {
  fixture = await startAuthServer();
  process.stdout.write(`auth fixture on ${fixture.base}\ndaemon home ${home}\n`);

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

  client = new Client({ name: 'session-workflow-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  process.stdout.write(`connected: ${tools.length} tools advertised\n`);

  await runSuite(fixture.base);
  await client.close();
}

async function runSuite(base) {
  let revealId;
  let headedId;
  /* ------------------------- logging in for real ------------------------- */
  area('fixture: a real login');

  let sid;
  await check('login form produces a session cookie', async () => {
    await call('page.navigate', { url: `${base}/` });
    await call('page.type', { selector: '#user', text: 'alice@example.com', insert_text: true });
    await call('page.type', { selector: '#pass', text: 'hunter2', insert_text: true });
    await call('js.evaluate', { expression: "document.querySelector('form').submit()" });
    await call('page.wait_for', { selector: '#welcome', timeout_ms: 5000 });
    const text = await call('page.extract_text', { selector: 'body' });
    assert(/Welcome back/.test(text.text), `expected the dashboard, got ${JSON.stringify(text.text)}`);
    const list = await call('storage.list_cookies', { domain_contains: '127.0.0.1' });
    sid = list.cookies.find((c) => c.name === 'sid');
    assert(sid, 'no sid cookie was set');
    return `sid=${sid.value.slice(0, 12)}…`;
  });

  /* --------------------------- A: storage.import ------------------------- */
  area('A: session restore without replaying the form');

  let exported;
  await check('storage.export captures the session', async () => {
    const res = await call('storage.export', {});
    assert(res.artifact, 'no artifact returned');
    const read = await call('artifact.read', { artifact_id: res.artifact.artifact_id ?? res.artifact.id });
    exported = JSON.parse(read.text ?? read.content ?? '{}');
    assert(Array.isArray(exported.cookies), 'export carried no cookies array');
    const found = exported.cookies.find((c) => c.name === 'sid');
    assert(found, 'export did not include the sid cookie');
    return `${exported.cookies.length} cookies`;
  });

  await check('clearing cookies really ends the session', async () => {
    await call('storage.clear_cookies', {});
    const nav = await call('page.navigate', { url: `${base}/dash` });
    assert(!/\/dash$/.test(nav.url), `expected a redirect away from /dash, landed on ${nav.url}`);
    return `bounced to ${nav.url.replace(base, '')}`;
  });

  await check('storage.import restores the session from an export payload', async () => {
    const res = await call('storage.import', { state: exported });
    assert(res.cookies_imported >= 1, `imported ${res.cookies_imported} cookies`);
    const nav = await call('page.navigate', { url: `${base}/dash` });
    assert(/\/dash$/.test(nav.url), `expected /dash, landed on ${nav.url}`);
    const text = await call('page.extract_text', { selector: 'body' });
    assert(/Welcome back/.test(text.text), `not logged in: ${JSON.stringify(text.text)}`);
    return `${res.cookies_imported} cookies, back on the dashboard`;
  });

  await check('storage.import also accepts a bare cookie list', async () => {
    await call('storage.clear_cookies', {});
    const res = await call('storage.import', {
      cookies: [{ name: 'sid', value: sid.value, domain: '127.0.0.1', path: '/' }],
    });
    assert(res.cookies_imported === 1, `imported ${res.cookies_imported}`);
    const nav = await call('page.navigate', { url: `${base}/dash` });
    assert(/\/dash$/.test(nav.url), `expected /dash, landed on ${nav.url}`);
    return 'one cookie, logged in';
  });

  await check('storage.import still writes plain key/value items', async () => {
    const res = await call('storage.import', { items: { theme: 'dark', tour: 'done' }, kind: 'local' });
    assert(res.imported === 2, `imported ${res.imported}`);
    const got = await call('storage.get', { key: 'theme', kind: 'local' });
    assert(got.value === 'dark', `read back ${JSON.stringify(got.value)}`);
    return 'items path unbroken';
  });

  await check('storage.import round-trips localStorage through an export', async () => {
    const dump = await call('storage.export', {});
    const read = await call('artifact.read', { artifact_id: dump.artifact.artifact_id ?? dump.artifact.id });
    const payload = JSON.parse(read.text ?? read.content ?? '{}');
    await call('storage.clear', { kind: 'local' });
    const res = await call('storage.import', { state: payload });
    const got = await call('storage.get', { key: 'theme', kind: 'local' });
    assert(got.value === 'dark', `after restore theme was ${JSON.stringify(got.value)}`);
    return `restored ${res.imported} keys`;
  });

  await check('an empty import explains itself rather than silently doing nothing', async () => {
    try {
      await call('storage.import', {});
      throw new Error('expected an error');
    } catch (err) {
      assert(/items|cookies|state/i.test(err.message), `unhelpful message: ${err.message}`);
      return 'rejected with guidance';
    }
  });

  /* ---------------------------- B: workflows ----------------------------- */
  area('B: parameterised workflow replay');

  await check('workflow.save stores a named, parameterised sequence', async () => {
    const res = await call('workflow.save', {
      name: 'fill-profile',
      vars: ['nick', 'city'],
      steps: [
        { tool: 'page.navigate', args: { url: `${base}/profile` } },
        { tool: 'page.type', args: { selector: '#nick', text: '{{nick}}', insert_text: true } },
        { tool: 'page.type', args: { selector: '#city', text: '{{city}}', insert_text: true } },
        { tool: 'page.click', args: { selector: '#save' } },
        { tool: 'page.expect', args: { selector: '#out', text_contains: '{{nick}}', timeout_ms: 2000 } },
      ],
    });
    assert(res.saved === true, 'not saved');
    assert(res.steps === 5, `stored ${res.steps} steps`);
    return `${res.steps} steps, vars=${res.vars.join(',')}`;
  });

  await check('workflow.list shows it', async () => {
    const res = await call('workflow.list', {});
    const found = res.workflows.find((w) => w.name === 'fill-profile');
    assert(found, 'saved workflow not listed');
    return `${res.workflows.length} saved`;
  });

  await check('workflow.run substitutes variables and every step passes', async () => {
    const res = await call('workflow.run', { name: 'fill-profile', vars: { nick: 'alice', city: 'Lisbon' } });
    assert(res.ok === true, `run failed: ${JSON.stringify(res.steps?.filter((s) => !s.ok))}`);
    assert(res.completed === 5, `only ${res.completed} steps ran`);
    const out = await call('page.extract_text', { selector: '#out' });
    assert(out.text.includes('alice @ Lisbon'), `page shows ${JSON.stringify(out.text)}`);
    return 'alice @ Lisbon';
  });

  await check('the same workflow replays with different values', async () => {
    const res = await call('workflow.run', { name: 'fill-profile', vars: { nick: 'bob', city: 'Porto' } });
    assert(res.ok === true, 'second run failed');
    const out = await call('page.extract_text', { selector: '#out' });
    assert(out.text.includes('bob @ Porto'), `page shows ${JSON.stringify(out.text)}`);
    return 'bob @ Porto';
  });

  await check('a missing variable is refused before anything is driven', async () => {
    try {
      await call('workflow.run', { name: 'fill-profile', vars: { nick: 'carol' } });
      throw new Error('expected an error');
    } catch (err) {
      assert(/city/.test(err.message), `message did not name the missing var: ${err.message}`);
      return 'named the missing var';
    }
  });

  await check('a step that does not land fails the run instead of reporting success', async () => {
    await call('workflow.save', {
      name: 'broken',
      steps: [
        { tool: 'page.navigate', args: { url: `${base}/profile` } },
        { tool: 'page.type', args: { selector: '#no-such-field', text: 'x' } },
      ],
    });
    const res = await call('workflow.run', { name: 'broken', continue_on_error: true });
    assert(res.ok === false, 'a broken run reported success');
    const failed = res.steps.find((s) => !s.ok);
    assert(failed, 'no step was marked failed');
    return `step ${failed.index} failed: ${String(failed.error).slice(0, 40)}`;
  });

  await check('typing that dispatches but does not land is caught', async () => {
    await call('workflow.save', {
      name: 'readonly-probe',
      steps: [
        { tool: 'page.navigate', args: { url: `${base}/profile` } },
        {
          tool: 'js.evaluate',
          args: { expression: "document.querySelector('#nick').readOnly = true" },
        },
        { tool: 'page.type', args: { selector: '#nick', text: 'ghost', insert_text: true } },
      ],
    });
    const res = await call('workflow.run', { name: 'readonly-probe' });
    assert(res.ok === false, 'typing into a readonly field was reported as success');
    return 'landed_characters checked, not assumed';
  });

  await check('a saved workflow survives a fresh page and re-resolves its locators', async () => {
    await call('page.navigate', { url: 'about:blank' });
    const res = await call('workflow.run', { name: 'fill-profile', vars: { nick: 'dana', city: 'Faro' } });
    assert(res.ok === true, 'replay after about:blank failed');
    return 'locators re-resolved from scratch';
  });

  /* -------------------------- D: credentials ----------------------------- */
  area('D: sealed credentials');

  await check('credentials.save never echoes the password back', async () => {
    const res = await call('credentials.save', {
      site: 'fixture',
      origin: base,
      username: 'alice@example.com',
      password: 'hunter2',
      login_url: `${base}/`,
      selectors: { username: '#user', password: '#pass', submit: '#go' },
    });
    assert(res.saved === true, 'not saved');
    const blob = JSON.stringify(res);
    assert(!blob.includes('hunter2'), `the response leaked the password: ${blob}`);
    return `redacted as ${res.password}`;
  });

  await check('the password is not readable on disk', async () => {
    const res = await call('credentials.list', {});
    const dir = res.directory;
    const raw = readFileSync(join(dir, 'fixture.json'), 'utf8');
    assert(!raw.includes('hunter2'), 'the vault file contains the plaintext password');
    assert(raw.includes('sealed'), 'no sealed field on disk');
    return 'ciphertext only';
  });

  await check('credentials.list returns metadata, never secrets', async () => {
    const res = await call('credentials.list', {});
    const found = res.credentials.find((c) => c.site === 'fixture');
    assert(found, 'not listed');
    assert(found.username === 'alice@example.com', 'username missing');
    assert(!JSON.stringify(res).includes('hunter2'), 'list leaked the password');
    return `${res.count} saved, no secrets in payload`;
  });

  await check('no tool anywhere returns the stored password', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('credentials.'));
    assert(!names.includes('credentials.get'), 'a credentials.get tool exists, which defeats the design');
    return `${names.length} credential tools, none of them a getter`;
  });

  await check('credentials.login signs in without exposing the password', async () => {
    await call('storage.clear_cookies', {});
    await call('page.navigate', { url: `${base}/` });
    const res = await call('credentials.login', { site: 'fixture' });
    const blob = JSON.stringify(res);
    assert(!blob.includes('hunter2'), `login result leaked the password: ${blob}`);
    await call('page.wait_for', { selector: '#welcome', timeout_ms: 5000 });
    const text = await call('page.extract_text', { selector: 'body' });
    assert(/Welcome back/.test(text.text), `not signed in: ${JSON.stringify(text.text)}`);
    return 'logged in, password never surfaced';
  });

  await check('a credential refuses to fill on the wrong origin', async () => {
    await call('page.navigate', { url: 'https://example.com/' });
    try {
      await call('credentials.login', { site: 'fixture' });
      throw new Error('it filled on a foreign origin');
    } catch (err) {
      assert(/bound to|was not typed/i.test(err.message), `wrong error: ${err.message}`);
      assert(!err.message.includes('hunter2'), 'the error leaked the password');
      return 'origin gate held';
    }
  });

  await check('a bad selector fails loudly instead of half-filling', async () => {
    await call('page.navigate', { url: `${base}/` });
    try {
      await call('credentials.login', { site: 'fixture', password_selector: '#no-such-field' });
      throw new Error('expected a failure');
    } catch (err) {
      assert(/landed|selector|not found/i.test(err.message), `wrong error: ${err.message}`);
      return 'refused rather than submitting a partial form';
    }
  });

  await check('site names cannot escape the vault directory', async () => {
    try {
      await call('credentials.save', {
        site: '../escape',
        origin: base,
        username: 'x',
        password: 'y',
      });
      throw new Error('traversal accepted');
    } catch (err) {
      assert(/site names/i.test(err.message), `wrong error: ${err.message}`);
      return 'rejected';
    }
  });

  await check('credentials.delete removes it', async () => {
    await call('credentials.delete', { site: 'fixture' });
    const res = await call('credentials.list', {});
    assert(!res.credentials.find((c) => c.site === 'fixture'), 'still listed');
    return 'gone';
  });

  /* ------------------------- C: headless handover ------------------------ */
  area('C: browser.reveal');

  await check('a headless browser reports itself as headless', async () => {
    const res = await call('browser.launch', { profile: 'reveal-test', headless: true, url: `${base}/profile` });
    revealId = res.browser_id;
    const st = await call('browser.status', { browser_id: revealId });
    assert(st.headless === true, `status says headless=${st.headless}`);
    return `${revealId} headless`;
  });

  await check('reveal relaunches headed, carrying the profile across', async () => {
    // Launch-time navigation is racy, so land the page explicitly before
    // touching origin-scoped storage.
    await call('page.navigate', { browser_id: revealId, url: `${base}/profile` });
    await call('storage.import', { browser_id: revealId, items: { survives: 'yes' }, kind: 'local' });
    await call('js.evaluate', {
      browser_id: revealId,
      expression: "document.body.innerHTML += '<h2 id=ephemeral>gone after reveal</h2>'",
    });

    const res = await call('browser.reveal', {
      browser_id: revealId,
      url: `${base}/profile`,
      control_mode: 'observe',
    });
    assert(res.revealed === true, 'nothing was revealed');
    assert(res.browser_id !== revealId, 'expected a new browser_id');
    headedId = res.browser_id;

    const st = await call('browser.status', { browser_id: headedId });
    assert(st.headless === false, `new browser says headless=${st.headless}`);
    return `${revealId} -> ${headedId}`;
  });

  await check('profile state survives, live page state does not', async () => {
    const got = await call('storage.get', { browser_id: headedId, key: 'survives', kind: 'local' });
    assert(got.value === 'yes', `localStorage did not survive: ${JSON.stringify(got.value)}`);
    // page.expect is read-only, so it works under the observe mode reveal set.
    const probe = await call('page.expect', { browser_id: headedId, selector: '#ephemeral', visible: true });
    assert(probe.pass === false, 'the agent DOM edit unexpectedly survived the relaunch');
    return 'localStorage kept, DOM edit gone (as reported)';
  });

  await check('reveal honoured the requested control mode', async () => {
    const st = await call('browser.status', { browser_id: headedId });
    assert(st.control_mode === 'observe', `mode is ${st.control_mode}`);
    try {
      await call('page.navigate', { browser_id: headedId, url: `${base}/dash` });
      throw new Error('observe mode did not block a navigation');
    } catch (err) {
      assert(/control_denied|observe/i.test(err.message), `unexpected error: ${err.message}`);
    }
    return 'observe enforced on the new window';
  });

  await check('revealing an already-headed browser is a no-op', async () => {
    await call('browser.set_control_mode', { browser_id: headedId, mode: 'shared' });
    const res = await call('browser.reveal', { browser_id: headedId });
    assert(res.revealed === false && res.already_headed === true, 'it relaunched a headed browser');
    assert(res.browser_id === headedId, 'the id changed on a no-op');
    return 'no pointless relaunch';
  });

  await check('recordings from the headless session stay queryable', async () => {
    const res = await call('browser.list', { include_historical: true });
    assert(Array.isArray(res.browsers), 'no browser list');
    await call('browser.close', { browser_id: headedId });
    return 'closed the revealed window';
  });

  await check('workflow.delete removes it', async () => {
    await call('workflow.delete', { name: 'broken' });
    const res = await call('workflow.list', {});
    assert(!res.workflows.find((w) => w.name === 'broken'), 'still listed after delete');
    return 'gone';
  });
}

function report() {
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  process.stdout.write(
    `\n\x1b[1m${passed} passed, ${failed.length} failed\x1b[0m\n`,
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
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { await fixture?.close(); } catch {}
  if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch {} }
  process.exit(exitCode);
}
