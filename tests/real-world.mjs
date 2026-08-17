/**
 * Headed run against a real public website, driven through the MCP protocol.
 * A visible Chromium window opens and you can watch the agent work.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'browserd-real-'));
const HEADLESS = process.argv.includes('--headless');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'dist', 'cli.js'), '--log-level', 'warn'],
  env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_HEADLESS: HEADLESS ? '1' : '0' },
  stderr: 'pipe',
});
const client = new Client({ name: 'real-world', version: '1.0.0' });
await client.connect(transport);

const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const txt = r.content.find(c => c.type === 'text')?.text ?? '{}';
  const img = r.content.find(c => c.type === 'image');
  const p = JSON.parse(txt);
  if (r.isError) throw new Error(`${n}: ${p.message ?? txt}`);
  if (img) p.__img = img.data.length;
  return p;
};
const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  say('1. Launch a REAL visible browser');
  const b = await call('browser.launch', { headless: HEADLESS, profile: 'real-world', window_size: { width: 1280, height: 900 } });
  console.log(`   pid=${b.pid}  ${b.product}`);
  console.log(`   executable: ${b.executable}`);
  console.log(`   profile dir: ${b.user_data_dir}`);

  say('2. Navigate to a real website (news.ycombinator.com)');
  const nav = await call('page.navigate', { url: 'https://news.ycombinator.com', wait_until: 'load' });
  console.log(`   loaded: ${nav.url}`);

  say('3. SEE it - screenshot returned as an image block');
  const shot = await call('page.screenshot', {});
  console.log(`   image to model: ${shot.__img} base64 chars`);
  console.log(`   saved: ${shot.artifact.path}`);

  say('4. Read the real page structure');
  const top = await call('js.evaluate', {
    expression: `[...document.querySelectorAll('.titleline > a')].slice(0,5).map((a,i) => (i+1) + '. ' + a.innerText)`,
  });
  for (const line of top.value) console.log(`   ${line}`);

  say('5. Real network traffic recorded without being asked');
  const net = await call('network.list_requests', { limit: 100 });
  console.log(`   ${net.total_matching} requests captured`);
  for (const r of net.requests.slice(0, 5)) {
    console.log(`   ${String(r.status).padEnd(4)} ${r.method.padEnd(4)} ${r.protocol ?? '-'} ${String(r.encoded_data_length ?? 0).padStart(7)}b  ${r.url.slice(0, 62)}`);
  }
  const sum = await call('network.summarize', { group_by: 'domain' });
  console.log(`   ${Math.round(sum.total_transferred_bytes / 1024)}KB total across ${sum.groups.length} domain(s)`);

  say('6. Full headers + body of a real request');
  const doc = net.requests.find(r => r.resource_type === 'Document') ?? net.requests[0];
  const det = await call('network.get_request', { request_id: doc.request_id });
  console.log(`   ${det.method} ${det.url}`);
  console.log(`   server=${det.response_headers.server ?? '?'}  ip=${det.remote_address}`);
  console.log(`   request headers: ${Object.keys(det.request_headers).length}, response headers: ${Object.keys(det.response_headers).length}`);
  const body = await call('network.get_body', { request_id: doc.request_id, max_chars: 120 });
  console.log(`   body ${body.size} bytes -> artifact ${body.artifact.artifact_id}`);
  console.log(`   first line: ${String(body.body).split('\n')[0].slice(0, 70)}`);

  say('7. Interact for real: type into the search box');
  await call('page.navigate', { url: 'https://duckduckgo.com', wait_until: 'load' });
  await sleep(1200);
  await call('page.type', { selector: 'input[name=q]', text: 'chrome devtools protocol', press_enter: true });
  await sleep(3000);
  const title = await call('js.evaluate', { expression: 'document.title' });
  console.log(`   after search, page title: "${title.value}"`);
  const shot2 = await call('page.screenshot', { return_image: false });
  console.log(`   screenshot of results: ${shot2.artifact.path}`);

  say('8. Highlight an element (watch the window)');
  await call('page.highlight', { selector: 'input[name=q]', duration_ms: 2500 });
  console.log('   overlay drawn on the search box');
  await sleep(2600);

  say('9. Real console + storage from a live site');
  const logs = await call('console.query', { limit: 5 });
  console.log(`   ${logs.total_matching} console entries, ${logs.exception_count} exceptions`);
  const ls = await call('storage.list', { kind: 'local' });
  console.log(`   localStorage: ${ls.count} keys on ${ls.origin}`);
  const ck = await call('storage.list_cookies', {});
  console.log(`   cookies: ${ck.total}`);

  say('10. Profile a real page load');
  await call('profile.start', { preset: 'slow-page' });
  await call('page.navigate', { url: 'https://example.com', wait_until: 'load' });
  await sleep(1500);
  const prof = await call('profile.stop');
  console.log(`   ${prof.duration_ms}ms window, ${prof.network_requests} requests`);
  console.log(`   longest main-thread task: ${prof.longest_task_ms ?? 0}ms`);
  if (prof.top_functions?.length) {
    console.log(`   hottest: ${prof.top_functions[0].function} ${prof.top_functions[0].self_time_ms}ms`);
  }
  console.log(`   bundle: ${prof.manifest.artifact_id}`);

  say('11. Leave the window open for 6s so you can see it');
  await sleep(6000);

  say('12. Close');
  await call('browser.close');
  console.log('   browser closed');
  console.log(`\n\x1b[32mReal-world run complete.\x1b[0m Artifacts under ${home}`);
} catch (e) {
  console.error('\nFAILED:', e.message);
  try { await call('browser.close'); } catch {}
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
