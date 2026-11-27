import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBrowserError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { bundledExtensions, paths, resolveChromium, type ResolvedBrowser } from '../util/paths.js';
import { isAlive } from './discovery.js';
import { STEALTH_ARGS } from './stealth.js';

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

/**
 * Camera, microphone and screen capture for automated tests.
 *
 * getUserMedia and getDisplayMedia stop at browser UI - a permission bubble and
 * a source picker - that CDP cannot click through, so a proctoring or
 * video-call flow is untestable unless the browser is told at process start to
 * answer those prompts itself. Every field is opt-in: an empty object adds no
 * switches, so a launch without media gets exactly the command line it always had.
 */
export interface MediaOptions {
  /** Accept camera requests without a prompt, and grant the camera permission. */
  camera?: boolean;
  /** Accept microphone requests without a prompt, and grant the microphone permission. */
  microphone?: boolean;
  /** Auto-pick a screen in the getDisplayMedia picker. Which screen is not controllable. */
  screen?: boolean;
  /** Auto-pick the capture source whose title contains this text, e.g. "Entire screen". Implies screen. */
  screenSource?: string;
  /** Replace real devices with Chromium's synthetic camera and microphone. */
  fakeDevices?: boolean;
  /** Absolute path to a .y4m or .mjpeg file played as the camera. Implies fakeDevices. */
  videoFile?: string;
  /** Absolute path to a .wav file played as the microphone. Implies fakeDevices. */
  audioFile?: string;
  /** Scope the camera/microphone permission grant to this origin. Default: every origin. */
  origin?: string;
}

/** An existing, absolute media file with one of the formats Chromium can play. */
function mediaFile(field: string, path: string, extensions: string[]): string {
  if (!isAbsolute(path)) {
    throw new AgentBrowserError(
      'bad_media',
      `media.${field} must be an absolute path; got "${path}". Chromium resolves it against its own working directory, not yours.`,
    );
  }
  if (!extensions.some((ext) => path.toLowerCase().endsWith(ext))) {
    throw new AgentBrowserError(
      'bad_media',
      `media.${field} must be a ${extensions.join(' or ')} file; got "${path}". Chromium silently falls back to its test pattern for anything else.`,
    );
  }
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    /* reported below */
  }
  if (!isFile) throw new AgentBrowserError('bad_media', `media.${field} does not exist or is not a file: ${path}`);
  return path;
}

/**
 * The Chromium switches for a media configuration, validated.
 *
 * Switch names are Chromium's own (content_switches, media_switches,
 * chrome_switches). --auto-accept-camera-and-microphone-capture is used rather
 * than --use-fake-ui-for-media-stream because the latter also intercepts screen
 * and tab capture; Chromium's own switch comment says to prefer the former for
 * exactly that reason, and it leaves the picker to the auto-select switches.
 */
export function mediaArgs(media: MediaOptions | undefined): string[] {
  if (!media) return [];
  const args: string[] = [];

  if (media.camera || media.microphone) args.push('--auto-accept-camera-and-microphone-capture');

  const videoFile =
    media.videoFile === undefined ? undefined : mediaFile('video_file', media.videoFile, ['.y4m', '.mjpeg']);
  const audioFile = media.audioFile === undefined ? undefined : mediaFile('audio_file', media.audioFile, ['.wav']);
  // Chromium splits this switch's value on '%' to read a "%noloop" suffix and
  // CHECK-fails the whole browser on anything else it finds there.
  if (audioFile?.includes('%')) {
    throw new AgentBrowserError('bad_media', `media.audio_file cannot contain "%": ${audioFile}`);
  }
  const files = videoFile !== undefined || audioFile !== undefined;
  if (files && media.fakeDevices === false) {
    throw new AgentBrowserError(
      'bad_media',
      "video_file and audio_file play through Chromium's fake capture devices, so they cannot be combined with fake_devices:false.",
    );
  }
  if (media.fakeDevices || files) args.push('--use-fake-device-for-media-stream');
  if (videoFile) args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  if (audioFile) args.push(`--use-file-for-fake-audio-capture=${audioFile}`);

  if (media.screenSource !== undefined) {
    if (!media.screenSource.trim()) {
      throw new AgentBrowserError('bad_media', 'media.screen_source is empty. Omit it and pass screen:true to take any screen.');
    }
    if (media.screen === false) {
      throw new AgentBrowserError('bad_media', 'media.screen_source auto-selects a capture source, so it cannot be combined with screen:false.');
    }
    // One switch, not both: the name-based one is the more specific request.
    args.push(`--auto-select-desktop-capture-source=${media.screenSource}`);
  } else if (media.screen) {
    args.push('--auto-select-screen-capture-source');
  }

  // The origin feeds a CDP grant after launch, not a switch, but a typo there
  // would only surface as a log line, so it is refused here with the rest.
  if (media.origin !== undefined) {
    let origin = 'null';
    try {
      origin = new URL(media.origin).origin;
    } catch {
      /* reported below */
    }
    if (origin === 'null') {
      throw new AgentBrowserError('bad_media', `media.origin is not an origin: "${media.origin}". Use e.g. "https://app.example.com".`);
    }
  }

  return args;
}

