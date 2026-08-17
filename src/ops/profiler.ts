import { readFileSync } from 'node:fs';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError, NotFoundError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import type { OpsContext } from './context.js';

export interface ProfilerArgs {
  browser_id?: string;
  target_id?: string;
}

/**
 * Read an artifact fully for in-process JSON parsing.
 *
 * `artifact.readRange` deliberately caps a single read at 4MB so a tool call
 * can never blow up the daemon; profiles, traces and heap snapshots routinely
 * exceed that, and parsing a truncated prefix yields invalid JSON. Callers here
 * have already size-checked the row.
 */
function readWholeArtifact(ctx: OpsContext, handle: string): string {
  const row = ctx.stores.artifacts.require(handle);
  return readFileSync(row.path, 'utf8');
}

async function pageOf(ctx: OpsContext, args: ProfilerArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolveTarget(args.target_id);
  return { instance, target };
}

/* ------------------------------ CPU profile ------------------------------ */

interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export async function startCpu(
  ctx: OpsContext,
  args: ProfilerArgs & { sampling_interval_us?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('profiler.cpu.start');
  if (instance.cpuProfiling.has(target.handle)) {
    throw new AgentBrowserError('already_profiling', 'A CPU profile is already running on this target.');
  }
  await target.session.send('Profiler.enable');
  if (args.sampling_interval_us) {
    await target.session.send('Profiler.setSamplingInterval', { interval: args.sampling_interval_us });
  }
  await target.session.send('Profiler.start');
  instance.cpuProfiling.set(target.handle, Date.now());
  return {
    target_id: target.handle,
    started: true,
    sampling_interval_us: args.sampling_interval_us ?? 1000,
    hint: 'Reproduce the slow interaction now, then call profiler.cpu.stop.',
  };
}

export async function stopCpu(
  ctx: OpsContext,
  args: ProfilerArgs & { save_path?: string; top?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('profiler.cpu.stop');
  const startedAt = instance.cpuProfiling.get(target.handle);
  if (startedAt === undefined) {
    throw new AgentBrowserError('not_profiling', 'No CPU profile is running on this target.');
  }
  const { profile } = await target.session.send<{ profile: CpuProfile }>('Profiler.stop');
  instance.cpuProfiling.delete(target.handle);

  const artifact = ctx.stores.artifacts.put('cpu_profile', Buffer.from(JSON.stringify(profile), 'utf8'), {
    browserId: instance.id,
    label: 'cpu',
    mime: 'application/json',
    sourceRef: target.handle,
    meta: { url: target.info.url, started_at: startedAt },
  });

  const summary = summarizeCpuProfile(profile, Math.min(Math.max(args.top ?? 12, 1), 50));
  const out: Record<string, unknown> = {
    target_id: target.handle,
    duration_ms: Math.round((profile.endTime - profile.startTime) / 1000),
    ...summary,
    artifact: toArtifactRef(artifact),
    hint: 'Open the .cpuprofile artifact in DevTools, or drill in with profiler.cpu.top_functions.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/**
 * Fold the sample tree into self-time per function. This is the number the
 * model actually needs; the full node graph stays in the artifact.
 */
function summarizeCpuProfile(profile: CpuProfile, top: number): Record<string, unknown> {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfTime = new Map<number, number>();
  const totalDelta = (profile.timeDeltas ?? []).reduce((a, b) => a + b, 0);

  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i]!;
      selfTime.set(nodeId, (selfTime.get(nodeId) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
  } else {
    // No sample stream: fall back to hit counts scaled by the sampling interval.
    for (const node of profile.nodes) selfTime.set(node.id, (node.hitCount ?? 0) * 1000);
  }

  const byFunction = new Map<string, { us: number; url: string; line: number; name: string }>();
  for (const [nodeId, us] of selfTime) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const frame = node.callFrame;
    const name = frame.functionName || '(anonymous)';
    const key = `${name}@${frame.url}:${frame.lineNumber}`;
    const existing = byFunction.get(key);
    if (existing) existing.us += us;
    else byFunction.set(key, { us, url: frame.url, line: frame.lineNumber + 1, name });
  }

  const ranked = [...byFunction.values()].sort((a, b) => b.us - a.us).slice(0, top);
  const totalUs = totalDelta || [...selfTime.values()].reduce((a, b) => a + b, 0) || 1;

  return {
    sample_count: profile.samples?.length ?? 0,
    top_functions: ranked.map((f) => ({
      function: f.name,
      self_time_ms: Number((f.us / 1000).toFixed(1)),
      percent: Number(((f.us / totalUs) * 100).toFixed(1)),
      location: f.url ? `${f.url}:${f.line}` : '(native)',
    })),
  };
}

export async function analyzeCpuProfile(
  ctx: OpsContext,
  args: { artifact_id: string; top?: number },
): Promise<Record<string, unknown>> {
  const row = ctx.stores.artifacts.require(args.artifact_id);
  if (row.kind !== 'cpu_profile') {
    throw new AgentBrowserError('wrong_kind', `Artifact ${args.artifact_id} is a ${row.kind}, not a cpu_profile.`);
  }
  const profile = JSON.parse(readWholeArtifact(ctx, args.artifact_id)) as CpuProfile;
  return {
    artifact_id: args.artifact_id,
    duration_ms: Math.round((profile.endTime - profile.startTime) / 1000),
    ...summarizeCpuProfile(profile, Math.min(Math.max(args.top ?? 20, 1), 100)),
  };
}

/* ------------------------------- coverage -------------------------------- */

export async function startCoverage(
  ctx: OpsContext,
  args: ProfilerArgs & { detailed?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('profiler.coverage.start');
  await target.session.send('Profiler.enable');
  await target.session.send('Profiler.startPreciseCoverage', {
    callCount: args.detailed === true,
    detailed: args.detailed !== false,
  });
  return { target_id: target.handle, started: true, hint: 'Exercise the page, then call profiler.coverage.stop.' };
}

export async function stopCoverage(
  ctx: OpsContext,
  args: ProfilerArgs & { save_path?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('profiler.coverage.stop');
  const { result } = await target.session.send<{
    result: Array<{
      scriptId: string;
      url: string;
      functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
    }>;
  }>('Profiler.takePreciseCoverage');
  await target.session.trySend('Profiler.stopPreciseCoverage');

  const perScript = result
    .filter((script) => script.url)
    .map((script) => {
      let used = 0;
      let total = 0;
      for (const fn of script.functions) {
        for (const range of fn.ranges) {
          const size = range.endOffset - range.startOffset;
          // The outermost range of each function spans the whole body.
          if (range === fn.ranges[0]) total += size;
          if (range.count > 0) used += size;
        }
      }
      return {
        url: script.url,
        total_bytes: total,
        used_bytes: Math.min(used, total),
        unused_bytes: Math.max(total - used, 0),
        percent_used: total ? Number(((Math.min(used, total) / total) * 100).toFixed(1)) : null,
      };
    })
    .sort((a, b) => b.unused_bytes - a.unused_bytes);

  const artifact = ctx.stores.artifacts.put('coverage', Buffer.from(JSON.stringify(result), 'utf8'), {
    browserId: instance.id,
    label: 'coverage',
    mime: 'application/json',
    sourceRef: target.handle,
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    script_count: perScript.length,
    total_bytes: perScript.reduce((a, s) => a + s.total_bytes, 0),
    unused_bytes: perScript.reduce((a, s) => a + s.unused_bytes, 0),
    worst_offenders: perScript.slice(0, 15),
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/* --------------------------------- heap ---------------------------------- */

/**
 * Heap snapshots arrive as a stream of chunks, so they are written straight to
 * an artifact. A large page can produce hundreds of megabytes here.
 */
export async function heapSnapshot(
  ctx: OpsContext,
  args: ProfilerArgs & { label?: string; save_path?: string; collect_garbage?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('memory.heap.snapshot');
  await target.session.send('HeapProfiler.enable');
  if (args.collect_garbage !== false) {
    await target.session.trySend('HeapProfiler.collectGarbage');
  }

  const chunks: string[] = [];
  const off = target.session.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
    chunks.push((params as { chunk: string }).chunk);
  });

  try {
    await target.session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 300_000);
  } finally {
    off();
  }

  const text = chunks.join('');
  const artifact = ctx.stores.artifacts.put('heap_snapshot', Buffer.from(text, 'utf8'), {
    browserId: instance.id,
    label: args.label ?? 'heap',
    mime: 'application/json',
    sourceRef: target.handle,
    meta: { url: target.info.url, label: args.label ?? null },
  });

  const summary = summarizeHeap(text);
  const out: Record<string, unknown> = {
    target_id: target.handle,
    label: args.label ?? null,
    ...summary,
    artifact: toArtifactRef(artifact),
    hint: 'Load the .heapsnapshot in DevTools Memory, or diff two of them with memory.heap.compare.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/** Read the node/edge counts out of the snapshot header without parsing it all. */
function summarizeHeap(text: string): Record<string, unknown> {
  try {
    const metaEnd = text.indexOf('"nodes"');
    const header = JSON.parse(`${text.slice(0, metaEnd > 0 ? metaEnd : 2000).replace(/,\s*$/, '')}}`) as {
      snapshot?: { node_count?: number; edge_count?: number };
    };
    return {
      node_count: header.snapshot?.node_count ?? null,
      edge_count: header.snapshot?.edge_count ?? null,
      snapshot_bytes: text.length,
    };
  } catch {
    return { snapshot_bytes: text.length };
  }
}

/**
 * Diff two heap snapshots by constructor. Parses only the node table and the
 * string table, never the full edge graph, so a pair of 300MB snapshots stays
 * tractable.
 */
export async function compareHeap(
  ctx: OpsContext,
  args: { before_artifact_id: string; after_artifact_id: string; top?: number },
): Promise<Record<string, unknown>> {
  const load = (handle: string): { counts: Map<string, { count: number; size: number }>; total: number } => {
    const row = ctx.stores.artifacts.require(handle);
    if (row.kind !== 'heap_snapshot') {
      throw new AgentBrowserError('wrong_kind', `Artifact ${handle} is a ${row.kind}, not a heap_snapshot.`);
    }
    if (row.size > 512 * 1024 * 1024) {
      throw new AgentBrowserError('too_large', `Snapshot ${handle} is ${row.size} bytes; comparison is capped at 512MB.`);
    }
    const parsed = JSON.parse(readWholeArtifact(ctx, handle)) as {
      snapshot: { meta: { node_fields: string[] } };
      nodes: number[];
      strings: string[];
    };

    const fields = parsed.snapshot.meta.node_fields;
    const stride = fields.length;
    const nameIndex = fields.indexOf('name');
    const sizeIndex = fields.indexOf('self_size');
    const counts = new Map<string, { count: number; size: number }>();
    let total = 0;

    for (let i = 0; i + stride <= parsed.nodes.length; i += stride) {
      const name = parsed.strings[parsed.nodes[i + nameIndex]!] ?? '(unknown)';
      const size = parsed.nodes[i + sizeIndex] ?? 0;
      total += size;
      const bucket = counts.get(name) ?? { count: 0, size: 0 };
      bucket.count++;
      bucket.size += size;
      counts.set(name, bucket);
    }
    return { counts, total };
  };

  const before = load(args.before_artifact_id);
  const after = load(args.after_artifact_id);

  const deltas: Array<{ constructor: string; count_delta: number; size_delta: number; after_count: number }> = [];
  for (const [name, afterBucket] of after.counts) {
    const beforeBucket = before.counts.get(name) ?? { count: 0, size: 0 };
    const countDelta = afterBucket.count - beforeBucket.count;
    const sizeDelta = afterBucket.size - beforeBucket.size;
    if (countDelta !== 0 || sizeDelta !== 0) {
      deltas.push({ constructor: name, count_delta: countDelta, size_delta: sizeDelta, after_count: afterBucket.count });
    }
  }
  deltas.sort((a, b) => b.size_delta - a.size_delta);

  const top = Math.min(Math.max(args.top ?? 20, 1), 100);
  const detached = deltas.filter((d) => d.constructor.startsWith('Detached'));

  return {
    before: args.before_artifact_id,
    after: args.after_artifact_id,
    total_size_before: before.total,
    total_size_after: after.total,
    size_delta: after.total - before.total,
    growth: deltas.filter((d) => d.size_delta > 0).slice(0, top),
    shrinkage: deltas.filter((d) => d.size_delta < 0).slice(-top).reverse(),
    detached_dom: detached,
    verdict:
      after.total > before.total * 1.1
        ? `Heap grew by ${Math.round((after.total - before.total) / 1024)}KB. Look at the top growth constructors${detached.length ? ' and the detached DOM nodes' : ''}.`
        : 'No significant heap growth between the two snapshots.',
  };
}

export async function collectGarbage(
  ctx: OpsContext,
  args: ProfilerArgs,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('memory.gc');
  await target.session.trySend('HeapProfiler.enable');
  await target.session.send('HeapProfiler.collectGarbage');
  return { target_id: target.handle, collected: true };
}

export async function heapUsage(ctx: OpsContext, args: ProfilerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  void instance;
  await target.session.trySend('Runtime.enable');
  const usage = await target.session.send<{ usedSize: number; totalSize: number }>('Runtime.getHeapUsage');
  // Chromium returns named fields here, not a {name,value} array.
  const counters = await target.session
    .send<{ documents?: number; nodes?: number; jsEventListeners?: number }>('Memory.getDOMCounters')
    .catch(() => null);
  return {
    target_id: target.handle,
    js_heap_used_bytes: usage.usedSize,
    js_heap_total_bytes: usage.totalSize,
    dom_counters: counters
      ? { documents: counters.documents ?? null, nodes: counters.nodes ?? null, event_listeners: counters.jsEventListeners ?? null }
      : null,
  };
}

/* -------------------------------- tracing -------------------------------- */

const TRACE_PRESETS: Record<string, string[]> = {
  'web-performance': [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'blink.user_timing',
    'loading',
    'latencyInfo',
  ],
  minimal: ['devtools.timeline'],
  javascript: ['devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-v8.cpu_profiler'],
  rendering: ['devtools.timeline', 'blink', 'cc', 'gpu', 'viz'],
};

export async function startTrace(
  ctx: OpsContext,
  args: ProfilerArgs & { preset?: string; categories?: string[] },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('profiler.trace.start');
  if (instance.tracing) {
    throw new AgentBrowserError('already_tracing', 'A trace is already recording on this browser.');
  }

  const preset = args.preset ?? 'web-performance';
  const categories = args.categories ?? TRACE_PRESETS[preset];
  if (!categories) {
    throw new AgentBrowserError(
      'unknown_preset',
      `Unknown trace preset "${preset}". Available: ${Object.keys(TRACE_PRESETS).join(', ')}.`,
    );
  }

  // Tracing is browser-wide, so it runs on the root session, not a page.
  await instance.browserSession.send('Tracing.start', {
    traceConfig: { includedCategories: categories, recordMode: 'recordUntilFull' },
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
  });
  instance.tracing = { startedAt: Date.now(), preset, categories };

  return {
    browser_id: instance.id,
    started: true,
    preset,
    category_count: categories.length,
    hint: 'Reproduce the problem, then call profiler.trace.stop. Keep traces short: they grow fast.',
  };
}

export async function stopTrace(
  ctx: OpsContext,
  args: ProfilerArgs & { save_path?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('profiler.trace.stop');
  const session = instance.tracing;
  if (!session) throw new AgentBrowserError('not_tracing', 'No trace is recording on this browser.');

  // Tracing.tracingComplete carries the stream handle; wait for it before reading.
  const streamHandle = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new AgentBrowserError('trace_timeout', 'Chromium did not finish the trace within 120s.'));
    }, 120_000);
    const off = instance.browserSession.on('Tracing.tracingComplete', (params) => {
      clearTimeout(timer);
      off();
      const stream = (params as { stream?: string }).stream;
      if (!stream) reject(new AgentBrowserError('no_trace_stream', 'Chromium returned no trace stream.'));
      else resolve(stream);
    });
    void instance.browserSession.send('Tracing.end').catch((err) => {
      clearTimeout(timer);
      off();
      reject(err);
    });
  });

  let eventCount = 0;
  const artifact = await ctx.stores.artifacts.putStream(
    'trace',
    {
      browserId: instance.id,
      label: 'trace',
      mime: 'application/json',
      meta: { preset: session.preset, categories: session.categories },
    },
    async (write) => {
      // Read the IO stream in bounded chunks so a large trace never lands in memory.
      for (;;) {
        const chunk = await instance.browserSession.send<{
          data: string;
          base64Encoded?: boolean;
          eof: boolean;
        }>('IO.read', { handle: streamHandle, size: 1024 * 1024 }, 60_000);
        const buffer = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'utf8');
        eventCount += countOccurrences(buffer.toString('utf8'), '"ph":');
        write(buffer);
        if (chunk.eof) break;
      }
      await instance.browserSession.trySend('IO.close', { handle: streamHandle });
    },
  );

  instance.tracing = null;
  const durationMs = Date.now() - session.startedAt;

  const out: Record<string, unknown> = {
    browser_id: instance.id,
    preset: session.preset,
    recording_duration_ms: durationMs,
    approx_event_count: eventCount,
    artifact: toArtifactRef(artifact),
    hint: 'Load the trace in chrome://tracing or the DevTools Performance panel, or run profiler.trace.long_tasks on it.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Pull the long tasks out of a recorded trace. This answers "what hung the main
 * thread" without the model ever loading the trace.
 */
export async function longTasks(
  ctx: OpsContext,
  args: { artifact_id: string; min_duration_ms?: number; limit?: number },
): Promise<Record<string, unknown>> {
  const row = ctx.stores.artifacts.require(args.artifact_id);
  if (row.kind !== 'trace') {
    throw new AgentBrowserError('wrong_kind', `Artifact ${args.artifact_id} is a ${row.kind}, not a trace.`);
  }
  if (row.size > 512 * 1024 * 1024) {
    throw new AgentBrowserError('too_large', 'Traces over 512MB are not analyzable in-process.');
  }

  const parsed = JSON.parse(readWholeArtifact(ctx, args.artifact_id));
  const events: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);

  const minMs = args.min_duration_ms ?? 50;
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);

  const tasks = events
    .filter((e) => {
      const name = String(e.name ?? '');
      // 'X' is a complete event; dur is in microseconds.
      return e.ph === 'X' && typeof e.dur === 'number' && (name === 'RunTask' || name === 'FunctionCall' || name === 'EvaluateScript' || name === 'V8.Execute');
    })
    .map((e) => ({
      name: String(e.name),
      duration_ms: Number(((e.dur as number) / 1000).toFixed(1)),
      start_ms: Number((((e.ts as number) ?? 0) / 1000).toFixed(1)),
      detail: (e.args as { data?: { functionName?: string; url?: string; lineNumber?: number } })?.data ?? null,
    }))
    .filter((t) => t.duration_ms >= minMs)
    .sort((a, b) => b.duration_ms - a.duration_ms);

  const totalBlocked = tasks.reduce((a, t) => a + Math.max(t.duration_ms - 50, 0), 0);

  return {
    artifact_id: args.artifact_id,
    total_events: events.length,
    long_task_count: tasks.length,
    total_blocking_time_ms: Number(totalBlocked.toFixed(1)),
    longest_task_ms: tasks[0]?.duration_ms ?? 0,
    tasks: tasks.slice(0, limit),
    verdict: tasks.length
      ? `${tasks.length} tasks over ${minMs}ms. The longest ran ${tasks[0]!.duration_ms}ms; anything above ~50ms is a visible jank frame.`
      : `No task exceeded ${minMs}ms. The main thread was not the bottleneck.`,
  };
}

/* ------------------------------- metrics --------------------------------- */

export async function metrics(ctx: OpsContext, args: ProfilerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  void instance;
  await target.session.trySend('Performance.enable');
  const { metrics: raw } = await target.session.send<{ metrics: Array<{ name: string; value: number }> }>(
    'Performance.getMetrics',
  );
  const byName = Object.fromEntries(raw.map((m) => [m.name, m.value]));

  return {
    target_id: target.handle,
    js_heap_used_bytes: byName.JSHeapUsedSize ?? null,
    js_heap_total_bytes: byName.JSHeapTotalSize ?? null,
    documents: byName.Documents ?? null,
    dom_nodes: byName.Nodes ?? null,
    event_listeners: byName.JSEventListeners ?? null,
    layout_count: byName.LayoutCount ?? null,
    recalc_style_count: byName.RecalcStyleCount ?? null,
    layout_duration_ms: byName.LayoutDuration === undefined ? null : Math.round(byName.LayoutDuration * 1000),
    recalc_style_duration_ms:
      byName.RecalcStyleDuration === undefined ? null : Math.round(byName.RecalcStyleDuration * 1000),
    script_duration_ms: byName.ScriptDuration === undefined ? null : Math.round(byName.ScriptDuration * 1000),
    task_duration_ms: byName.TaskDuration === undefined ? null : Math.round(byName.TaskDuration * 1000),
    all: byName,
  };
}

export async function processInfo(ctx: OpsContext, args: ProfilerArgs): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const info = await instance.browserSession
    .send<{ processInfo: Array<{ type: string; id: number; cpuTime: number }> }>('SystemInfo.getProcessInfo')
    .catch(() => null);
  if (!info) {
    throw new AgentBrowserError('unsupported', 'This Chromium does not expose SystemInfo.getProcessInfo.');
  }
  return {
    browser_id: instance.id,
    browser_pid: instance.pid,
    process_count: info.processInfo.length,
    processes: info.processInfo
      .map((p) => ({ type: p.type, pid: p.id, cpu_time_seconds: Number(p.cpuTime.toFixed(2)) }))
      .sort((a, b) => b.cpu_time_seconds - a.cpu_time_seconds),
  };
}

/* ------------------------------ debug bundle ----------------------------- */

const BUNDLE_PRESETS: Record<string, { description: string; cpu: boolean; trace: string | null; heap: boolean }> = {
  cpu: { description: 'CPU sampling profile only.', cpu: true, trace: null, heap: false },
  'slow-page': { description: 'CPU profile plus a web-performance trace.', cpu: true, trace: 'web-performance', heap: false },
  hang: { description: 'Trace and CPU profile, for a frozen main thread.', cpu: true, trace: 'web-performance', heap: false },
  'memory-leak': { description: 'Heap snapshots either side of the repro.', cpu: false, trace: null, heap: true },
  full: { description: 'Everything: CPU, trace and heap.', cpu: true, trace: 'web-performance', heap: true },
};

/**
 * Preset-driven profiling: one call arms every recorder that matters for the
 * named problem, so the model does not have to know Chrome's trace categories.
 */
export async function startProfile(
  ctx: OpsContext,
  args: ProfilerArgs & { preset?: string },
): Promise<Record<string, unknown>> {
  const name = args.preset ?? 'slow-page';
  const preset = BUNDLE_PRESETS[name];
  if (!preset) {
    throw new AgentBrowserError(
      'unknown_preset',
      `Unknown profile preset "${name}". Available: ${Object.keys(BUNDLE_PRESETS).join(', ')}.`,
    );
  }
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('profile.start');
  if (instance.profileSession) {
    throw new AgentBrowserError('already_profiling', `Profile ${instance.profileSession.id} is already running.`);
  }

  const id = mintId('prof');
  const started: string[] = [];
  const before: string[] = [];

  if (preset.heap) {
    const snapshot = await heapSnapshot(ctx, { ...args, label: `${id}-before` });
    before.push(String((snapshot.artifact as Record<string, unknown>).artifact_id));
    started.push('heap snapshot (before)');
  }
  if (preset.cpu) {
    await startCpu(ctx, args);
    started.push('cpu profile');
  }
  if (preset.trace) {
    await startTrace(ctx, { ...args, preset: preset.trace });
    started.push(`trace (${preset.trace})`);
  }

  instance.profileSession = {
    id,
    preset: name,
    startedAt: Date.now(),
    targetHandle: target.handle,
    cpu: preset.cpu,
    trace: preset.trace !== null,
    heap: preset.heap,
    beforeArtifacts: before,
  };

  return {
    browser_id: instance.id,
    profile_id: id,
    preset: name,
    description: preset.description,
    recording: started,
    note: 'Network and console recording were already running; they will be included in the bundle.',
    hint: 'Reproduce the problem now, then call profile.stop.',
  };
}

export async function stopProfile(
  ctx: OpsContext,
  args: ProfilerArgs & { save_path?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('profile.stop');
  const session = instance.profileSession;
  if (!session) throw new AgentBrowserError('not_profiling', 'No profile session is running.');
  instance.profileSession = null;

  const targetArgs = { ...args, target_id: session.targetHandle };
  const artifacts: Record<string, unknown> = {};
  const summary: Record<string, unknown> = {};

  if (session.cpu) {
    const cpu = await stopCpu(ctx, targetArgs);
    artifacts.cpu_profile = cpu.artifact;
    summary.top_functions = cpu.top_functions;
    summary.cpu_duration_ms = cpu.duration_ms;
  }
  if (session.trace) {
    const trace = await stopTrace(ctx, args);
    artifacts.trace = trace.artifact;
    const tasks = await longTasks(ctx, {
      artifact_id: String((trace.artifact as Record<string, unknown>).artifact_id),
    }).catch(() => null);
    if (tasks) {
      summary.long_task_count = tasks.long_task_count;
      summary.longest_task_ms = tasks.longest_task_ms;
      summary.total_blocking_time_ms = tasks.total_blocking_time_ms;
    }
  }
  if (session.heap) {
    const after = await heapSnapshot(ctx, { ...targetArgs, label: `${session.id}-after` });
    artifacts.heap_after = after.artifact;
    const beforeId = session.beforeArtifacts[0];
    if (beforeId) {
      artifacts.heap_before = { artifact_id: beforeId };
      const diff = await compareHeap(ctx, {
        before_artifact_id: beforeId,
        after_artifact_id: String((after.artifact as Record<string, unknown>).artifact_id),
      }).catch(() => null);
      if (diff) {
        summary.heap_size_delta = diff.size_delta;
        summary.heap_verdict = diff.verdict;
        summary.detached_dom = diff.detached_dom;
      }
    }
  }

  // Everything the recorders captured during the window, without re-asking Chrome.
  const since = session.startedAt;
  const requests = ctx.stores.network.list({ browserId: instance.id, since, limit: 5000 });
  const failures = requests.filter((r) => r.error_text || (r.status !== null && r.status >= 400));
  const errors = ctx.stores.console.listEntries({ browserId: instance.id, since, level: 'error', limit: 500 });
  const exceptions = ctx.stores.console.listExceptions({ browserId: instance.id, since, limit: 500 });

  const manifest = {
    profile_id: session.id,
    preset: session.preset,
    started_at: new Date(session.startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - session.startedAt,
    artifacts,
    summary,
    network: { total: requests.length, failed: failures.length },
    console: { errors: errors.length, exceptions: exceptions.length },
  };

  const bundle = ctx.stores.artifacts.put('debug_bundle', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), {
    browserId: instance.id,
    label: session.preset,
    mime: 'application/json',
    meta: { profile_id: session.id },
  });

  const out: Record<string, unknown> = {
    browser_id: instance.id,
    profile_id: session.id,
    preset: session.preset,
    duration_ms: manifest.duration_ms,
    ...summary,
    network_requests: requests.length,
    network_failures: failures.length,
    console_errors: errors.length,
    exceptions: exceptions.length,
    artifacts,
    manifest: toArtifactRef(bundle),
    hint: 'Drill in with profiler.cpu.analyze, profiler.trace.long_tasks, network.summarize or console.query.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(bundle.artifact_handle, args.save_path);
  }
  return out;
}

export async function profileStatus(ctx: OpsContext, args: ProfilerArgs): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const session = instance.profileSession;
  return {
    browser_id: instance.id,
    profiling: session !== null,
    ...(session
      ? {
          profile_id: session.id,
          preset: session.preset,
          running_for_ms: Date.now() - session.startedAt,
          recording: {
            cpu: session.cpu,
            trace: session.trace,
            heap: session.heap,
          },
        }
      : {}),
    cpu_profiles_running: [...instance.cpuProfiling.keys()],
    tracing: instance.tracing !== null,
  };
}

export function requireArtifact(ctx: OpsContext, handle: string): void {
  if (!ctx.stores.artifacts.get(handle)) throw new NotFoundError('artifact', handle);
}
