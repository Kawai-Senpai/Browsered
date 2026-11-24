import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM = 'https://github.com/Kawai-Senpai/Browsered.git';
const BRANCH = 'master';
const REVISION = /^[a-f0-9]{40}$/;
const ENTRY = join('dist', 'cli.js');
const CHECK_INTERVAL = 10 * 60 * 1000;
// Longer than the sum of subprocess timeouts. An interrupted worker can be retried.
const LOCK_LIFETIME = 25 * 60 * 1000;
const worker = fileURLToPath(import.meta.url);

function git(cwd, args, timeout = 5_000) {
  return spawnSync('git', args, {
    cwd, timeout, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
}

function output(result) {
  if (result.status === 0) return result.stdout.trim();
  throw new Error(result.error?.message || result.stderr?.trim() || 'git exited ' + result.status);
}

export function cleanCheckout(root, remote = UPSTREAM) {
  try {
    if (output(git(root, ['remote', 'get-url', 'origin'])).toLowerCase() !== remote.toLowerCase()) return undefined;
    if (output(git(root, ['symbolic-ref', '--short', 'HEAD'])) !== BRANCH) return undefined;
    if (output(git(root, ['status', '--porcelain=v1', '--untracked-files=normal']))) return undefined;
    const revision = output(git(root, ['rev-parse', 'HEAD']));
    return REVISION.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

export function preparedUpdate(cache, base) {
  try {
    const manifest = JSON.parse(readFileSync(join(cache, 'ready.json'), 'utf8'));
    if (manifest.base !== base || !REVISION.test(manifest.revision) || manifest.revision === base) return undefined;
    const path = join(cache, manifest.revision, ENTRY);
    if (existsSync(path)) return { revision: manifest.revision, path };
  } catch {
    // Corrupt or missing metadata leaves the source checkout usable.
  }
  return undefined;
}

function modifiedAt(path) {
  try { return statSync(path).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

export function selectUpdate(root) {
  if (process.env.AGENTBROWSER_AUTO_UPDATE !== '1') return undefined;
  const base = cleanCheckout(root);
  if (!base) return undefined;
  const id = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  const home = resolve(process.env.AGENTBROWSER_HOME || join(homedir(), '.agent-browser'));
  const cache = join(home, 'updates', id, [process.platform, process.arch, process.versions.modules].join('-'));
  const ready = preparedUpdate(cache, base);
  try {
    mkdirSync(cache, { recursive: true });
    if (Date.now() - modifiedAt(join(cache, 'last-check')) >= CHECK_INTERVAL) {
      const log = openSync(join(cache, 'update.log'), 'a');
      try {
        const child = spawn(process.execPath, [worker, '--prepare', cache, base], {
          cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
        });
        child.on('error', error => process.stderr.write('[browserd] Update check could not start: ' + error.message + '\n'));
        child.unref();
      } finally {
        closeSync(log);
      }
    }
  } catch (error) {
    process.stderr.write('[browserd] Update check skipped: ' + error.message + '\n');
  }
  if (ready) process.stderr.write('[browserd] Starting staged revision ' + ready.revision.slice(0, 12) + '\n');
  return ready?.path;
}

function runBuild(directory, command, args, timeout) {
  const result = spawnSync(command, args, {
    cwd: directory, timeout, windowsHide: true, stdio: ['ignore', 2, 2],
    env: { ...process.env, NODE_ENV: 'development', npm_config_update_notifier: 'false' },
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(command + ' ' + args.join(' ') + ' exited ' + (result.status ?? result.signal));
  }
}

function runNpm(directory, args, timeout) {
  // These arguments are fixed npm commands. The Windows npm launcher is a .cmd file.
  if (process.platform === 'win32') {
    return runBuild(directory, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], timeout);
  }
  return runBuild(directory, 'npm', args, timeout);
}

function publish(cache, base, revision) {
  const temporary = join(cache, 'ready-' + randomUUID() + '.json');
  try {
    writeFileSync(temporary, JSON.stringify({ base, revision }) + '\n', { flag: 'wx' });
    renameSync(temporary, join(cache, 'ready.json'));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function prepareUpdate({ cache, base, remote = UPSTREAM }) {
  if (!REVISION.test(base)) throw new Error('Invalid source revision');
  mkdirSync(cache, { recursive: true });
  const checked = join(cache, 'last-check');
  const lock = join(cache, 'checking');
  if (Date.now() - modifiedAt(checked) < CHECK_INTERVAL) return 'recent_check';
  if (Date.now() - modifiedAt(lock) >= LOCK_LIFETIME) {
    try { unlinkSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    closeSync(openSync(lock, 'wx'));
  } catch (error) {
    if (error.code === 'EEXIST') return 'check_in_progress';
    throw error;
  }

  let staged;
  try {
    // A sibling launcher could have completed an update before we got the lock.
    if (Date.now() - modifiedAt(checked) < CHECK_INTERVAL) return 'recent_check';
    writeFileSync(checked, new Date().toISOString() + '\n');
    const previous = preparedUpdate(cache, base)?.revision ?? base;
    const reference = 'refs/heads/' + BRANCH;
    const latest = output(git(cache, ['ls-remote', '--exit-code', remote, reference], 45_000)).split(/\s+/)[0];
    if (!REVISION.test(latest)) throw new Error('Upstream returned an invalid revision');
    if (latest === previous) return 'current';

    staged = await mkdtemp(join(cache, 'stage-'));
    output(git(staged, ['clone', '--quiet', '--no-tags', '--single-branch', '--branch', BRANCH, '--', remote, '.'], 120_000));
    const revision = output(git(staged, ['rev-parse', 'HEAD']));
    if (!REVISION.test(revision)) throw new Error('Cloned checkout has an invalid revision');
    if (revision === previous) return 'current';
    if (git(staged, ['merge-base', '--is-ancestor', previous, revision]).status !== 0) {
      throw new Error('Upstream revision is not a fast-forward from the current build');
    }

    const destination = join(cache, revision);
    if (!existsSync(join(destination, ENTRY))) {
      runNpm(staged, ['ci', '--include=dev', '--no-audit', '--no-fund'], 360_000);
      runNpm(staged, ['run', 'build'], 120_000);
      if (!existsSync(join(staged, ENTRY))) throw new Error('Build did not produce the Browsered entry point');
      runBuild(staged, process.execPath, [ENTRY, '--tools'], 20_000);
      if (existsSync(join(staged, 'node_modules', 'better-sqlite3', 'package.json'))) {
        runBuild(staged, process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], 20_000);
      }
      // Rename within the same filesystem. Completed builds never change while in use.
      renameSync(staged, destination);
      staged = undefined;
    }
    publish(cache, base, revision);
    return 'staged ' + revision;
  } finally {
    try {
      if (staged) await rm(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } finally {
      unlinkSync(lock);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === worker && process.argv[2] === '--prepare') {
  try {
    const result = await prepareUpdate({ cache: process.argv[3], base: process.argv[4] });
    console.error('[browserd] Update check: ' + result);
  } catch (error) {
    console.error('[browserd] Update check failed: ' + error.message);
    process.exitCode = 1;
  }
}
