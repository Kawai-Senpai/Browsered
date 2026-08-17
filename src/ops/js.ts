import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import { renderRemoteObject } from '../util/remote-object.js';
import type { OpsContext } from './context.js';
import { evaluate, type EvaluateOptions } from './element.js';

export interface JsArgs {
  browser_id?: string;
  target_id?: string;
  frame_id?: string;
}

async function pageOf(ctx: OpsContext, args: JsArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolveTarget(args.target_id);
  return { instance, target };
}

/**
 * Runs an expression exactly as typing it into the DevTools console would,
 * command-line helpers ($, $$, $x, copy) included.
 */
export async function evaluateExpression(
  ctx: OpsContext,
  args: JsArgs & {
    expression: string;
    await_promise?: boolean;
    return_by_value?: boolean;
    command_line_api?: boolean;
    timeout_ms?: number;
    max_chars?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('js.evaluate');

  const options: EvaluateOptions = {
    expression: args.expression,
    awaitPromise: args.await_promise !== false,
    returnByValue: args.return_by_value !== false,
    includeCommandLineAPI: args.command_line_api !== false,
    timeoutMs: args.timeout_ms ?? 30_000,
  };
  if (args.frame_id) options.frameId = args.frame_id;

  const { result, exceptionText } = await evaluate(instance, target, options);

  if (exceptionText) {
    return {
      target_id: target.handle,
      ok: false,
      error: exceptionText,
      hint: 'The expression threw. The exception is also recorded in console.exceptions.',
    };
  }

  const rendered = renderRemoteObject(result);
  const max = Math.min(Math.max(args.max_chars ?? 40_000, 200), 400_000);

  let value: unknown = result.value;
  let truncated = false;
  let artifact: Record<string, unknown> | undefined;

  if (value !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      serialized = String(value);
    }
    if (serialized.length > max) {
      truncated = true;
      const stored = ctx.stores.artifacts.put('other', Buffer.from(serialized, 'utf8'), {
        browserId: instance.id,
        label: 'evaluate-result',
        mime: 'application/json',
        sourceRef: target.handle,
      });
      artifact = toArtifactRef(stored);
      value = `${serialized.slice(0, max)}\n… (${serialized.length} chars; full value in artifact)`;
    }
  }

  return {
    target_id: target.handle,
    ok: true,
    type: result.type,
    subtype: result.subtype ?? null,
    value,
    rendered,
    truncated,
    ...(artifact ? { artifact } : {}),
  };
}

interface ResourceEntry {
  frameId: string;
  url: string;
  type: string;
  mimeType: string;
  contentSize?: number;
}

