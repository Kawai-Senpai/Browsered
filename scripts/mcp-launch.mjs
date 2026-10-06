#!/usr/bin/env node
/**
 * The entry MCP clients launch. Starts dist/cli.js, repairing the checkout first
 * when it has to.
 *
 *   node scripts/mcp-launch.mjs [any dist/cli.js arguments]
 *
 * dist/ and node_modules/ are both gitignored, so a disk cleaner, a `git clean`
 * or a fresh clone leaves a checkout that every client config still points at
 * and that cannot start. This file is committed and uses only Node built-ins,
 * so it survives all of those: it reinstalls dependencies and rebuilds when
 * they are missing, then hands over to the real CLI.
 *
 * stdout belongs to the MCP protocol. Everything npm prints goes to stderr.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(ROOT, 'dist', 'cli.js');

/** Declared packages that are not installed. A half-deleted tree counts. */
function missingPackages() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return declared.filter((name) => !existsSync(join(ROOT, 'node_modules', name, 'package.json')));
}

function npm(args) {
  process.stderr.write(`[browserd] npm ${args.join(' ')}\n`);
  // shell: npm is npm.cmd on Windows. stdout is redirected to our stderr.
  const result = spawnSync('npm', args, { cwd: ROOT, shell: true, stdio: ['ignore', 2, 2] });
  if (result.status !== 0) {
    process.stderr.write(
      `[browserd] npm ${args.join(' ')} failed (exit ${result.status ?? result.signal}). ` +
        `Run it by hand in ${ROOT} to see why.\n`,
    );
    process.exit(1);
  }
}

const missing = missingPackages();
if (missing.length) {
  process.stderr.write(`[browserd] missing packages (${missing.join(', ')}); installing\n`);
  // install, not ci: ci deletes node_modules first and fails on a native
  // module another running browserd still holds open.
  npm(['install', '--no-audit', '--no-fund']);
}
if (missing.length || !existsSync(ENTRY)) {
  process.stderr.write('[browserd] dist/cli.js is missing; building\n');
  npm(['run', 'build']);
}

await import(pathToFileURL(ENTRY).href);
