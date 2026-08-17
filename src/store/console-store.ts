import { mintId } from '../util/ids.js';
import { j, unj, type Db } from './db.js';

export interface ConsoleRow {
  log_handle: string;
  browser_id: string;
  target_handle: string | null;
  source: string;
  level: string;
  text: string | null;
  args: string | null;
  url: string | null;
  line_number: number | null;
  column_number: number | null;
  stack: string | null;
  network_request: string | null;
  ts: number;
}

export interface ExceptionRow {
  exception_handle: string;
  browser_id: string;
  target_handle: string | null;
  text: string;
  description: string | null;
  url: string | null;
  line_number: number | null;
  column_number: number | null;
  stack: string | null;
  ts: number;
}

export interface ConsoleFilter {
  browserId?: string;
  targetHandle?: string;
  level?: string;
  source?: string;
  search?: string;
  regex?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/**
 * Console output and uncaught exceptions, kept past navigation. DevTools
 * discards these on reload unless "preserve log" is on; the recorder never
 * discards them, so an agent can inspect what happened before a redirect.
 */
export class ConsoleStore {
  constructor(private readonly db: Db) {}

  addEntry(entry: {
    browserId: string;
    targetHandle: string | null;
    source: string;
    level: string;
    text: string | null;
    args?: unknown;
    url?: string | null;
    lineNumber?: number | null;
    columnNumber?: number | null;
    stack?: unknown;
    networkRequest?: string | null;
    ts: number;
  }): string {
    const handle = mintId('log');
    this.db
      .prepare(
        `INSERT INTO console_entries (
           log_handle, browser_id, target_handle, source, level, text, args, url,
           line_number, column_number, stack, network_request, ts
         ) VALUES (
           @handle, @browserId, @targetHandle, @source, @level, @text, @args, @url,
           @lineNumber, @columnNumber, @stack, @networkRequest, @ts
         )`,
      )
      .run({
        handle,
        browserId: entry.browserId,
        targetHandle: entry.targetHandle,
        source: entry.source,
        level: entry.level,
        text: entry.text,
        args: j(entry.args),
        url: entry.url ?? null,
        lineNumber: entry.lineNumber ?? null,
        columnNumber: entry.columnNumber ?? null,
        stack: j(entry.stack),
        networkRequest: entry.networkRequest ?? null,
        ts: entry.ts,
      });
    return handle;
  }

  addException(entry: {
    browserId: string;
    targetHandle: string | null;
    text: string;
    description?: string | null;
    url?: string | null;
    lineNumber?: number | null;
    columnNumber?: number | null;
    stack?: unknown;
    ts: number;
  }): string {
    const handle = mintId('exc');
    this.db
      .prepare(
        `INSERT INTO exceptions (
           exception_handle, browser_id, target_handle, text, description, url,
           line_number, column_number, stack, ts
         ) VALUES (
           @handle, @browserId, @targetHandle, @text, @description, @url,
           @lineNumber, @columnNumber, @stack, @ts
         )`,
      )
      .run({
        handle,
        browserId: entry.browserId,
        targetHandle: entry.targetHandle,
        text: entry.text,
        description: entry.description ?? null,
        url: entry.url ?? null,
        lineNumber: entry.lineNumber ?? null,
        columnNumber: entry.columnNumber ?? null,
        stack: j(entry.stack),
        ts: entry.ts,
      });
    return handle;
  }

  private buildWhere(
    filter: ConsoleFilter,
    textColumn: string,
  ): { clause: string; params: Record<string, unknown> } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.browserId) {
      where.push('browser_id = @browserId');
      params.browserId = filter.browserId;
    }
    if (filter.targetHandle) {
      where.push('target_handle = @targetHandle');
      params.targetHandle = filter.targetHandle;
    }
    if (filter.level) {
      where.push('level = @level');
      params.level = filter.level;
    }
    if (filter.source) {
      where.push('source = @source');
      params.source = filter.source;
    }
    if (filter.search) {
      where.push(`${textColumn} LIKE @search`);
      params.search = `%${filter.search}%`;
    }
    if (filter.regex) {
      where.push(`regexp(@regex, ${textColumn}) = 1`);
      params.regex = filter.regex;
    }
    if (filter.since !== undefined) {
      where.push('ts >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push('ts <= @until');
      params.until = filter.until;
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  listEntries(filter: ConsoleFilter): ConsoleRow[] {
    const { clause, params } = this.buildWhere(filter, 'text');
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    params.limit = Math.min(Math.max(filter.limit ?? 100, 1), 2000);
    params.offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(
        `SELECT * FROM console_entries ${clause} ORDER BY ts ${order}, rowid ${order} LIMIT @limit OFFSET @offset`,
      )
      .all(params) as ConsoleRow[];
  }

  countEntries(filter: ConsoleFilter): number {
    const { clause, params } = this.buildWhere(filter, 'text');
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM console_entries ${clause}`).get(params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  listExceptions(filter: ConsoleFilter): ExceptionRow[] {
    // Exceptions carry no level/source columns; drop those predicates.
    const { level, source, ...rest } = filter;
    void level;
    void source;
    const { clause, params } = this.buildWhere(rest, 'text');
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    params.limit = Math.min(Math.max(filter.limit ?? 100, 1), 2000);
    params.offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(
        `SELECT * FROM exceptions ${clause} ORDER BY ts ${order}, rowid ${order} LIMIT @limit OFFSET @offset`,
      )
      .all(params) as ExceptionRow[];
  }

  clear(browserId: string, targetHandle?: string): number {
    if (targetHandle) {
      const a = this.db
        .prepare(`DELETE FROM console_entries WHERE browser_id = ? AND target_handle = ?`)
        .run(browserId, targetHandle);
      const c = this.db
        .prepare(`DELETE FROM exceptions WHERE browser_id = ? AND target_handle = ?`)
        .run(browserId, targetHandle);
      return a.changes + c.changes;
    }
    const a = this.db.prepare(`DELETE FROM console_entries WHERE browser_id = ?`).run(browserId);
    const c = this.db.prepare(`DELETE FROM exceptions WHERE browser_id = ?`).run(browserId);
    return a.changes + c.changes;
  }
}

export function toConsoleView(row: ConsoleRow): Record<string, unknown> {
  return {
    log_id: row.log_handle,
    target_id: row.target_handle,
    source: row.source,
    level: row.level,
    text: row.text,
    args: unj(row.args),
    url: row.url,
    line: row.line_number,
    column: row.column_number,
    stack: unj(row.stack),
    network_request_id: row.network_request,
    at: new Date(row.ts).toISOString(),
  };
}

export function toExceptionView(row: ExceptionRow): Record<string, unknown> {
  return {
    exception_id: row.exception_handle,
    target_id: row.target_handle,
    text: row.text,
    description: row.description,
    url: row.url,
    line: row.line_number,
    column: row.column_number,
    stack: unj(row.stack),
    at: new Date(row.ts).toISOString(),
  };
}
