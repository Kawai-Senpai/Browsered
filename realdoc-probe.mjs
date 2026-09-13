import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'browserd-real-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js', '--log-level', 'warn'],
  env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_LOG_LEVEL: 'warn', AGENTBROWSER_HEADLESS: '1' },
  stderr: 'pipe',
});
const client = new Client({ name: 'realdoc', version: '1.0.0' });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const p = JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}');
  if (r.isError) throw new Error(`${name}: ${p.message}`);
  return p;
};

const URL_ = process.argv[2];
try {
  const saved = await call('doc.save', { url: URL_, collection: 'probe', preview_chars: 700, timeout_ms: 45000 });
  console.log('--- saved:', saved.document.title, '|', saved.document.words, 'words |', saved.document.chars, 'chars');
  console.log('--- root landmark:', saved.root_selector, '| scroll:', JSON.stringify(saved.scroll));
  console.log('--- headings:', saved.headings.slice(0, 8).map(h => `h${h.level}:${h.text}`).join(' | '));
  console.log('--- links found:', saved.links_found);
  console.log('--- PREVIEW ---\n' + saved.preview);
  const s = await call('doc.search', { query: process.argv[3] ?? 'install' });
  console.log('--- search hits:', s.count, s.results.map(r => `${r.title} (${r.score})`).join(', '));
  console.log('--- snippet:', s.results[0]?.snippet?.slice(0, 200));
} catch (e) {
  console.log('ERROR:', e.message);
} finally {
  await client.close(); await transport.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
}
