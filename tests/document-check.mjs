/**
 * The saved-page library and the site crawler.
 *
 * The fixture is a small documentation site built around the three things that
 * make naive page capture wrong:
 *
 *   - /api reveals half its content only after a scroll, so an extraction taken
 *     on arrival is silently incomplete and looks complete;
 *   - /guide wraps its content in <main> and surrounds it with a sidebar and
 *     footer that would otherwise be saved on every single page, which is what
 *     wrecks search ranking across a crawled site;
 *   - the index links to /guide three times - plain, with a #fragment, and with
 *     a utm_source - which a crawler that keys on the raw URL fetches as three
 *     different pages.
 *
 *   node tests/document-check.mjs [--headed] [--keep]
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

/* -------------------------------- fixture --------------------------------- */

const CHROME = `
<nav><a href="/">Home</a><a href="/guide">Guide</a> SIDEBAR-NOISE repeated on every page</nav>
`;
const FOOTER = `<footer>FOOTER-NOISE copyright and legal links on every page</footer>`;

const PAGES = {
  '/': `<!doctype html><meta charset=utf-8><title>Fixture Docs</title>${CHROME}
<main>
  <h1>Fixture Docs</h1>
  <p>This index links onward to the rest of the site. It exists so a crawl has somewhere
  to start and enough prose that the content landmark is chosen over the body element,
  which needs more than two hundred characters of text before it counts as content.</p>
  <ul>
    <li><a href="/guide">The guide</a></li>
    <li><a href="/guide#section-two">The guide, second section</a></li>
    <li><a href="/guide?utm_source=newsletter">The guide, from the newsletter</a></li>
    <li><a href="/api">API reference</a></li>
    <li><a href="/changelog">Changelog</a></li>
    <li><a href="https://example.com/offsite">Somewhere else entirely</a></li>
  </ul>
</main>${FOOTER}`,

  '/guide': `<!doctype html><meta charset=utf-8><title>Guide</title>${CHROME}
<main>
  <h1>Guide</h1>
  <p>The guide explains how the fixture is put together, at enough length that the
  main landmark holds real prose rather than a stub, because the capture only accepts
  a content landmark that actually contains something worth saving.</p>
  <h2 id="section-two">Section two</h2>
  <ul><li>First bullet</li><li>Second bullet</li></ul>
  <pre><code class="language-js">const answer = 42;
console.log(answer);</code></pre>
  <table>
    <tr><th>Option</th><th>Default</th></tr>
    <tr><td>scroll</td><td>true</td></tr>
    <tr><td>format</td><td>markdown</td></tr>
  </table>
  <p>See also the <a href="/deep">deep page</a>, which is two hops from the index.</p>
</main>${FOOTER}`,

  '/api': `<!doctype html><meta charset=utf-8><title>API</title>${CHROME}
<main>
  <h1>API</h1>
  <p>The reference starts here. Everything below this paragraph is appended only once
  the page has been scrolled, which is the behaviour that makes an extraction taken on
  arrival quietly incomplete rather than obviously broken.</p>
  <div style="height: 2400px"></div>
  <div id="lazy"></div>
</main>${FOOTER}
<script>
  let revealed = false;
  addEventListener('scroll', () => {
    if (revealed || scrollY < 600) return;
    revealed = true;
    document.getElementById('lazy').innerHTML =
      '<h2>Lazy section</h2><p>LAZILY-REVEALED content, running AGENTBROWSER_VERSION 5.42.1 ' +
      'and only present once something has scrolled the page.</p>';
  }, { passive: true });
</script>`,

  '/changelog': `<!doctype html><meta charset=utf-8><title>Changelog</title>${CHROME}
<main>
  <h1>Changelog</h1>
  <p>Released AGENTBROWSER_VERSION 5.41.0 with assorted fixes, and before that a
  number of releases that are not interesting enough to enumerate here but do give
  this landmark the length it needs to be treated as the page content.</p>
</main>${FOOTER}`,

  '/deep': `<!doctype html><meta charset=utf-8><title>Deep</title>${CHROME}
<main>
  <h1>Deep</h1>
  <p>Reachable only from the guide, so it is two link hops from the index and must not
  appear in a crawl limited to a single hop. It carries enough text to be picked as the
  content landmark in its own right, same as every other page here.</p>
</main>${FOOTER}`,
};

