import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../util/logger.js';
import { bundledExtensions, paths, resolveChromium, type ResolvedBrowser } from '../util/paths.js';

const log = createLogger('browser:launch');

/**
 * Flags that keep a headed Chromium usable by a human while staying honest for
 * observation. Deliberately conservative: nothing here disables extensions,
 * site isolation or the network stack, because the point is to watch a real
 * browser rather than a stripped-down automation shell.
 */
const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  /*
   * OptimizationHints is deliberately NOT disabled here. Chromium's New Tab
   * Page depends on it, and `--disable-features=OptimizationHints` segfaults
   * the browser process the moment chrome://newtab loads - which is every time
   * a human clicks "+". Reproducible on plain Chromium with this flag alone,
   * no CDP client attached.
   */
  '--disable-features=Translate,MediaRouter',
  // Background tabs otherwise get throttled, which distorts recorded timings.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  // Keeps Chromium from prompting for a system keyring on Linux/macOS, which
  // would block a headless or unattended launch forever.
  '--password-store=basic',
  '--use-mock-keychain',
];

/**
 * Extra flags Linux containers need.
 *
 * Chromium's setuid sandbox cannot initialise inside most Docker/CI images
 * (no user namespaces), and `/dev/shm` there is typically 64MB, which makes
 * renderers crash on real pages. Both are container problems, not Linux
 * problems, so these are only added when a container is detected: dropping the
 * sandbox on a normal desktop would be a real security regression.
 */
function linuxContainerArgs(): string[] {
  if (process.platform !== 'linux') return [];
  const inContainer =
    existsSync('/.dockerenv') ||
    process.env.container !== undefined ||
    (() => {
      try {
        return /docker|kubepods|containerd|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8'));
      } catch {
        return false;
      }
    })();
  if (!inContainer) return [];
  log.info('container detected: adding --no-sandbox and --disable-dev-shm-usage');
  return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
}

