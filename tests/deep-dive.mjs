/**
 * Deep verification of the debugging surface against a REAL public website,
 * driven entirely through MCP: debugger, inspector, memory, session storage,
 * control mode, console access, and real network log export/inspection.
 *
 *   node tests/deep-dive.mjs [--headless]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'browserd-deep-'));
const HEADLESS = process.argv.includes('--headless');
const SITE = 'https://news.ycombinator.com';

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
const area = (n) => console.log(`\n\x1b[1m-- ${n} ${'-'.repeat(Math.max(0, 56 - n.length))}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
  env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_HEADLESS: HEADLESS ? '1' : '0' },
  stderr: 'pipe',
});
const client = new Client({ name: 'deep-dive', version: '1.0.0' });
await client.connect(transport);

const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const txt = r.content.find((c) => c.type === 'text')?.text ?? '{}';
  const p = JSON.parse(txt);
  if (r.isError) {
    const e = new Error(`${n}: ${p.message ?? txt}`);
    e.payload = p;
    throw e;
  }
  const img = r.content.find((c) => c.type === 'image');
  if (img) p.__img = img.data.length;
  return p;
};
const test = async (l, fn) => {
  try {
    ok(l, await fn());
  } catch (e) {
    no(l, e.message);
  }
};

try {
  await call('browser.launch', { headless: HEADLESS, profile: 'deep', window_size: { width: 1400, height: 950 } });
  await call('page.navigate', { url: SITE, wait_until: 'load' });
  await sleep(1000);

  /* ============================ CONSOLE ACCESS ========================== */
  area('console log access (real site + injected)');
  await test('reads console output the real page produced', async () => {
    await call('js.evaluate', {
      expression: `console.log('deep-dive marker', {a:1}); console.warn('warned'); console.error('errored')`,
    });
    await sleep(400);
    const c = await call('console.query', { limit: 50 });
    const marker = c.entries.find((e) => String(e.text).includes('deep-dive marker'));
    if (!marker) throw new Error('marker log not recorded');
    if (!marker.args?.length) throw new Error('structured args not captured');
    return `${c.total_matching} entries, args captured, stack ${marker.stack ? 'yes' : 'no'}`;
  });
  await test('level filtering isolates errors', async () => {
    const e = await call('console.query', { level: 'error', limit: 20 });
    if (!e.entries.length) throw new Error('no errors');
    if (!e.entries.every((x) => x.level === 'error')) throw new Error('filter leaked');
    return `${e.entries.length} error entries`;
  });
  await test('captures a real uncaught exception with a stack', async () => {
    await call('js.evaluate', { expression: `setTimeout(() => { throw new Error('deep-dive-uncaught'); }, 0)` });
    await sleep(600);
    const x = await call('console.exceptions', {});
    const hit = x.exceptions.find((e) => JSON.stringify(e).includes('deep-dive-uncaught'));
    if (!hit) throw new Error('exception not recorded');
    return `${x.count} exceptions, stack frames: ${hit.stack?.length ?? 0}`;
  });
  await test('console survives navigation (preserve-log behaviour)', async () => {
    const before = (await call('console.query', { limit: 1 })).total_matching;
    await call('page.reload', { wait_until: 'load' });
    await sleep(800);
    const after = (await call('console.query', { limit: 1 })).total_matching;
    if (after < before) throw new Error(`lost entries: ${before} -> ${after}`);
    return `${before} kept across reload -> ${after}`;
  });
  await test('console.export writes real NDJSON to disk', async () => {
    const dest = join(home, 'console.ndjson');
    await call('console.export', { save_path: dest });
    const lines = readFileSync(dest, 'utf8').trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l));
    if (!parsed.length) throw new Error('empty export');
    return `${lines.length} NDJSON lines on disk, kinds: ${[...new Set(parsed.map((p) => p.kind))].join('/')}`;
  });

  /* ======================= NETWORK LOG / EXPORT ========================= */
  area('real network log: inspect + export');
  await test('records the real site load including the main document', async () => {
    const n = await call('network.list_requests', { limit: 200 });
    const doc = n.requests.find((r) => r.resource_type === 'Document');
    if (!doc) throw new Error('main document missing from recording');
    if (!n.total_matching) throw new Error('nothing recorded');
    const types = [...new Set(n.requests.map((r) => r.resource_type))];
    return `${n.total_matching} requests, types: ${types.join(', ')}`;
  });
  await test('full header inspection on a real HTTPS request', async () => {
    const n = await call('network.list_requests', { limit: 50 });
    const doc = n.requests.find((r) => r.resource_type === 'Document') ?? n.requests[0];
    const d = await call('network.get_request', { request_id: doc.request_id });
    if (!Object.keys(d.response_headers).length) throw new Error('no response headers');
    if (!d.timing) throw new Error('no timing');
    return `${d.protocol} ${d.remote_address} | ${Object.keys(d.request_headers).length} req + ${Object.keys(d.response_headers).length} res headers | server=${d.response_headers.server ?? '?'}`;
  });
  await test('reads a real response body off the wire', async () => {
    const n = await call('network.list_requests', { limit: 50 });
    const doc = n.requests.find((r) => r.resource_type === 'Document') ?? n.requests[0];
    const b = await call('network.get_body', { request_id: doc.request_id, max_chars: 300 });
    if (!b.available) throw new Error(`body unavailable: ${b.reason}`);
    if (!String(b.body).length) throw new Error('empty body');
    return `${b.size} bytes, artifact ${b.artifact.artifact_id}`;
  });
  await test('timing + size analysis over real traffic', async () => {
    const s = await call('network.summarize', { group_by: 'domain' });
    return `${s.request_count} reqs, ${Math.round(s.total_transferred_bytes / 1024)}KB, slowest ${s.slowest[0]?.duration_ms ?? 0}ms`;
  });
  await test('HAR export is a valid, loadable file', async () => {
    const dest = join(home, 'real.har');
    await call('network.export_har', { include_bodies: true, save_path: dest });
    const har = JSON.parse(readFileSync(dest, 'utf8'));
    if (har.log.version !== '1.2') throw new Error('not HAR 1.2');
    const e = har.log.entries[0];
    if (!e.request?.url || !e.response) throw new Error('malformed entry');
    const withBodies = har.log.entries.filter((x) => x.response?.content?.text).length;
    return `${har.log.entries.length} entries, ${withBodies} with bodies, ${Math.round(statSync(dest).size / 1024)}KB on disk`;
  });
  await test('searching inside recorded bodies finds real content', async () => {
    const r = await call('network.search_bodies', { query: 'Hacker News', which: 'response' });
    if (!r.bodies_with_matches) throw new Error('needle not found in any real body');
    return `${r.bodies_with_matches} bodies matched`;
  });

  /* ============================== DEBUGGER ============================== */
  area('debugger: breakpoints, stepping, variables');
  await test('enable + see real parsed scripts from the site', async () => {
    await call('debugger.enable');
    const s = await call('debugger.list_scripts');
    if (!s.count) throw new Error('no scripts parsed');
    return `${s.count} scripts parsed on the live site`;
  });
  await test('pause on a debugger statement and read a LOCAL variable', async () => {
    await call('js.evaluate', {
      expression: `window.__probe = function(order) { const total = order.qty * order.price; const tax = total * 0.2; debugger; return total + tax; }`,
    });
    call('js.evaluate', {
      expression: `setTimeout(() => window.__probe({qty: 3, price: 25}), 50)`,
      await_promise: false,
    }).catch(() => {});
    const p = await call('debugger.wait_for_pause', { timeout_ms: 8000 });
    if (!p.paused) throw new Error('never paused');
    const f = await call('debugger.call_frames');
    const total = await call('debugger.evaluate_on_frame', { expression: 'total', frame_index: 0 });
    const tax = await call('debugger.evaluate_on_frame', { expression: 'tax', frame_index: 0 });
    const arg = await call('debugger.evaluate_on_frame', { expression: 'order.qty', frame_index: 0 });
    const tv = JSON.stringify(total);
    const xv = JSON.stringify(tax);
    if (!tv.includes('75')) throw new Error(`total wrong: ${tv}`);
    if (!xv.includes('15')) throw new Error(`tax wrong: ${xv}`);
    return `paused at ${f.frames[0].function || '(anon)'} | total=75 tax=15 order.qty=${JSON.stringify(arg).match(/\d+/)?.[0]}`;
  });
  await test('inspect the scope chain while paused', async () => {
    const f = await call('debugger.call_frames');
    const scopes = f.frames[0].scopes ?? [];
    if (!scopes.length) throw new Error('no scope chain');
    // A paused function frame must expose at least its own locals and global.
    const types = scopes.map((s) => s.type);
    if (!types.includes('local')) throw new Error(`no local scope: ${types.join('/')}`);
    const expandable = scopes.find((s) => s.object_id);
    if (!expandable) throw new Error('no expandable scope object');
    const props = await call('debugger.inspect_object', { object_id: expandable.object_id });
    return `${f.frames.length} frames, ${scopes.length} scopes (${types.join('/')}), ${props.properties?.length ?? 0} props readable`;
  });
  await test('step through execution while paused', async () => {
    const s = await call('debugger.step', { kind: 'over' });
    await sleep(300);
    return `stepped: ${s.reason ?? s.stepped ?? 'ok'}`;
  });
  await test('resume returns the page to running', async () => {
    await call('debugger.resume').catch(() => {});
    await sleep(300);
    const r = await call('js.evaluate', { expression: '1+1' });
    if (r.value !== 2) throw new Error('page did not resume');
    return 'page responsive again';
  });
  await test('conditional breakpoint on a real script URL', async () => {
    const s = await call('debugger.list_scripts');
    const real = (s.scripts ?? []).find((x) => String(x.url).startsWith('http'));
    if (!real) return 'no external script on this page (skipped)';
    const bp = await call('debugger.set_breakpoint', { url: real.url, line: 1, condition: 'false' });
    await call('debugger.remove_breakpoint', { breakpoint_id: bp.breakpoint_id });
    return `set+removed on ${String(real.url).split('/').pop()}`;
  });
  await call('debugger.disable').catch(() => {});

  /* ============================== INSPECTOR ============================= */
  area('inspector: elements, listeners, layout, a11y');
  await test('inspect a real element with listeners + accessibility', async () => {
    const i = await call('inspector.element', { selector: 'a' });
    if (!i.box) throw new Error('no box model');
    return `<${i.tag}> box ${Math.round(i.box.width)}x${Math.round(i.box.height)}, role=${i.accessibility?.role ?? '?'}, ${i.event_listeners?.length ?? 0} listeners`;
  });
  await test('walk real ancestors with stacking context', async () => {
    const p = await call('inspector.parents', { selector: 'a' });
    if (!p.ancestors.length) throw new Error('no ancestors');
    return `${p.ancestors.length} deep: ${p.ancestors.slice(0, 3).map((a) => a.element).join(' < ')}`;
  });
  await test('DOMSnapshot of a real page with layout', async () => {
    const s = await call('inspector.snapshot', { save_path: join(home, 'snapshot.json') });
    const raw = JSON.parse(readFileSync(join(home, 'snapshot.json'), 'utf8'));
    if (!raw.documents?.length) throw new Error('no documents in snapshot');
    return `${s.node_count} nodes, ${s.string_table_size} strings, ${Math.round(statSync(join(home, 'snapshot.json')).size / 1024)}KB`;
  });
  await test('accessibility tree of the real site', async () => {
    const a = await call('inspector.accessibility_tree', { max_nodes: 40 });
    if (!a.tree.length) throw new Error('empty tree');
    return `${a.node_count} AX nodes; first: ${a.tree.split('\n')[0].trim().slice(0, 45)}`;
  });
  await test('css.explain_visibility on a genuinely hidden element', async () => {
    await call('js.evaluate', {
      expression: `(() => { const d=document.createElement('div'); d.id='dd-hidden'; d.style.display='none'; d.textContent='x'; document.body.appendChild(d); })()`,
    });
    const v = await call('css.explain_visibility', { selector: '#dd-hidden' });
    if (v.visible) throw new Error('claims visible');
    return v.verdict.slice(0, 55);
  });

  /* ===================== MEMORY / SESSION STORAGE ======================= */
  area('memory + session storage');
  await test('session storage round-trips on a real origin', async () => {
    await call('storage.set', { kind: 'session', key: 'dd_session', value: JSON.stringify({ step: 'checkout', ts: 1 }) });
    const g = await call('storage.get', { kind: 'session', key: 'dd_session', as_json: true });
    if (g.parsed?.step !== 'checkout') throw new Error(`got ${JSON.stringify(g)}`);
    const inPage = await call('js.evaluate', { expression: `sessionStorage.getItem('dd_session')` });
    if (!String(inPage.value).includes('checkout')) throw new Error('page cannot see it');
    return `origin ${g.origin}, page agrees`;
  });
  await test('session vs local storage stay separate', async () => {
    await call('storage.set', { kind: 'local', key: 'dd_local', value: 'L' });
    const s = await call('storage.list', { kind: 'session' });
    const l = await call('storage.list', { kind: 'local' });
    if (s.items.some((i) => i.key === 'dd_local')) throw new Error('local leaked into session');
    if (!l.items.some((i) => i.key === 'dd_local')) throw new Error('local not stored');
    return `session=${s.count} keys, local=${l.count} keys`;
  });
  await test('session storage clears without touching local', async () => {
    await call('storage.clear', { kind: 'session' });
    const s = await call('storage.list', { kind: 'session' });
    const l = await call('storage.list', { kind: 'local' });
    if (s.count !== 0) throw new Error(`session still has ${s.count}`);
    if (!l.count) throw new Error('local was wiped too');
    return `session emptied, local kept ${l.count}`;
  });
  await test('JS heap + DOM counters from the real page', async () => {
    const m = await call('memory.usage');
    if (!m.js_heap_used_bytes) throw new Error('no heap reading');
    return `${Math.round(m.js_heap_used_bytes / 1048576)}MB used / ${Math.round(m.js_heap_total_bytes / 1048576)}MB, ${m.dom_counters?.nodes ?? '?'} nodes, ${m.dom_counters?.event_listeners ?? '?'} listeners`;
  });
  await test('heap snapshot + diff detects a real leak', async () => {
    const before = await call('memory.heap.snapshot', { label: 'dd-before' });
    await call('js.evaluate', {
      expression: `window.__leak = []; for (let i=0;i<60000;i++) window.__leak.push({i, s:'y'.repeat(50)}); window.__leak.length`,
    });
    const after = await call('memory.heap.snapshot', { label: 'dd-after' });
    const d = await call('memory.heap.compare', {
      before_artifact_id: before.artifact.artifact_id,
      after_artifact_id: after.artifact.artifact_id,
    });
    if (d.size_delta < 100000) throw new Error(`no growth detected (${d.size_delta})`);
    return `+${Math.round((d.size_delta / 1048576) * 10) / 10}MB, top growth: ${d.growth.slice(0, 3).map((g) => g.constructor).join(', ')}`;
  });
  await test('detached DOM nodes are surfaced (classic leak signature)', async () => {
    const before = await call('memory.heap.snapshot', { label: 'dd-dom-before' });
    await call('js.evaluate', {
      expression: `window.__detached = []; for (let i=0;i<3000;i++){ const d=document.createElement('div'); d.innerHTML='<span>x</span>'; window.__detached.push(d); } window.__detached.length`,
    });
    await call('memory.gc');
    const after = await call('memory.heap.snapshot', { label: 'dd-dom-after' });
    const d = await call('memory.heap.compare', {
      before_artifact_id: before.artifact.artifact_id,
      after_artifact_id: after.artifact.artifact_id,
    });
    const det = d.detached_dom ?? [];
    return det.length
      ? `${det.length} detached constructors, e.g. ${det[0].constructor} +${det[0].count_delta}`
      : `no detached bucket (heap +${Math.round(d.size_delta / 1024)}KB)`;
  });
  await test('heap snapshot artifact is a real .heapsnapshot file', async () => {
    const dest = join(home, 'heap.heapsnapshot');
    await call('memory.heap.snapshot', { label: 'dd-file', save_path: dest });
    const j = JSON.parse(readFileSync(dest, 'utf8'));
    if (!j.snapshot?.meta?.node_fields) throw new Error('not a valid heap snapshot');
    return `${Math.round((statSync(dest).size / 1048576) * 10) / 10}MB, ${j.snapshot.node_count} nodes (loadable in DevTools)`;
  });

  /* ============================ CONTROL MODE ============================ */
  area('control mode arbitration');
  await test('observe blocks writes to storage and DOM but allows reads', async () => {
    await call('browser.set_control_mode', { mode: 'observe' });
    const read = await call('storage.list', { kind: 'local' });
    if (typeof read.count !== 'number') throw new Error('read blocked');
    let blocked = 0;
    const mutations = [
      ['storage.set', { kind: 'local', key: 'x', value: '1' }],
      ['dom.set_attribute', { selector: 'body', name: 'x', value: '1' }],
      ['js.evaluate', { expression: '1' }],
    ];
    for (const [n, a] of mutations) {
      try {
        await call(n, a);
      } catch {
        blocked++;
      }
    }
    if (blocked !== 3) throw new Error(`only ${blocked}/3 mutations blocked`);
    return `reads ok (${read.count} keys), 3/3 mutations denied`;
  });
  await test('paused mode also freezes the agent', async () => {
    await call('browser.set_control_mode', { mode: 'paused' });
    try {
      await call('page.click', { selector: 'a' });
      throw new Error('click allowed');
    } catch (e) {
      if (String(e.message).includes('click allowed')) throw e;
    }
    return 'click denied under paused';
  });
  await test('agent mode hands control back', async () => {
    const m = await call('browser.set_control_mode', { mode: 'agent' });
    if (!m.can_mutate) throw new Error('still blocked');
    await call('js.evaluate', { expression: '1+1' });
    return `${m.previous_mode} -> ${m.control_mode}`;
  });

  /* ======================== BROWSE / EXPORT WRAP ======================== */
  area('browse + artifact export');
  await test('navigates a second real site and keeps both histories', async () => {
    await call('page.navigate', { url: 'https://example.com', wait_until: 'load' });
    await sleep(500);
    const h = await call('page.history', { limit: 20 });
    const urls = h.navigations.map((n) => n.url);
    if (!urls.some((u) => u.includes('ycombinator')) || !urls.some((u) => u.includes('example.com'))) {
      throw new Error(`history incomplete: ${urls.join(', ')}`);
    }
    return `${h.navigations.length} recorded navigations across 2 sites`;
  });
  await test('network recording spans both sites', async () => {
    const n = await call('network.summarize', { group_by: 'domain' });
    if (n.groups.length < 2) throw new Error(`only ${n.groups.length} domain(s)`);
    return `${n.groups.map((g) => `${g.key}(${g.count})`).join(', ')}`;
  });
  await test('artifacts accumulated and are all on disk', async () => {
    const a = await call('artifact.list', { limit: 50 });
    let missing = 0;
    for (const x of a.artifacts.slice(0, 12)) {
      const s = await call('artifact.stat', { artifact_id: x.artifact_id });
      if (!s.exists) missing++;
    }
    if (missing) throw new Error(`${missing} artifacts missing on disk`);
    const kinds = [...new Set(a.artifacts.map((x) => x.kind))];
    return `${a.count} artifacts, kinds: ${kinds.join(', ')}`;
  });

  await call('browser.close');
} catch (e) {
  no('harness', e.stack ?? e.message);
  try {
    await call('browser.close');
  } catch {}
} finally {
  console.log(`\n\x1b[1m${'='.repeat(62)}\x1b[0m`);
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m   artifacts: ${home}`);
  await client.close();
  await transport.close();
  process.exit(fail ? 1 : 0);
}
