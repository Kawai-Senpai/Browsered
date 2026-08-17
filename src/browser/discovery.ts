import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../util/logger.js';
import { paths } from '../util/paths.js';

const log = createLogger('discovery');

/**
 * A browser advertised on disk so any later process can find it.
 *
 * The point of browserd is that a browser you opened yourself keeps recording
 * whether or not an agent is attached, and that a *different* process - a new
 * MCP session started hours later - can discover it and pick up the whole
 * history. An in-memory registry cannot do that, because each stdio MCP session
 * is its own process with its own empty map.
 *
 * So a launched browser writes one of these files, and every daemon sweeps the
 * directory on startup and adopts what is still alive.
 */
export interface BrowserRecord {
  /** The daemon-minted handle, stable for the browser's lifetime. */
  browserId: string;
  /** CDP endpoint. This is what a new process actually connects to. */
  wsEndpoint: string;
  profile: string;
  userDataDir: string;
  /** Chromium's pid, used to tell a live entry from a stale one. */
  pid: number;
  /** The `browserd open` process, if one is supervising. */
  ownerPid: number | null;
  executable: string | null;
  extensions: string[];
  headless: boolean;
  startedAt: number;
  /** Bumped by the owner so a hard-killed browser can be aged out. */
  heartbeatAt: number;
}

function runtimeDir(): string {
  const dir = join(paths.runtime(), 'browsers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function recordPath(browserId: string): string {
  return join(runtimeDir(), `${browserId}.json`);
}

/** True if a pid is a live process this user can signal. */
function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything, which is the portable way to ask "is this pid still there".
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else. That still
    // counts as alive; only ESRCH means it is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function publish(record: BrowserRecord): void {
  writeFileSync(recordPath(record.browserId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  log.debug(`published ${record.browserId} -> ${record.wsEndpoint}`);
}

export function heartbeat(browserId: string): void {
  const file = recordPath(browserId);
  if (!existsSync(file)) return;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as BrowserRecord;
    record.heartbeatAt = Date.now();
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    /* A torn read during another process's write; the next tick will fix it. */
  }
}

export function withdraw(browserId: string): void {
  rmSync(recordPath(browserId), { force: true });
  log.debug(`withdrew ${browserId}`);
}

/**
 * Every browser currently advertised and still running.
 *
 * Dead entries are deleted as they are found: a browser that crashed should not
 * keep showing up in `browser.list` forever, and cleaning here means no
 * separate reaper process is needed.
 */
export function discover(): BrowserRecord[] {
  const dir = runtimeDir();
  const live: BrowserRecord[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);

    let record: BrowserRecord;
    try {
      record = JSON.parse(readFileSync(file, 'utf8')) as BrowserRecord;
    } catch {
      rmSync(file, { force: true });
      continue;
    }

    if (!isAlive(record.pid)) {
      log.debug(`reaping ${record.browserId}: pid ${record.pid} is gone`);
      rmSync(file, { force: true });
      continue;
    }

    live.push(record);
  }

  return live.sort((a, b) => a.startedAt - b.startedAt);
}

export function findByProfile(profile: string): BrowserRecord | undefined {
  return discover().find((r) => r.profile === profile);
}
