#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { discover, heartbeat } from './browser/discovery.js';
import { BrowserRegistry } from './browser/registry.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { createMcpServer, TOOLS } from './mcp/server.js';
import type { OpsContext } from './ops/context.js';
import { createStores } from './store/index.js';
import { createLogger, setLogFile, setLogLevel } from './util/logger.js';
import { paths } from './util/paths.js';

const log = createLogger('cli');

interface CliOptions {
  mode: 'stdio' | 'http' | 'tools' | 'help' | 'open' | 'list';
  port?: number;
  host?: string;
  headless?: boolean;
  profile?: string;
  noAutoLaunch?: boolean;
  logLevel?: string;
  url?: string;
  noExtensions?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: 'stdio' };

  // Subcommands come first and read more naturally than flags for the two
  // things a human types by hand.
  if (argv[0] === 'open') {
    options.mode = 'open';
    argv = argv.slice(1);
  } else if (argv[0] === 'list' || argv[0] === 'ls') {
    options.mode = 'list';
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--mcp':
      case '--stdio':
        options.mode = 'stdio';
        break;
      case '--http':
      case '--serve':
        options.mode = 'http';
        break;
      case '--tools':
        options.mode = 'tools';
        break;
      case '--help':
      case '-h':
        options.mode = 'help';
        break;
      case '--port':
        options.port = Number(argv[++i]);
        break;
      case '--host':
        options.host = argv[++i];
        break;
      case '--profile':
        options.profile = argv[++i];
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--no-auto-launch':
        options.noAutoLaunch = true;
        break;
      case '--log-level':
        options.logLevel = argv[++i];
        break;
      case '--url':
        options.url = argv[++i];
        break;
      case '--no-extensions':
        options.noExtensions = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}. Try --help.`);
    }
  }
  return options;
}

const HELP = `browserd - a continuously-recording Chromium with programmable DevTools, over MCP

Usage:
  browserd open                 Open a browser you drive yourself. It records
                                from the moment it starts, and any MCP client
                                can discover and attach to it afterwards.
  browserd list                 Show every browser currently running.
  browserd [--mcp]              Run as an MCP server on stdio (default).
  browserd --http [--port N]    Run as an MCP Streamable HTTP server on 127.0.0.1.
  browserd --tools              Print the tool surface and exit.

Options:
  --url URL          For "open": the page to start on.
  --no-extensions    For "open": skip the bundled capture panel.
  --port N           HTTP port (default 7331; 0 picks a free one).
  --host HOST        HTTP bind address (default 127.0.0.1; do not expose publicly).
  --profile NAME     Profile used by auto-launched browsers.
  --headless         Auto-launch headless. Default is a visible window you can also use.
  --no-auto-launch   Never spawn a browser implicitly; require browser.launch.
  --log-level LEVEL  trace | debug | info | warn | error.

Claude Code / MCP client config (stdio):
  {"mcpServers": {"browserd": {"command": "npx", "args": ["-y", "browserd"]}}}

Data lives in ${paths.home()}
`;

function buildConfig(options: CliOptions): DaemonConfig {
  const overrides: Partial<DaemonConfig> = {};
  if (options.port !== undefined) overrides.port = options.port;
  if (options.host) overrides.host = options.host;
  if (options.profile) overrides.autoLaunchProfile = options.profile;
  if (options.headless) overrides.autoLaunchHeadless = true;
  if (options.noAutoLaunch) overrides.autoLaunch = false;
  if (options.logLevel) overrides.logLevel = options.logLevel as DaemonConfig['logLevel'];
  return loadConfig(overrides);
}

async function runStdio(ctx: OpsContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel here, so every log line must go to stderr
  // or a file; configureLogger already handles that for stdio mode.
  log.info('MCP server ready on stdio');
}

async function runHttp(ctx: OpsContext, config: DaemonConfig): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? config.host}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            tools: TOOLS.length,
            browsers: ctx.registry.list().map((b) => ({ browser_id: b.id, profile: b.profile, status: b.status })),
          }),
        );
        return;
      }

      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', hint: 'MCP endpoint is POST /mcp' }));
        return;
      }

      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? sessions.get(sessionId) : undefined;

        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            // Loopback binding plus origin validation: a page on the open web
            // must not be able to drive the browser through this endpoint.
            enableDnsRebindingProtection: true,
            allowedOrigins: config.allowedOrigins,
            allowedHosts: [`${config.host}:${config.port}`, `localhost:${config.port}`],
            onsessioninitialized: (id) => {
              sessions.set(id, transport!);
              log.info(`session ${id} opened (${sessions.size} active)`);
            },
            onsessionclosed: (id) => {
              sessions.delete(id);
              log.info(`session ${id} closed (${sessions.size} active)`);
            },
          });
          const server = createMcpServer(ctx);
          await server.connect(transport);
        }

        await transport.handleRequest(req, res);
      } catch (err) {
        log.error('request failed', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      }
    })();
  });

  await new Promise<void>((resolve) => http.listen(config.port, config.host, resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log.info(`MCP server ready on http://${config.host}:${port}/mcp (${TOOLS.length} tools)`);
}

