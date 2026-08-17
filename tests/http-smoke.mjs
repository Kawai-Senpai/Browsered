/** Verifies the Streamable HTTP transport, its health endpoint and origin guard. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'browserd-http-'));
const PORT = 7391;
let fails = 0;
const ok = (l, d='') => console.log(`  PASS ${l}${d?' '+d:''}`);
const bad = (l, e) => { fails++; console.log(`  FAIL ${l}\n       ${e}`); };

const proc = spawn(process.execPath, [join(ROOT,'dist','cli.js'), '--http', '--port', String(PORT), '--log-level', 'warn'],
  { env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_HEADLESS: '1' }, stdio: ['ignore','pipe','pipe'] });
let banner = '';
proc.stderr.on('data', d => { banner += d; });
await new Promise(r => setTimeout(r, 1800));

try {
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
  health.ok && health.tools > 170 ? ok('/health responds', `${health.tools} tools`) : bad('/health', JSON.stringify(health));

  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
  const c = new Client({ name: 'http-smoke', version: '1.0.0' });
  await c.connect(t);
  const { tools } = await c.listTools();
  tools.length > 170 ? ok('MCP handshake over HTTP', `${tools.length} tools`) : bad('handshake', tools.length);

  const call = async (n,a={}) => JSON.parse((await c.callTool({name:n,arguments:a})).content.find(x=>x.type==='text').text);
  const nav = await call('page.navigate', { url: 'data:text/html,<h1 id=x>http mode</h1>', wait_until: 'load' });
  nav.url ? ok('tool call drives a real browser over HTTP') : bad('navigate', JSON.stringify(nav));
  const txt = await call('page.extract_text', {});
  String(txt.text).includes('http mode') ? ok('page content read back', `"${txt.text.trim()}"`) : bad('extract', txt.text);
  const shot = (await c.callTool({name:'page.screenshot',arguments:{}})).content.find(x=>x.type==='image');
  shot ? ok('image content block over HTTP', `${shot.data.length} b64 chars`) : bad('screenshot','no image block');
  await call('browser.close', {});

  // DNS-rebinding guard: a foreign Origin must be refused.
  const evil = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method:'POST',
    headers:{'content-type':'application/json','accept':'application/json, text/event-stream','origin':'http://evil.example.com'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}),
  });
  evil.status >= 400 ? ok('foreign Origin rejected', `HTTP ${evil.status}`) : bad('origin guard', `allowed with ${evil.status}`);
  await c.close();
} catch (e) { bad('http suite', e.message); }
finally {
  proc.kill();
  await new Promise(r => setTimeout(r, 500));
  rmSync(home, { recursive: true, force: true });
  console.log(fails ? `\n${fails} HTTP check(s) failed` : '\nHTTP transport OK');
  process.exit(fails ? 1 : 0);
}
