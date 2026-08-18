import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root for everything the daemon owns: profiles, database, blobs, logs. */
export function homeDir(): string {
  return process.env.AGENTBROWSER_HOME
    ? resolve(process.env.AGENTBROWSER_HOME)
    : join(homedir(), '.agent-browser');
}

export const paths = {
  home: homeDir,
  profiles: () => join(homeDir(), 'profiles'),
  profile: (name: string) => join(homeDir(), 'profiles', name),
  db: () => join(homeDir(), 'browserd.db'),
  blobs: () => join(homeDir(), 'blobs'),
  logs: () => join(homeDir(), 'logs'),
  netlogs: () => join(homeDir(), 'netlogs'),
  traces: () => join(homeDir(), 'traces'),
  screenshots: () => join(homeDir(), 'screenshots'),
  runtime: () => join(homeDir(), 'run'),
  daemonInfo: () => join(homeDir(), 'run', 'browserd.json'),
  config: () => join(homeDir(), 'config.json'),
  /**
   * Where the bundled capture panel saves capsules.
   *
   * The vendored Context Capsule writes through chrome.downloads, which without
   * this would land in the human's Downloads folder - somewhere an agent has no
   * reason to look. Pointing Chromium's download directory here puts capsules
   * beside the rest of the evidence browserd already owns.
   */
  capsules: () => join(homeDir(), 'capsules'),
};

/**
 * Extensions shipped inside the package, loaded into every headed browser
 * unless disabled.
 *
 * Resolved relative to this module rather than cwd, so it works the same when
 * browserd is launched by an MCP client from an arbitrary directory. Both the
 * built (`dist/util/`) and source (`src/util/`) layouts sit two levels below
 * the package root.
 */
export function bundledExtensionsDir(): string {
  return resolve(fileURLToPath(new URL('../../extensions', import.meta.url)));
}

/** Absolute paths of every bundled extension that is actually present. */
export function bundledExtensions(): string[] {
  const root = bundledExtensionsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    // A directory without a manifest is not a loadable extension, and passing
    // one to Chromium aborts the whole launch.
    .filter((dir) => existsSync(join(dir, 'manifest.json')));
}

const WINDOWS_CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MAC_CHROME_CANDIDATES = [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

function playwrightCacheDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'ms-playwright');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

/**
 * Chromium builds shipped by Playwright. Preferred over installed Chrome
 * because stable Chrome dropped `--load-extension` in 137, which would break
 * extension loading outright.
 */
function playwrightChromiumCandidates(): string[] {
  const cache = playwrightCacheDir();
  if (!existsSync(cache)) return [];
  let entries: string[];
  try {
    entries = readdirSync(cache);
  } catch {
    return [];
  }
  const builds: Array<{ revision: number; dir: string }> = [];
  for (const entry of entries) {
    // Skip `chromium_headless_shell-*`: it cannot run headed.
    const match = /^chromium-(\d+)$/.exec(entry);
    if (!match) continue;
    builds.push({ revision: Number(match[1]), dir: join(cache, entry) });
  }
  builds.sort((a, b) => b.revision - a.revision);

  const out: string[] = [];
  for (const build of builds) {
    // Layout changed around build 1200: chrome-win -> chrome-win64.
    const relatives =
      process.platform === 'win32'
        ? ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']
        : process.platform === 'darwin'
          ? [
              'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
              'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
            ]
          : ['chrome-linux/chrome'];
    for (const rel of relatives) out.push(join(build.dir, rel));
  }
  return out;
}

function isExecutableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolvedBrowser {
  executablePath: string;
  /** Playwright's Chromium supports --load-extension; stable Chrome >=137 does not. */
  supportsExtensionFlags: boolean;
  source: 'env' | 'config' | 'playwright' | 'system';
}

/**
 * Find a Chromium to drive. Order: explicit override, configured path,
 * Playwright's bundled build, then whatever the system has.
 */
export function resolveChromium(configuredPath?: string): ResolvedBrowser {
  const fromEnv = process.env.AGENTBROWSER_CHROMIUM;
  if (fromEnv) {
    if (!isExecutableFile(fromEnv)) {
      throw new Error(`AGENTBROWSER_CHROMIUM points at a missing file: ${fromEnv}`);
    }
    return { executablePath: fromEnv, supportsExtensionFlags: true, source: 'env' };
  }
  if (configuredPath) {
    if (!isExecutableFile(configuredPath)) {
      throw new Error(`Configured chromiumPath points at a missing file: ${configuredPath}`);
    }
    return { executablePath: configuredPath, supportsExtensionFlags: true, source: 'config' };
  }
  for (const candidate of playwrightChromiumCandidates()) {
    if (isExecutableFile(candidate)) {
      return { executablePath: candidate, supportsExtensionFlags: true, source: 'playwright' };
    }
  }
  const systemCandidates =
    process.platform === 'win32'
      ? WINDOWS_CHROME_CANDIDATES
      : process.platform === 'darwin'
        ? MAC_CHROME_CANDIDATES
        : LINUX_CHROME_CANDIDATES;
  for (const candidate of systemCandidates) {
    if (isExecutableFile(candidate)) {
      // Branded Chrome/Edge 137+ ignore the extension sideloading flags.
      const branded = /chrome\.exe$|msedge|Google Chrome|google-chrome|microsoft-edge/i.test(
        candidate,
      );
      return {
        executablePath: candidate,
        supportsExtensionFlags: !branded,
        source: 'system',
      };
    }
  }
  throw new Error(
    'No Chromium found. Install Playwright browsers (`npx playwright install chromium`) ' +
      'or set AGENTBROWSER_CHROMIUM to a Chromium executable.',
  );
}
