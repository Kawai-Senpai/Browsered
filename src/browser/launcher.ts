import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBrowserError } from '../util/errors.js';
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
  // Validated before anything touches the profile, so a bad path costs nothing.
  const media = mediaArgs(options.media);

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

  if (media.length) {
    log.info(`media capture switches: ${media.join(' ')}`);
    args.push(...media);
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
