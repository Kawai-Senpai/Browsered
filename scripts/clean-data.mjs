#!/usr/bin/env node
/**
 * Inspect and clean the browserd data directory.
 *
 *   node scripts/clean-data.mjs                    # show what is stored, delete nothing
 *   node scripts/clean-data.mjs --recordings       # wipe SQLite rows + blobs, keep profiles
 *   node scripts/clean-data.mjs --artifacts        # delete screenshots/HARs/traces/heaps
 *   node scripts/clean-data.mjs --profiles         # delete browser profiles (logs you out)
 *   node scripts/clean-data.mjs --logs             # delete daemon logs
 *   node scripts/clean-data.mjs --all              # everything above
 *   node scripts/clean-data.mjs --older-than 7d    # only data older than a cutoff
 *   node scripts/clean-data.mjs --vacuum           # compact SQLite after deleting
 *
 * Nothing is deleted without an explicit flag, and destructive runs ask for
 * confirmation unless --yes is passed.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { paths } from '../dist/util/paths.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const HOME = paths.home();
const DB = paths.db();
const ALL = has('all');
const WANT = {
  recordings: ALL || has('recordings'),
  artifacts: ALL || has('artifacts'),
  profiles: ALL || has('profiles'),
  logs: ALL || has('logs'),
};
const DRY = !Object.values(WANT).some(Boolean);

/** "7d", "24h", "30m" -> cutoff timestamp. */
function parseCutoff(v) {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(v.trim());
  if (!m) throw new Error(`Cannot parse --older-than "${v}". Use forms like 7d, 24h, 30m.`);
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
  return Date.now() - Number(m[1]) * mult;
}
let CUTOFF;
try {
  CUTOFF = parseCutoff(val('older-than'));
} catch (err) {
  // Thrown at module scope, so it would otherwise surface as a raw stack.
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

function dirSize(dir) {
  if (!existsSync(dir)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      try {
        if (entry.isDirectory()) walk(p);
        else {
          bytes += statSync(p).size;
          files++;
        }
      } catch {
        /* raced with a delete; ignore */
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

const human = (b) =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB`
  : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB`
  : b >= 1 << 10 ? `${(b / (1 << 10)).toFixed(0)} KB`
  : `${b} B`;

function openDb() {
  if (!existsSync(DB)) return null;
  const Database = require('better-sqlite3');
  return new Database(DB);
}

/* --------------------------------- report -------------------------------- */

function report() {
  console.log(`\n\x1b[1mbrowserd data\x1b[0m  ${HOME}\n`);

  const rows = [];
  const dbBytes = existsSync(DB) ? statSync(DB).size : 0;
  rows.push(['SQLite (browserd.db)', dbBytes, '']);

  for (const [label, dir] of [
    ['blobs (request/response bodies)', paths.blobs()],
    ['artifacts (shots, HARs, traces, heaps)', join(HOME, 'artifacts')],
    ['profiles (cookies + sessions)', paths.profiles()],
    ['logs', paths.logs()],
  ]) {
    const { bytes, files } = dirSize(dir);
    rows.push([label, bytes, files ? `${files} files` : '']);
  }

  const width = Math.max(...rows.map((r) => r[0].length));
  let total = 0;
  for (const [label, bytes, note] of rows) {
    total += bytes;
    console.log(`  ${label.padEnd(width)}  ${human(bytes).padStart(9)}  \x1b[90m${note}\x1b[0m`);
  }
  console.log(`  ${'total'.padEnd(width)}  \x1b[1m${human(total).padStart(9)}\x1b[0m\n`);

  const db = openDb();
  if (db) {
    try {
      const counts = [
        ['requests', 'requests'],
        ['console entries', 'console_entries'],
        ['exceptions', 'exceptions'],
        ['websocket frames', 'ws_messages'],
        ['navigations', 'navigations'],
        ['artifacts (indexed)', 'artifacts'],
        ['targets', 'targets'],
        ['browsers', 'browsers'],
      ];
      console.log('  \x1b[1mrecorded rows\x1b[0m');
      for (const [label, table] of counts) {
        try {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
          if (n) console.log(`    ${label.padEnd(22)} ${String(n).padStart(8)}`);
        } catch {
          /* table may not exist in an older schema */
        }
      }
      const oldest = db.prepare(`SELECT MIN(started_at) AS t FROM requests`).get()?.t;
      if (oldest) console.log(`\n  oldest recording: ${new Date(oldest).toISOString()}`);
    } finally {
      db.close();
    }
  }

  if (DRY) {
    console.log(
      '\n  Nothing deleted. Pass --recordings, --artifacts, --profiles, --logs or --all.' +
        '\n  Add --older-than 7d to keep recent data, --vacuum to compact SQLite.\n',
    );
  }
}

/* --------------------------------- clean --------------------------------- */

function cleanRecordings(db) {
  if (!db) return { rows: 0, blobs: 0 };
  const where = CUTOFF ? ' WHERE started_at < @cutoff' : '';
  const p = { cutoff: CUTOFF };

  // Collect blob refs before deleting rows, or the files become unreachable.
  const refs = new Set();
  try {
    for (const r of db.prepare(`SELECT body_blob, post_data_blob FROM requests${where}`).all(p)) {
      if (r.body_blob) refs.add(r.body_blob);
      if (r.post_data_blob) refs.add(r.post_data_blob);
    }
  } catch {
    /* schema mismatch */
  }

  let rows = 0;
  const tables = CUTOFF
    ? [['requests', 'started_at'], ['console_entries', 'ts'], ['exceptions', 'ts'], ['navigations', 'ts'], ['ws_messages', 'ts']]
    : [['requests'], ['console_entries'], ['exceptions'], ['navigations'], ['ws_messages'], ['websockets']];

  const tx = db.transaction(() => {
    for (const [table, tsCol] of tables) {
      try {
        const sql = CUTOFF && tsCol ? `DELETE FROM ${table} WHERE ${tsCol} < @cutoff` : `DELETE FROM ${table}`;
        rows += db.prepare(sql).run(p).changes;
      } catch {
        /* table may not exist */
      }
    }
  });
  tx();

  // Only delete blobs no surviving row still references.
  let blobs = 0;
  const blobDir = paths.blobs();
  for (const ref of refs) {
    let stillUsed = false;
    try {
      stillUsed =
        db.prepare(`SELECT 1 FROM requests WHERE body_blob = ? OR post_data_blob = ? LIMIT 1`).get(ref, ref) !==
        undefined;
    } catch {
      /* ignore */
    }
    if (stillUsed) continue;
    for (const candidate of [join(blobDir, ref), join(blobDir, ref.slice(0, 2), ref)]) {
      if (existsSync(candidate)) {
        rmSync(candidate, { force: true });
        blobs++;
        break;
      }
    }
  }
  return { rows, blobs };
}

function removeDir(dir, { keepRoot = true } = {}) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (CUTOFF) {
      try {
        if (statSync(p).mtimeMs >= CUTOFF) continue;
      } catch {
        continue;
      }
    }
    rmSync(p, { recursive: true, force: true });
    removed++;
  }
  if (!keepRoot) rmSync(dir, { recursive: true, force: true });
  return removed;
}

async function confirm(summary) {
  if (has('yes') || has('y')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${summary}\nProceed? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  if (!existsSync(HOME)) {
    console.log(`\nNo data directory at ${HOME} - nothing to clean.\n`);
    return;
  }

  report();
  if (DRY) return;

  const targets = Object.entries(WANT).filter(([, v]) => v).map(([k]) => k);
  const scope = CUTOFF ? ` older than ${val('older-than')}` : '';
  const warn = WANT.profiles
    ? '\n  \x1b[33mProfiles hold cookies and session tokens: deleting them logs you out everywhere.\x1b[0m'
    : '';

  if (!(await confirm(`About to delete: \x1b[1m${targets.join(', ')}\x1b[0m${scope}.${warn}`))) {
    console.log('Aborted.\n');
    return;
  }

  console.log('');
  if (WANT.recordings) {
    const db = openDb();
    if (db) {
      try {
        const { rows, blobs } = cleanRecordings(db);
        console.log(`  recordings  removed ${rows} rows, ${blobs} blob files`);
        if (has('vacuum')) {
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.exec('VACUUM');
          console.log(`  vacuum      database compacted to ${human(statSync(DB).size)}`);
        }
      } finally {
        db.close();
      }
    } else {
      console.log('  recordings  no database found');
    }
  }
  if (WANT.artifacts) {
    console.log(`  artifacts   removed ${removeDir(join(HOME, 'artifacts'))} entries`);
  }
  if (WANT.profiles) {
    console.log(`  profiles    removed ${removeDir(paths.profiles())} profiles`);
  }
  if (WANT.logs) {
    console.log(`  logs        removed ${removeDir(paths.logs())} files`);
  }

  console.log('\n\x1b[1mAfter:\x1b[0m');
  report();
}

main().catch((err) => {
  console.error(`\nclean-data failed: ${err.message}\n`);
  process.exit(1);
});