function startServer() {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = PAGES[path];
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<title>Missing</title><main>not found</main>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
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

/* --------------------------------- main ----------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'browserd-document-'));
let fixture;
let transport;

async function main() {
  fixture = await startServer();
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

  client = new Client({ name: 'document-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const docTools = tools.filter((t) => t.name.startsWith('doc.')).map((t) => t.name);
  process.stdout.write(`connected: ${tools.length} tools, ${docTools.length} of them doc.*\n`);

  await runSuite(fixture.base, docTools);
  await client.close();
}

async function runSuite(base, docTools) {
  /* ------------------------------ A: capture ----------------------------- */
  area('A: capture sees what a reader sees');

  await check('the whole doc family is advertised', async () => {
    for (const name of ['save', 'list', 'get', 'search', 'crawl', 'crawls', 'delete']) {
      assert(docTools.includes(`doc.${name}`), `doc.${name} is not advertised`);
    }
    return docTools.join(', ');
  });

  await check('scrolling first captures content that is not there on arrival', async () => {
    const res = await call('doc.save', { url: `${base}/api`, collection: 'fixture' });
    assert(res.saved === true, 'not saved');
    const doc = await call('doc.get', { doc_id: res.document.doc_id, end_line: 500 });
    assert(
      doc.text.content.includes('LAZILY-REVEALED'),
      'the scroll-revealed section is missing from the saved text',
    );
    return `${res.document.words} words, scroll ${JSON.stringify(res.scroll)}`;
  });

  await check('without scrolling the same page comes back short', async () => {
    const res = await call('doc.save', {
      url: `${base}/api`,
      scroll: false,
      refresh: true,
      preview_chars: 4000,
    });
    assert(
      !res.preview.includes('LAZILY-REVEALED'),
      'content appeared without scrolling; the fixture is not testing what it claims',
    );
    // Put the full version back for the searches later on.
    await call('doc.save', { url: `${base}/api`, refresh: true, collection: 'fixture' });
    return 'confirmed the scroll sweep is what finds it';
  });

  await check('markdown keeps the structure innerText throws away', async () => {
    const res = await call('doc.save', { url: `${base}/guide`, collection: 'fixture' });
    const doc = await call('doc.get', { doc_id: res.document.doc_id, end_line: 500 });
    const text = doc.text.content;
    assert(text.includes('## Section two'), 'headings were flattened');
    assert(text.includes('```'), 'the code block lost its fence');
    assert(text.includes('const answer = 42;'), 'the code itself is missing');
    assert(text.includes('| Option | Default |'), 'the table was not kept as a table');
    assert(text.includes('- First bullet'), 'the list lost its bullets');
    assert(/\[deep page\]\(http/.test(text), 'the link target was dropped');
    return `${text.split('\n').length} lines of markdown`;
  });

  await check('site chrome is not saved on every page', async () => {
    const doc = await call('doc.get', { url: `${base}/guide`, end_line: 500 });
    assert(!doc.text.content.includes('SIDEBAR-NOISE'), 'the nav was captured');
    assert(!doc.text.content.includes('FOOTER-NOISE'), 'the footer was captured');
    assert(doc.document.title === 'Guide', `title is ${doc.document.title}`);
    return `root ${doc.meta.root_selector}`;
  });

  await check('headings are recorded for navigation', async () => {
    const doc = await call('doc.get', { url: `${base}/guide`, include_text: false });
    const texts = doc.headings.map((h) => h.text);
    assert(texts.includes('Section two'), `headings were ${JSON.stringify(texts)}`);
    return texts.join(' / ');
  });

  /* ------------------------------ B: library ----------------------------- */
  area('B: the library remembers so the browser does not repeat');

  await check('re-saving a known URL answers from the database, not the browser', async () => {
    const res = await call('doc.save', { url: `${base}/guide` });
    assert(res.already_saved === true, 'it re-fetched a page it already had');
    assert(res.saved === false, 'it reported a save it did not do');
    return res.document.doc_id;
  });

  await check('refresh updates in place instead of forking the library', async () => {
    const before = await call('doc.get', { url: `${base}/guide`, include_text: false });
    const res = await call('doc.save', { url: `${base}/guide`, refresh: true });
    assert(res.document.doc_id === before.document.doc_id, 'refresh minted a second document');
    assert(res.updated === true, 'refresh reported a creation');
    assert(res.document.revision > before.document.revision, 'the revision did not advance');
    const list = await call('doc.list', { url_contains: '/guide' });
    assert(list.total === 1, `${list.total} documents for one URL`);
    return `revision ${before.document.revision} -> ${res.document.revision}`;
  });

  await check('a fragment and a tracking parameter address the same document', async () => {
    const byFragment = await call('doc.get', { url: `${base}/guide#section-two`, include_text: false });
    const byUtm = await call('doc.get', { url: `${base}/guide?utm_source=newsletter`, include_text: false });
    assert(
      byFragment.document.doc_id === byUtm.document.doc_id,
      'the same page resolved to two documents',
    );
    return byFragment.document.url;
  });

  await check('group_by site answers "what do I already have saved"', async () => {
    const res = await call('doc.list', { group_by: 'site' });
    assert(res.sites.length >= 1, 'no sites listed');
    const site = res.sites.find((s) => s.site === '127.0.0.1');
    assert(site, `expected 127.0.0.1, got ${res.sites.map((s) => s.site).join(', ')}`);
    assert(site.documents >= 2, `only ${site.documents} documents`);
    return `${site.site}: ${site.documents} docs, ${site.words} words`;
  });

  await check('listing sorts by the column asked for', async () => {
    const res = await call('doc.list', { sort: 'words', order: 'desc' });
    const words = res.documents.map((d) => d.words);
    assert(
      words.every((w, i) => i === 0 || words[i - 1] >= w),
      `not descending by words: ${words.join(', ')}`,
    );
    return words.join(' >= ');
  });

  /* ------------------------------ C: search ------------------------------ */
  area('C: search across everything saved');

  await check('full-text search ranks and shows the match in context', async () => {
    const res = await call('doc.search', { query: 'lazily revealed content' });
    assert(res.count >= 1, 'no hits');
    const hit = res.results[0];
    assert(hit.url.endsWith('/api'), `top hit was ${hit.url}`);
    assert(hit.snippet.includes('<<'), `no snippet markers in ${JSON.stringify(hit.snippet)}`);
    return `${res.count} hits, top score ${hit.score}`;
  });

  await check('punctuation in a query is not a syntax error', async () => {
    const res = await call('doc.search', { query: 'console.log(answer);' });
    assert(res.count >= 1, 'a query with punctuation found nothing');
    return `${res.count} hits`;
  });

  await check('regex mode answers what full-text search structurally cannot', async () => {
    const res = await call('doc.search', {
      query: 'AGENTBROWSER_VERSION 5\\.\\d+\\.\\d+',
      mode: 'regex',
    });
    assert(res.count >= 1, 'no documents matched the version pattern');
    const urls = res.results.map((r) => r.url);
    assert(urls.some((u) => u.endsWith('/api')), `matched ${urls.join(', ')}`);
    return `${res.count} of ${res.documents_scanned} documents scanned`;
  });

  await check('search can be scoped to one collection', async () => {
    const res = await call('doc.search', { query: 'fixture', collection: 'nothing-here' });
    assert(res.count === 0, `collection scoping was ignored: ${res.count} hits`);
    return 'empty as expected';
  });

  /* ------------------------------- D: crawl ------------------------------ */
  area('D: crawl explores and matches');

  let crawlId;
  await check('a one-hop crawl visits the linked pages and no further', async () => {
    const res = await call('doc.crawl', {
      url: `${base}/`,
      max_depth: 1,
      collection: 'crawled',
      find: [
        { name: 'version', regex: 'AGENTBROWSER_VERSION ([0-9.]+)' },
        { name: 'title', selector: 'main h1' },
      ],
    });
    crawlId = res.crawl_id;
    const urls = res.pages.map((p) => p.url);
    assert(urls.some((u) => u.endsWith('/changelog')), `never reached /changelog: ${urls.join(', ')}`);
    assert(!urls.some((u) => u.endsWith('/deep')), `followed a second hop to /deep: ${urls.join(', ')}`);
    return `${res.pages_visited} pages: ${urls.map((u) => new URL(u).pathname).join(' ')}`;
  });

  await check('three link forms of one page are fetched once', async () => {
    const res = await call('doc.crawls', { crawl_id: crawlId });
    const guides = res.crawl ? res.documents.filter((d) => d.url.endsWith('/guide')) : [];
    assert(guides.length === 1, `/guide appears ${guides.length} times in the crawl`);
    const visited = res.crawl.pages_visited;
    assert(visited <= 5, `visited ${visited} pages for a 5-page site with duplicate links`);
    return `${visited} pages visited, ${res.documents.length} documents`;
  });

  await check('the crawl stayed on the origin', async () => {
    const res = await call('doc.crawls', { crawl_id: crawlId });
    const offsite = res.documents.filter((d) => !d.url.includes('127.0.0.1'));
    assert(offsite.length === 0, `left the origin: ${offsite.map((d) => d.url).join(', ')}`);
    return 'no off-site pages';
  });

  await check('find rules are recorded per page and queryable afterwards', async () => {
    const res = await call('doc.crawls', { crawl_id: crawlId, rule: 'version' });
    assert(res.matches.length >= 2, `only ${res.matches.length} version hits`);
    const withGroup = res.matches.find((m) => m.detail && m.detail.groups);
    assert(withGroup, 'no capture group was returned');
    assert(/^\d+\.\d+/.test(withGroup.detail.groups[0]), `group was ${withGroup.detail.groups[0]}`);
    return res.matches.map((m) => m.value).join(' / ');
  });

  await check('selector rules read the live DOM', async () => {
    const res = await call('doc.crawls', { crawl_id: crawlId, rule: 'title' });
    const values = res.matches.map((m) => m.value);
    assert(values.includes('Changelog'), `selector hits were ${values.join(', ')}`);
    return values.join(', ');
  });

  await check('exclude keeps the crawler out of a section', async () => {
    const res = await call('doc.crawl', {
      url: `${base}/`,
      max_depth: 1,
      exclude: ['/api', '/changelog'],
      save: false,
    });
    const urls = res.pages.map((p) => p.url);
    assert(!urls.some((u) => u.endsWith('/api')), `excluded page was still visited: ${urls.join(', ')}`);
    assert(res.pages_saved === 0, `save:false still stored ${res.pages_saved} documents`);
    return urls.map((u) => new URL(u).pathname).join(' ');
  });

  await check('a two-hop crawl reaches what one hop could not', async () => {
    const res = await call('doc.crawl', {
      url: `${base}/`,
      max_depth: 2,
      collection: 'crawled-deep',
      max_pages: 10,
    });
    const urls = res.pages.map((p) => p.url);
    assert(urls.some((u) => u.endsWith('/deep')), `/deep still unreached: ${urls.join(', ')}`);
    return `${res.pages_visited} pages, ${res.pages_saved} newly saved`;
  });

  await check('past crawls stay inspectable', async () => {
    const res = await call('doc.crawls', {});
    assert(res.count >= 3, `only ${res.count} crawls recorded`);
    assert(res.crawls.every((c) => c.status === 'done' || c.status === 'stopped'), 'a crawl is stuck running');
    return res.crawls.map((c) => `${c.status}:${c.pages_visited}`).join(' ');
  });

  /* ------------------------------ E: delete ------------------------------ */
  area('E: deletion asks before it is irreversible');

  await check('bulk deletion shows what it would remove and does nothing', async () => {
    const res = await call('doc.delete', { collection: 'crawled' });
    assert(res.deleted === 0, `deleted ${res.deleted} documents without confirmation`);
    assert(res.would_delete >= 1, 'nothing matched');
    const still = await call('doc.list', { collection: 'crawled' });
    assert(still.total === res.would_delete, 'the documents went away anyway');
    return `${res.would_delete} would go`;
  });

  await check('confirmed deletion removes the documents and their index entries', async () => {
    const res = await call('doc.delete', { collection: 'crawled', confirm: true });
    assert(res.deleted >= 1, 'nothing was deleted');
    const left = await call('doc.list', { collection: 'crawled' });
    assert(left.total === 0, `${left.total} documents survived`);
    return `${res.deleted} deleted`;
  });

  await check('deleting everything at once is refused', async () => {
    let refused = false;
    try {
      await call('doc.delete', { confirm: true });
    } catch (err) {
      refused = err.payload?.code === 'no_selection';
    }
    assert(refused, 'doc.delete accepted a call with no selection');
    return 'refused, as it should';
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
