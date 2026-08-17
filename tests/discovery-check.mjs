/**
 * The workflow browserd exists for:
 *
 *   1. a human runs `browserd open` and uses the browser normally
 *   2. later, a completely separate MCP session discovers that browser
 *   3. and can read everything it recorded before the agent ever attached
 *
 * This proves step 2 and 3 across real process boundaries, which an in-memory
 * registry cannot do.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'browserd-disc-'));
const CLI = join(ROOT, 'dist', 'cli.js');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A page whose traffic and console output we can later look for. */
const fixture = createServer((req, res) => {
  if (req.url === '/api/secret-call') {
    res.writeHead(418, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: 'RECORDED_BEFORE_AGENT_ATTACHED' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Discovery fixture</title>
    <script>
      console.log('human-was-here');
      fetch('/api/secret-call');
    </script>
    <h1>opened by a human</h1>`);
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fixture.address().port}`;

console.log('\n\x1b[1mCross-process discovery\x1b[0m\n');

let opener;
let client;
let transport;

try {
  /* ---- Step 1: a human opens a browser. Separate process, headless here. ---- */
  opener = spawn(process.execPath, [CLI, 'open', '--profile', 'disc-test', '--headless', '--url', base], {
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let openerOut = '';
  opener.stdout.on('data', (d) => (openerOut += d));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !openerOut.includes('browser_id')) await sleep(250);
  must(openerOut.includes('browser_id'), `open never reported a browser:\n${openerOut}`);
  const openedId = /browser_id\s+(br_\w+)/.exec(openerOut)?.[1];

  await test('`browserd open` launches and advertises a browser', async () => {
    must(openedId, 'no browser_id printed');
    return openedId;
  });

  // Let the page load and its traffic land in the recording.
  await sleep(3000);

  await test('`browserd list` sees it from another process', async () => {
    const out = await new Promise((resolve) => {
      let s = '';
      const p = spawn(process.execPath, [CLI, 'list'], {
        env: { ...process.env, AGENTBROWSER_HOME: home },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    must(out.includes(openedId), `list did not show ${openedId}:\n${out}`);
    return '1 browser listed';
  });

  /* ---- Step 2: a brand new MCP session, as an agent would start. ---- */
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--log-level', 'error'],
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_HEADLESS: '1' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'discovery-check', version: '1.0.0' });
  await client.connect(transport);

  const call = async (n, a = {}) => {
    const r = await client.callTool({ name: n, arguments: a });
    const txt = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    const p = JSON.parse(txt);
    if (r.isError) throw new Error(`${n}: ${p.message ?? txt}`);
    return p;
  };

  await test('a fresh MCP session finds the already-open browser', async () => {
    const list = await call('browser.list');
    must(list.count >= 1, `MCP session saw ${list.count} browsers`);
    const found = list.browsers.find((b) => b.browser_id === openedId);
    must(found, `did not find ${openedId} in ${list.browsers.map((b) => b.browser_id).join(', ')}`);
    return `${found.browser_id} profile=${found.profile}`;
  });

  await test('the browser_id is stable across processes', async () => {
    const status = await call('browser.status', { browser_id: openedId });
    must(status.browser_id === openedId, `id changed to ${status.browser_id}`);
    return openedId;
  });

  await test('it does NOT launch a second window', async () => {
    const list = await call('browser.list');
    must(list.count === 1, `expected 1 browser, found ${list.count}`);
    return 'attached instead of spawning';
  });

  /* ---- Step 3: read what was recorded before the agent existed. ---- */
  await test('network recorded before the agent attached is readable', async () => {
    const reqs = await call('network.list_requests', { browser_id: openedId, limit: 50 });
    const secret = reqs.requests.find((r) => r.url.includes('/api/secret-call'));
    must(secret, `the pre-attach request is missing from ${reqs.total_matching} recorded`);
    must(secret.status === 418, `status was ${secret.status}`);
    const body = await call('network.get_body', { request_id: secret.request_id, as_json: true });
    must(
      body.parsed?.marker === 'RECORDED_BEFORE_AGENT_ATTACHED',
      `body was ${JSON.stringify(body.parsed)}`,
    );
    return `${reqs.total_matching} requests, 418 body readable`;
  });

  await test('console recorded before the agent attached is readable', async () => {
    const logs = await call('console.query', { browser_id: openedId, limit: 50 });
    const hit = logs.entries.find((e) => String(e.text).includes('human-was-here'));
    must(hit, `pre-attach log missing from ${logs.total_matching} entries`);
    return `"${hit.text}"`;
  });

  await test('the agent can drive the browser the human opened', async () => {
    const r = await call('js.evaluate', {
      browser_id: openedId,
      expression: `document.querySelector('h1').textContent`,
    });
    must(String(r.value).includes('opened by a human'), `got ${r.value}`);
    return `"${r.value}"`;
  });

  await test('closing the browser withdraws it from discovery', async () => {
    await call('browser.close', { browser_id: openedId });
    await sleep(1500);
    const out = await new Promise((resolve) => {
      let s = '';
      const p = spawn(process.execPath, [CLI, 'list'], {
        env: { ...process.env, AGENTBROWSER_HOME: home },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    must(!out.includes(openedId), `still advertised after close:\n${out}`);
    return 'record removed';
  });
} catch (err) {
  no('harness', err.stack ?? err.message);
} finally {
  try {
    await client?.close();
  } catch {}
  try {
    await transport?.close();
  } catch {}
  opener?.kill();
  await sleep(600);
  fixture.close();
  rmSync(home, { recursive: true, force: true });
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}
