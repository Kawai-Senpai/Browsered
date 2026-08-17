/**
 * Live MCP conformance run.
 *
 * Spawns the real browserd stdio server, connects a real MCP client, and calls
 * tools the way a model would. Every assertion goes through tools/call, so this
 * exercises schema validation, the handler wiring and the ops together.
 *
 *   node tests/mcp-live.mjs [--headed] [--keep]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

/* ------------------------------ test harness ----------------------------- */

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\x1b[0m\n`);
};

let client;

/** Call a tool and return its parsed JSON payload. Throws on isError. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  const image = res.content.find((c) => c.type === 'image');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (res.isError) {
    const err = new Error(`${name}: ${payload.message ?? text}`);
    err.payload = payload;
    err.toolError = true;
    throw err;
  }
  if (image) payload.__image = { mimeType: image.mimeType, bytes: image.data.length };
  return payload;
}

/** Assert, recording pass/fail rather than aborting the run. */
async function check(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ area: currentArea, label, ok: true, ms });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label} \x1b[90m(${ms}ms)${detail ? ` ${detail}` : ''}\x1b[0m\n`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ area: currentArea, label, ok: false, ms, error: err.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label} \x1b[90m(${ms}ms)\x1b[0m\n         ${err.message}\n`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

/* --------------------------- local test fixture -------------------------- */

/**
 * A local page is used rather than the open web: the run must be deterministic
 * and must exercise XHR, WebSocket, console output, exceptions, storage,
 * timers, a slow endpoint and a deliberately hidden element.
 */
const FIXTURE_HTML = `<!doctype html>
<html><head><title>browserd fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; margin: 20px; }
  #hidden-box { display: none; }
  #clipped { width: 0; overflow: hidden; }
  .card { padding: 8px; border: 1px solid #ccc; }
  #deep { z-index: 1; position: relative; }
  #cover { position: absolute; top: 0; left: 0; width: 300px; height: 80px; z-index: 99; background: rgba(255,0,0,.2); }
</style></head>
<body>
  <h1 id="title">Fixture Page</h1>
  <button id="go">Run</button>
  <button id="slow">Slow</button>
  <input id="name" placeholder="name">
  <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <div id="hidden-box">you cannot see me</div>
  <div id="clipped"><span>clipped text</span></div>
  <div class="card" id="deep">deep card</div>
  <div id="cover"></div>
  <p id="out">idle</p>
  <script>
    console.log('fixture booted', { version: 3 });
    console.warn('a warning');
    localStorage.setItem('token', 'abc123');
    sessionStorage.setItem('step', 'checkout');
    window.__ticks = 0;
    setInterval(() => { window.__ticks++; }, 60000);
    function submitPayment(amount) {
      // Deliberate bug for the debugger test: amount is undefined on the click path.
      return fetch('/api/payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture': 'yes' },
        body: JSON.stringify({ cardToken: 'tok_92', currency: 'USD', amount: amount })
      }).then(r => r.json());
    }
    window.submitPayment = submitPayment;
    document.getElementById('go').addEventListener('click', async () => {
      document.getElementById('out').textContent = 'working';
      const res = await submitPayment(undefined);
      document.getElementById('out').textContent = 'error: ' + res.field;
      console.error('payment failed', res);
      try { null.f(); } catch (e) { setTimeout(() => { throw new Error('async boom'); }, 0); }
    });
    document.getElementById('slow').addEventListener('click', () => {
      fetch('/api/slow').then(() => console.log('slow done'));
    });
    const ws = new WebSocket('ws://127.0.0.1:PORT_PLACEHOLDER/ws');
    ws.onopen = () => ws.send('hello-from-page');
    ws.onmessage = (e) => console.log('ws said', e.data);
    const idb = indexedDB.open('fixture-db', 1);
    idb.onupgradeneeded = () => idb.result.createObjectStore('items', { keyPath: 'id' });
    idb.onsuccess = () => {
      const tx = idb.result.transaction('items', 'readwrite');
      tx.objectStore('items').put({ id: 1, name: 'widget', status: 'disabled' });
      tx.objectStore('items').put({ id: 2, name: 'gadget', status: 'active' });
    };
  </script>
</body></html>`;

async function startFixtureServer() {
  let wsPort = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      const body = FIXTURE_HTML.replace('PORT_PLACEHOLDER', String(wsPort));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/payment') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json', 'x-request-handled': 'fixture' });
        res.end(JSON.stringify({ error: 'missing field', field: 'amount', echo: JSON.parse(raw || '{}') }));
      });
      return;
    }
    if (url.pathname === '/api/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slow: true }));
      }, 800);
      return;
    }
    if (url.pathname === '/api/big') {
      // Big enough that the daemon must hand back an artifact, not inline text.
      const rows = Array.from({ length: 6000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
        status: i % 97 === 0 ? 'disabled' : 'active',
        note: 'x'.repeat(60),
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { users: rows }, marker: 'NEEDLE_IN_BIG_BODY' }));
      return;
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`// fixture module\nexport function computeTotal(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}\n// UNIQUE_SOURCE_TOKEN marker for js.search_source\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Minimal RFC6455 echo server, so WebSocket frames get recorded.
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      socket.send(`echo:${data}`);
      socket.send(JSON.stringify({ kind: 'tick', at: Date.now() }));
    });
  });
  wsPort = port;

  return { port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}

