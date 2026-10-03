import { readFileSync } from 'node:fs';
import { AgentBrowserError } from '../util/errors.js';
import { safeWriteFile, splitPath, type OnConflict } from '../util/safe-file.js';
import { requireRun, runPayload } from './batch.js';
import type { OpsContext } from './context.js';

/**
 * Write content to a file on the daemon host in one call: text, JSON, an
 * artifact or a batch run's results. Exactly one source.
 */
export async function write(
  ctx: OpsContext,
  args: {
    path?: string;
    dir?: string;
    filename?: string;
    content?: string;
    encoding?: 'utf8' | 'base64';
    json?: unknown;
    artifact_id?: string;
    batch_id?: string;
    on_conflict?: OnConflict;
  },
): Promise<Record<string, unknown>> {
  const sources = [args.content !== undefined, args.json !== undefined, !!args.artifact_id, !!args.batch_id].filter(Boolean);
  if (sources.length !== 1) {
    throw new AgentBrowserError('bad_args', 'Pass exactly one of content, json, artifact_id or batch_id.');
  }

  let dir: string;
  let filename: string;
  if (args.path) {
    if (args.dir || args.filename) throw new AgentBrowserError('bad_args', 'Pass either path, or dir with filename - not both.');
    ({ dir, filename } = splitPath(args.path));
  } else if (args.dir && args.filename) {
    dir = args.dir;
    filename = args.filename;
  } else {
    throw new AgentBrowserError('bad_args', 'Pass path, or dir with filename.');
  }

  let data: Buffer;
  let source: string;
  if (args.content !== undefined) {
    data = Buffer.from(args.content, args.encoding ?? 'utf8');
    source = 'content';
  } else if (args.json !== undefined) {
    data = Buffer.from(`${JSON.stringify(args.json, null, 2)}\n`, 'utf8');
    source = 'json';
  } else if (args.artifact_id) {
    data = readFileSync(ctx.stores.artifacts.require(args.artifact_id).path);
    source = args.artifact_id;
  } else {
    const run = requireRun(args.batch_id!);
    data = Buffer.from(`${JSON.stringify(runPayload(run), null, 2)}\n`, 'utf8');
    source = run.status === 'running' ? `${run.id} (partial: still running)` : run.id;
  }

  return { ...safeWriteFile(dir, filename, data, args.on_conflict ?? 'rename'), source };
}
