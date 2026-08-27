#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { discover, findByProfile, heartbeat } from './browser/discovery.js';
import { BrowserRegistry } from './browser/registry.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { createMcpServer, TOOLS } from './mcp/server.js';
import { bundle as captureBundle } from './ops/capture.js';
import type { OpsContext } from './ops/context.js';
import { createStores } from './store/index.js';
import { AgentBrowserError } from './util/errors.js';
import { createLogger, setLogFile, setLogLevel } from './util/logger.js';
import { paths } from './util/paths.js';

const log = createLogger('cli');

interface CliOptions {
  mode: 'stdio' | 'http' | 'tools' | 'help' | 'open' | 'list' | 'capture' | 'stop';
  port?: number;
  host?: string;
  headless?: boolean;
  profile?: string;
  noAutoLaunch?: boolean;
  logLevel?: string;
  url?: string;
  noExtensions?: boolean;
  browserId?: string;
  last?: string;
  note?: string;
  out?: string;
  noRedact?: boolean;
  noBodies?: boolean;
  detach?: boolean;
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
  } else if (argv[0] === 'capture') {
    options.mode = 'capture';
    argv = argv.slice(1);
  } else if (argv[0] === 'stop') {
    options.mode = 'stop';
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
      case '--last':
        options.last = argv[++i];
        break;
      case '--note':
        options.note = argv[++i];
        break;
      case '--out':
        options.out = argv[++i];
        break;
      case '--browser':
        options.browserId = argv[++i];
        break;
      case '--no-redact':
        options.noRedact = true;
        break;
      case '--no-bodies':
        options.noBodies = true;
        break;
      case '--detach':
      case '--background':
        options.detach = true;
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
  browserd open --detach        The same, but in the background: you get your
                                prompt back and the browser keeps recording.
  browserd list                 Show every browser currently running.
  browserd capture              Bundle the last few minutes of recording into a
                                zip you can attach to a bug report. The window is
                                chosen after the bug, not before it.
  browserd stop                 Close a detached browser and end its recording.
  browserd [--mcp]              Run as an MCP server on stdio (default).
  browserd --http [--port N]    Run as an MCP Streamable HTTP server on 127.0.0.1.
  browserd --tools              Print the tool surface and exit.

Options:
  --url URL          For "open": the page to start on.
  --detach           For "open": run in the background and return immediately.
  --no-extensions    For "open": skip the bundled capture panel.
  --browser ID       For "stop"/"capture": which browser, when several run.
  --port N           HTTP port (default 7331; 0 picks a free one).
  --host HOST        HTTP bind address (default 127.0.0.1; do not expose publicly).
  --profile NAME     Profile used by auto-launched browsers.
  --headless         Auto-launch headless. Default is a visible window you can also use.
  --no-auto-launch   Never spawn a browser implicitly; require browser.launch.
  --log-level LEVEL  trace | debug | info | warn | error.

For "capture":
  --last WINDOW      How far back to reach: 3m, 5m, 10m, 1h. Default 10m.
  --note TEXT        What you saw. Goes in the bundle's summary.md.
  --out PATH         Where to write the zip. Default ${paths.capsules()}
  --browser ID       Which browser, when more than one is running.
  --no-redact        Keep credentials verbatim. The bundle becomes a secret.
  --no-bodies        Metadata only; much smaller zip.

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
/**
 * Refuse a launch that Chromium is going to refuse anyway.
 *
 * Chromium will not start a second process on a user-data-dir another process
 * already holds: it hands the URL to the running instance and exits 21. A
 * window duly appears, so from the outside it looks like the browser started
 * and browserd failed - the worst possible thing to hand somebody to debug.
 * Catching it while the profile is still just a string turns a stack trace
 * into a sentence.
 */
function requireFreeProfile(profile: string): void {
  const inUse = findByProfile(profile);
  if (!inUse) return;
  throw new AgentBrowserError(
    'profile_in_use',
    `Profile "${profile}" is already open as ${inUse.browserId}.\n` +
      '  Chromium allows one browser per profile, so this would only add a window\n' +
      '  to the browser you already have - and that one is already recording.\n\n' +
      '  Use it as it is, or start a separate browser on another profile:\n' +
      `    browserd open --detach --profile ${profile}-2`,
  );
}

async function runOpen(ctx: OpsContext, options: CliOptions): Promise<void> {
  const stores = ctx.stores;
  const registry = ctx.registry;

  requireFreeProfile(options.profile ?? ctx.config.autoLaunchProfile);

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
  /*
   * Collector callbacks are async - onLoadingFinished awaits getResponseBody
   * before it writes. When the browser goes away those promises are still
   * pending, so closing the database immediately both loses the tail of the
   * recording and makes every late write throw. Yield first and let them land.
   * The store-level isOpen guards cover anything still outstanding after this.
   */
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  stores.close();
}

/**
 * Re-launch this command as a background process and return.
 *
 * The recorder lives in the process that owns the browser, so "open a browser
 * and give me my prompt back" cannot just return early - it has to hand the
 * browser to a process that outlives this one. The child runs the ordinary
 * blocking `open`; this parent waits only long enough to report the browser it
 * registered, so the caller still learns the id.
 */
async function runOpenDetached(ctx: OpsContext, options: CliOptions): Promise<void> {
  const profile = options.profile ?? ctx.config.autoLaunchProfile;
  requireFreeProfile(profile);

  const before = new Set(discover().map((r) => r.browserId));

  // Keep the child's output: when a launch fails this is the only account of
  // why, and the whole point of detaching is that nobody is watching its console.
  mkdirSync(paths.logs(), { recursive: true });
  const logPath = join(paths.logs(), `open-${profile}.log`);
  const logFd = openSync(logPath, 'w');

  const args = process.argv.slice(1).filter((a) => a !== '--detach' && a !== '--background');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  const out = process.stdout;
  out.write('\n  Starting a browser in the background...\n');

  /*
   * Generous, because a cold profile on a slow disk genuinely can take minutes
   * to first paint - and a launch that is merely slow must not be reported as
   * a launch that failed. Nothing waits on the clock in the normal case: the
   * loop returns the moment the child advertises itself, and gives up early if
   * the child dies.
   */
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));

    const fresh = discover().find((r) => !before.has(r.browserId));
    if (fresh) {
      out.write(`
  browserd is recording.

    browser_id  ${fresh.browserId}
    profile     ${fresh.profile}
    pid         ${fresh.pid}

  Use the browser normally. This window is free - capture a bug or
  open another browser whenever you like.

  Recording stops when you close the browser window, or run:
    browserd stop

`);
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The browser failed to start.\n${indentedTail(logPath)}`);
    }
  }

  throw new Error(
    `The browser did not come up within 3 minutes, and the process is still running.\n${indentedTail(logPath)}`,
  );
}

/**
 * The interesting lines of a failed launch's log, indented for the error block.
 *
 * Stack frames are dropped: the reason a browser did not start is a sentence
 * ("points at a missing file", "exited before the DevTools endpoint appeared"),
 * and a tail that is all `at ModuleJob.run` buries it. The full log is still
 * named for anyone who wants the frames.
 */
function indentedTail(logPath: string, lines = 6): string {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return `  (no output was captured; see ${logPath})`;
  }

  const all = text.trimEnd().split(/\r?\n/);
  const meaningful = all.filter((l) => l.trim() && !/^\s*at\s/.test(l));
  const tail = (meaningful.length ? meaningful : all).slice(-lines);

  if (!tail.length) return `  (the process wrote nothing; see ${logPath})`;
  return `${tail.map((l) => `    ${l}`).join('\n')}\n\n  Full log: ${logPath}`;
}

/**
 * Stop a detached recording by closing its browser.
 *
 * Killing Chromium rather than the daemon is deliberate: the daemon is already
 * watching for the browser to go away, and its shutdown path flushes the
 * collectors that are still writing. Killing the daemon first would drop that
 * tail.
 */
function runStop(options: CliOptions): void {
  const records = discover();
  const out = process.stdout;

  if (!records.length) {
    out.write('\n  No browsers are running.\n\n');
    return;
  }

  const targets = options.browserId
    ? records.filter((r) => r.browserId === options.browserId)
    : records;

  if (!targets.length) {
    throw new Error(`No running browser with id ${options.browserId}.`);
  }
  if (targets.length > 1 && !options.browserId) {
    throw new Error(
      `${targets.length} browsers are running; name one with --browser ID:\n` +
        targets.map((r) => `    ${r.browserId}  ${r.profile}`).join('\n'),
    );
  }

  for (const record of targets) {
    try {
      process.kill(record.pid);
      out.write(`\n  Stopped ${record.browserId} (${record.profile}). The recording is kept.\n\n`);
    } catch (err) {
      out.write(`\n  Could not stop ${record.browserId}: ${(err as Error).message}\n\n`);
    }
  }
}

/**
 * Pick the browser a capture should read, without adopting it.
 *
 * `registry.resolve()` would attach a second CDP client and install a second
 * set of collectors, duplicating every row for as long as this process lived.
 * A capture only reads SQLite, so it resolves the id from the discovery
 * registry instead, and falls back to recorded history when nothing is running
 * - the bug may well be why the tester already closed the window.
 */
function resolveCaptureBrowser(ctx: OpsContext, requested?: string): string {
  if (requested) return requested;

  const running = discover();
  if (running.length === 1) return running[0]!.browserId;
  if (running.length > 1) {
    throw new Error(
      `${running.length} browsers are running; name one with --browser ID:\n` +
        running.map((r) => `    ${r.browserId}  ${r.profile}`).join('\n'),
    );
  }

  const recorded = ctx.stores.targets.listBrowsers(true);
  const last = recorded[0];
  if (!last) throw new Error('Nothing has been recorded yet. Start a browser with: browserd open');
  return last.browser_id;
}

/**
 * Bundle a slice of the recording for a bug report.
 *
 * Runs in its own short-lived process so a tester can fire it from a second
 * terminal while `browserd open` still holds the first one.
 */
async function runCapture(ctx: OpsContext, options: CliOptions): Promise<void> {
  const browserId = resolveCaptureBrowser(ctx, options.browserId);
  const out = process.stdout;
  const window = options.last ?? '10m';

  out.write(`
  Capturing the last ${window} from ${browserId}...
`);

  /*
   * Name the file rather than handing exportTo a bare directory: that path
   * falls back to the artifact handle, and "art_3970213.zip" is not something
   * anyone wants to find attached to a bug report three weeks later.
   */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destination = options.out ?? join(paths.capsules(), `capture-${browserId}-${stamp}.zip`);

  const result = await captureBundle(ctx, {
    browser_id: browserId,
    since: window,
    save_path: destination,
    ...(options.note ? { note: options.note } : {}),
    ...(options.noRedact ? { redact: false } : {}),
    ...(options.noBodies ? { include_bodies: false } : {}),
  });

  const counts = result.counts as Record<string, number>;
  const saved = result.saved_to as Record<string, unknown> | undefined;
  const artifact = result.artifact as Record<string, unknown>;
  const sizeMb = (Number(artifact.size) / (1024 * 1024)).toFixed(1);

  out.write(`
  Captured.

    requests    ${counts.requests} (${counts.failed_requests} failed)
    console     ${counts.console_errors} errors, ${counts.exceptions} exceptions
    navigations ${counts.navigations}
    size        ${sizeMb} MB
`);
  if (!options.noRedact) {
    out.write('    secrets     masked\n');
  } else {
    out.write('    secrets     NOT masked - this file is sensitive\n');
  }
  out.write(`
  ${String(saved?.exported_to ?? artifact.path)}

  Attach that zip to the bug. It has the network HAR, the console log,
  runnable curl commands, and a summary.md that reads first.

`);
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

  if (options.mode === 'stop') {
    try {
      runStop(options);
    } catch (err) {
      process.stderr.write(`
  ${(err as Error).message}

`);
      process.exitCode = 1;
    }
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
    // Let in-flight collector callbacks settle before the handle goes away.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    stores.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (options.mode === 'capture') {
    try {
      await runCapture(ctx, options);
    } catch (err) {
      // "Two browsers are running" is a thing the tester fixes by adding a
      // flag, not a crash. A stack trace here would read as a broken tool.
      process.stderr.write(`\n  ${(err as Error).message}\n\n`);
      process.exitCode = 1;
    } finally {
      stores.close();
    }
    return;
  }

  if (options.mode === 'open' && options.detach) {
    // Nothing in this process owns a browser or the stores; the child does.
    try {
      await runOpenDetached(ctx, options);
    } catch (err) {
      process.stderr.write(`\n  ${(err as Error).message}\n\n`);
      process.exitCode = 1;
    } finally {
      stores.close();
    }
    return;
  }

  if (options.mode === 'open') {
    try {
      await runOpen(ctx, options);
    } catch (err) {
      // "That profile is already open" is a thing to read, not a stack to wade
      // through. Anything unexpected still surfaces its stack via the thrown
      // error's own reporting path.
      if (err instanceof AgentBrowserError && err.code === 'profile_in_use') {
        process.stderr.write(`\n  ${err.message}\n\n`);
        process.exitCode = 1;
        stores.close();
        return;
      }
      throw err;
    }
  } else if (options.mode === 'http') await runHttp(ctx, config);
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