/** The CDP permissions a media configuration grants at launch. */
export function mediaPermissions(media: MediaOptions | undefined): string[] {
  if (!media) return [];
  return [...(media.camera ? ['videoCapture'] : []), ...(media.microphone ? ['audioCapture'] : [])];
}

export interface LaunchOptions {
  profile: string;
  launchEngine?: LaunchEngine;
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
  /** Camera, microphone and screen capture without prompts. Off unless given. */
  media?: MediaOptions;
  /** Enable Chromium NetLog capture for the whole browser lifetime. */
  netLog?: boolean;
  /** Chromium capture mode: Default | IncludeSensitive | Everything. */
  netLogCaptureMode?: string;
  chromiumPath?: string;
  /** Hide automation signals from bot detectors. */
  stealth?: boolean;
  /** Wipe the profile directory before launching. */
  freshProfile?: boolean;
  launchTimeoutMs?: number;
  env?: Record<string, string>;
}

export type LaunchEngine = 'native' | 'patchright';

export interface LaunchedBrowser {
  process: ChildProcess | null;
  closeLauncher?: () => Promise<void>;
  pid: number;
  wsEndpoint: string;
  port: number;
  userDataDir: string;
  executable: string;
  resolved: ResolvedBrowser;
  netLogPath: string | null;
  extensionsLoaded: string[];
}

/** Who already holds a profile. wsEndpoint is null when it has no DevTools port. */
export interface ProfileOwner {
  wsEndpoint: string | null;
  pid: number | null;
}

/**
 * A live Chromium owns this profile, so launching on it cannot work.
 *
 * Chromium allows one process per --user-data-dir. A second one hands its URLs
 * to the first (the stray about:blank tab in someone's window) and quits without
 * a DevTools port, so a launch can only ever fail here. Callers that can use the
 * running browser attach to `owner` instead.
 */
export class ProfileInUseError extends AgentBrowserError {
  readonly owner: ProfileOwner;

  constructor(userDataDir: string, owner: ProfileOwner) {
    super(
      'profile_in_use',
      `Another Chromium${owner.pid ? ` (pid ${owner.pid})` : ''} is already using this profile: ${userDataDir}. ` +
        'Close that window, or launch with a different profile.',
      { userDataDir, pid: owner.pid, wsEndpoint: owner.wsEndpoint },
    );
    this.name = 'ProfileInUseError';
    this.owner = owner;
  }
}