async function listResources(target: ManagedTarget): Promise<ResourceEntry[]> {
  interface FrameResourceTree {
    frame: { id: string; url: string };
    resources: Array<{ url: string; type: string; mimeType: string; contentSize?: number }>;
    childFrames?: FrameResourceTree[];
  }
  const { frameTree } = await target.session.send<{ frameTree: FrameResourceTree }>(
    'Page.getResourceTree',
  );
  const out: ResourceEntry[] = [];
  const walk = (node: FrameResourceTree): void => {
    for (const resource of node.resources ?? []) {
      out.push({
        frameId: node.frame.id,
        url: resource.url,
        type: resource.type,
        mimeType: resource.mimeType,
        ...(resource.contentSize === undefined ? {} : { contentSize: resource.contentSize }),
      });
    }
    // The document itself is a resource of its own frame.
    out.push({ frameId: node.frame.id, url: node.frame.url, type: 'Document', mimeType: 'text/html' });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);

  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.frameId}|${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listScripts(
  ctx: OpsContext,
  args: JsArgs & { types?: string[]; url_contains?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const resources = await listResources(target);
  const wantTypes = new Set((args.types ?? ['Script', 'Document', 'Stylesheet']).map((t) => t.toLowerCase()));

  const filtered = resources.filter(
    (r) =>
      wantTypes.has(r.type.toLowerCase()) &&
      (!args.url_contains || r.url.includes(args.url_contains)),
  );

  // Scripts the debugger knows about but that are not page resources: eval'd
  // code, inline module blobs, extension scripts.
  const parsed = instance.parsedScripts.get(target.handle);
  const extra = parsed
    ? [...parsed.values()]
        .filter((s) => !filtered.some((r) => r.url === s.url))
        .filter((s) => !args.url_contains || s.url.includes(args.url_contains))
        .map((s) => ({
          url: s.url || '(inline/eval)',
          type: 'Script',
          source: 'debugger',
          script_id: s.scriptId,
          lines: s.endLine + 1,
        }))
    : [];

  return {
    target_id: target.handle,
    count: filtered.length + extra.length,
    debugger_enabled: instance.debuggerEnabled.has(target.handle),
    scripts: [
      ...filtered.map((r) => ({
        url: r.url,
        type: r.type,
        mime: r.mimeType,
        size: r.contentSize ?? null,
        frame_id: r.frameId,
        source: 'resource',
      })),
      ...extra,
    ],
    hint: 'Enable debugger.enable to also see eval\'d and inline scripts with script ids.',
  };
}

async function fetchSource(
  target: ManagedTarget,
  entry: { frameId?: string; url?: string; scriptId?: string },
): Promise<string> {
  if (entry.scriptId) {
    const { scriptSource } = await target.session.send<{ scriptSource: string }>(
      'Debugger.getScriptSource',
      { scriptId: entry.scriptId },
    );
    return scriptSource;
  }
  if (!entry.frameId || !entry.url) {
    throw new AgentBrowserError('bad_args', 'Provide url (with optional frame_id) or script_id.');
  }
  const { content, base64Encoded } = await target.session.send<{
    content: string;
    base64Encoded: boolean;
  }>('Page.getResourceContent', { frameId: entry.frameId, url: entry.url });
  return base64Encoded ? Buffer.from(content, 'base64').toString('utf8') : content;
}

export async function getSource(
  ctx: OpsContext,
  args: JsArgs & {
    url?: string;
    script_id?: string;
    line_start?: number;
    line_end?: number;
    save_path?: string;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);

  let frameId = args.frame_id;
  if (args.url && !frameId) {
    const resources = await listResources(target);
    frameId = resources.find((r) => r.url === args.url)?.frameId;
    if (!frameId) {
      const partial = resources.find((r) => r.url.includes(args.url!));
      if (!partial) {
        throw new AgentBrowserError(
          'not_found',
          `No loaded resource matching "${args.url}". Call js.list_scripts to see what is available.`,
        );
      }
      frameId = partial.frameId;
      args = { ...args, url: partial.url };
    }
  }

  const source = await fetchSource(target, {
    ...(frameId ? { frameId } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...(args.script_id ? { scriptId: args.script_id } : {}),
  });

  const artifact = ctx.stores.artifacts.put('script_source', Buffer.from(source, 'utf8'), {
    browserId: instance.id,
    label: (args.url ?? args.script_id ?? 'source').split('/').pop() ?? 'source',
    mime: 'application/javascript',
    ...(args.url ?? args.script_id ? { sourceRef: (args.url ?? args.script_id)! } : {}),
    meta: { url: args.url, script_id: args.script_id },
  });

  const lines = source.split('\n');
  const start = Math.max(args.line_start ?? 1, 1);
  const end = Math.min(args.line_end ?? Math.min(lines.length, start + 200), lines.length);
  const window = lines.slice(start - 1, end);

  const out: Record<string, unknown> = {
    target_id: target.handle,
    url: args.url ?? null,
    script_id: args.script_id ?? null,
    total_lines: lines.length,
    total_chars: source.length,
    line_start: start,
    line_end: end,
    source: window.map((line, i) => `${start + i}\t${line}`).join('\n'),
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/**
 * Grep every loaded script/document/stylesheet in the browser rather than
 * shipping bundles into a prompt. Returns file:line hits; the caller then pulls
 * only the ranges that matter.
 */
export async function searchSource(
  ctx: OpsContext,
  args: JsArgs & {
    query: string;
    is_regex?: boolean;
    ignore_case?: boolean;
    types?: string[];
    url_contains?: string;
    max_matches_per_file?: number;
    max_files?: number;
    context_lines?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  void instance;
  const resources = await listResources(target);
  const wantTypes = new Set((args.types ?? ['Script', 'Document', 'Stylesheet']).map((t) => t.toLowerCase()));
  const candidates = resources
    .filter((r) => wantTypes.has(r.type.toLowerCase()))
    .filter((r) => !args.url_contains || r.url.includes(args.url_contains))
    .slice(0, Math.min(Math.max(args.max_files ?? 60, 1), 300));

  let test: (line: string) => boolean;
  if (args.is_regex) {
    let re: RegExp;
    try {
      re = new RegExp(args.query, args.ignore_case ? 'i' : '');
    } catch (err) {
      throw new AgentBrowserError('bad_regex', `Invalid regex: ${(err as Error).message}`);
    }
    test = (line) => re.test(line);
  } else {
    const needle = args.ignore_case ? args.query.toLowerCase() : args.query;
    test = (line) => (args.ignore_case ? line.toLowerCase() : line).includes(needle);
  }

  const perFile = Math.min(Math.max(args.max_matches_per_file ?? 5, 1), 50);
  const contextLines = Math.min(Math.max(args.context_lines ?? 0, 0), 10);
  const files: Array<Record<string, unknown>> = [];
  let totalMatches = 0;
  let searched = 0;
  const failures: string[] = [];

  for (const resource of candidates) {
    let source: string;
    try {
      source = await fetchSource(target, { frameId: resource.frameId, url: resource.url });
    } catch {
      // Cross-origin or evicted resources are expected misses, not errors.
      failures.push(resource.url);
      continue;
    }
    searched++;
    const lines = source.split('\n');
    const hits: Array<Record<string, unknown>> = [];
    for (let i = 0; i < lines.length && hits.length < perFile; i++) {
      const line = lines[i]!;
      if (!test(line)) continue;
      totalMatches++;
      const hit: Record<string, unknown> = {
        line: i + 1,
        // Minified bundles are one enormous line; show the neighbourhood of the hit.
        text: line.length > 400 ? excerptAround(line, args.query, args.ignore_case) : line,
      };
      if (contextLines > 0) {
        hit.before = lines.slice(Math.max(0, i - contextLines), i);
        hit.after = lines.slice(i + 1, i + 1 + contextLines);
      }
      hits.push(hit);
    }
    if (hits.length) {
      files.push({
        url: resource.url,
        type: resource.type,
        frame_id: resource.frameId,
        total_lines: lines.length,
        matches: hits,
      });
    }
  }

  return {
    target_id: target.handle,
    query: args.query,
    files_searched: searched,
    files_with_matches: files.length,
    total_matches: totalMatches,
    unreadable_resources: failures.length,
    results: files,
    hint: 'Pull a window with js.get_source(url, line_start, line_end) instead of fetching the whole file.',
  };
}

function excerptAround(line: string, query: string, ignoreCase?: boolean): string {
  const haystack = ignoreCase ? line.toLowerCase() : line;
  const needle = ignoreCase ? query.toLowerCase() : query;
  const at = haystack.indexOf(needle);
  if (at < 0) return `${line.slice(0, 400)}… (${line.length} chars)`;
  const from = Math.max(0, at - 200);
  const to = Math.min(line.length, at + needle.length + 200);
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''} (col ${at + 1} of ${line.length})`;
}
