/**
 * Semantic locators and the QA handoff.
 *
 * The property under test is not "the tools return something" but "the numbers
 * they return are the numbers a Playwright test would see". So the fixture is
 * built around the case that actually breaks tests: the same link text in a
 * header and a footer, which is unambiguous to a human and two matches to a
 * strict-mode locator. A tool that reported one match there would be worse than
 * useless, because it would be confidently wrong.
 *
 *   node tests/qa-check.mjs [--headed] [--keep]
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

/**
 * A todo page with the ambiguities real applications have: one link text in two
 * landmarks, a button that is also carrying a test id, a labelled input, and an
 * element hidden from the accessibility tree.
 */
function startFixture() {
  const page = `<!doctype html><meta charset=utf-8><title>QA Fixture</title>
<body>
<header>
  <nav aria-label="Primary"><a href="/models">Models</a></nav>
</header>
<main>
  <h1>Todos</h1>
  <form id=f onsubmit="return false">
    <label for=title>Title</label>
    <input id=title name=title>
    <label for=urgent>Urgent</label>
    <input id=urgent type=checkbox checked>
    <button id=add type=button data-testid="add-todo">Add todo</button>
  </form>
  <ul id=list></ul>
  <ul><li>A seeded item</li></ul>
  <p id=ghost aria-hidden="true">Hidden from assistive technology</p>
</main>
<footer>
  <nav aria-label="Secondary"><a href="/models">Models</a></nav>
</footer>
<script>
  document.getElementById('add').addEventListener('click', async () => {
    const value = document.getElementById('title').value;
    const li = document.createElement('li');
    li.textContent = value;
    document.getElementById('list').appendChild(li);
    await fetch('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: value }),
    });
    console.error('fixture: deliberate console error');
  });
</script>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/todos') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
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

const home = mkdtempSync(join(tmpdir(), 'browserd-qa-'));
let fixture;
let transport;

async function main() {
  fixture = await startFixture();
  process.stdout.write(`fixture on ${fixture.base}\ndaemon home ${home}\n`);

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

  client = new Client({ name: 'qa-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  process.stdout.write(`connected: ${tools.length} tools advertised\n`);

  await runSuite(fixture.base);
  await client.close();
}

async function runSuite(base) {
  await call('page.navigate', { url: `${base}/` });
  await call('page.wait_for', { selector: '#add', timeout_ms: 5000 });

  /* ------------------------ A: naming an element ------------------------- */
  area('A: locator.candidates');

  await check('an unambiguous button gets a unique recommendation', async () => {
    const res = await call('locator.candidates', { selector: '#add' });
    assert(res.recommended, `no recommendation: ${JSON.stringify(res.candidates)}`);
    const role = res.candidates.find((c) => c.target.by === 'role');
    assert(role, 'no role candidate offered');
    assert(role.target.role === 'button', `role is ${role.target.role}`);
    assert(role.target.name === 'Add todo', `name is ${JSON.stringify(role.target.name)}`);
    assert(role.unique, `role candidate matched ${role.matches}`);
    return `${res.candidates.length} candidates, recommended by=${res.recommended.by}`;
  });

  await check('a test id is offered and preferred over text', async () => {
    const res = await call('locator.candidates', { selector: '#add' });
    const testId = res.candidates.find((c) => c.target.by === 'testId');
    assert(testId, 'no testId candidate');
    assert(testId.target.testId === 'add-todo', `testId is ${testId.target.testId}`);
    assert(testId.unique, `testId matched ${testId.matches}`);
    assert(res.candidates[0].target.by === 'testId', `first candidate is ${res.candidates[0].target.by}`);
    return 'data-testid ranked first';
  });

  await check('a label locator is found for the input', async () => {
    const res = await call('locator.candidates', { selector: '#title' });
    const label = res.candidates.find((c) => c.target.by === 'label');
    assert(label, `no label candidate: ${JSON.stringify(res.candidates.map((c) => c.target))}`);
    assert(label.target.label === 'Title', `label is ${JSON.stringify(label.target.label)}`);
    return `label=${JSON.stringify(label.target.label)} matches=${label.matches}`;
  });

  await check('a duplicated link is scoped to its landmark, not narrowed with an index', async () => {
    const res = await call('locator.candidates', { selector: 'header nav a' });
    const role = res.candidates.find((c) => c.target.by === 'role');
    assert(role, 'no role candidate for the header link');
    assert(role.unique, `expected a unique form, got ${role.matches} matches`);
    assert(role.target.within, `no within scope: ${JSON.stringify(role.target)}`);
    assert(
      role.target.within.role === 'navigation',
      `scoped to ${role.target.within.role}, expected navigation`,
    );
    assert(!JSON.stringify(role).includes('nth'), 'a positional index leaked into the target');
    return `${role.compiles_to}`;
  });

  await check('an aria-hidden element gets no role candidate, and says why', async () => {
    const res = await call('locator.candidates', { selector: '#ghost' });
    assert(res.role_note, `expected a role_note, got ${JSON.stringify(res)}`);
    assert(
      /ignored|accessibility tree/i.test(res.role_note),
      `unexpected role_note: ${res.role_note}`,
    );
    assert(
      !res.candidates.some((c) => c.target.by === 'role'),
      'a role candidate was offered for an element the role engine cannot match',
    );
    return 'reported rather than guessed';
  });

  /* ---------------------- B: checking one before use --------------------- */
  area('B: locator.check');

  await check('the unscoped duplicate is reported as a strict-mode failure', async () => {
    const res = await call('locator.check', {
      target: { by: 'role', role: 'link', name: 'Models' },
    });
    assert(res.ok === false, 'reported ok for a locator matching twice');
    assert(res.matches === 2, `matched ${res.matches}, expected 2`);
    assert(/strict mode/i.test(res.error ?? ''), `unhelpful error: ${res.error}`);
    return `${res.matches} matches, refused`;
  });

  await check('the scoped form resolves to exactly one', async () => {
    const res = await call('locator.check', {
      target: {
        by: 'role',
        role: 'link',
        name: 'Models',
        within: { role: 'navigation', name: 'Primary' },
      },
    });
    assert(res.ok === true, `not ok: ${JSON.stringify(res)}`);
    assert(res.matches === 1, `matched ${res.matches}`);
    assert(res.scope_matches === 1, `scope matched ${res.scope_matches}`);
    return res.compiles_to;
  });

  await check('an ambiguous scope is refused before the inner locator is evaluated', async () => {
    const res = await call('locator.check', {
      target: { by: 'role', role: 'link', name: 'Models', within: { role: 'navigation' } },
    });
    assert(res.ok === false, 'accepted a scope that matches two navigations');
    assert(res.scope_matches === 2, `scope matched ${res.scope_matches}`);
    return 'scope checked first';
  });

  await check('a locator matching nothing says so rather than throwing', async () => {
    const res = await call('locator.check', {
      target: { by: 'role', role: 'button', name: 'Delete everything' },
    });
    assert(res.ok === false && res.matches === 0, `unexpected: ${JSON.stringify(res)}`);
    return 'zero matches reported';
  });

  /* -------------------------- C: recording a flow ------------------------ */
  area('C: qa recording');

  await check('a driven flow is recorded as semantic steps', async () => {
    await call('qa.record_start', { flow: 'create a todo' });
    await call('page.navigate', { url: `${base}/` });
    await call('page.type', { selector: '#title', text: 'Buy milk', clear: true, insert_text: true });
    await call('page.click', { selector: '#add' });
    await call('page.wait_for', { selector: '#list li', timeout_ms: 5000 });
    const res = await call('qa.steps', {});

    assert(res.count >= 3, `recorded ${res.count} steps`);
    const fill = res.steps.find((s) => s.action === 'fill');
    assert(fill, 'no fill step recorded');
    assert(fill.value === 'Buy milk', `fill value is ${JSON.stringify(fill.value)}`);
    assert(fill.target, 'fill step has no semantic target');
    assert(fill.target.by !== undefined, 'fill target is not a semantic locator');
    assert(!fill.problem, `fill step reported a problem: ${fill.problem}`);

    const click = res.steps.find((s) => s.action === 'click');
    assert(click, 'no click step recorded');
    assert(click.target && click.target.by === 'testId', `click target is ${JSON.stringify(click.target)}`);
    return `${res.count} steps, click by ${click.target.by}`;
  });

  await check('typing without clear is flagged, because fill() replaces and type appends', async () => {
    await call('qa.record_start', { flow: 'append probe' });
    await call('page.type', { selector: '#title', text: 'x', insert_text: true });
    const res = await call('qa.steps', {});
    const fill = res.steps.find((s) => s.action === 'fill');
    assert(fill, 'no fill step');
    assert(fill.problem, 'appending was recorded as if it were a fill');
    assert(/clear/i.test(fill.problem), `unexpected problem text: ${fill.problem}`);
    return 'difference surfaced, not smoothed over';
  });

  /* --------------------------- D: evidence ------------------------------- */
  area('D: qa.evidence');

  let recordedAt;
  await check('the flow the fixture drove shows up as request candidates', async () => {
    await call('qa.record_start', { flow: 'evidence run' });
    recordedAt = Date.now();
    await call('page.navigate', { url: `${base}/` });
    await call('page.type', { selector: '#title', text: 'Ship it', clear: true, insert_text: true });
    await call('page.click', { selector: '#add' });
    await call('page.wait_for', { selector: '#list li', timeout_ms: 5000 });

    const res = await call('qa.evidence', {});
    const post = res.candidate_assertions.find(
      (c) => c.assertion.type === 'requestSeen' && c.assertion.method === 'POST',
    );
    assert(post, `no POST candidate: ${JSON.stringify(res.candidate_assertions)}`);
    assert(post.assertion.urlIncludes === '/api/todos', `urlIncludes is ${post.assertion.urlIncludes}`);
    assert(post.oracle === null, 'a candidate arrived with an oracle already attached');
    return `${res.candidate_assertions.length} candidates`;
  });

  await check('a console error becomes a finding, not an assertion', async () => {
    const res = await call('qa.evidence', {});
    const finding = res.findings.find((f) => /deliberate console error/.test(f.summary ?? ''));
    assert(finding, `console error not surfaced: ${JSON.stringify(res.findings)}`);
    assert(finding.category === 'console', `category is ${finding.category}`);
    assert(
      !res.candidate_assertions.some((c) => /console/i.test(JSON.stringify(c))),
      'a console error leaked into the assertion candidates',
    );
    return `${res.findings.length} findings`;
  });

  await check('the evidence window is honest about the oracle', async () => {
    const res = await call('qa.evidence', {});
    assert(res.oracle_warning, 'no oracle warning');
    assert(
      /observation, not a requirement/i.test(res.oracle_warning),
      `the warning does not state the rule: ${res.oracle_warning}`,
    );
    assert(typeof recordedAt === 'number', 'no recording timestamp');
    assert(res.window && res.window.since, 'no window reported');
    return 'stated';
  });

  /* ------------------------ E: the scenario draft ------------------------ */
  area('E: qa.scenario_draft');

  await check('a draft carries the steps but refuses to call itself compilable', async () => {
    const res = await call('qa.scenario_draft', { id: 'todo-create', name: 'A todo can be created' });
    assert(res.ready_to_compile === false, 'a draft claimed to be ready to compile');
    assert(Array.isArray(res.scenario.assertions) && res.scenario.assertions.length === 0,
      'the draft invented assertions');
    assert(res.scenario.requirementSource === null, 'the draft invented a requirement source');
    assert(res.scenario.steps.length >= 2, `only ${res.scenario.steps.length} steps`);
    assert(res.blocking.length >= 2, `blocking list is ${JSON.stringify(res.blocking)}`);
    return `${res.scenario.steps.length} steps, ${res.candidate_assertions.length} candidates, blocked`;
  });

  await check('the draft rejects an id a scenario schema would reject', async () => {
    try {
      await call('qa.scenario_draft', { id: 'Todo Create', name: 'x' });
      throw new Error('accepted an invalid scenario id');
    } catch (err) {
      assert(/lowercase|bad_id/i.test(err.message), `unexpected error: ${err.message}`);
      return 'rejected at the source';
    }
  });

  await check('session events come back shaped for a harness, without assertions', async () => {
    const res = await call('qa.session_events', {});
    assert(res.count > 0, 'no events');
    const action = res.events.find((e) => e.type === 'action');
    assert(action, 'no action events');
    assert(
      !res.events.some((e) => e.type === 'candidate-assertion'),
      'candidate assertions were emitted as session events',
    );
    return `${res.count} events`;
  });

  /* ---------------------- F: shapes a harness loads ---------------------- */
  area('F: artifact shapes');

  await check('storage.export can emit a real Playwright storageState', async () => {
    await call('storage.set', { key: 'seen-tour', value: 'yes' });
    // A session cookie with no SameSite is the case Chromium reports as an
    // absent field and Playwright refuses to load, so it is the one worth
    // covering rather than a fully specified cookie that maps trivially.
    await call('storage.set_cookie', { name: 'sid', value: 'abc123', url: `${base}/` });

    const res = await call('storage.export', { format: 'playwright' });
    assert(res.format === 'playwright', `format is ${res.format}`);
    const read = await call('artifact.read', {
      artifact_id: res.artifact.artifact_id ?? res.artifact.id,
    });
    const state = JSON.parse(read.text ?? read.content ?? '{}');

    assert(Array.isArray(state.cookies), 'no cookies array');
    const sid = state.cookies.find((c) => c.name === 'sid');
    assert(sid, `the cookie did not survive the mapping: ${JSON.stringify(state.cookies)}`);
    assert(
      ['Strict', 'Lax', 'None'].includes(sid.sameSite),
      `sameSite is ${JSON.stringify(sid.sameSite)}, which Playwright will reject`,
    );
    assert(typeof sid.expires === 'number', `expires is ${typeof sid.expires}, expected a number`);
    assert(typeof sid.httpOnly === 'boolean' && typeof sid.secure === 'boolean', 'cookie flags are not booleans');

    assert(Array.isArray(state.origins), 'no origins array');
    const origin = state.origins[0];
    assert(origin, 'localStorage was not carried into origins');
    assert(Array.isArray(origin.localStorage), 'localStorage is not the array Playwright expects');
    assert(
      origin.localStorage.some((e) => e.name === 'seen-tour' && e.value === 'yes'),
      `localStorage entry missing: ${JSON.stringify(origin.localStorage)}`,
    );
    assert(state.sessionStorage === undefined, 'sessionStorage leaked into a storageState file');
    return `${state.cookies.length} cookies (sid sameSite=${sid.sameSite}), ${origin.localStorage.length} localStorage entries`;
  });

  await check('an aria snapshot carries no refs and leaves existing ones working', async () => {
    const refs = await call('page.snapshot', {});
    const match = /\[ref=(e\d+)\]/.exec(refs.snapshot);
    assert(match, 'the refs snapshot produced no refs to test with');
    const ref = match[1];

    const aria = await call('page.snapshot', { format: 'aria' });
    assert(aria.format === 'aria', `format is ${aria.format}`);
    assert(!aria.snapshot.includes('[ref='), 'refs leaked into the aria snapshot');
    assert(!/\bgeneric\b/.test(aria.snapshot), 'generic containers leaked into the aria snapshot');
    assert(aria.verify, 'no instruction to verify the snapshot before trusting it');

    const still = await call('dom.inspect', { ref });
    assert(still, `ref ${ref} stopped resolving after an aria snapshot`);
    return `${aria.node_count} nodes, ${ref} still resolves`;
  });

  /*
   * These rules were each derived by diffing this output against Playwright's
   * own locator.ariaSnapshot() on a fixture. Any one of them broken produces a
   * snapshot that fails to parse as an expectation, which is a silent failure:
   * the assertion errors out before it has compared anything.
   */
  await check('the aria snapshot uses the dialect a Playwright assertion expects', async () => {
    const aria = await call('page.snapshot', { format: 'aria' });
    const snapshot = aria.snapshot;

    assert(aria.node_count > 0 && snapshot.length > 0, 'the aria snapshot is empty');
    assert(/- heading "Todos" \[level=1\]/.test(snapshot), `no heading line: ${snapshot.slice(0, 400)}`);
    assert(/- button "Add todo"/.test(snapshot), 'no button line');
    assert(/^- banner:/m.test(snapshot), `does not start at a landmark: ${snapshot.slice(0, 200)}`);

    // Chrome node names that have no meaning in the dialect and make it unparseable.
    for (const alien of ['RootWebArea', 'StaticText', 'LabelText', 'ListMarker', 'generic']) {
      assert(!snapshot.includes(alien), `Chrome-only node "${alien}" leaked into the dialect`);
    }
    assert(!/value=/.test(snapshot), 'browserd-only value= annotations leaked in');

    // A true state is spelled bare; Chrome reports the string "true".
    assert(/- checkbox "Urgent" \[checked\]/.test(snapshot), `checkbox state is not bare: ${snapshot}`);
    assert(!/\[checked=/.test(snapshot), 'checked was emitted with a value');

    // level belongs to headings only, though Chrome reports it on list items too.
    for (const line of snapshot.split('\n')) {
      if (line.includes('[level=')) {
        assert(line.includes('- heading'), `level emitted on a non-heading: ${line.trim()}`);
      }
    }

    // Text that is not an element's accessible name survives as a text node.
    assert(/- text: A seeded item/.test(snapshot), `list item text was dropped: ${snapshot}`);
    return `${aria.node_count} nodes, dialect clean`;
  });

  /* --------------------------- G: the guide ------------------------------ */
  area('G: discoverability');

  await check('the new families are documented, not just registered', async () => {
    const locator = await call('guide.tool', { name: 'locator.candidates' });
    assert(locator.family_notes, 'no family notes for locator');
    const qa = await call('guide.tool', { name: 'qa.evidence' });
    assert(qa.family_notes, 'no family notes for qa');
    assert(/oracle/i.test(JSON.stringify(qa)), 'the qa guide does not mention the oracle rule');
    return 'guide covers both families';
  });

  await check('recording stops cleanly and keeps what it captured', async () => {
    const res = await call('qa.record_stop', {});
    assert(res.recording === false, 'still recording');
    assert(res.steps > 0, 'stopping discarded the steps');
    const after = await call('qa.steps', {});
    assert(after.count === res.steps, 'steps were lost after stopping');
    return `${res.steps} steps kept`;
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
  try { await fixture?.close(); } catch {}
  if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch {} }
  process.exit(exitCode);
}
