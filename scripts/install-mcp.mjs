#!/usr/bin/env node
/**
 * Register browserd with an MCP client.
 *
 *   node scripts/install-mcp.mjs                 # detect and patch every client found
 *   node scripts/install-mcp.mjs --client claude # just one
 *   node scripts/install-mcp.mjs --print         # print the JSON, change nothing
 *   node scripts/install-mcp.mjs --http          # register the HTTP endpoint instead of stdio
 *
 * Config files are merged, never overwritten, and a .bak copy is written first.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(ROOT, 'dist', 'cli.js');
const SERVER_NAME = 'browserd';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const HOME = homedir();
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const isWin = platform() === 'win32';
const isMac = platform() === 'darwin';

/** Where each known client keeps its MCP server list. */
const CLIENTS = {
  'claude-desktop': {
    label: 'Claude Desktop',
    path: isWin
      ? join(APPDATA, 'Claude', 'claude_desktop_config.json')
      : isMac
        ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(HOME, '.config', 'Claude', 'claude_desktop_config.json'),
    key: 'mcpServers',
  },
  'claude-code': {
    label: 'Claude Code (user scope)',
    path: join(HOME, '.claude.json'),
    key: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    path: join(HOME, '.cursor', 'mcp.json'),
    key: 'mcpServers',
  },
  windsurf: {
    label: 'Windsurf',
    path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers',
  },
  vscode: {
    label: 'VS Code (user settings)',
    path: isWin
      ? join(APPDATA, 'Code', 'User', 'mcp.json')
      : isMac
        ? join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : join(HOME, '.config', 'Code', 'User', 'mcp.json'),
    key: 'servers',
  },
};

const HTTP_PORT = value('port') ?? '7331';

/** The entry the client will launch. */
function serverEntry() {
  if (flag('http')) {
    return { type: 'http', url: `http://127.0.0.1:${HTTP_PORT}/mcp` };
  }
  const env = {};
  if (flag('headless')) env.AGENTBROWSER_HEADLESS = '1';
  if (value('profile')) env.AGENTBROWSER_PROFILE = value('profile');
  return {
    command: process.execPath,
    args: [ENTRY],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix or move it, then re-run.`);
  }
}

function install(id) {
  const client = CLIENTS[id];
  if (!client) throw new Error(`Unknown client "${id}". Known: ${Object.keys(CLIENTS).join(', ')}`);

  const config = readJson(client.path);
  const bucket = (config[client.key] ??= {});
  const existed = Boolean(bucket[SERVER_NAME]);
  bucket[SERVER_NAME] = serverEntry();

  mkdirSync(dirname(client.path), { recursive: true });
  // Back up before touching a file the user's editor depends on.
  if (existsSync(client.path)) copyFileSync(client.path, `${client.path}.bak`);
  writeFileSync(client.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`  ${existed ? 'updated' : 'added  '} ${client.label}`);
  console.log(`          ${client.path}`);
  return true;
}

function main() {
  if (!existsSync(ENTRY)) {
    console.error(`browserd is not built yet.\n  cd "${ROOT}" && npm install && npm run build\n`);
    process.exit(1);
  }

  const entry = { mcpServers: { [SERVER_NAME]: serverEntry() } };

  if (flag('print')) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  if (flag('help') || flag('h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('/**', '').trim());
    return;
  }

  const only = value('client');
  console.log(`\nRegistering ${SERVER_NAME} (${flag('http') ? `HTTP :${HTTP_PORT}` : 'stdio'})\n`);

  if (only) {
    install(only);
  } else {
    // Patch every client whose config directory already exists, so this does
    // not create config for editors the user does not have installed.
    let touched = 0;
    for (const [id, client] of Object.entries(CLIENTS)) {
      if (!existsSync(client.path) && !existsSync(dirname(client.path))) continue;
      try {
        install(id);
        touched++;
      } catch (err) {
        console.log(`  skipped ${client.label}: ${err.message}`);
      }
    }
    if (!touched) {
      console.log('  No MCP client config found. Add this to yours manually:\n');
      console.log(JSON.stringify(entry, null, 2));
    }
  }

  console.log('\nRestart your MCP client to pick up the change.');
  console.log(`Then ask it: "list my browsers" or "open example.com and show me a screenshot".\n`);
}

main();