export interface LaunchOptions {
  profile: string;
  headless?: boolean;
  /** Absolute paths to unpacked extension directories. */
  extensions?: string[];
  /** Load extensions shipped with browserd. Default true for headed launches. */
  bundledExtensions?: boolean;
  /** Extra Chromium switches, appended verbatim. */
  args?: string[];
  /** Start with these URLs open. */
  urls?: string[];
  windowSize?: { width: number; height: number };
  /** Enable Chromium NetLog capture for the whole browser lifetime. */
  netLog?: boolean;
  /** Chromium capture mode: Default | IncludeSensitive | Everything. */
  netLogCaptureMode?: string;
  chromiumPath?: string;
  /** Wipe the profile directory before launching. */
  freshProfile?: boolean;
  launchTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface LaunchedBrowser {
  process: ChildProcess;
  pid: number;
  wsEndpoint: string;
  port: number;
  userDataDir: string;
  executable: string;
  resolved: ResolvedBrowser;
  netLogPath: string | null;
  extensionsLoaded: string[];
}

/**
 * Chromium writes the negotiated port and browser WebSocket path here once the
 * DevTools endpoint is listening. Polling this file is more reliable than
 * scraping stderr, which is quiet on some builds.
 */
async function readDevToolsActivePort(
  userDataDir: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ port: number; path: string }> {
  const file = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let exitInfo: string | null = null;
  let exitCode: number | null = null;
  child.once('exit', (code, signal) => {
    exitInfo = `code=${code} signal=${signal}`;
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exitInfo) {
      /*
       * Exit 21 is Chromium's ProcessSingleton bailing out: another process
       * already holds this --user-data-dir, so it hands its URLs to that
       * instance and quits without ever opening a DevTools port. The bare exit
       * code sends people hunting for sandbox or missing-binary problems, so
       * the profile conflict is named explicitly. The timeout path below gives
       * the same advice, but a locked profile exits far too fast to reach it.
       */
      if (exitCode === 21) {
        throw new Error(
          `Chromium exited immediately: another browser is already using this profile ` +
            `(${userDataDir}). Close it, or launch with a different profile. [${exitInfo}]`,
        );
      }
      throw new Error(`Chromium exited before the DevTools endpoint appeared (${exitInfo})`);
    }
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8');
        const lines = raw.split('\n');
        const portLine = lines[0]?.trim();
        const pathLine = lines[1]?.trim();
        if (portLine && pathLine) {
          const port = Number(portLine);
          if (Number.isFinite(port) && port > 0) return { port, path: pathLine };
        }
      } catch {
        // Chromium may be mid-write; retry.
      }
    }
    await delay(50);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${file}. ` +
      `If a browser is already running against this profile, close it or use a different profile.`,
  );
}

export async function launchBrowser(options: LaunchOptions): Promise<LaunchedBrowser> {
  const resolved = resolveChromium(options.chromiumPath);
  const userDataDir = paths.profile(options.profile);

  if (options.freshProfile && existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
  mkdirSync(userDataDir, { recursive: true });

  // A live DevToolsActivePort from a previous run makes the poll below return a
  // stale port. Remove it so we only ever read the one this launch writes.
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  if (existsSync(activePortFile)) rmSync(activePortFile, { force: true });

  const args = [...BASE_ARGS, ...linuxContainerArgs()];
  args.push('--remote-debugging-port=0');
  args.push(`--user-data-dir=${userDataDir}`);

  if (options.headless) args.push('--headless=new');
  if (options.windowSize) {
    args.push(`--window-size=${options.windowSize.width},${options.windowSize.height}`);
  }

  /*
   * Bundled extensions ship inside the package and load by default, so a headed
   * browser always has the capture panel available without the human wiring
   * anything up. They are skipped when:
   *
   *   - headless, where a side panel has no UI to appear in and the extra
   *     service worker only adds targets to instrument, or
   *   - the resolved browser is branded Chrome/Edge 137+, which ignores the
   *     sideloading flags entirely. Failing the launch over a convenience
   *     extension would be worse than launching without it, so this is a
   *     warning rather than the hard error an explicit `extensions` list gets.
   */
  const wantBundled =
    options.bundledExtensions !== false &&
    process.env.AGENTBROWSER_NO_BUNDLED_EXTENSIONS !== '1' &&
    !options.headless;
  let bundled: string[] = [];
  if (wantBundled) {
    bundled = bundledExtensions();
    if (bundled.length && !resolved.supportsExtensionFlags) {
      log.warn(
        'branded Chrome/Edge cannot sideload extensions; launching without the bundled capture panel',
      );
      bundled = [];
    }
  }

  const requested = [...(options.extensions ?? []), ...bundled];
  const extensions = requested.filter((p) => existsSync(p));
  const missing = (options.extensions ?? []).filter((p) => !existsSync(p));
  if (missing.length) log.warn(`ignoring missing extension paths: ${missing.join(', ')}`);
  if (extensions.length) {
    if (!resolved.supportsExtensionFlags) {
      throw new Error(
        `${resolved.executablePath} is branded Chrome/Edge, which removed --load-extension in 137. ` +
          `Install Playwright's Chromium (npx playwright install chromium) or point ` +
          `AGENTBROWSER_CHROMIUM at an unbranded Chromium build.`,
      );
    }
    const list = extensions.join(',');
    args.push(`--disable-extensions-except=${list}`);
    args.push(`--load-extension=${list}`);
  }

  let netLogPath: string | null = null;
  if (options.netLog) {
    mkdirSync(paths.netlogs(), { recursive: true });
    netLogPath = join(paths.netlogs(), `${options.profile}-${Date.now()}.json`);
    args.push(`--log-net-log=${netLogPath}`);
    // Chromium capture modes: Default | IncludeSensitive | Everything.
    // "Everything" includes raw socket bytes and therefore credentials.
    args.push(`--net-log-capture-mode=${options.netLogCaptureMode ?? 'Default'}`);
  }

  if (options.args?.length) args.push(...options.args);
  if (options.urls?.length) args.push(...options.urls);
  else args.push('about:blank');

  log.info(`launching ${resolved.executablePath} (profile=${options.profile})`);
  log.debug('args', args);

  const child = spawn(resolved.executablePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: false,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.trace(`chromium: ${text}`);
  });
  child.stdout?.on('data', () => {
    /* drained so the pipe never fills and blocks the browser */
  });

  if (!child.pid) throw new Error('Failed to spawn Chromium: no pid');

  const { port, path } = await readDevToolsActivePort(
    userDataDir,
    child,
    options.launchTimeoutMs ?? 45_000,
  );
  const wsEndpoint = `ws://127.0.0.1:${port}${path}`;
  log.info(`chromium ready pid=${child.pid} ws=${wsEndpoint}`);

  return {
    process: child,
    pid: child.pid,
    wsEndpoint,
    port,
    userDataDir,
    executable: resolved.executablePath,
    resolved,
    netLogPath,
    extensionsLoaded: extensions,
  };
}

/** Best-effort teardown: the browser tree, not just the launcher process. */
export async function killBrowserProcess(child: ChildProcess, pid: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await delay(500);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
