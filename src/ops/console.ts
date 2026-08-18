import { toArtifactRef } from '../store/artifact-store.js';
import {
  toConsoleView,
  toExceptionView,
  type ConsoleFilter,
  type ConsoleRow,
  type ExceptionRow,
  type StackMode,
  type ViewOptions,
} from '../store/console-store.js';
import { parseSince, resolveBrowserScope, type OpsContext } from './context.js';

export interface ConsoleQueryArgs {
  browser_id?: string;
  target_id?: string;
  level?: string | string[];
  source?: string;
  search?: string;
  regex?: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
  fields?: string[];
  stack?: StackMode;
}

/**
 * Console is recorded continuously and never dropped on navigation, so the
 * query runs against SQLite rather than asking Chromium for anything.
 */
async function scope(ctx: OpsContext, args: ConsoleQueryArgs): Promise<ConsoleFilter> {
  // Recorded console survives the browser that produced it.
  const { browserId } = await resolveBrowserScope(ctx, args.browser_id);
  const filter: ConsoleFilter = { browserId };
  if (args.target_id) filter.targetHandle = args.target_id;
  if (args.source) filter.source = args.source;
  if (args.search) filter.search = args.search;
  if (args.regex) filter.regex = args.regex;
  const since = parseSince(args.since);
  if (since !== undefined) filter.since = since;
  const until = parseSince(args.until);
  if (until !== undefined) filter.until = until;
  if (args.limit !== undefined) filter.limit = args.limit;
  if (args.offset !== undefined) filter.offset = args.offset;
  if (args.order) filter.order = args.order;
  return filter;
}

/** Exports are read off disk, so they keep everything the recorder captured. */
const EXPORT_VIEW: ViewOptions = { stack: 'full', include_args: true };

/** Levels arrive as one value or a list; the store takes one at a time. */
function levelsOf(level: string | string[] | undefined): string[] {
  if (!level) return [];
  return Array.isArray(level) ? level : [level];
}

export async function query(
  ctx: OpsContext,
  args: ConsoleQueryArgs & { include_exceptions?: boolean },
): Promise<Record<string, unknown>> {
  const base = await scope(ctx, args);
  const levels = levelsOf(args.level);
  const view: ViewOptions = {
    ...(args.fields ? { fields: args.fields } : {}),
    ...(args.stack ? { stack: args.stack } : {}),
  };

  let rows: ConsoleRow[];
  let total: number;
  if (levels.length <= 1) {
    const filter = levels[0] ? { ...base, level: levels[0] } : base;
    rows = ctx.stores.console.listEntries(filter);
    total = ctx.stores.console.countEntries(filter);
  } else {
    // Multi-level asks are a union of single-level queries, re-sorted.
    const collected: ConsoleRow[] = [];
    total = 0;
    for (const level of levels) {
      const filter = { ...base, level };
      collected.push(...ctx.stores.console.listEntries(filter));
      total += ctx.stores.console.countEntries(filter);
    }
    const desc = base.order !== 'asc';
    collected.sort((a, b) => (desc ? b.ts - a.ts : a.ts - b.ts));
    rows = collected.slice(0, base.limit ?? 100);
  }

  const out: Record<string, unknown> = {
    browser_id: base.browserId,
    total_matching: total,
    returned: rows.length,
    offset: base.offset ?? 0,
    entries: rows.map((row) => toConsoleView(row, view)),
  };

  if (args.include_exceptions !== false) {
    const exceptions = ctx.stores.console.listExceptions(base);
    out.exceptions = exceptions.map((row) => toExceptionView(row, view));
    out.exception_count = exceptions.length;
  }
  if (total > rows.length) {
    out.hint = `Only ${rows.length} of ${total} shown. Narrow with level/search/since, or page with offset.`;
  }
  return out;
}

export async function exceptions(
  ctx: OpsContext,
  args: ConsoleQueryArgs,
): Promise<Record<string, unknown>> {
  const filter = await scope(ctx, args);
  const rows = ctx.stores.console.listExceptions(filter);
  const view: ViewOptions = {
    ...(args.fields ? { fields: args.fields } : {}),
    ...(args.stack ? { stack: args.stack } : {}),
  };
  return {
    browser_id: filter.browserId,
    count: rows.length,
    exceptions: rows.map((row) => toExceptionView(row, view)),
  };
}

/**
 * Dump a time slice to NDJSON on disk. This is the answer to "50k console
 * lines": the model gets a handle and a summary, not the lines.
 */
export async function exportLogs(
  ctx: OpsContext,
  args: ConsoleQueryArgs & { save_path?: string; include_exceptions?: boolean },
): Promise<Record<string, unknown>> {
  const base = await scope(ctx, args);
  const levels = levelsOf(args.level);
  // Exports ignore the display page size: the point is the whole window.
  const filter: ConsoleFilter = { ...base, limit: 100_000, offset: 0, order: 'asc' };

  const entries: ConsoleRow[] = [];
  if (levels.length === 0) {
    entries.push(...ctx.stores.console.listEntries(filter));
  } else {
    for (const level of levels) entries.push(...ctx.stores.console.listEntries({ ...filter, level }));
    entries.sort((a, b) => a.ts - b.ts);
  }

  const exceptionRows: ExceptionRow[] =
    args.include_exceptions === false ? [] : ctx.stores.console.listExceptions(filter);

  const artifact = await ctx.stores.artifacts.putStream(
    'console_export',
    {
      browserId: base.browserId ?? null,
      label: 'console',
      mime: 'application/x-ndjson',
      meta: { entry_count: entries.length, exception_count: exceptionRows.length },
    },
    (write) => {
      // The export goes to disk, not into context: keep full stacks and args.
      for (const row of entries) {
        write(`${JSON.stringify({ kind: 'console', ...toConsoleView(row, EXPORT_VIEW) })}\n`);
      }
      for (const row of exceptionRows) {
        write(`${JSON.stringify({ kind: 'exception', ...toExceptionView(row, EXPORT_VIEW) })}\n`);
      }
    },
  );

  const byLevel: Record<string, number> = {};
  for (const row of entries) byLevel[row.level] = (byLevel[row.level] ?? 0) + 1;

  const out: Record<string, unknown> = {
    browser_id: base.browserId,
    entry_count: entries.length,
    exception_count: exceptionRows.length,
    by_level: byLevel,
    artifact: toArtifactRef(artifact),
    hint: 'Slice it with artifact.read_lines or artifact.search instead of loading the file.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

export async function clear(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const deleted = ctx.stores.console.clear(instance.id, args.target_id);
  return { browser_id: instance.id, deleted };
}
