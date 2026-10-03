/**
 * Batch visiting, unsticking a hung tab, progress, and safe file writes.
 *
 * The fixture has the pages that stall a one-at-a-time loop:
 *
 *   - /spin pins its renderer in a busy loop, so load never fires and every
 *     evaluate waits forever;
 *   - /stall never finishes sending its response;
 *   - /missing is a real 404, which is a result, not a failure.
 *
 * The batch must report each page on its own and still reach the good pages
 * queued behind the bad ones.
 *
 *   node tests/batch-check.mjs [--headed] [--keep]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const results = [];
let client;

async function call(name, args = {}, options) {
  const res = await client.callTool({ name, arguments: args }, CallToolResultSchema, options);
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
    results.push({ label, ok: true });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}\n`);
  } catch (err) {
    results.push({ label, ok: false, err });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${err.message}\n`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* -------------------------------- fixture --------------------------------- */

const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><main>${body}</main>`;

const fixture = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/stall') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<!doctype html><title>Stall</title><p>first bytes');
    return; // never ends
  }
  if (path === '/missing') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(page('Missing', '<h1>Not here</h1>'));
    return;
  }
  if (path === '/spin') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Spin', '<h1>Spin</h1><script>for (;;) {}</script>'));
    return;
  }
  const n = /^\/ok(\d+)$/.exec(path)?.[1];
  if (n) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(`OK ${n}`, `<h1>Page ${n}</h1><p>BODY-${n}</p>`));
    return;
  }
  res.writeHead(404);
  res.end();
});

let transport;
let home;
let outDir;

async function main() {
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  home = mkdtempSync(join(tmpdir(), 'browserd-batch-'));
  outDir = mkdtempSync(join(tmpdir(), 'browserd-batch-out-'));

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
  client = new Client({ name: 'batch-test', version: '1.0.0' });
  await client.connect(transport);

  let batchId;
  await check('one hung page does not stall the batch; each page reports its own status', async () => {
    const progress = [];
    const res = await call(
      'page.visit_batch',
      {
        urls: [`${base}/ok1`, `${base}/spin`, `${base}/stall`, `${base}/missing`, `${base}/ok2`, `${base}/ok3`],
        concurrency: 1,
        page_timeout_ms: 4000,
        wait_until: 'load',
        expression: 'document.querySelector("h1")?.textContent',
        wait_ms: 120000,
      },
      { onprogress: (p) => progress.push(p), timeout: 180000 },
    );
    batchId = res.batch_id;
    const by = Object.fromEntries(res.results.map((r) => [new URL(r.url).pathname, r]));
    assert(res.status === 'done', `status ${res.status}`);
    assert(by['/ok1'].status === 'ok' && by['/ok1'].text.includes('BODY-1'), 'ok1 not extracted');
    assert(by['/spin'].status === 'timeout', `spin was ${by['/spin'].status}`);
    assert(by['/spin'].tab_reset, 'spin did not reset its tab');
    assert(by['/stall'].status !== 'ok' || by['/stall'].text !== undefined, 'stall missing');
    assert(by['/missing'].http_status === 404, `missing http_status ${by['/missing'].http_status}`);
    assert(by['/ok2'].status === 'ok' && by['/ok2'].value === 'Page 2', `ok2 after the hang: ${JSON.stringify(by['/ok2'])}`);
    assert(by['/ok3'].status === 'ok', 'ok3 not reached');
    assert(progress.length >= 6, `only ${progress.length} progress notifications`);
    return `spin=${by['/spin'].status}/${by['/spin'].tab_reset} stall=${by['/stall'].status} progress=${progress.length}`;
  });

  await check('wait_ms:0 returns at once and the run finishes in the daemon', async () => {
    const res = await call('page.visit_batch', { urls: [`${base}/ok4`, `${base}/ok5`], wait_ms: 0 });
    assert(res.status === 'running', `status ${res.status}`);
    const later = await call('page.batch_status', { batch_id: res.batch_id, wait_ms: 30000 });
    assert(later.status === 'done' && later.counts.ok === 2, JSON.stringify(later.counts));
    assert(later.artifact?.artifact_id, 'no artifact for the finished run');
    return `${later.done}/${later.total} via batch_status`;
  });

  await check('cancel keeps what was visited and marks the rest cancelled', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `${base}/ok${10 + i}`);
    const res = await call('page.visit_batch', { urls, concurrency: 1, delay_ms: 300, wait_ms: 900 });
    const stopped = await call('page.batch_status', { batch_id: res.batch_id, cancel: true });
    assert(stopped.status === 'cancelled', `status ${stopped.status}`);
    assert((stopped.counts.ok ?? 0) >= 1, 'nothing kept');
    assert((stopped.counts.cancelled ?? 0) >= 1, 'nothing cancelled');
    return JSON.stringify(stopped.counts);
  });

  await check('page.reset_target brings a spinning tab back without closing the browser', async () => {
    const tab = await call('page.new_tab', { url: `${base}/spin` });
    await new Promise((r) => setTimeout(r, 1500));
    let hung = false;
    try {
      await call('js.evaluate', { target_id: tab.target_id, expression: '1+1', timeout_ms: 2000 });
    } catch {
      hung = true;
    }
    const reset = await call('page.reset_target', { target_id: tab.target_id, url: `${base}/ok7` });
    assert(reset.responsive === true, JSON.stringify(reset));
    const text = await call('page.extract_text', { target_id: reset.target_id });
    assert(text.text.includes('BODY-7'), `after reset: ${text.text}`);
    await call('page.close_tab', { target_id: reset.target_id });
    return `hung before=${hung}, mode=${reset.mode}`;
  });

  await check('file.write sanitizes the name and never overwrites by default', async () => {
    const first = await call('file.write', { dir: outDir, filename: 'CON: a/b?.json', json: { a: 1 } });
    assert(!/[:/?]/.test(first.path.slice(outDir.length + 1)), `unsanitized: ${first.path}`);
    assert(first.sanitized === true, 'not flagged as sanitized');
    const second = await call('file.write', { dir: outDir, filename: 'CON: a/b?.json', content: 'x' });
    assert(second.renamed && second.path !== first.path, 'collision not renamed');
    let refused = false;
    try {
      await call('file.write', { path: first.path, content: 'y', on_conflict: 'error' });
    } catch (err) {
      refused = err.payload?.code === 'file_exists';
    }
    assert(refused, 'on_conflict:error did not refuse');
    const over = await call('file.write', { path: first.path, content: 'z', on_conflict: 'overwrite' });
    assert(over.overwritten && readFileSync(first.path, 'utf8') === 'z', 'overwrite failed');
    assert(!readdirSync(outDir).some((f) => f.endsWith('.tmp')), 'temp file left behind');
    let relative = false;
    try {
      await call('file.write', { path: 'relative.txt', content: 'x' });
    } catch (err) {
      relative = err.payload?.code === 'bad_path';
    }
    assert(relative, 'relative path accepted');
    return readdirSync(outDir).join(', ');
  });

  await check('file.write exports a batch run', async () => {
    const res = await call('file.write', { dir: outDir, filename: 'batch.json', batch_id: batchId });
    const data = JSON.parse(readFileSync(res.path, 'utf8'));
    assert(existsSync(res.path) && data.results.length === 6, `${data.results?.length} results`);
    return res.path;
  });
}

function report() {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m\n`);
  return failed.length;
}

let exitCode = 1;
try {
  await main();
  exitCode = report() === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`\nHARNESS ERROR: ${err.stack ?? err}\n`);
  report();
} finally {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { fixture.closeAllConnections?.(); fixture.close(); } catch {}
  if (!KEEP) {
    for (const dir of [home, outDir]) {
      try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  process.exit(exitCode);
}
