/**
 * The built-in documentation.
 *
 * The property that matters is that the guide cannot drift: every argument it
 * describes is read from the same schema the server validates against, so these
 * checks compare the guide's output against the live tool list rather than
 * against a fixture. A tool added tomorrow is documented tomorrow.
 *
 * No browser is needed: guide.* never touches a page.
 *
 *   node tests/guide-check.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');

const results = [];
let currentArea = '(none)';
const area = (name) => {
  currentArea = name;
  process.stdout.write(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\x1b[0m\n`);
};

let client;
let advertised = [];

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

const home = mkdtempSync(join(tmpdir(), 'browserd-guide-'));
let transport;

async function main() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
    env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'warn', AGENTBROWSER_HEADLESS: '1' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'guide-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  advertised = tools;
  process.stdout.write(`connected: ${tools.length} tools advertised\n`);
  await runSuite();
  await client.close();
}

async function runSuite() {
  /* ------------------------------- A: index ------------------------------ */
  area('A: the index');

  await check('guide.list counts exactly the tools the server registered', async () => {
    const res = await call('guide.list', {});
    assert(res.tool_count === advertised.length, `guide says ${res.tool_count}, server advertises ${advertised.length}`);
    const listed = res.families.reduce((n, f) => n + f.tools, 0);
    assert(listed === advertised.length, `families sum to ${listed}, not ${advertised.length}`);
    return `${res.tool_count} tools in ${res.families.length} families`;
  });

  await check('every family in the index really exists in the tool list', async () => {
    const res = await call('guide.list', {});
    const real = new Set(advertised.map((t) => t.name.split('.')[0]));
    for (const family of res.families) {
      assert(real.has(family.family), `guide invented a family: ${family.family}`);
    }
    return `${res.families.length} families, all real`;
  });

  await check('guide.list{family} lists that family and nothing else', async () => {
    const res = await call('guide.list', { family: 'skeleton' });
    const expected = advertised.filter((t) => t.name.startsWith('skeleton.')).length;
    assert(res.tools.length === expected, `${res.tools.length} listed, ${expected} registered`);
    assert(res.tools.every((t) => t.name.startsWith('skeleton.')), 'a foreign tool leaked into the family listing');
    assert(typeof res.family_notes === 'string', 'no family notes');
    return `${res.tools.length} tools`;
  });

  await check('an unknown family names the real ones', async () => {
    let message = '';
    try {
      await call('guide.list', { family: 'telepathy' });
    } catch (err) {
      message = err.message;
    }
    assert(/no tool family/i.test(message), `unhelpful error: ${message}`);
    assert(/network/.test(message), 'the error does not list the families that exist');
    return 'error lists real families';
  });

  /* ------------------------------ B: one tool ---------------------------- */
  area('B: the per-tool guide');

  await check('the argument list matches the live schema, name for name', async () => {
    for (const name of ['page.click', 'network.list_requests', 'skeleton.capture', 'time.run']) {
      const doc = await call('guide.tool', { name });
      const tool = advertised.find((t) => t.name === name);
      const schemaKeys = Object.keys(tool.inputSchema.properties ?? {}).sort();
      const docKeys = doc.arguments.map((a) => a.name).sort();
      assert(
        JSON.stringify(schemaKeys) === JSON.stringify(docKeys),
        `${name}: guide documents ${docKeys.join(',')} but the schema has ${schemaKeys.join(',')}`,
      );
    }
    return '4 tools, arguments identical to their schemas';
  });

  await check('required arguments are reported as required', async () => {
    const doc = await call('guide.tool', { name: 'skeleton.capture' });
    assert(doc.required_arguments.includes('name'), 'name is required but not reported so');
    assert(!doc.required_arguments.includes('selector'), 'selector is optional but reported required');
    const tool = advertised.find((t) => t.name === 'skeleton.capture');
    const schemaRequired = (tool.inputSchema.required ?? []).sort();
    assert(
      JSON.stringify(schemaRequired) === JSON.stringify([...doc.required_arguments].sort()),
      `guide says ${doc.required_arguments} but the schema requires ${schemaRequired}`,
    );
    return doc.required_arguments.join(', ');
  });

  await check('enum arguments carry their accepted values', async () => {
    const doc = await call('guide.tool', { name: 'page.screenshot' });
    const mode = doc.arguments.find((a) => a.name === 'mode');
    assert(mode?.values?.length >= 2, 'the mode enum has no values listed');
    assert(mode.type.startsWith('enum('), `mode rendered as ${mode.type}`);
    return `mode = ${mode.values.join(' | ')}`;
  });

  await check('the mutating flag agrees with the server annotation', async () => {
    for (const name of ['page.click', 'browser.status', 'guide.search', 'js.evaluate']) {
      const doc = await call('guide.tool', { name });
      const tool = advertised.find((t) => t.name === name);
      const readOnly = tool.annotations?.readOnlyHint === true;
      assert(doc.mutating === !readOnly, `${name}: guide says mutating=${doc.mutating}, server says readOnly=${readOnly}`);
    }
    return 'mutating flags consistent';
  });

  await check('the well-known tools carry real depth, not just the blurb', async () => {
    for (const name of ['page.click', 'page.snapshot', 'workflow.run', 'skeleton.capture', 'time.run']) {
      const doc = await call('guide.tool', { name });
      assert(doc.when_to_use, `${name}: no when_to_use`);
      assert(doc.how_it_works, `${name}: no how_it_works`);
      assert(doc.caveats?.length >= 1, `${name}: no caveats`);
      assert(doc.family_notes, `${name}: no family notes`);
    }
    const click = await call('guide.tool', { name: 'page.click' });
    assert(/observed_change/.test(JSON.stringify(click)), 'the click guide never mentions observed_change');
    return 'when, how, caveats and family notes on all five';
  });

  await check('an undocumented tool still gets accurate generated detail', async () => {
    const documented = new Set();
    const list = await call('guide.list', { family: 'storage' });
    for (const t of list.tools) if (t.documented) documented.add(t.name);
    const plain = list.tools.find((t) => !t.documented);
    assert(plain, 'every storage tool has notes, so this check proves nothing');
    const doc = await call('guide.tool', { name: plain.name });
    assert(doc.summary && doc.arguments, 'no generated detail');
    assert(doc.family_notes, 'family notes should still apply');
    assert(doc.detail_level, 'the guide does not say that notes are missing');
    return `${plain.name} documented from its registration`;
  });

  await check('a near miss resolves, a typo suggests', async () => {
    const fuzzy = await call('guide.tool', { name: 'audit_layout' });
    assert(fuzzy.name === 'page.audit_layout', `resolved to ${fuzzy.name}`);
    let message = '';
    try {
      await call('guide.tool', { name: 'page.clik' });
    } catch (err) {
      message = err.message;
    }
    assert(/page\.click/.test(message), `no suggestion for a typo: ${message}`);
    return 'audit_layout -> page.audit_layout, page.clik -> did you mean page.click';
  });

  /* ------------------------------ C: search ------------------------------ */
  area('C: search, filter and sort');

  await check('a plain description of a problem finds the right tool first', async () => {
    const cases = [
      ['my click did nothing', 'page.click'],
      ['why is my element hidden', 'css.explain_visibility'],
      ['get back into a logged in session', 'storage.import'],
      ['loading placeholder skeleton', 'skeleton.capture'],
    ];
    for (const [query, expected] of cases) {
      const res = await call('guide.search', { query, limit: 5 });
      const names = res.results.map((r) => r.name);
      assert(names.includes(expected), `"${query}" did not surface ${expected}, got ${names.join(', ')}`);
    }
    return `${cases.length} problem statements, all resolved`;
  });

  await check('the mutating filter excludes tools that change the page', async () => {
    const res = await call('guide.search', { query: 'cookies', mutating: false, limit: 20 });
    for (const hit of res.results) {
      assert(hit.mutating === false, `${hit.name} mutates but passed a read-only filter`);
    }
    const both = await call('guide.search', { query: 'cookies', limit: 20 });
    assert(both.matches > res.matches, 'the filter did not exclude anything');
    return `${res.matches} read-only of ${both.matches}`;
  });

  await check('the family filter restricts to that family', async () => {
    const res = await call('guide.search', { query: 'body', family: 'network', limit: 20 });
    assert(res.results.length > 0, 'nothing found in network');
    assert(res.results.every((r) => r.family === 'network'), 'a foreign family leaked through the filter');
    return `${res.results.length} network hits`;
  });

  await check('sort by name and by family actually reorder the results', async () => {
    const byName = await call('guide.search', { query: 'storage', sort: 'name', limit: 10 });
    const names = byName.results.map((r) => r.name);
    assert(JSON.stringify(names) === JSON.stringify([...names].sort()), 'sort:name is not sorted');
    const byFamily = await call('guide.search', { query: 'storage', sort: 'family', limit: 10 });
    const families = byFamily.results.map((r) => r.family ?? 'topic');
    assert(JSON.stringify(families) === JSON.stringify([...families].sort()), 'sort:family is not grouped');
    return 'both orderings hold';
  });

  await check('kind filters separate tools from topics', async () => {
    const tools = await call('guide.search', { query: 'artifact', kind: 'tools', limit: 20 });
    assert(tools.results.every((r) => r.kind === 'tool'), 'a topic leaked into a tools-only search');
    const topics = await call('guide.search', { query: 'artifact', kind: 'topics', limit: 20 });
    assert(topics.results.every((r) => r.kind === 'topic'), 'a tool leaked into a topics-only search');
    assert(topics.results.length > 0, 'no topic matched "artifact"');
    return `${tools.results.length} tools, ${topics.results.length} topics`;
  });

  await check('full:true expands hits into complete write-ups', async () => {
    const res = await call('guide.search', { query: 'skeleton capture', limit: 2, full: true });
    const hit = res.results.find((r) => r.kind === 'tool');
    assert(hit.arguments?.length > 0, 'full results carry no arguments');
    assert(hit.caveats || hit.detail_level, 'full results carry no notes at all');
    return 'expanded in place';
  });

  await check('an empty query is refused rather than returning everything', async () => {
    let message = '';
    try {
      await call('guide.search', { query: '  ' });
    } catch (err) {
      message = err.message;
    }
    assert(/empty_query|something to look for/i.test(message), `unexpected error: ${message}`);
    return 'refused';
  });

  /* ------------------------------ D: topics ------------------------------ */
  area('D: long-form topics');

  await check('every advertised topic can be fetched and is substantial', async () => {
    const index = await call('guide.list', { kind: 'topics' });
    assert(index.topics.length >= 6, `only ${index.topics.length} topics`);
    let total = 0;
    for (const topic of index.topics) {
      const res = await call('guide.topic', { name: topic.name });
      assert(res.body.length > 700, `topic ${topic.name} is only ${res.body.length} chars`);
      total += res.body.length;
    }
    return `${index.topics.length} topics, ${total} chars total`;
  });

  await check('the install topic reports this daemon, not a generic path', async () => {
    const res = await call('guide.topic', { name: 'install' });
    assert(res.body.includes(home), `the daemon home (${home}) is not in the install topic`);
    assert(/package root/.test(res.body), 'no package root');
    assert(/npm run build/.test(res.body), 'no update procedure');
    assert(/reconnect|restart/i.test(res.body), 'it does not say to reconnect the client after updating');
    assert(/chromium/i.test(res.body), 'it does not say which Chromium is in use');
    return 'live paths, update procedure and the reconnect trap';
  });

  await check('the architecture topic explains the layers and the recording pipeline', async () => {
    const res = await call('guide.topic', { name: 'architecture' });
    for (const term of ['src/ops', 'sha256', 'DevTools Protocol', 'control mode']) {
      assert(res.body.includes(term), `architecture never mentions ${term}`);
    }
    return 'processes, layers, pipeline, artifacts';
  });

  await check('the traps topic covers the failures that look like something else', async () => {
    const res = await call('guide.topic', { name: 'traps' });
    for (const term of ['observed_change', 'landed_characters', 'pagehide', 'bypass_module_cache']) {
      assert(res.body.includes(term), `traps never mentions ${term}`);
    }
    return '4 known traps present';
  });

  await check('an unknown topic lists the real ones', async () => {
    let message = '';
    try {
      await call('guide.topic', { name: 'quantum' });
    } catch (err) {
      message = err.message;
    }
    assert(/no topic named/i.test(message), `unhelpful error: ${message}`);
    assert(/architecture/.test(message), 'the error does not list the topics that exist');
    return 'error lists real topics';
  });

  await check('guide.* is read-only and never launched a browser', async () => {
    for (const name of ['guide.search', 'guide.tool', 'guide.topic', 'guide.list']) {
      const tool = advertised.find((t) => t.name === name);
      assert(tool, `${name} is not advertised`);
      assert(tool.annotations?.readOnlyHint === true, `${name} is not annotated read-only`);
    }
    const browsers = await call('browser.list', {});
    const running = (browsers.browsers ?? []).filter((b) => b.status === 'running' || b.live === true);
    assert(running.length === 0, `the guide suite started ${running.length} browsers`);
    return 'four read-only tools, zero browsers';
  });
}

function report() {
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  process.stdout.write(`\n\x1b[1m${passed} passed, ${failed.length} failed\x1b[0m\n`);
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
  if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch {} }
  process.exit(exitCode);
}
