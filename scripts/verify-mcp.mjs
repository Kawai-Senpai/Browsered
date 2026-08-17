#!/usr/bin/env node
/**
 * Verify that what is written into MCP client configs actually launches and
 * speaks MCP. Reads the real config files rather than assuming, so a stale or
 * hand-edited entry is caught.
 *
 *   node scripts/verify-mcp.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const isWin = platform() === 'win32';
const isMac = platform() === 'darwin';

const TARGETS = [
  { label: 'Claude Code', path: join(HOME, '.claude.json'), format: 'json', key: 'mcpServers' },
  {
    label: 'Claude Desktop',
    path: isWin
      ? join(APPDATA, 'Claude', 'claude_desktop_config.json')
      : isMac
        ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(HOME, '.config', 'Claude', 'claude_desktop_config.json'),
    format: 'json',
    key: 'mcpServers',
  },
  { label: 'Codex CLI', path: join(HOME, '.codex', 'config.toml'), format: 'toml', key: 'mcp_servers' },
  { label: 'Cursor', path: join(HOME, '.cursor', 'mcp.json'), format: 'json', key: 'mcpServers' },
  {
    label: 'Windsurf',
    path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
    key: 'mcpServers',
  },
  {
    label: 'VS Code',
    path: isWin
      ? join(APPDATA, 'Code', 'User', 'mcp.json')
      : isMac
        ? join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : join(HOME, '.config', 'Code', 'User', 'mcp.json'),
    format: 'json',
    key: 'servers',
  },
];

/** Pull just the browserd entry out of a TOML file, without a full parser. */
function readTomlEntry(source, key, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${key}.${name}]`);
  if (start === -1) return null;
  const entry = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (raw.startsWith('[')) {
      entry[k] = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
    } else if (raw.startsWith('"')) {
      entry[k] = raw.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }
  }
  return entry;
}

function readEntry(target) {
  if (!existsSync(target.path)) return { state: 'no-config' };
  const source = readFileSync(target.path, 'utf8');
  let entry;
  if (target.format === 'toml') {
    entry = readTomlEntry(source, target.key, 'browserd');
  } else {
    try {
      entry = JSON.parse(source)?.[target.key]?.browserd ?? null;
    } catch (err) {
      return { state: 'bad-json', error: err.message };
    }
  }
  return entry ? { state: 'found', entry } : { state: 'not-registered' };
}

/** Launch exactly what the config says and complete a real MCP handshake. */
async function probe(entry) {
  if (entry.url) return { ok: true, note: `http endpoint ${entry.url} (not launched)` };
  if (!entry.command || !entry.args?.length) throw new Error('entry has no command/args');
  if (!existsSync(entry.command)) throw new Error(`command not found: ${entry.command}`);
  if (!existsSync(entry.args[0])) throw new Error(`entry script not found: ${entry.args[0]}`);

  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...process.env, ...(entry.env ?? {}), AGENTBROWSER_LOG_LEVEL: 'error' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify-mcp', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { ok: true, note: `${tools.length} tools advertised` };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

let failures = 0;
console.log('\nVerifying browserd registration\n');

for (const target of TARGETS) {
  const found = readEntry(target);
  if (found.state === 'no-config') {
    console.log(`  \x1b[90m----\x1b[0m ${target.label.padEnd(16)} no config file (client not installed)`);
    continue;
  }
  if (found.state === 'not-registered') {
    console.log(`  \x1b[90m----\x1b[0m ${target.label.padEnd(16)} config exists, browserd not registered`);
    continue;
  }
  if (found.state === 'bad-json') {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${target.label.padEnd(16)} unreadable config: ${found.error}`);
    continue;
  }
  try {
    const r = await probe(found.entry);
    console.log(`  \x1b[32mOK  \x1b[0m ${target.label.padEnd(16)} ${r.note}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${target.label.padEnd(16)} ${err.message}`);
  }
}

console.log(
  failures
    ? `\n\x1b[31m${failures} client(s) misconfigured\x1b[0m\n`
    : '\n\x1b[32mEvery registered client launches browserd successfully.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
