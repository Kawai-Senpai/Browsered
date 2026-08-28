import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NotFoundError, AgentBrowserError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import { jsonPath, type JsonMatch } from '../util/jsonpath.js';
import { j, unj, type Db } from './db.js';

export type ArtifactKind =
  | 'response_body'
  | 'request_body'
  | 'har'
  | 'network_export'
  | 'console_export'
  | 'dom_export'
  | 'script_source'
  | 'screenshot'
  | 'netlog'
  | 'trace'
  | 'cpu_profile'
  | 'heap_snapshot'
  | 'coverage'
  | 'storage_export'
  | 'debug_bundle'
  | 'other';

export interface ArtifactRow {
  artifact_handle: string;
  browser_id: string | null;
  kind: string;
  label: string | null;
  path: string;
  mime: string | null;
  size: number;
  sha256: string | null;
  encoding: string | null;
  source_ref: string | null;
  meta: string | null;
  created_at: number;
}

export interface SearchHit {
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/json': '.json',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'text/html': '.html',
  'text/css': '.css',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/x-ndjson': '.ndjson',
  'application/zip': '.zip',
};

function safeLabel(label: string | undefined): string {
  if (!label) return 'artifact';
  return label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'artifact';
}

/**
 * Large payloads live on disk and are addressed by handle. Nothing here ever
 * returns a whole file by default: callers read ranges, read line windows,
 * stream-search, or run a JSON query. A 200MB response stays inspectable
 * without anyone trying to put it in a prompt.
 */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly root: string,
  ) {
    mkdirSync(root, { recursive: true });
  }

  private allocate(kind: ArtifactKind, label: string | undefined, mime: string | undefined): {
    handle: string;
    path: string;
  } {
    const handle = mintId('art');
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(this.root, kind, day);
    mkdirSync(dir, { recursive: true });
    const ext = mime ? (EXTENSION_BY_MIME[mime.split(';')[0]!.trim()] ?? '.bin') : '.bin';
    const path = join(dir, `${handle}-${safeLabel(label)}${ext}`);
    return { handle, path };
  }

  private record(input: {
    handle: string;
    path: string;
    kind: ArtifactKind;
    browserId?: string | null;
    label?: string;
    mime?: string;
    encoding?: string;
    sourceRef?: string;
    meta?: unknown;
    size: number;
    sha256: string | null;
  }): ArtifactRow {
    this.db
      .prepare(
        `INSERT INTO artifacts (
           artifact_handle, browser_id, kind, label, path, mime, size, sha256, encoding, source_ref, meta, created_at
         ) VALUES (
           @handle, @browserId, @kind, @label, @path, @mime, @size, @sha256, @encoding, @sourceRef, @meta, @createdAt
         )`,
      )
      .run({
        handle: input.handle,
        browserId: input.browserId ?? null,
        kind: input.kind,
        label: input.label ?? null,
        path: input.path,
        mime: input.mime ?? null,
        size: input.size,
        sha256: input.sha256,
        encoding: input.encoding ?? null,
        sourceRef: input.sourceRef ?? null,
        meta: j(input.meta),
        createdAt: Date.now(),
      });
    return this.get(input.handle)!;
  }

  /** Write a buffer as a new artifact. */
  put(
    kind: ArtifactKind,
    data: Buffer,
    options: {
      browserId?: string | null;
      label?: string;
      mime?: string;
      encoding?: string;
      sourceRef?: string;
      meta?: unknown;
    } = {},
  ): ArtifactRow {
    const { handle, path } = this.allocate(kind, options.label, options.mime);
    mkdirSync(dirname(path), { recursive: true });
    createWriteStreamSync(path, data);
    return this.record({
      handle,
      path,
      kind,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      ...options,
    });
  }

  /**
   * Stream rows into a new artifact. Used by exports that must never buffer
   * the whole result set in memory.
   */
  async putStream(
    kind: ArtifactKind,
    options: {
      browserId?: string | null;
      label?: string;
      mime?: string;
      sourceRef?: string;
      meta?: unknown;
    },
    writer: (write: (chunk: string | Buffer) => void) => void | Promise<void>,
  ): Promise<ArtifactRow> {
    const { handle, path } = this.allocate(kind, options.label, options.mime);
    mkdirSync(dirname(path), { recursive: true });
    const stream = createWriteStream(path);
    const hash = createHash('sha256');
    let size = 0;

    const write = (chunk: string | Buffer): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buf.length;
      hash.update(buf);
      stream.write(buf);
    };

    try {
      await writer(write);
    } finally {
      await new Promise<void>((res, rej) => {
        stream.end((err?: Error | null) => (err ? rej(err) : res()));
      });
    }

    return this.record({
      handle,
      path,
      kind,
      size,
      sha256: hash.digest('hex'),
      ...options,
    });
  }

  get(handle: string): ArtifactRow | undefined {
    return this.db.prepare(`SELECT * FROM artifacts WHERE artifact_handle = ?`).get(handle) as
      | ArtifactRow
      | undefined;
  }

  require(handle: string): ArtifactRow {
    const row = this.get(handle);
    if (!row) throw new NotFoundError('artifact', handle);
    return row;
  }

  list(filter: { browserId?: string; kind?: string; label?: string; limit?: number }): ArtifactRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.browserId) {
      where.push('browser_id = @browserId');
      params.browserId = filter.browserId;
    }
    if (filter.kind) {
      where.push('kind = @kind');
      params.kind = filter.kind;
    }
    // Substring match: labels group a run of captures from one investigation.
    if (filter.label) {
      where.push("label LIKE '%' || @label || '%'");
      params.label = filter.label;
    }
    params.limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM artifacts ${clause} ORDER BY created_at DESC LIMIT @limit`)
      .all(params) as ArtifactRow[];
  }

  stat(handle: string): Record<string, unknown> {
    const row = this.require(handle);
    let onDisk: number | null = null;
    try {
      onDisk = statSync(row.path).size;
    } catch {
      onDisk = null;
    }
    return {
      artifact_id: row.artifact_handle,
      kind: row.kind,
      label: row.label,
      path: row.path,
      mime: row.mime,
      size: row.size,
      size_on_disk: onDisk,
      exists: onDisk !== null,
      sha256: row.sha256,
      encoding: row.encoding,
      source: row.source_ref,
      meta: unj(row.meta),
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  /** Byte-range read. `encoding: 'base64'` for binary artifacts. */
  readRange(
    handle: string,
    offset = 0,
    length = 64 * 1024,
    encoding: 'utf8' | 'base64' = 'utf8',
  ): Record<string, unknown> {
    const row = this.require(handle);
    const clampedLength = Math.min(Math.max(length, 1), 4 * 1024 * 1024);
    const buffer = Buffer.alloc(clampedLength);
    // Bounded read: never pulls more than the requested window into memory.
    const fd = openSyncSafe(row.path);
    let bytesRead = 0;
    try {
      bytesRead = readSyncSafe(fd, buffer, offset, clampedLength);
    } finally {
      closeSyncSafe(fd);
    }
    const slice = buffer.subarray(0, bytesRead);
    return {
      artifact_id: handle,
      offset,
      bytes_read: bytesRead,
      total_size: row.size,
      eof: offset + bytesRead >= row.size,
      encoding,
      content: encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
    };
  }

  /** Line window, 1-indexed and inclusive. */
  async readLines(handle: string, start = 1, end = 200): Promise<Record<string, unknown>> {
    const row = this.require(handle);
    const from = Math.max(start, 1);
    const to = Math.max(end, from);
    if (to - from > 20_000) {
      throw new AgentBrowserError('range_too_large', 'Line ranges are capped at 20000 lines per read.');
    }
    const lines: string[] = [];
    let lineNo = 0;
    let total = 0;

    const rl = createInterface({ input: createReadStream(row.path), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo++;
      total = lineNo;
      if (lineNo >= from && lineNo <= to) lines.push(line);
      // Keep counting past `to` only if the caller wants a total; stop early
      // once we are well beyond the window to stay cheap on huge files.
      if (lineNo > to + 1 && lineNo > 200_000) break;
    }
    rl.close();

    return {
      artifact_id: handle,
      start_line: from,
      end_line: from + lines.length - 1,
      line_count: lines.length,
      total_lines_seen: total,
      truncated: total > to,
      content: lines.join('\n'),
    };
  }

  /**
   * Streamed search. Reads line by line, so a multi-hundred-megabyte body is
   * searchable without ever being fully resident.
   */
  async search(
    handle: string,
    options: {
      query: string;
      isRegex?: boolean;
      ignoreCase?: boolean;
      contextLines?: number;
      maxMatches?: number;
    },
  ): Promise<Record<string, unknown>> {
    const row = this.require(handle);
    const contextLines = Math.min(Math.max(options.contextLines ?? 0, 0), 20);
    const maxMatches = Math.min(Math.max(options.maxMatches ?? 50, 1), 500);

    let test: (line: string) => boolean;
    if (options.isRegex) {
      let re: RegExp;
      try {
        re = new RegExp(options.query, options.ignoreCase ? 'i' : '');
      } catch (err) {
        throw new AgentBrowserError('bad_regex', `Invalid regex: ${(err as Error).message}`);
      }
      test = (line) => re.test(line);
    } else {
      const needle = options.ignoreCase ? options.query.toLowerCase() : options.query;
      test = (line) => (options.ignoreCase ? line.toLowerCase() : line).includes(needle);
    }

    const hits: SearchHit[] = [];
    const ring: string[] = [];
    /** Matches still collecting trailing context. */
    const pendingAfter: Array<{ hit: SearchHit; remaining: number }> = [];
    let lineNo = 0;
    let totalMatches = 0;

    const rl = createInterface({ input: createReadStream(row.path), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo++;

      for (let i = pendingAfter.length - 1; i >= 0; i--) {
        const entry = pendingAfter[i]!;
        entry.hit.after!.push(line);
        entry.remaining--;
        if (entry.remaining <= 0) pendingAfter.splice(i, 1);
      }

      if (test(line)) {
        totalMatches++;
        if (hits.length < maxMatches) {
          const hit: SearchHit = { line: lineNo, text: truncateLine(line) };
          if (contextLines > 0) {
            hit.before = ring.slice(-contextLines);
            hit.after = [];
            pendingAfter.push({ hit, remaining: contextLines });
          }
          hits.push(hit);
        }
      }

      if (contextLines > 0) {
        ring.push(line);
        if (ring.length > contextLines) ring.shift();
      }
      // Stop scanning once the cap is met and no context is still outstanding.
      if (hits.length >= maxMatches && pendingAfter.length === 0) break;
    }
    rl.close();

    return {
      artifact_id: handle,
      query: options.query,
      regex: options.isRegex === true,
      matches_returned: hits.length,
      matches_found_so_far: totalMatches,
      truncated: totalMatches > hits.length,
      lines_scanned: lineNo,
      matches: hits.map((h) => ({
        line: h.line,
        text: h.text,
        ...(h.before?.length ? { before: h.before.map(truncateLine) } : {}),
        ...(h.after?.length ? { after: h.after.map(truncateLine) } : {}),
      })),
    };
  }

  /** Run a JSONPath subset query against a JSON artifact. */
  jsonQuery(handle: string, path: string, limit = 50): Record<string, unknown> {
    const row = this.require(handle);
    if (row.size > 256 * 1024 * 1024) {
      throw new AgentBrowserError(
        'too_large',
        `Artifact is ${row.size} bytes; JSON queries are capped at 256MB. Use artifact.search instead.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(row.path, 'utf8'));
    } catch (err) {
      throw new AgentBrowserError('not_json', `Artifact is not valid JSON: ${(err as Error).message}`);
    }
    let matches: JsonMatch[];
    try {
      matches = jsonPath(parsed, path, limit);
    } catch (err) {
      throw new AgentBrowserError('bad_path', (err as Error).message);
    }
    return {
      artifact_id: handle,
      path,
      match_count: matches.length,
      matches: matches.map((m) => ({ path: m.path, value: m.value })),
    };
  }

  /** Copy an artifact to a caller-chosen destination. */
  exportTo(handle: string, destination: string): Record<string, unknown> {
    const row = this.require(handle);
    const dest = isAbsolute(destination) ? destination : resolve(process.cwd(), destination);
    // Treat a destination with no extension as a directory to drop the file in.
    const target = extname(dest) === '' ? join(dest, `${handle}${extname(row.path)}`) : dest;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(row.path, target);
    return { artifact_id: handle, exported_to: target, size: row.size };
  }
}

function truncateLine(line: string, max = 2000): string {
  return line.length > max ? `${line.slice(0, max)}… (${line.length} chars)` : line;
}

// Thin wrappers so the range read stays readable and all fd handling is in one place.
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';

function openSyncSafe(path: string): number {
  try {
    return openSync(path, 'r');
  } catch (err) {
    throw new AgentBrowserError('artifact_missing', `Artifact file is gone: ${path} (${(err as Error).message})`);
  }
}

function readSyncSafe(fd: number, buffer: Buffer, offset: number, length: number): number {
  return readSync(fd, buffer, 0, length, offset);
}

function closeSyncSafe(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* nothing useful to do */
  }
}

function createWriteStreamSync(path: string, data: Buffer): void {
  writeFileSync(path, data);
}

export function toArtifactRef(row: ArtifactRow): Record<string, unknown> {
  return {
    artifact_id: row.artifact_handle,
    path: row.path,
    size: row.size,
    mime: row.mime,
    kind: row.kind,
  };
}