/**
 * Open a browser you drive yourself, which records from the moment it starts
 * and can be discovered by any MCP session afterwards.
 *
 * This is the workflow browserd exists for: launch it like any browser, use it
 * normally, and later tell an agent to look at what happened. The process stays
 * in the foreground so closing it is how you stop recording, and so a heartbeat
 * can keep the discovery record fresh.
 */
async function runOpen(ctx: OpsContext, options: CliOptions): Promise<void> {
  const stores = ctx.stores;
  const registry = ctx.registry;

  const instance = await registry.launch({
    profile: options.profile ?? ctx.config.autoLaunchProfile,
    headless: options.headless ?? false,
    ...(options.noExtensions ? { bundledExtensions: false } : {}),
  });

  /*
   * Navigate through CDP rather than passing the URL as a Chromium argument.
   * A positional URL is only honoured on a cold profile - with an existing
   * user-data-dir Chromium restores its previous session instead, so the page
   * would sit at about:blank and nothing would be recorded. Driving the
   * navigation ourselves also means the recorders are provably live first.
   */
  if (options.url) {
    const target = await instance.resolvePageOrOpen();
    await target.session.send('Page.navigate', { url: options.url });
  }

  const out = process.stdout;
  out.write(`
  browserd is recording.

`);
  out.write(`  browser_id  ${instance.id}
`);
  out.write(`  profile     ${instance.profile}
`);
  out.write(`  pid         ${instance.pid}
`);
  out.write(`  endpoint    ${instance.wsEndpoint}
`);
  if (instance.extensions.length) {
    out.write(`  extensions  ${instance.extensions.length} loaded
`);
  }
  out.write(`
  Use the browser normally. Network, console, exceptions and
`);
  out.write(`  navigations are being recorded the whole time.

`);
  out.write(`  Any MCP client can now find it - just ask your agent to look.
`);
  out.write(`  Close the window or press Ctrl+C here to stop.

`);

  /*
   * Keep the discovery record fresh. A reader treats a live pid as
   * authoritative, but the heartbeat lets a future reaper age out records whose
   * owner died without cleaning up.
   */
  const beat = setInterval(() => heartbeat(instance.id), 15_000);
  beat.unref?.();

  await new Promise<void>((resolve) => {
    instance.onClosed((reason) => {
      out.write(`  browser closed: ${reason}

`);
      resolve();
    });
    const stop = () => {
      out.write(`
  stopping...
`);
      void instance.close().finally(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  clearInterval(beat);
  stores.close();
}

/** Show every browser currently advertised on disk. */
function runList(): void {
  const records = discover();
  const out = process.stdout;

  if (!records.length) {
    out.write(`
  No browsers are running.

  Start one with:  browserd open

`);
    return;
  }

  out.write(`
  ${records.length} browser${records.length === 1 ? '' : 's'} running

`);
  for (const r of records) {
    const age = Math.round((Date.now() - r.startedAt) / 60_000);
    out.write(`  ${r.browserId}  ${r.profile.padEnd(14)} pid ${String(r.pid).padEnd(7)} up ${age}m
`);
    out.write(`  ${' '.repeat(r.browserId.length)}  ${r.wsEndpoint}

`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (options.mode === 'list') {
    runList();
    return;
  }

  if (options.mode === 'tools') {
    const byArea = new Map<string, string[]>();
    for (const tool of TOOLS) {
      const area = tool.name.split('.')[0]!;
      const list = byArea.get(area) ?? [];
      list.push(`  ${tool.name}${tool.readOnly ? '' : ' *'}`);
      byArea.set(area, list);
    }
    process.stdout.write(`browserd exposes ${TOOLS.length} tools (* = mutating)\n\n`);
    for (const [area, names] of byArea) {
      process.stdout.write(`${area}\n${names.join('\n')}\n\n`);
    }
    return;
  }

  const config = buildConfig(options);
  setLogLevel(config.logLevel);
  // The logger only ever writes to stderr, so stdout stays clean for the
  // stdio JSON-RPC channel. The file is a second copy, not a redirect.
  setLogFile(config.logFile ?? join(paths.logs(), 'browserd.log'));

  const stores = createStores();
  const registry = new BrowserRegistry(stores, config);
  const ctx: OpsContext = { registry, stores, config };

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal}: shutting down`);
    try {
      await registry.closeAll();
    } catch (err) {
      log.warn('failed to close browsers cleanly', err);
    }
    stores.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (options.mode === 'open') await runOpen(ctx, options);
  else if (options.mode === 'http') await runHttp(ctx, config);
  else await runStdio(ctx);
}

/*
 * Piping our output into something that exits early - `browserd --tools | head`
 * is the obvious case - closes stdout underneath us. Node surfaces that as an
 * unhandled EPIPE and prints a stack trace, which looks like a crash in the
 * tool rather than the perfectly normal end of a pipeline.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main().catch((err) => {
  process.stderr.write(`browserd failed to start: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
