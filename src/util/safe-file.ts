import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { AgentBrowserError } from './errors.js';

/**
 * Writing a file for an agent, safely.
 *
 * The alternative an agent reaches for is a shell: echo the content in chunks,
 * quote it, hope nothing in it is a metacharacter. That breaks on the first
 * page title with a quote or a dollar sign and silently overwrites whatever was
 * there. This does one write, from bytes, to a name that is legal on every
 * platform, and never replaces a file unless asked to.
 */

export type OnConflict = 'error' | 'rename' | 'overwrite';

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME = 180;

/** A file name that every OS accepts, keeping as much of the original as it can. */
export function sanitizeFilename(name: string): string {
  let out = name.normalize('NFC').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  // Windows drops trailing dots and spaces, so "report." would collide with "report".
  out = out.replace(/[. ]+$/, '');
  if (RESERVED.test(out)) out = `_${out}`;
  if (out === '' || /^\.+$/.test(out)) out = 'file';
  if (out.length > MAX_NAME) {
    const ext = extname(out).slice(0, 16);
    out = out.slice(0, MAX_NAME - ext.length) + ext;
  }
  return out;
}

function nthName(name: string, n: number): string {
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * Write `data` to `dir`/`filename`. The directory is created; the file name is
 * sanitized; an existing file is an error, renamed around, or replaced
 * atomically depending on `onConflict`.
 */
export function safeWriteFile(
  dir: string,
  filename: string,
  data: Buffer,
  onConflict: OnConflict,
): { path: string; requested_name: string; sanitized: boolean; renamed: boolean; overwritten: boolean; size: number } {
  if (!isAbsolute(dir)) {
    throw new AgentBrowserError(
      'bad_path',
      `Directory must be absolute: ${JSON.stringify(dir)}. The daemon's working directory is not yours, so a relative path would land somewhere unexpected.`,
    );
  }
  const clean = sanitizeFilename(filename);
  mkdirSync(dir, { recursive: true });
  const base = { requested_name: filename, sanitized: clean !== filename, size: data.length };

  if (onConflict === 'overwrite') {
    const finalPath = join(dir, clean);
    const existed = existsSync(finalPath);
    // Write beside it and rename over it, so a reader never sees half a file.
    const tmp = join(dir, `.${clean}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeExclusive(tmp, data);
      renameSync(tmp, finalPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return { ...base, path: finalPath, renamed: false, overwritten: existed };
  }

  // Exclusive create: the existence check and the write are one step, so two
  // writers racing for the same name cannot both win.
  for (let n = 1; n <= 9_999; n++) {
    const name = n === 1 ? clean : nthName(clean, n);
    const finalPath = join(dir, name);
    try {
      writeExclusive(finalPath, data);
      return { ...base, path: finalPath, renamed: n > 1, overwritten: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (onConflict === 'error') {
        throw new AgentBrowserError(
          'file_exists',
          `${finalPath} already exists. Pass on_conflict:"rename" to write beside it or "overwrite" to replace it.`,
          { path: finalPath },
        );
      }
    }
  }
  throw new AgentBrowserError('file_exists', `No free name for ${clean} in ${dir}.`);
}

function writeExclusive(path: string, data: Buffer): void {
  const fd = openSync(path, 'wx');
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  } finally {
    closeSync(fd);
  }
}

/** Split a full path into the directory and the name to sanitize. */
export function splitPath(path: string): { dir: string; filename: string } {
  return { dir: dirname(path), filename: basename(path) };
}
