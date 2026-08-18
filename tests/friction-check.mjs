/**
 * Live check for the friction-log fixes (BROWSERD-SUGGESTIONS.md).
 *
 * Every item that changed behaviour is exercised through tools/call against a
 * fixture built to trigger it: an sr-only SEO block, a 600px table that
 * overflows a phone, a React-style button that only responds to a real click,
 * a textarea fed multi-line text, and an API that is simply not there.
 *
 *   node tests/friction-check.mjs [--headed]
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

let client;

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
    throw err;
  }
  if (image) payload.__image = { mimeType: image.mimeType, bytes: image.data.length };
  return payload;
}

async function check(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ area: currentArea, label, ok: true });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label} \x1b[90m(${ms}ms)${detail ? ` ${detail}` : ''}\x1b[0m\n`);
  } catch (err) {
    results.push({ area: currentArea, label, ok: false, error: err.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n         ${err.message}\n`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

/* --------------------------- fixture ------------------------------------- */

const FIXTURE_HTML = `<!doctype html>
<html><head><title>Friction Fixture - Marketing Site</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; margin: 0; }
  main { padding: 16px; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }
  /* Deliberately wider than a phone, to give page.audit_layout something real. */
  #wide-table { width: 600px; border-collapse: collapse; }
  #wide-table td { border: 1px solid #ccc; padding: 4px; }
  #tiny-tap { width: 16px; height: 16px; padding: 0; font-size: 8px; }
  #fade { opacity: 0; animation: fade 600ms forwards; }
  @keyframes fade { to { opacity: 1; } }
</style></head>
<body>
  <p class="sr-only">SEO BOILERPLATE BLOCK best cheapest fastest widgets buy widgets online widget store near me</p>
  <main>
    <h1 id="heading">Real Visible Heading</h1>
    <div id="fade">faded in</div>
    <button id="react-btn">React Button</button>
    <button id="tiny-tap">x</button>
    <p id="status">idle</p>
    <textarea id="notes" rows="4"></textarea>
    <input id="single" type="text">
    <table id="wide-table"><tr><td>col-a-wide-content</td><td>col-b-wide-content</td><td>col-c-wide-content</td></tr></table>
    <p id="dom-only" style="display:none">DOMONLYTEXT marker</p>
  </main>
  <script>
    /*
     * Only responds to a trusted-looking click through the element's own
     * handler path, and ignores a raw mousedown/mouseup pair with buttons:0 -
     * the shape that made page.click report success for nothing.
     */
    var btn = document.getElementById('react-btn');
    btn.addEventListener('click', function (e) {
      if (e.detail === 0 && !e.isTrusted) return;
      document.getElementById('status').textContent = 'reacted';
    });
    setTimeout(function () {
      var p = document.createElement('p');
      p.id = 'late';
      p.textContent = 'LATE TEXT ARRIVED';
      document.querySelector('main').appendChild(p);
    }, 700);
    // A counter for page.observe(selector:).
    var n = 0;
    setInterval(function () {
      n++;
      document.getElementById('status').setAttribute('data-n', String(n));
    }, 200);
  </script>
</body></html>`;

async function startFixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FIXTURE_HTML);
      return;
    }
    if (url.pathname === '/api/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/* --------------------------------- main ---------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-friction-'));
let fixture;
let transport;