/* --------------------------------- main ---------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-live-'));
let fixture;
let transport;

async function main() {
  fixture = await startFixtureServer();
  process.stdout.write(`fixture server on ${fixture.base}\n`);
  process.stdout.write(`daemon home ${home}\n`);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn', ...(HEADED ? [] : [])],
    env: {
      ...process.env,
      AGENTBROWSER_HOME: home,
      AGENTBROWSER_LOG_LEVEL: 'warn',
      // Headless unless --headed, so the suite runs unattended.
      AGENTBROWSER_HEADLESS: HEADED ? '0' : '1',
    },
    stderr: 'pipe',
  });

  client = new Client({ name: 'browserd-live-test', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  process.stdout.write(`connected: ${tools.length} tools advertised\n`);

  await runSuite(tools);

  await client.close();
}

async function runSuite(tools) {
  const url = `${fixture.base}/`;

  /* ------------------------------ discovery ------------------------------ */
  area('protocol + discovery');
  await check('tools/list returns the full surface', async () => {
    must(tools.length >= 170, `only ${tools.length} tools`);
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      'page.screenshot', 'network.get_body', 'console.query', 'debugger.set_breakpoint',
      'time.run', 'fault.delay', 'memory.heap.compare', 'artifact.json_query', 'cdp.send',
    ]) must(names.has(required), `missing ${required}`);
    return `${tools.length} tools`;
  });
  await check('every tool has a description and input schema', async () => {
    const bad = tools.filter((t) => !t.description || !t.inputSchema);
    must(bad.length === 0, `${bad.length} incomplete: ${bad.slice(0, 3).map((t) => t.name)}`);
  });
  await check('readOnly tools are annotated', async () => {
    const shot = tools.find((t) => t.name === 'page.screenshot');
    must(shot.annotations?.readOnlyHint === true, 'page.screenshot not marked read-only');
    const click = tools.find((t) => t.name === 'page.click');
    must(click.annotations?.readOnlyHint === false, 'page.click marked read-only');
  });
  await check('invalid arguments are rejected by the schema', async () => {
    try {
      await call('page.navigate', { url: 12345 });
      throw new Error('expected a validation failure');
    } catch (err) {
      must(err.toolError || /invalid|expected/i.test(err.message), `unexpected: ${err.message}`);
    }
  });

  /* ------------------------------- browser ------------------------------- */
  area('browser lifecycle + auto-launch');
  let browserId;
  await check('browser.list shows nothing before first use', async () => {
    const r = await call('browser.list');
    must(r.count === 0, `expected 0, got ${r.count}`);
  });
  await check('a tool call auto-launches a browser (no human needed)', async () => {
    const r = await call('page.list_tabs');
    must(r.browser_id?.startsWith('br_'), 'no browser id');
    browserId = r.browser_id;
    return browserId;
  });
  await check('browser.status reports version and recording counters', async () => {
    const r = await call('browser.status');
    must(r.version?.product, 'no product');
    must(r.recording, 'no recording block');
    return r.version.product;
  });
  await check('browser.list_targets enumerates attached targets', async () => {
    const r = await call('browser.list_targets');
    must(r.count >= 1, 'no targets');
    return `${r.count} targets`;
  });

  /* ---------------------------- navigation/vision ------------------------ */
  area('navigation + vision');
  await check('page.navigate loads the fixture', async () => {
    const r = await call('page.navigate', { url, wait_until: 'load' });
    must(String(r.url).includes('127.0.0.1'), `url=${r.url}`);
  });
  await check('page.extract_text reads rendered text', async () => {
    const r = await call('page.extract_text', { max_chars: 500 });
    must(r.text.includes('Fixture Page'), 'title text missing');
  });
  await check('page.screenshot returns a real image block to the model', async () => {
    const r = await call('page.screenshot', { mode: 'viewport' });
    must(r.__image, 'no image content block');
    must(r.__image.mimeType === 'image/png', `mime=${r.__image.mimeType}`);
    must(r.__image.bytes > 1000, 'image suspiciously small');
    must(r.artifact?.artifact_id, 'no artifact stored');
    return `${r.__image.bytes} b64 chars + ${r.artifact.artifact_id}`;
  });
  await check('page.screenshot full_page works', async () => {
    const r = await call('page.screenshot', { mode: 'full_page', return_image: false });
    must(r.artifact?.size > 1000, 'no artifact bytes');
    return `${r.artifact.size} bytes`;
  });
  await check('page.snapshot gives stable refs for interaction', async () => {
    const r = await call('page.snapshot');
    const text = JSON.stringify(r);
    must(/e\d+/.test(text), 'no eNN refs in snapshot');
  });
  await check('page.list_frames reports execution contexts', async () => {
    const r = await call('page.list_frames');
    must(Array.isArray(r.frames) && r.frames.length >= 1, 'no frames');
  });

  /* ------------------------------ interaction ---------------------------- */
  area('interaction');
  await check('page.type enters text', async () => {
    await call('page.type', { selector: '#name', text: 'Ada Lovelace' });
    const r = await call('js.evaluate', { expression: `document.querySelector('#name').value` });
    must(r.value === 'Ada Lovelace', `got ${r.value}`);
  });
  await check('page.select_option chooses a value', async () => {
    await call('page.select_option', { selector: '#pick', values: ['b'] });
    const r = await call('js.evaluate', { expression: `document.querySelector('#pick').value` });
    must(r.value === 'b', `got ${r.value}`);
  });
  await check('page.hover works', async () => {
    await call('page.hover', { selector: '#title' });
  });
  await check('page.click triggers the app and its network call', async () => {
    await call('page.click', { selector: '#go' });
    await sleep(1200);
    const r = await call('js.evaluate', { expression: `document.querySelector('#out').textContent` });
    must(String(r.value).includes('amount'), `out=${r.value}`);
    return String(r.value);
  });
  await check('page.press sends key events', async () => {
    await call('page.press', { selector: '#name', key: 'Control+A' });
  });
  await check('page.scroll works', async () => {
    await call('page.scroll', { delta_y: 200 });
  });
  await check('page.highlight + unhighlight drive the overlay', async () => {
    await call('page.highlight', { selector: '#deep', duration_ms: 300 });
    await call('page.unhighlight');
  });
  await check('page.wait_for finds an existing element', async () => {
    const r = await call('page.wait_for', { selector: '#title', timeout_ms: 3000 });
    must(r.found !== false, 'not found');
  });

  /* -------------------------------- network ------------------------------ */
  area('network recording (the core requirement)');
  let paymentId;
  await check('network.list_requests shows traffic recorded without being asked', async () => {
    const r = await call('network.list_requests', { limit: 50 });
    must(r.total_matching >= 2, `only ${r.total_matching} requests`);
    const payment = r.requests.find((q) => q.url.includes('/api/payment'));
    must(payment, 'payment request not recorded');
    paymentId = payment.request_id;
    must(payment.status === 400, `status=${payment.status}`);
    return `${r.total_matching} requests, payment=${paymentId}`;
  });
  await check('network.get_request returns ALL headers, both sent and wire', async () => {
    const r = await call('network.get_request', { request_id: paymentId });
    must(r.request_headers, 'no request headers');
    must(r.response_headers, 'no response headers');
    const reqH = JSON.stringify(r.request_headers).toLowerCase();
    must(reqH.includes('x-fixture'), 'custom request header missing');
    const resH = JSON.stringify(r.response_headers).toLowerCase();
    must(resH.includes('x-request-handled'), 'custom response header missing');
    must(r.initiator, 'no initiator');
    must(r.timing, 'no timing');
    return `${Object.keys(r.request_headers).length} req / ${Object.keys(r.response_headers).length} res headers`;
  });
  await check('network.get_body returns the REQUEST payload (debuggable)', async () => {
    const r = await call('network.get_body', { request_id: paymentId, which: 'request', as_json: true });
    must(r.available, `not available: ${r.reason}`);
    must(r.parsed?.cardToken === 'tok_92', `payload=${JSON.stringify(r.parsed)}`);
    return `cardToken=${r.parsed.cardToken}, amount=${r.parsed.amount}`;
  });
  await check('network.get_body returns the RESPONSE body (debuggable)', async () => {
    const r = await call('network.get_body', { request_id: paymentId, which: 'response', as_json: true });
    must(r.available, `not available: ${r.reason}`);
    must(r.parsed?.field === 'amount', `body=${JSON.stringify(r.parsed)}`);
    return `error=${r.parsed.error} field=${r.parsed.field}`;
  });
  await check('network.summarize aggregates failures and slowest', async () => {
    const r = await call('network.summarize', { group_by: 'status' });
    must(r.request_count >= 2, 'too few');
    must(Array.isArray(r.failures), 'no failures array');
    must(r.failures.some((f) => f.status === 400), 'the 400 was not surfaced');
  });
  await check('network.search_bodies finds text inside recorded payloads', async () => {
    const r = await call('network.search_bodies', { query: 'missing field', which: 'response' });
    must(r.bodies_with_matches >= 1, 'no matches');
    return `${r.bodies_with_matches} bodies`;
  });
  await check('large response is stored as an artifact, not dumped inline', async () => {
    await call('js.evaluate', { expression: `fetch('/api/big').then(r=>r.json()).then(j=>window.__big=j.data.users.length)` });
    await sleep(1500);
    const list = await call('network.list_requests', { url_contains: '/api/big', limit: 5 });
    must(list.requests.length === 1, 'big request not recorded');
    const body = await call('network.get_body', { request_id: list.requests[0].request_id, max_chars: 500 });
    must(body.artifact?.artifact_id, 'no artifact');
    must(body.size > 400000, `body only ${body.size} bytes`);
    must(body.truncated === true, 'not truncated inline');
    must(body.body.length <= 600, `inline body too big: ${body.body.length}`);
    return `${body.size} bytes stored, ${body.body.length} chars inlined`;
  });
  await check('artifact.json_query slices the big body without loading it', async () => {
    const list = await call('network.list_requests', { url_contains: '/api/big', limit: 1 });
    const body = await call('network.get_body', { request_id: list.requests[0].request_id, max_chars: 200 });
    const q = await call('artifact.json_query', {
      artifact_id: body.artifact.artifact_id,
      path: "$.data.users[?(@.status == 'disabled')]",
      limit: 5,
    });
    must(q.match_count >= 1, `no jsonpath matches: ${JSON.stringify(q).slice(0, 200)}`);
    return `${q.match_count} disabled users`;
  });
  await check('artifact.search greps a huge artifact by stream', async () => {
    const list = await call('network.list_requests', { url_contains: '/api/big', limit: 1 });
    const body = await call('network.get_body', { request_id: list.requests[0].request_id, max_chars: 200 });
    const s = await call('artifact.search', { artifact_id: body.artifact.artifact_id, query: 'NEEDLE_IN_BIG_BODY' });
    must(s.matches_found_so_far >= 1, 'needle not found');
  });
  await check('network.list_websockets + ws_messages capture frames', async () => {
    const r = await call('network.list_websockets');
    must(r.count >= 1, 'no websockets recorded');
    const ws = r.websockets[0];
    const msgs = await call('network.ws_messages', { websocket_id: ws.websocket_id });
    must(msgs.total_messages >= 1, 'no frames');
    const sent = msgs.messages.some((m) => String(m.payload).includes('hello-from-page'));
    const got = msgs.messages.some((m) => String(m.payload).includes('echo:'));
    must(sent || got, 'neither direction captured');
    return `${msgs.total_messages} frames`;
  });
  await check('network.export_har produces a HAR artifact', async () => {
    const r = await call('network.export_har', { include_bodies: false });
    must(r.entry_count >= 2, 'too few entries');
    must(r.artifact?.artifact_id, 'no artifact');
    return `${r.entry_count} entries`;
  });

  /* -------------------------------- console ------------------------------ */
  area('console recording + execution');
  await check('console.query returns logs recorded continuously', async () => {
    const r = await call('console.query', { limit: 50 });
    must(r.total_matching >= 2, `only ${r.total_matching}`);
    const boot = r.entries.find((e) => String(e.text).includes('fixture booted'));
    must(boot, 'boot log missing (recording started too late)');
    return `${r.total_matching} entries`;
  });
  await check('console.query filters by level', async () => {
    const r = await call('console.query', { level: 'error', limit: 20 });
    must(r.entries.every((e) => e.level === 'error'), 'level filter leaked');
    must(r.entries.length >= 1, 'no errors captured');
  });
  await check('console.query filters by search text', async () => {
    const r = await call('console.query', { search: 'payment failed', limit: 10 });
    must(r.entries.length >= 1, 'search found nothing');
  });
  await check('uncaught exceptions are captured with stacks', async () => {
    const r = await call('console.exceptions', {});
    must(r.count >= 1, 'no exceptions recorded');
    const boom = JSON.stringify(r.exceptions);
    must(boom.includes('async boom'), 'async throw not captured');
    return `${r.count} exceptions`;
  });
  await check('js.evaluate runs like the DevTools console', async () => {
    const r = await call('js.evaluate', {
      expression: `[...document.querySelectorAll('button')].map(b => ({ text: b.innerText, id: b.id }))`,
    });
    must(Array.isArray(r.value) && r.value.length === 2, `got ${JSON.stringify(r.value)}`);
    return `${r.value.length} buttons`;
  });
  await check('js.evaluate reports thrown exceptions rather than hanging', async () => {
    const r = await call('js.evaluate', { expression: `throw new Error('deliberate')` });
    must(r.ok === false, 'expected ok:false');
    must(String(r.error).includes('deliberate'), `error=${r.error}`);
  });
  await check('console.export writes NDJSON to an artifact', async () => {
    const r = await call('console.export', {});
    must(r.entry_count >= 2, 'nothing exported');
    must(r.artifact?.artifact_id, 'no artifact');
    return `${r.entry_count} lines`;
  });

  /* --------------------------------- DOM/CSS ----------------------------- */
  area('DOM + CSS');
  await check('dom.summary gives structure not markup', async () => {
    const r = await call('dom.summary', { max_depth: 4 });
    must(r.tree.includes('h1'), 'no h1 in outline');
    must(r.tree.length < 4000, 'summary is too big to be a summary');
  });
  await check('dom.query returns boxes and visibility', async () => {
    const r = await call('dom.query', { selector: 'button' });
    must(r.total_matches === 2, `got ${r.total_matches}`);
    must(r.matches[0].box.width > 0, 'no box');
  });
  await check('dom.inspect returns attributes and a selector path', async () => {
    const r = await call('dom.inspect', { selector: '#deep' });
    must(r.tag === 'div', `tag=${r.tag}`);
    must(r.selector_path, 'no selector path');
  });
  await check('dom.get_html stores an artifact and truncates inline', async () => {
    const r = await call('dom.get_html', { whole_document: true, max_chars: 500 });
    must(r.artifact?.artifact_id, 'no artifact');
    must(r.length > 500, 'document unexpectedly tiny');
    must(r.truncated === true, 'not truncated');
  });
  await check('dom.set_attribute mutates the live page', async () => {
    await call('dom.set_attribute', { selector: '#title', name: 'data-tested', value: 'yes' });
    const r = await call('js.evaluate', { expression: `document.querySelector('#title').dataset.tested` });
    must(r.value === 'yes', `got ${r.value}`);
  });
  await check('css.computed returns real computed values', async () => {
    const r = await call('css.computed', { selector: '#hidden-box' });
    must(r.computed.display === 'none', `display=${r.computed.display}`);
  });
  await check('css.matched_rules shows the cascade with source lines', async () => {
    const r = await call('css.matched_rules', { selector: '#hidden-box' });
    must(Array.isArray(r.matched_rules), 'no rules');
    must(JSON.stringify(r.matched_rules).includes('display'), 'display rule not attributed');
  });
  await check('css.explain_visibility names the culprit (display:none)', async () => {
    const r = await call('css.explain_visibility', { selector: '#hidden-box' });
    must(r.visible === false, 'claims visible');
    must(String(r.verdict).includes('display: none'), `verdict=${r.verdict}`);
    return r.verdict.slice(0, 60);
  });
  await check('css.explain_visibility diagnoses a zero-width ancestor', async () => {
    const r = await call('css.explain_visibility', { selector: '#clipped span' });
    must(r.visible === false, 'claims visible');
    must(JSON.stringify(r.problems).includes('zero size'), `problems=${JSON.stringify(r.problems).slice(0,150)}`);
  });
  await check('css.set_style edits inline style', async () => {
    const r = await call('css.set_style', { selector: '#title', properties: { color: 'rgb(0, 128, 0)' } });
    must(JSON.stringify(r.applied).includes('128'), `applied=${JSON.stringify(r.applied)}`);
  });
  await check('dom.export dumps the tree to an artifact', async () => {
    const r = await call('dom.export', {});
    must(r.node_count > 10, `only ${r.node_count} nodes`);
    must(r.artifact?.artifact_id, 'no artifact');
    return `${r.node_count} nodes`;
  });

  /* --------------------------------- JS ---------------------------------- */
  area('JavaScript source access');
  await check('js.list_scripts enumerates loaded resources', async () => {
    await call('js.evaluate', { expression: `fetch('/app.js').then(r=>r.text())` });
    await sleep(500);
    const r = await call('js.list_scripts');
    must(r.count >= 1, 'no scripts');
    return `${r.count} scripts`;
  });
  await check('js.search_source greps loaded sources locally', async () => {
    const r = await call('js.search_source', { query: 'submitPayment', context_lines: 1 });
    must(r.total_matches >= 1, 'token not found in any source');
    return `${r.total_matches} hits in ${r.files_with_matches} files`;
  });
  await check('js.get_source returns a line window plus an artifact', async () => {
    const r = await call('js.get_source', { url, line_start: 1, line_end: 12 });
    must(r.artifact?.artifact_id, 'no artifact');
    must(r.source.split('\n').length <= 13, 'window not respected');
  });

  /* ------------------------------- storage ------------------------------- */
  area('storage');
  await check('storage.list reads localStorage', async () => {
    const r = await call('storage.list', { kind: 'local' });
    must(r.items.some((i) => i.key === 'token' && i.value === 'abc123'), `items=${JSON.stringify(r.items)}`);
  });
  await check('storage.list reads sessionStorage', async () => {
    const r = await call('storage.list', { kind: 'session' });
    must(r.items.some((i) => i.key === 'step'), 'session key missing');
  });
  await check('storage.set writes and the page sees it', async () => {
    await call('storage.set', { kind: 'session', key: 'debug_mode', value: 'true' });
    const r = await call('js.evaluate', { expression: `sessionStorage.getItem('debug_mode')` });
    must(r.value === 'true', `got ${r.value}`);
  });
  await check('storage.remove deletes a key', async () => {
    await call('storage.remove', { kind: 'session', key: 'debug_mode' });
    const r = await call('js.evaluate', { expression: `sessionStorage.getItem('debug_mode')` });
    must(r.value === null, `got ${r.value}`);
  });
  await check('cookies can be set and listed', async () => {
    await call('storage.set_cookie', { name: 'live_test', value: 'v1', url });
    const r = await call('storage.list_cookies', { name: 'live_test' });
    must(r.returned >= 1, 'cookie not found');
  });
  await check('IndexedDB databases and records are readable', async () => {
    const dbs = await call('storage.indexeddb.databases');
    must(dbs.databases.includes('fixture-db'), `dbs=${JSON.stringify(dbs.databases)}`);
    const desc = await call('storage.indexeddb.describe', { database: 'fixture-db' });
    must(desc.object_stores.some((s) => s.name === 'items'), 'store missing');
    const rows = await call('storage.indexeddb.query', { database: 'fixture-db', object_store: 'items' });
    must(rows.returned >= 2, `only ${rows.returned} records`);
    return `${rows.returned} records`;
  });
  await check('IndexedDB write goes through page-side API', async () => {
    const put = await call('storage.indexeddb.put', {
      database: 'fixture-db', object_store: 'items', value: { id: 3, name: 'sprocket', status: 'active' },
    });
    must(put.ok, `put=${JSON.stringify(put)}`);
    const rows = await call('storage.indexeddb.query', { database: 'fixture-db', object_store: 'items' });
    must(rows.returned >= 3, 'record not persisted');
  });
  await check('storage.usage reports quota', async () => {
    const r = await call('storage.usage');
    must(typeof r.quota_bytes === 'number', 'no quota');
  });
  await check('storage.export bundles everything to an artifact', async () => {
    const r = await call('storage.export');
    must(r.artifact?.artifact_id, 'no artifact');
  });

  /* ------------------------------- debugger ------------------------------ */
  area('JavaScript debugger');
  await check('debugger.enable turns on the domain', async () => {
    const r = await call('debugger.enable');
    must(r.enabled !== false, `r=${JSON.stringify(r).slice(0,150)}`);
  });
  await check('debugger.list_scripts sees parsed scripts', async () => {
    const r = await call('debugger.list_scripts');
    must(r.count >= 1, 'no parsed scripts');
    return `${r.count} scripts`;
  });
  await check('breakpoint set / list / remove round-trips', async () => {
    const set = await call('debugger.set_breakpoint', { url, line: 30 });
    must(set.breakpoint_id, 'no breakpoint id');
    const list = await call('debugger.list_breakpoints');
    must(list.count >= 1, 'not listed');
    await call('debugger.remove_breakpoint', { breakpoint_id: set.breakpoint_id });
    const after = await call('debugger.list_breakpoints');
    must(after.count === list.count - 1, 'not removed');
    return set.breakpoint_id;
  });
  await check('pause / call_frames / evaluate_on_frame / resume works', async () => {
    // Pause inside a function so there are real locals to inspect.
    await call('js.evaluate', {
      expression: `window.__dbg = () => { const secret = 'found-it'; debugger; return secret; }`,
    });
    await call('debugger.pause_on_exceptions', { state: 'none' });
    // Fire it without awaiting: the page will halt at `debugger`.
    call('js.evaluate', { expression: `setTimeout(() => window.__dbg(), 50)`, await_promise: false }).catch(() => {});
    const paused = await call('debugger.wait_for_pause', { timeout_ms: 8000 });
    must(paused.paused, `never paused: ${JSON.stringify(paused).slice(0, 150)}`);
    const frames = await call('debugger.call_frames');
    must(frames.frames?.length >= 1, 'no call frames');
    const ev = await call('debugger.evaluate_on_frame', { expression: 'secret', frame_index: 0 });
    must(String(JSON.stringify(ev)).includes('found-it'), `eval=${JSON.stringify(ev).slice(0, 200)}`);
    await call('debugger.resume');
    return `${frames.frames.length} frames, local read back`;
  });
  await check('debugger.disable cleans up', async () => {
    await call('debugger.disable');
  });

  /* ------------------------------- inspector ----------------------------- */
  area('inspector');
  await check('inspector.element returns listeners and accessibility', async () => {
    const r = await call('inspector.element', { selector: '#go' });
    must(r.tag === 'button', `tag=${r.tag}`);
    must(Array.isArray(r.event_listeners), 'no listener array');
    must(r.event_listeners.some((l) => l.type === 'click'), 'click listener not found');
    must(r.accessibility?.role, 'no ax role');
    return `role=${r.accessibility.role}, ${r.event_listeners.length} listeners`;
  });
  await check('inspector.parents walks the ancestor chain', async () => {
    const r = await call('inspector.parents', { selector: '#deep' });
    must(r.ancestors.length >= 1, 'no ancestors');
  });
  await check('inspector.children lists child elements', async () => {
    const r = await call('inspector.children', { selector: 'body' });
    must(r.total >= 5, `only ${r.total}`);
  });
  await check('inspector.snapshot captures DOMSnapshot to an artifact', async () => {
    const r = await call('inspector.snapshot');
    must(r.artifact?.artifact_id, 'no artifact');
    must(r.node_count > 5, `only ${r.node_count} nodes`);
    return `${r.node_count} nodes`;
  });
  await check('inspector.accessibility_tree renders the AX tree', async () => {
    const r = await call('inspector.accessibility_tree', { max_nodes: 60 });
    must(r.node_count >= 3, 'tree too small');
    must(r.tree.length > 10, 'no rendered tree');
  });
  await check('inspector.pick arms the picker without blocking', async () => {
    const r = await call('inspector.pick', {});
    must(r.inspect_mode === 'searchForNode', `mode=${r.inspect_mode}`);
    await call('inspector.pick', { mode: 'none' });
  });

  /* ------------------------------- profiler ------------------------------ */
  area('profiler + memory');
  await check('CPU profile start/stop returns top functions', async () => {
    await call('profiler.cpu.start');
    await call('js.evaluate', {
      expression: `(() => { let s = 0; for (let i = 0; i < 3e6; i++) s += Math.sqrt(i); return s; })()`,
    });
    const r = await call('profiler.cpu.stop', { top: 5 });
    must(r.artifact?.artifact_id, 'no cpuprofile artifact');
    must(Array.isArray(r.top_functions), 'no top_functions');
    return `${r.duration_ms}ms, ${r.top_functions.length} functions`;
  });
  await check('profiler.cpu.analyze re-reads a stored profile', async () => {
    const list = await call('artifact.list', { kind: 'cpu_profile', limit: 1 });
    const r = await call('profiler.cpu.analyze', { artifact_id: list.artifacts[0].artifact_id, top: 3 });
    must(Array.isArray(r.top_functions), 'no analysis');
  });
  await check('coverage start/stop reports unused bytes', async () => {
    await call('profiler.coverage.start');
    await call('js.evaluate', { expression: `1+1` });
    const r = await call('profiler.coverage.stop');
    must(typeof r.total_bytes === 'number', 'no totals');
    return `${r.script_count} scripts`;
  });
  await check('trace start/stop streams to an artifact', async () => {
    await call('profiler.trace.start', { preset: 'minimal' });
    await call('page.reload', { wait_until: 'load' });
    const r = await call('profiler.trace.stop');
    must(r.artifact?.artifact_id, 'no trace artifact');
    must(r.artifact.size > 1000, `trace only ${r.artifact.size} bytes`);
    return `${r.artifact.size} bytes, ~${r.approx_event_count} events`;
  });
  await check('profiler.trace.long_tasks analyzes the trace', async () => {
    const list = await call('artifact.list', { kind: 'trace', limit: 1 });
    const r = await call('profiler.trace.long_tasks', { artifact_id: list.artifacts[0].artifact_id, min_duration_ms: 1 });
    must(typeof r.long_task_count === 'number', 'no analysis');
    return `${r.long_task_count} tasks, longest ${r.longest_task_ms}ms`;
  });
  await check('heap snapshot + compare detects growth', async () => {
    const before = await call('memory.heap.snapshot', { label: 'before' });
    await call('js.evaluate', {
      expression: `window.__leak = []; for (let i = 0; i < 40000; i++) window.__leak.push({ i, pad: 'x'.repeat(40) }); window.__leak.length`,
    });
    const after = await call('memory.heap.snapshot', { label: 'after' });
    const diff = await call('memory.heap.compare', {
      before_artifact_id: before.artifact.artifact_id,
      after_artifact_id: after.artifact.artifact_id,
    });
    must(diff.size_delta > 100000, `delta only ${diff.size_delta}`);
    must(Array.isArray(diff.growth) && diff.growth.length > 0, 'no growth listed');
    return `+${Math.round(diff.size_delta / 1024)}KB, top=${diff.growth[0].constructor}`;
  });
  await check('memory.gc and memory.usage work', async () => {
    await call('memory.gc');
    const r = await call('memory.usage');
    must(r.js_heap_used_bytes > 0, 'no heap usage');
    return `${Math.round(r.js_heap_used_bytes / 1048576)}MB used`;
  });
  await check('performance.metrics returns counters', async () => {
    const r = await call('performance.metrics');
    must(r.dom_nodes > 0, 'no node count');
    return `${r.dom_nodes} nodes, ${r.event_listeners} listeners`;
  });
  await check('performance.processes enumerates Chromium processes', async () => {
    const r = await call('performance.processes');
    must(r.process_count >= 1, 'no processes');
    return `${r.process_count} processes`;
  });
  await check('preset-driven profile.start/stop produces a bundle', async () => {
    await call('profile.start', { preset: 'slow-page' });
    await call('page.click', { selector: '#slow' });
    await sleep(1200);
    const r = await call('profile.stop');
    must(r.manifest?.artifact_id, 'no manifest');
    must(r.artifacts?.cpu_profile, 'no cpu artifact in bundle');
    must(typeof r.network_requests === 'number', 'no network rollup');
    return `${r.duration_ms}ms, ${r.network_requests} reqs, ${r.console_errors} errors`;
  });

  /* --------------------------------- time -------------------------------- */
  area('clock control');
  await check('time.install pins the clock to a future date', async () => {
    const r = await call('time.install', { time: '2030-01-01T00:00:00Z' });
    must(r.installed, 'not installed');
    const now = await call('js.evaluate', { expression: `new Date().toISOString()` });
    must(String(now.value).startsWith('2030'), `page date=${now.value}`);
    return String(now.value);
  });
  await check('time.run fires every due timer in order', async () => {
    await call('js.evaluate', { expression: `window.__t = 0; setInterval(() => window.__t++, 60000);` });
    const r = await call('time.run', { duration: '30m' });
    must(r.timers_fired >= 30, `only fired ${r.timers_fired}`);
    const t = await call('js.evaluate', { expression: `window.__t` });
    must(t.value === 30, `page counter=${t.value}`);
    return `${r.timers_fired} timers fired, page saw ${t.value}`;
  });
  await check('time.jump fires each due timer at most once', async () => {
    await call('js.evaluate', { expression: `window.__j = 0; setInterval(() => window.__j++, 60000);` });
    await call('time.jump', { duration: '30m' });
    const j = await call('js.evaluate', { expression: `window.__j` });
    must(j.value === 1, `expected 1 (laptop-reopen semantics), got ${j.value}`);
    return `fired once, not ${30}`;
  });
  await check('time.freeze stops progression', async () => {
    const r = await call('time.freeze');
    must(r.paused, 'not paused');
    const a = await call('js.evaluate', { expression: `Date.now()` });
    await sleep(300);
    const b = await call('js.evaluate', { expression: `Date.now()` });
    must(a.value === b.value, `clock advanced ${b.value - a.value}ms while frozen`);
  });
  await check('time.set_fixed_date pins Date only', async () => {
    await call('time.resume');
    await call('time.set_fixed_date', { time: '2026-12-25T12:00:00Z' });
    const d = await call('js.evaluate', { expression: `new Date().toISOString()` });
    must(String(d.value).startsWith('2026-12-25'), `date=${d.value}`);
    await call('time.clear_fixed_date');
  });
  await check('time.uninstall restores real timers', async () => {
    const r = await call('time.uninstall');
    must(r.installed === false, 'still installed');
    const d = await call('js.evaluate', { expression: `new Date().getFullYear()` });
    must(d.value === new Date().getFullYear(), `year=${d.value}`);
  });

  /* ------------------------------ environment ---------------------------- */
  area('environment simulation');
  await check('device.preset emulates a phone (page sees the real width)', async () => {
    const r = await call('device.preset', { preset: 'iphone' });
    must(r.viewport.width === 390, `width=${r.viewport.width}`);
    // The fixture carries <meta name="viewport">, so the emulated width is the
    // layout width. Without that tag a real phone also lays out at 980px.
    const w = await call('js.evaluate', { expression: `innerWidth` });
    must(w.value === 390, `page innerWidth=${w.value}`);
    const dpr = await call('js.evaluate', { expression: `devicePixelRatio` });
    must(dpr.value === 3, `dpr=${dpr.value}`);
    // maxTouchPoints is live immediately; `ontouchstart in window` is decided
    // at document creation, so it only appears after a reload.
    const pts = await call('js.evaluate', { expression: `navigator.maxTouchPoints` });
    must(pts.value === 5, `maxTouchPoints=${pts.value}`);
    await call('page.reload', { wait_until: 'load' });
    const touch = await call('js.evaluate', { expression: `'ontouchstart' in window` });
    must(touch.value === true, 'ontouchstart absent after reload');
    return `${w.value}px layout, dpr=${dpr.value}, ${pts.value} touch points`;
  });
  await check('clicking still works under touch emulation', async () => {
    // Regression guard: touch emulation once wedged Input.dispatchMouseEvent
    // permanently. page.click must fall back to touch dispatch.
    const r = await call('page.click', { selector: '#title' });
    must(r.input === 'touch', `input path was ${r.input}`);
    return 'dispatched as touch';
  });
  await check('device.reset restores the viewport', async () => {
    await call('device.reset');
  });
  await check('cpu.throttle applies and resets', async () => {
    const r = await call('cpu.throttle', { rate: 4 });
    must(r.rate === 4, `rate=${r.rate}`);
    await call('cpu.reset');
  });
  await check('network.simulate applies a preset', async () => {
    const r = await call('network.simulate', { preset: 'slow-3g' });
    must(r.latency_ms === 400, `latency=${r.latency_ms}`);
    await call('network.simulate_reset');
  });
  await check('offline mode is visible to the page', async () => {
    await call('network.simulate', { preset: 'offline' });
    const r = await call('js.evaluate', { expression: `navigator.onLine` });
    must(r.value === false, `navigator.onLine=${r.value}`);
    await call('network.simulate_reset');
    return 'navigator.onLine=false';
  });
  await check('environment.timezone changes the page timezone', async () => {
    await call('environment.timezone', { timezone: 'Asia/Tokyo' });
    const r = await call('js.evaluate', {
      expression: `Intl.DateTimeFormat().resolvedOptions().timeZone`,
    });
    must(r.value === 'Asia/Tokyo', `tz=${r.value}`);
    return String(r.value);
  });
  await check('environment.color_scheme forces dark mode', async () => {
    await call('environment.color_scheme', { scheme: 'dark' });
    const r = await call('js.evaluate', { expression: `matchMedia('(prefers-color-scheme: dark)').matches` });
    must(r.value === true, 'media query did not flip');
  });
  await check('location.set overrides geolocation', async () => {
    await call('permissions.grant', { permissions: ['geolocation'] });
    await call('location.set', { preset: 'tokyo' });
    const r = await call('js.evaluate', {
      await_promise: true,
      expression: `new Promise(res => navigator.geolocation.getCurrentPosition(
        p => res(Math.round(p.coords.latitude)), e => res('err:' + e.code), { timeout: 4000 }))`,
    });
    must(r.value === 36 || r.value === 35, `lat=${r.value}`);
    return `lat=${r.value}`;
  });
  await check('environment.vision applies a deficiency filter', async () => {
    const r = await call('environment.vision', { deficiency: 'deuteranopia' });
    must(r.deficiency === 'deuteranopia', 'not applied');
  });
  await check('scenario.list and scenario.apply work', async () => {
    const list = await call('scenario.list');
    must(list.scenarios.length >= 3, 'too few scenarios');
    const r = await call('scenario.apply', { scenario: 'slow-mobile' });
    must(r.applied.device && r.applied.network && r.applied.cpu, 'scenario incomplete');
    return `${list.scenarios.length} scenarios`;
  });
  await check('environment.status lists active overrides', async () => {
    const r = await call('environment.status');
    must(Object.keys(r.active_overrides).length >= 2, 'overrides not tracked');
    return Object.keys(r.active_overrides).join(',');
  });
  await check('environment.reset clears everything', async () => {
    await call('environment.reset');
    const r = await call('environment.status');
    must(Object.keys(r.active_overrides).length === 0, `still set: ${JSON.stringify(r.active_overrides)}`);
  });

  /* -------------------------------- faults ------------------------------- */
  area('fault injection');
  await check('fault.replace_response returns a synthetic 500', async () => {
    const f = await call('fault.replace_response', {
      url: '**/api/payment', status: 500, body: { error: 'injected failure' },
    });
    must(f.fault_id, 'no fault id');
    const r = await call('js.evaluate', {
      await_promise: true,
      expression: `fetch('/api/payment', { method: 'POST', body: '{}' }).then(r => r.status + ':' + r.statusText).catch(e => 'threw')`,
    });
    must(String(r.value).startsWith('500'), `got ${r.value}`);
    await call('fault.remove', { fault_id: f.fault_id });
    return `page saw ${r.value}`;
  });
  await check('fault.abort makes matching requests fail', async () => {
    const f = await call('fault.abort', { url: '**/api/slow' });
    const r = await call('js.evaluate', {
      await_promise: true,
      expression: `fetch('/api/slow').then(() => 'ok').catch(() => 'failed')`,
    });
    must(r.value === 'failed', `got ${r.value}`);
    await call('fault.remove', { fault_id: f.fault_id });
  });
  await check('fault.delay stalls a request measurably', async () => {
    const f = await call('fault.delay', { url: '**/app.js', delay: '1200ms' });
    const r = await call('js.evaluate', {
      await_promise: true,
      timeout_ms: 20000,
      expression: `(async () => { const t = Date.now(); await fetch('/app.js?d=' + Math.random()); return Date.now() - t; })()`,
    });
    must(r.value >= 1000, `only took ${r.value}ms`);
    await call('fault.remove', { fault_id: f.fault_id });
    return `${r.value}ms`;
  });
  await check('fault.list and fault.clear manage rules', async () => {
    await call('fault.abort', { url: '**/nothing/**' });
    const list = await call('fault.list');
    must(list.count >= 1, 'no rules listed');
    const cleared = await call('fault.clear');
    must(cleared.interception_active === false, 'interception left on');
  });

  /* ------------------------------ control mode --------------------------- */
  area('control mode (human vs AI arbitration)');
  await check('observe mode refuses mutations but allows reads', async () => {
    await call('browser.set_control_mode', { mode: 'observe' });
    const read = await call('console.query', { limit: 1 });
    must(typeof read.total_matching === 'number', 'read blocked in observe');
    try {
      await call('page.click', { selector: '#go' });
      throw new Error('click was allowed in observe mode');
    } catch (err) {
      must(err.toolError, `unexpected: ${err.message}`);
      must(/control|observe|denied/i.test(JSON.stringify(err.payload)), `wrong error: ${err.message}`);
    }
    return 'reads ok, click denied';
  });
  await check('cdp.send is gated by control mode too', async () => {
    try {
      await call('cdp.send', { method: 'Browser.getVersion' });
      throw new Error('cdp.send was allowed in observe mode');
    } catch (err) {
      must(err.toolError, `unexpected: ${err.message}`);
    }
  });
  await check('shared mode restores mutation', async () => {
    await call('browser.set_control_mode', { mode: 'shared' });
    await call('page.click', { selector: '#title' });
  });

  /* ------------------------------ escape hatch --------------------------- */
  area('escape hatch + artifacts');
  await check('cdp.send reaches raw CDP', async () => {
    const r = await call('cdp.send', { method: 'Browser.getVersion' });
    must(r.result?.product, `result=${JSON.stringify(r.result).slice(0, 120)}`);
    return r.result.product;
  });
  await check('cdp.send works against a target session', async () => {
    const tabs = await call('page.list_tabs');
    const r = await call('cdp.send', {
      target_id: tabs.tabs[0].target_id,
      method: 'Runtime.evaluate',
      params: { expression: '2 + 2', returnByValue: true },
    });
    must(r.result?.result?.value === 4, `got ${JSON.stringify(r.result)}`);
  });
  await check('artifact.list / stat / read / read_lines work', async () => {
    const list = await call('artifact.list', { limit: 5 });
    must(list.count >= 1, 'no artifacts');
    const id = list.artifacts[0].artifact_id;
    const st = await call('artifact.stat', { artifact_id: id });
    must(st.exists, 'artifact missing on disk');
    const read = await call('artifact.read', { artifact_id: id, length: 200, encoding: 'base64' });
    must(read.bytes_read > 0, 'read nothing');
    return `${list.count} artifacts`;
  });
  await check('artifact.export copies to a caller path', async () => {
    const list = await call('artifact.list', { kind: 'har', limit: 1 });
    const dest = join(home, 'exported.har');
    const r = await call('artifact.export', { artifact_id: list.artifacts[0].artifact_id, path: dest });
    must(existsSync(dest), 'file not written');
    const parsed = JSON.parse(readFileSync(dest, 'utf8'));
    must(parsed.log?.entries?.length >= 1, 'HAR malformed');
    return `${parsed.log.entries.length} HAR entries on disk`;
  });

  /* -------------------------------- tabs --------------------------------- */
  area('tabs + teardown');
  await check('page.new_tab and page.close_tab manage tabs', async () => {
    const before = await call('page.list_tabs');
    const opened = await call('page.new_tab', { url: `${fixture.base}/`, activate: true });
    must(opened.target_id, 'no target id');
    await sleep(600);
    const during = await call('page.list_tabs');
    must(during.count === before.count + 1, `count ${during.count}`);
    await call('page.close_tab', { target_id: opened.target_id });
    await sleep(400);
    const after = await call('page.list_tabs');
    must(after.count === before.count, `count ${after.count}`);
    return `${before.count} -> ${during.count} -> ${after.count}`;
  });
  await check('recording survived navigation (history is intact)', async () => {
    const r = await call('page.history', { limit: 20 });
    must(r.navigations.length >= 2, `only ${r.navigations.length} navigations`);
    return `${r.navigations.length} navigations`;
  });
  await check('browser.close shuts the browser down', async () => {
    const r = await call('browser.close');
    must(r.closed, 'not closed');
    const list = await call('browser.list');
    must(list.count === 0, `${list.count} still running`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------- reporting ------------------------------- */

function report() {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const byArea = new Map();
  for (const r of results) {
    const b = byArea.get(r.area) ?? { pass: 0, fail: 0 };
    r.ok ? b.pass++ : b.fail++;
    byArea.set(r.area, b);
  }

  process.stdout.write(`\n\x1b[1m${'═'.repeat(64)}\nRESULTS\x1b[0m\n`);
  for (const [name, b] of byArea) {
    const mark = b.fail === 0 ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  ${mark} ${name.padEnd(42)} ${b.pass}/${b.pass + b.fail}\n`);
  }
  process.stdout.write(`\n  \x1b[1m${passed.length}/${results.length} checks passed\x1b[0m\n`);
  if (failed.length) {
    process.stdout.write(`\n\x1b[31mFailures:\x1b[0m\n`);
    for (const f of failed) process.stdout.write(`  - [${f.area}] ${f.label}\n      ${f.error}\n`);
  }
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