/** The browser WebSocket behind a DevTools port, or null if nothing answers there. */
async function devToolsEndpoint(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** True when a live process holds the profile, without asking Chromium to start. */
function profileLocked(userDataDir: string): boolean {
  if (process.platform === 'win32') {
    // Chromium keeps `lockfile` open with no sharing while it runs. A leftover
    // file from a crash opens fine, so this cannot be fooled by a dead browser.
    const file = join(userDataDir, 'lockfile');
    if (!existsSync(file)) return false;
    try {
      closeSync(openSync(file, 'r+'));
      return false;
    } catch (err) {
      return ['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '');
    }
  }
  // Elsewhere SingletonLock is a symlink to "hostname-pid".
  const lock = join(userDataDir, 'SingletonLock');
  try {
    lstatSync(lock);
    process.kill(Number(readlinkSync(lock).split('-').pop()), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 10_000 }, (_err, stdout) => {
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Browser processes started on this profile: never its renderers or helpers. */
async function profileProcesses(userDataDir: string): Promise<number[]> {
  if (process.platform === 'win32') {
    // The path travels in an environment variable so nothing in it needs quoting.
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and " +
      "$_.CommandLine.Contains('--user-data-dir=' + $env:BROWSERD_PROFILE) -and " +
      "-not $_.CommandLine.Contains('--type=') } | ForEach-Object { $_.ProcessId }";
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      BROWSERD_PROFILE: userDataDir,
    });
    return out.split(/\s+/).map(Number).filter((pid) => pid > 0);
  }
  const out = await run('ps', ['-axo', 'pid=,command=']);
  return out
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${userDataDir}`) && !line.includes('--type='))
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => pid > 0);
}

async function listeningPorts(pid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[3] === 'LISTENING' && Number(cols[4]) === pid)
      .map((cols) => Number(cols[1]?.split(':').pop()))
      .filter((port) => port > 0);
  }
  const out = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
  return [...out.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
}

/**
 * The running browser that holds a profile, if there is one.
 *
 * DevToolsActivePort answers the common case with one request. Everything after
 * it runs only once the profile is known to be locked, so a normal launch pays
 * for one file read and never for a process scan.
 */
export async function findProfileOwner(userDataDir: string): Promise<ProfileOwner | null> {
  const file = join(userDataDir, 'DevToolsActivePort');
  if (existsSync(file)) {
    const port = Number(readFileSync(file, 'utf8').split('\n')[0]?.trim());
    const wsEndpoint = port > 0 ? await devToolsEndpoint(port) : null;
    if (wsEndpoint) return { wsEndpoint, pid: null };
  }
  if (!profileLocked(userDataDir)) return null;

  const pids = await profileProcesses(userDataDir);
  for (const pid of pids) {
    for (const port of await listeningPorts(pid)) {
      const wsEndpoint = await devToolsEndpoint(port);
      if (wsEndpoint) return { wsEndpoint, pid };
    }
  }
  return { wsEndpoint: null, pid: pids[0] ?? null };
}

/**
 * Chromium writes the negotiated port and browser WebSocket path here once the
 * DevTools endpoint is listening. Polling this file is more reliable than
 * scraping stderr, which is quiet on some builds.
 */
async function readDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<{ port: number; path: string }> {
  const file = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let exitInfo: string | null = null;
  let exitCode: number | null = null;
  child?.once('exit', (code, signal) => {
    exitInfo = `code=${code} signal=${signal}`;
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exitInfo) {
      /*
       * Exit 21 is Chromium's ProcessSingleton bailing out: another process
       * already holds this --user-data-dir, so it hands its URLs to that
       * instance and quits without ever opening a DevTools port. On Windows the
       * same hand-off exits 0. launchBrowser checks for an owner first, so this
       * only catches a browser that started between that check and the spawn.
       */
      if (exitCode === 21 || exitCode === 0) {
        throw new ProfileInUseError(
          userDataDir,
          (await findProfileOwner(userDataDir)) ?? { wsEndpoint: null, pid: null },
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
  // Validated before anything touches the profile, so a bad path costs nothing.
  const media = mediaArgs(options.media);

  // Before anything below: a spawn here would only drop a blank tab in the
  // running window, and removing DevToolsActivePort would hide its port for good.
  const owner = existsSync(userDataDir) ? await findProfileOwner(userDataDir) : null;
  if (owner) throw new ProfileInUseError(userDataDir, owner);

  if (options.freshProfile && existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
  mkdirSync(userDataDir, { recursive: true });

  // A live DevToolsActivePort from a previous run makes the poll below return a
  // stale port. Remove it so we only ever read the one this launch writes.
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  if (existsSync(activePortFile)) rmSync(activePortFile, { force: true });

  const args = [...BASE_ARGS, ...linuxContainerArgs()];
  if (options.stealth) args.push(...STEALTH_ARGS);
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

  if (media.length) {
    log.info(`media capture switches: ${media.join(' ')}`);
    args.push(...media);
  }

  if (options.args?.length) args.push(...options.args);
  if (options.launchEngine === 'patchright') args.push('--remote-debugging-pipe');
  if (options.urls?.length) args.push(...options.urls);
  else args.push('about:blank');

  log.info(`launching ${resolved.executablePath} (profile=${options.profile})`);
  log.debug('args', args);

  const env = { ...process.env, ...options.env };
  const timeout = options.launchTimeoutMs ?? 45_000;
  if (options.launchEngine === 'patchright') {
    const { chromium } = await import('patchright');
    const deadline = Date.now() + timeout;
    // Browsered owns the Chromium command line and the WebSocket recorder.
    // Patchright owns the persistent process through its additional CDP pipe.
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: resolved.executablePath,
      ignoreDefaultArgs: true,
      viewport: null,
      headless: options.headless === true,
      args,
      env,
      timeout,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    try {
      const browser = context.browser();
      if (!browser) throw new Error('Patchright did not return a persistent Chromium browser');
      const session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      await session.detach();
      const pid = processInfo.find((entry) => entry.type === 'browser')?.id;
      if (!pid) throw new Error('Patchright launched Chromium but did not report its pid');
      const { port, path } = await readDevToolsActivePort(userDataDir, Math.max(100, deadline - Date.now()));
      return {
        process: null,
        closeLauncher: async () => {
          const closed = browser.close();
          // Chromium can close its CDP socket while its process lingers.
          // Give it time to flush the profile, then reap it as on native launches.
          try {
            await Promise.race([closed, delay(2_000, undefined, { ref: false })]);
          } finally {
            await killBrowserProcess(null, pid);
          }
          await closed;
        },
        pid,
        wsEndpoint: `ws://127.0.0.1:${port}${path}`,
        port,
        userDataDir,
        executable: resolved.executablePath,
        resolved,
        netLogPath,
        extensionsLoaded: extensions,
      };
    } catch (err) {
      await context.close().catch((closeErr) => log.warn('failed to close Patchright Chromium', closeErr));
      throw err;
    }
  }

  const child = spawn(resolved.executablePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: options.headless === true,
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
    timeout,
    child,
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
export async function killBrowserProcess(child: ChildProcess | null, pid: number): Promise<void> {
  const running = () => child ? child.exitCode === null && child.signalCode === null : isAlive(pid);
  if (!running()) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    if (child) child.kill('SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await delay(500);
  if (running()) {
    try {
      if (child) child.kill('SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