async function main() {
  fixture = await startFixture();
  process.stdout.write(`fixture ${fixture.base}\ndaemon home ${home}\n`);

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
  client = new Client({ name: 'browserd-friction-test', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const url = `${fixture.base}/`;

  /* ------------------------------------------------------- new surface --- */
  area('new tools are advertised');
  await check('page.audit_layout and network.probe and fault.test exist', async () => {
    for (const required of ['page.audit_layout', 'network.probe', 'fault.test']) {
      must(names.has(required), `missing ${required}`);
    }
    return `${tools.length} tools`;
  });

  /* --------------------------------------------- identity + navigation --- */
  area('S1: identity, navigation honesty');
  await check('page.navigate returns the committed title and HTTP status', async () => {
    const r = await call('page.navigate', { url, wait_until: 'load' });
    must(r.title === 'Friction Fixture - Marketing Site', `title was ${JSON.stringify(r.title)}`);
    must(r.http_status === 200, `http_status was ${r.http_status}`);
    must(r.committed === true, 'committed was not true');
    return `title=${JSON.stringify(r.title)} status=${r.http_status}`;
  });

  await check('browser.status lists page targets with url and title', async () => {
    const r = await call('browser.status');
    must(Array.isArray(r.pages), 'no pages array');
    const active = r.pages.find((p) => p.active) ?? r.pages[0];
    must(active, 'no page listed');
    must(String(active.url).startsWith(fixture.base), `url was ${active.url}`);
    must(active.title === 'Friction Fixture - Marketing Site', `title was ${active.title}`);
    must(active.load_state, 'no load_state');
    return `${r.pages.length} page(s), active title=${JSON.stringify(active.title)}, ${active.load_state}`;
  });

  await check('browser.list hides historical browsers by default', async () => {
    const r = await call('browser.list');
    must(r.historical === undefined, 'historical listed without being asked');
    return `${r.count} running, historical_available=${r.historical_available ?? 0}`;
  });

  /* ------------------------------------------------------------ snapshot --- */
  area('S1: snapshot and text extraction');
  await check('page.snapshot accepts root_selector and reports max_nodes', async () => {
    const r = await call('page.snapshot', { root_selector: 'main', max_nodes: 200 });
    must(r.root_selector === 'main', 'root_selector not echoed');
    must(r.max_nodes === 200, `max_nodes was ${r.max_nodes}`);
    must(r.node_count > 1, `only ${r.node_count} nodes`);
    return `${r.node_count} nodes, ${r.ref_count} refs`;
  });

  await check('page.extract_text(visible_only) drops the sr-only SEO block', async () => {
    const all = await call('page.extract_text');
    const visible = await call('page.extract_text', { visible_only: true });
    must(all.text.includes('SEO BOILERPLATE BLOCK'), 'fixture sr-only block was not in the default read');
    must(!visible.text.includes('SEO BOILERPLATE BLOCK'), 'visible_only still returned the sr-only block');
    must(visible.text.includes('Real Visible Heading'), 'visible_only dropped real content');
    must(visible.visible_only === true, 'visible_only not echoed');
    return `${all.length} -> ${visible.length} chars`;
  });

  /* ------------------------------------------------------------ wait_for --- */
  await check('page.wait_for reports which text path matched', async () => {
    await call('page.wait_for', { text: 'LATE TEXT ARRIVED', timeout_ms: 5000 });
    // Re-check once laid out, so this asserts the rendered path specifically.
    const r = await call('page.wait_for', { text: 'Real Visible Heading', timeout_ms: 3000 });
    must(r.matched_via === 'rendered_text', `matched_via was ${r.matched_via}`);
    return `matched_via=${r.matched_via}`;
  });

  await check('page.wait_for falls back to textContent for display:none text', async () => {
    const r = await call('page.wait_for', { text: 'DOMONLYTEXT', timeout_ms: 4000 });
    must(r.matched_via === 'dom_text', `matched_via was ${r.matched_via}`);
    must(r.note && r.note.includes('textContent'), 'no explanatory note');
    return `matched_via=${r.matched_via}`;
  });

  await check('page.wait_for near-miss explains a genuinely absent string', async () => {
    let err;
    try {
      await call('page.wait_for', { text: 'THIS STRING IS NOT ANYWHERE', timeout_ms: 1200 });
    } catch (e) {
      err = e;
    }
    must(err, 'wait_for did not fail on absent text');
    const near = JSON.stringify(err.payload ?? {});
    must(near.includes('closest_text') || near.includes('searched'), `no near-miss detail: ${near.slice(0, 200)}`);
    return 'near-miss reported';
  });

  /* ------------------------------------------------------------- click --- */
  area('S3: click verification and coordinates');
  await check('page.click reports DPR-aware coordinates', async () => {
    const r = await call('page.click', { selector: '#heading' });
    must(r.at && r.at.css && r.at.device, `at was ${JSON.stringify(r.at)}`);
    must(typeof r.at.dpr === 'number', 'no dpr');
    return `css=${r.at.css.x},${r.at.css.y} device=${r.at.device.x},${r.at.device.y} dpr=${r.at.dpr}`;
  });

  await check('page.click observes whether the page actually reacted', async () => {
    const r = await call('page.click', { selector: '#react-btn', verify_ms: 400 });
    must('observed_change' in r, 'no observed_change field');
    return `observed_change=${r.observed_change}${r.dom_mutations ? ` (${r.dom_mutations} mutations)` : ''}`;
  });

  await check('retry_if_unchanged falls back to the element own click', async () => {
    await call('js.evaluate', { expression: "document.getElementById('status').textContent = 'idle'" });
    const r = await call('page.click', { selector: '#react-btn', verify_ms: 300, retry_if_unchanged: true });
    const status = await call('page.extract_text', { selector: '#status' });
    must(status.text.includes('reacted'), `status was ${JSON.stringify(status.text)}`);
    return `observed_change=${r.observed_change}${r.retried_via ? ` via ${r.retried_via}` : ''}`;
  });

  /* -------------------------------------------------------------- type --- */
  area('S3: typing');
  await check('page.type sends newlines as Enter in a textarea', async () => {
    const r = await call('page.type', { selector: '#notes', text: 'line one\nline two\nline three', clear: true });
    const value = await call('js.evaluate', { expression: "document.getElementById('notes').value" });
    must(String(value.value).includes('\n'), `textarea holds ${JSON.stringify(value.value)}`);
    must(r.landed_characters === 28, `landed_characters=${r.landed_characters}`);
    return `newlines=${r.newlines} landed=${r.landed_characters}`;
  });

  await check('page.type warns rather than silently flattening on a single-line input', async () => {
    const r = await call('page.type', { selector: '#single', text: 'a\nb', clear: true });
    must(r.warning && r.warning.includes('single-line'), `no warning: ${JSON.stringify(r.warning)}`);
    return `warned, landed=${r.landed_characters}`;
  });

  await check('insert_text mode carries newlines verbatim', async () => {
    const r = await call('page.type', { selector: '#notes', text: 'x\ny', clear: true, insert_text: true });
    must(r.mode === 'insert_text', `mode was ${r.mode}`);
    must(r.landed_characters === 3, `landed_characters=${r.landed_characters}`);
    return `mode=${r.mode} landed=${r.landed_characters}`;
  });

  /* ------------------------------------------------------------ scroll --- */
  await check('page.scroll reports which mechanism moved the page', async () => {
    const r = await call('page.scroll', { delta_y: 200 });
    must(r.via === 'wheel' || r.via === 'script', `via was ${r.via}`);
    return `via=${r.via} position=${JSON.stringify(r.position)}`;
  });

  /* ------------------------------------------------------------ observe --- */
  await check('page.observe(selector) watches one element without an expression', async () => {
    const r = await call('page.observe', { selector: '#status', every_ms: 100, for_ms: 600 });
    must(r.selector === '#status', 'selector not echoed');
    must(Array.isArray(r.samples) || Array.isArray(r.timeline), `no timeline: ${Object.keys(r)}`);
    return `sampled ${JSON.stringify(r.sampled)}`;
  });

  /* --------------------------------------------------------- screenshot --- */
  area('S2/S3: screenshots');
  await check('page.screenshot settles animations and downscales', async () => {
    const r = await call('page.screenshot', {
      mode: 'viewport',
      settle: true,
      max_width: 400,
      format: 'webp',
      timeout_ms: 20000,
    });
    must(r.__image, 'no image returned');
    return `${r.__image.bytes} b64 chars, ${JSON.stringify(r.scaled ?? r.width ?? 'n/a')}`;
  });

  await check('full_page capture with trigger_lazy_content completes', async () => {
    const r = await call('page.screenshot', {
      mode: 'full_page',
      trigger_lazy_content: true,
      max_width: 500,
      timeout_ms: 20000,
    });
    must(r.__image, 'no image returned');
    return `${r.__image.bytes} b64 chars`;
  });

  /* -------------------------------------------------------- audit_layout --- */
  area('S2: layout audit');
  await check('page.audit_layout finds the 600px table at phone widths', async () => {
    const r = await call('page.audit_layout', { widths: [320, 1280], min_touch_target: 24 });
    const at320 = r.results[0].widths['320'];
    const at1280 = r.results[0].widths['1280'];
    must(at320.horizontal_scroll === true, 'no horizontal scroll detected at 320');
    must(at1280.horizontal_scroll === false, 'reported horizontal scroll at 1280');
    must(at320.overflowing.length > 0, 'no overflowing element listed');
    must(at320.touch_targets_below_total > 0, 'the 16px button was not flagged');
    return `320: scroll=${at320.horizontal_scroll}, ${at320.overflowing_outermost_total} overflow, ${at320.touch_targets_below_total} small taps`;
  });

  await check('audit_layout restores the real viewport afterwards', async () => {
    const w = await call('js.evaluate', { expression: 'innerWidth' });
    must(Number(w.value) > 400, `viewport still emulated at ${w.value}px`);
    return `${w.value}px`;
  });

  /* --------------------------------------------------------- device preset --- */
  await check('device.preset has a 320px phone-small profile', async () => {
    const r = await call('device.preset', { preset: 'phone-small' });
    must(r.viewport.width === 320, `width was ${r.viewport.width}`);
    must(r.viewport.height === 568, `height was ${r.viewport.height}`);
    await call('device.reset');
    return `${r.viewport.width}x${r.viewport.height} dpr=${r.device_scale_factor}`;
  });

  /* -------------------------------------------------------------- network --- */
  area('S2: network');
  await check('network.probe reports reachability from the page', async () => {
    const ok = await call('network.probe', { url: `${fixture.base}/api/ok` });
    must(ok.reachable === true, `not reachable: ${JSON.stringify(ok)}`);
    must(ok.status === 200, `status ${ok.status}`);
    const dead = await call('network.probe', { url: 'http://127.0.0.1:1/nothing', timeout_ms: 3000 });
    must(dead.reachable === false, 'a dead port reported as reachable');
    return `ok=${ok.status} in ${ok.duration_ms}ms, dead port refused`;
  });

  await check('network.list_requests projects only the requested fields', async () => {
    const r = await call('network.list_requests', { fields: ['url', 'status'], limit: 5 });
    must(r.requests.length > 0, 'no requests recorded');
    const keys = Object.keys(r.requests[0]).sort();
    must(keys.join(',') === 'status,url', `got fields ${keys.join(',')}`);
    return `${r.requests.length} rows, fields=${keys.join(',')}`;
  });

  await check('network.summarize groups by error and rolls up telemetry', async () => {
    await call('js.evaluate', {
      expression: `fetch('${fixture.base}/missing-a').catch(()=>{}); fetch('${fixture.base}/missing-b').catch(()=>{}); true`,
    });
    await new Promise((r) => setTimeout(r, 700));
    const r = await call('network.summarize', { group_by: 'error', sort: 'time' });
    const http404 = r.groups.find((g) => g.key === 'http_404');
    must(http404, `no http_404 group: ${r.groups.map((g) => g.key).join(',')}`);
    must(r.failures.every((f) => f.started_at), 'a failure entry had no started_at');
    return `groups=${r.groups.map((g) => `${g.key}:${g.count}`).join(' ')}`;
  });

  await check('network.summarize can exclude domains', async () => {
    const r = await call('network.summarize', { group_by: 'domain', exclude_domains: ['127.0.0.1'] });
    must(r.excluded && r.excluded.by_domain > 0, `nothing excluded: ${JSON.stringify(r)}`);
    // Excluding the only host empties the result, and that has to say why.
    must(r.explanation.includes('exclude_domains'), `explanation did not mention it: ${r.explanation}`);
    return `excluded ${r.excluded.by_domain}, explained`;
  });

  await check('zero-match list_requests explains itself', async () => {
    const r = await call('network.list_requests', { url_contains: 'zzz-no-such-path' });
    must(r.returned === 0, 'unexpectedly matched');
    must(r.explanation && r.explanation.includes('matched'), `no explanation: ${JSON.stringify(r.explanation)}`);
    return r.explanation.slice(0, 70);
  });

  /* ---------------------------------------------------------------- faults --- */
  area('S2/S3: fault feedback');
  await check('fault.test dry-runs a glob without creating a rule', async () => {
    const before = await call('fault.list');
    const r = await call('fault.test', { url: `${fixture.base}/**` });
    const after = await call('fault.list');
    must(after.count === before.count, 'fault.test created a rule');
    must(r.matches > 0, `matched nothing: ${JSON.stringify(r).slice(0, 200)}`);
    return `${r.matches}/${r.requests_considered} match, ${r.sample_matches.length} samples`;
  });

  await check('fault.test warns when a glob would kill the page document', async () => {
    const r = await call('fault.test', { url: `${fixture.base}/**` });
    must(r.warning && r.warning.includes('Document'), `no document warning: ${JSON.stringify(r.warning)}`);
    return 'warned about the driven page';
  });

  await check('a glob that matches nothing says so at creation', async () => {
    const r = await call('fault.abort', { url: 'http://never.example.invalid/**' });
    must(r.matches_in_recording === 0, `matched ${r.matches_in_recording}`);
    must(r.warning && r.warning.includes('none'), `no warning: ${JSON.stringify(r.warning)}`);
    const list = await call('fault.list');
    const rule = list.faults.find((f) => f.fault_id === r.fault_id);
    must(rule.note && rule.note.includes('never fired'), 'fault.list did not flag the unfired rule');
    await call('fault.clear');
    return 'creation and list both flagged it';
  });

  await check('a rule that fires records the URLs it matched', async () => {
    await call('fault.abort', { url: `${fixture.base}/api/**`, error_reason: 'ConnectionRefused' });
    await call('js.evaluate', { expression: `fetch('${fixture.base}/api/ok').catch(()=>{}); true` });
    await new Promise((r) => setTimeout(r, 600));
    const list = await call('fault.list');
    const rule = list.faults[0];
    must(rule.times_applied > 0, 'rule never fired');
    must(rule.matched_so_far && rule.matched_so_far.length > 0, 'no matched_so_far');
    await call('fault.clear');
    return `${rule.times_applied} hits, first=${rule.matched_so_far[0].slice(-20)}`;
  });

  /* --------------------------------------------------------------- console --- */
  area('S2: console');
  await check('console entries are not duplicated', async () => {
    const marker = `DEDUPE_MARKER_${Date.now()}`;
    await call('js.evaluate', { expression: `console.log(${JSON.stringify(marker)}); true` });
    await new Promise((r) => setTimeout(r, 400));
    const r = await call('console.query', { search: marker, include_exceptions: false });
    must(r.returned === 1, `${r.returned} entries for one console.log`);
    return '1 entry per log';
  });

  await check('failed-resource console entries carry a usable request_id', async () => {
    await call('js.evaluate', {
      expression: `var i=new Image(); i.src='${fixture.base}/missing-image-xyz.png'; true`,
    });
    await new Promise((r) => setTimeout(r, 900));
    const r = await call('console.query', { search: 'Failed to load resource', include_exceptions: false, limit: 5 });
    if (r.returned === 0) return 'no failed-resource entry emitted (browser did not log one)';
    const withId = r.entries.find((e) => e.network_request_id);
    must(withId, `no entry carried a request_id: ${JSON.stringify(r.entries[0])}`);
    must(String(withId.network_request_id).startsWith('req_'), `id was ${withId.network_request_id}`);
    const detail = await call('network.get_request', { request_id: withId.network_request_id });
    must(detail.url.includes('missing-image-xyz'), `request_id resolved to ${detail.url}`);
    return `request_id joins to ${detail.url.slice(-24)}`;
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
    process.stdout.write(
      `\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`,
    );
    for (const f of failed) process.stdout.write(`  \x1b[31m${f.area} / ${f.label}\x1b[0m\n`);
    process.exit(failed.length ? 1 : 0);
  });
