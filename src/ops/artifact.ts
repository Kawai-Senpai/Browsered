import { toArtifactRef } from '../store/artifact-store.js';
import type { OpsContext } from './context.js';

export async function stat(
  ctx: OpsContext,
  args: { artifact_id: string },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.stat(args.artifact_id);
}

export async function list(
  ctx: OpsContext,
  args: { browser_id?: string; kind?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const rows = ctx.stores.artifacts.list({
    ...(args.browser_id ? { browserId: args.browser_id } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  return {
    count: rows.length,
    artifacts: rows.map((row) => ({
      ...toArtifactRef(row),
      created_at: new Date(row.created_at).toISOString(),
      source: row.source_ref,
    })),
  };
}

export async function read(
  ctx: OpsContext,
  args: { artifact_id: string; offset?: number; length?: number; encoding?: 'utf8' | 'base64' },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.readRange(
    args.artifact_id,
    args.offset ?? 0,
    args.length ?? 64 * 1024,
    args.encoding ?? 'utf8',
  );
}

export async function readLines(
  ctx: OpsContext,
  args: { artifact_id: string; start?: number; end?: number },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.readLines(args.artifact_id, args.start ?? 1, args.end ?? 200);
}

export async function search(
  ctx: OpsContext,
  args: {
    artifact_id: string;
    query: string;
    is_regex?: boolean;
    ignore_case?: boolean;
    context_lines?: number;
    max_matches?: number;
  },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.search(args.artifact_id, {
    query: args.query,
    ...(args.is_regex === undefined ? {} : { isRegex: args.is_regex }),
    ...(args.ignore_case === undefined ? {} : { ignoreCase: args.ignore_case }),
    ...(args.context_lines === undefined ? {} : { contextLines: args.context_lines }),
    ...(args.max_matches === undefined ? {} : { maxMatches: args.max_matches }),
  });
}

export async function jsonQuery(
  ctx: OpsContext,
  args: { artifact_id: string; path: string; limit?: number },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.jsonQuery(args.artifact_id, args.path, args.limit ?? 50);
}

/** Copy an artifact to a caller-chosen path, for tooling outside the daemon. */
export async function exportTo(
  ctx: OpsContext,
  args: { artifact_id: string; path: string },
): Promise<Record<string, unknown>> {
  return ctx.stores.artifacts.exportTo(args.artifact_id, args.path);
}
