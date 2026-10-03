/**
 * Visit a list of URLs and extract from each, where one bad page cannot stall
 * the rest.
 *
 * Doing this one page.navigate at a time has three failure modes, and this
 * module exists for all three:
 *
 * A page that hangs takes the session with it. A script that never yields or
 * an evaluate whose promise never settles leaves every later command on that
 * tab queued behind it. Here every page runs against a hard deadline, and a
 * page that misses it gets its tab reset (page.reset_target), so the next URL
 * starts on a tab that answers.
 *
 * A long run outlives the client's request timeout. The run lives in the
 * daemon, not in the request: visit_batch waits up to wait_ms, returns what is
 * finished, and the rest keeps going. batch_status reads it at any point, so
 * nothing already visited is ever lost to a timeout.
 *
 * Results are per page. Each one says ok / error / timeout with its own
 * status, URL and timing, rather than one error for the whole call.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError, CdpError, NotFoundError, TimeoutError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import { createLogger } from '../util/logger.js';
import type { OpsContext, ToolRun } from './context.js';
import { capture, persist } from './document.js';
import { evaluate } from './element.js';
import { navigate, resetTarget, VISIBLE_TEXT_FN, waitForTarget } from './page.js';

const log = createLogger('ops:batch');

type Extract = 'text' | 'visible_text' | 'markdown' | 'none';

export interface BatchArgs {
  browser_id?: string;
  urls: string[];
  extract?: Extract;
  selector?: string;
  expression?: string;
  max_chars?: number;
  concurrency?: number;
  page_timeout_ms?: number;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'none';
  settle_ms?: number;
  delay_ms?: number;
  wait_ms?: number;
  save?: boolean;
  collection?: string;
  label?: string;
}

interface PageResult {
  index: number;
  url: string;
  status: 'ok' | 'error' | 'timeout' | 'cancelled';
  final_url?: string;
  title?: string | null;
  http_status?: number | null;
  text?: string;
  text_length?: number;
  truncated?: boolean;
  value?: unknown;
  value_error?: string;
  doc_id?: string;
  error?: string;
  ms: number;
  tab_reset?: string;
}

interface BatchRun {
  id: string;
  browserId: string;
  args: BatchArgs;
  status: 'running' | 'done' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  results: Array<PageResult | null>;
  done: number;
  controller: AbortController;
  finished: Promise<void>;
  artifactId: string | null;
  /** Set while a visit_batch call is waiting on this run, so it can report progress. */
  progress: ToolRun['progress'] | null;
}

/** Runs live in the daemon so they survive the request that started them. */
const RUNS = new Map<string, BatchRun>();
const KEEP_RUNS = 20;

function forget(): void {
  const finished = [...RUNS.values()].filter((r) => r.status !== 'running');
  for (const run of finished.slice(0, Math.max(0, RUNS.size - KEEP_RUNS))) RUNS.delete(run.id);
}

export function requireRun(batchId: string): BatchRun {
  const run = RUNS.get(batchId);
  if (!run) throw new NotFoundError('batch', `${batchId} (runs are kept in memory; a daemon restart forgets them, but finished runs are saved as an artifact)`);
  return run;
}

/** Everything a run has produced so far, as written to its artifact or a file. */
export function runPayload(run: BatchRun): Record<string, unknown> {
  return {
    batch_id: run.id,
    status: run.status,
    started_at: new Date(run.startedAt).toISOString(),
    finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    total: run.results.length,
    results: run.results.filter((r): r is PageResult => r !== null),
  };
}

/* ------------------------------- one page ---------------------------------- */

async function extractFrom(
  ctx: OpsContext,
  instance: BrowserInstance,
  target: ManagedTarget,
  run: BatchRun,
  result: PageResult,
): Promise<void> {
  const args = run.args;
  const extract = args.extract ?? 'text';
  const max = Math.min(Math.max(args.max_chars ?? 4_000, 0), 200_000);

  if (args.settle_ms) await delay(Math.min(args.settle_ms, 30_000));

  if (extract === 'markdown') {
    const captured = await capture(instance, target, {
      format: 'markdown',
      ...(args.selector ? { selector: args.selector } : {}),
    });
    result.title = captured.title;
    result.final_url = captured.url;
    result.text_length = captured.text.length;
    result.truncated = captured.text.length > max;
    result.text = captured.text.slice(0, max);
    if (args.save && captured.text.trim()) {
      const { row } = persist(ctx, captured, {
        browserId: instance.id,
        collection: args.collection,
        label: args.label,
        httpStatus: result.http_status ?? null,
      });
      result.doc_id = row.doc_handle;
    }
  } else if (extract !== 'none') {
    const root = args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : 'document.body';
    const body =
      extract === 'visible_text' ? `(${VISIBLE_TEXT_FN})(r)` : '(r.innerText || r.textContent || "")';
    const { result: value } = await evaluate(instance, target, {
      expression: `(function () { const r = ${root}; return r ? ${body} : null; })()`,
      returnByValue: true,
    });
    if (value.value === null && args.selector) {
      result.error = `selector matched nothing: ${args.selector}`;
    }
    const text = String(value.value ?? '');
    result.text_length = text.length;
    result.truncated = text.length > max;
    result.text = text.slice(0, max);
  }

  if (args.expression) {
    const { result: value, exceptionText } = await evaluate(instance, target, {
      expression: args.expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionText) result.value_error = exceptionText;
    else result.value = value.value;
  }

  if (result.title === undefined) {
    const { result: info } = await evaluate(instance, target, {
      expression: '[location.href, document.title]',
      returnByValue: true,
    });
    const [href, title] = (info.value ?? []) as [string?, string?];
    result.final_url = href ?? result.final_url;
    result.title = title ?? null;
  }
}

async function visitOne(
  ctx: OpsContext,
  instance: BrowserInstance,
  target: ManagedTarget,
  run: BatchRun,
  index: number,
): Promise<PageResult> {
  const url = run.args.urls[index]!;
  const result: PageResult = { index, url, status: 'ok', ms: 0 };
  const nav = (await navigate(ctx, {
    browser_id: instance.id,
    target_id: target.handle,
    url,
    wait_until: run.args.wait_until ?? 'load',
    timeout_ms: Math.min(run.args.page_timeout_ms ?? 45_000, 30_000),
  })) as Record<string, unknown>;
  result.final_url = nav.url as string;
  result.http_status = (nav.http_status as number | undefined) ?? null;
  if (nav.committed === false) {
    result.status = 'error';
    result.error = String(nav.error ?? 'no document committed');
    return result;
  }
  await extractFrom(ctx, instance, target, run, result);
  if (result.error) result.status = 'error';
  return result;
}

/* -------------------------------- workers ---------------------------------- */

async function openWorkerTab(instance: BrowserInstance): Promise<ManagedTarget> {
  const { targetId } = await instance.browserSession.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    background: true,
  });
  return waitForTarget(instance, targetId, 10_000);
}

async function worker(ctx: OpsContext, instance: BrowserInstance, run: BatchRun, queue: number[]): Promise<void> {
  const pageTimeout = Math.min(Math.max(run.args.page_timeout_ms ?? 45_000, 1_000), 600_000);
  const pause = Math.min(Math.max(run.args.delay_ms ?? 0, 0), 30_000);
  let tab: ManagedTarget | null = null;

  try {
    tab = await openWorkerTab(instance);
    while (queue.length > 0 && !run.controller.signal.aborted) {
      const index = queue.shift()!;
      const started = Date.now();
      let result: PageResult;
      let timer: NodeJS.Timeout | undefined;
      const work = visitOne(ctx, instance, tab, run, index);
      // The abandoned promise still settles later (reset fails its commands);
      // swallow that here so it is not reported as an unhandled rejection.
      work.catch(() => undefined);
      try {
        result = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(`page ${run.args.urls[index]}`, pageTimeout)), pageTimeout);
          }),
        ]);
      } catch (err) {
        const timedOut = err instanceof TimeoutError;
        result = {
          index,
          url: run.args.urls[index]!,
          status: timedOut ? 'timeout' : 'error',
          error: (err as Error).message,
          ms: 0,
        };
        // A timeout or a CDP failure can leave the tab wedged; make sure the
        // next URL starts on one that answers.
        if (timedOut || err instanceof CdpError) {
          try {
            const reset = await resetTarget(ctx, { browser_id: instance.id, target_id: tab.handle, mode: 'auto' });
            result.tab_reset = String(reset.mode);
            tab = instance.resolvePage(String(reset.target_id));
          } catch (resetErr) {
            log.warn(`reset of ${tab.handle} failed, opening a new tab`, resetErr);
            tab = await openWorkerTab(instance);
            result.tab_reset = 'new_tab';
          }
        }
      } finally {
        clearTimeout(timer);
      }
      result.ms = Date.now() - started;
      run.results[index] = result;
      run.done++;
      run.progress?.(run.done, run.results.length, `${result.status} ${result.url}`);
      if (pause > 0 && queue.length > 0) await delay(pause);
    }
  } finally {
    if (tab) {
      await instance.browserSession
        .send('Target.closeTarget', { targetId: tab.cdpTargetId }, 5_000)
        .catch(() => undefined);
    }
  }
}

async function execute(ctx: OpsContext, instance: BrowserInstance, run: BatchRun): Promise<void> {
  const queue = run.args.urls.map((_, i) => i);
  const workers = Math.min(Math.max(run.args.concurrency ?? 2, 1), 6, queue.length);
  const outcomes = await Promise.allSettled(
    Array.from({ length: workers }, () => worker(ctx, instance, run, queue)),
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') log.warn(`batch ${run.id} worker failed`, outcome.reason);
  }
  // Anything a dead worker or a cancel left behind is reported, not dropped.
  run.results.forEach((r, index) => {
    if (r) return;
    const failed = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined;
    run.results[index] = {
      index,
      url: run.args.urls[index]!,
      status: run.controller.signal.aborted ? 'cancelled' : 'error',
      ...(run.controller.signal.aborted ? {} : { error: failed ? String((failed.reason as Error)?.message ?? failed.reason) : 'not visited' }),
      ms: 0,
    };
  });
  run.status = run.controller.signal.aborted ? 'cancelled' : 'done';
  run.finishedAt = Date.now();
  const artifact = ctx.stores.artifacts.put('other', Buffer.from(JSON.stringify(runPayload(run), null, 2), 'utf8'), {
    browserId: run.browserId,
    label: run.args.label ?? `batch-${run.id}`,
    mime: 'application/json',
    sourceRef: run.id,
  });
  run.artifactId = artifact.artifact_handle;
  forget();
}

/* ---------------------------------- ops ------------------------------------ */

function view(ctx: OpsContext, run: BatchRun, opts: { include_text?: boolean; offset?: number; limit?: number }): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const r of run.results) if (r) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const ready = run.results.filter((r): r is PageResult => r !== null);
  const offset = Math.max(opts.offset ?? 0, 0);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const page = ready
    .slice(offset, offset + limit)
    .map((r) => (opts.include_text === false ? { ...r, text: undefined } : r));
  const remaining = run.results.length - run.done;
  return {
    batch_id: run.id,
    status: run.status,
    total: run.results.length,
    done: run.done,
    remaining,
    counts,
    elapsed_ms: (run.finishedAt ?? Date.now()) - run.startedAt,
    results: page,
    ...(ready.length > offset + limit ? { next_offset: offset + limit } : {}),
    ...(run.artifactId ? { artifact: toArtifactRef(ctx.stores.artifacts.require(run.artifactId)) } : {}),
    hint:
      run.status === 'running'
        ? `Still running in the daemon; nothing is lost if this call ends. Poll page.batch_status(batch_id:"${run.id}"), or cancel:true to stop it. Finished pages are already in results.`
        : `Write everything to disk with file.write(batch_id:"${run.id}", dir:..., filename:...).`,
  };
}

export async function visitBatch(ctx: OpsContext, args: BatchArgs, toolRun?: ToolRun): Promise<Record<string, unknown>> {
  if (args.urls.length === 0) throw new AgentBrowserError('bad_args', 'urls is empty.');
  if (args.urls.length > 500) throw new AgentBrowserError('bad_args', `At most 500 URLs per batch (got ${args.urls.length}).`);
  for (const url of args.urls) {
    try {
      new URL(url);
    } catch {
      throw new AgentBrowserError('bad_url', `Not an absolute URL: ${JSON.stringify(url)}.`);
    }
  }
  if (args.save && (args.extract ?? 'text') !== 'markdown') {
    throw new AgentBrowserError('bad_args', 'save:true stores pages as documents, which needs extract:"markdown".');
  }

  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('page.visit_batch');

  const run: BatchRun = {
    id: mintId('bat'),
    browserId: instance.id,
    args,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    results: args.urls.map(() => null),
    done: 0,
    controller: new AbortController(),
    finished: Promise.resolve(),
    artifactId: null,
    progress: null,
  };
  RUNS.set(run.id, run);
  run.finished = execute(ctx, instance, run).catch((err) => {
    log.warn(`batch ${run.id} failed`, err);
    run.status = run.controller.signal.aborted ? 'cancelled' : 'done';
    run.finishedAt = Date.now();
  });

  return waitOn(ctx, run, args.wait_ms ?? 60_000, toolRun, {});
}

/**
 * Wait for a run up to `waitMs`, reporting progress, then answer with what is
 * finished. The client cancelling its request stops the waiting, not the run.
 */
async function waitOn(
  ctx: OpsContext,
  run: BatchRun,
  waitMs: number,
  toolRun: ToolRun | undefined,
  opts: { include_text?: boolean; offset?: number; limit?: number },
): Promise<Record<string, unknown>> {
  const wait = Math.min(Math.max(waitMs, 0), 600_000);
  if (wait > 0 && run.status === 'running') {
    run.progress = toolRun?.progress ?? null;
    run.progress?.(run.done, run.results.length, 'started');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      run.finished,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait);
      }),
      new Promise<void>((resolve) => {
        onAbort = resolve;
        toolRun?.signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) toolRun?.signal?.removeEventListener('abort', onAbort);
    run.progress = null;
  }
  return view(ctx, run, opts);
}

export async function batchStatus(
  ctx: OpsContext,
  args: { batch_id?: string; cancel?: boolean; wait_ms?: number; include_text?: boolean; offset?: number; limit?: number },
  toolRun?: ToolRun,
): Promise<Record<string, unknown>> {
  if (!args.batch_id) {
    return {
      count: RUNS.size,
      batches: [...RUNS.values()].map((r) => ({
        batch_id: r.id,
        status: r.status,
        total: r.results.length,
        done: r.done,
        started_at: new Date(r.startedAt).toISOString(),
      })),
    };
  }
  const run = requireRun(args.batch_id);
  if (args.cancel && run.status === 'running') {
    run.controller.abort();
    // Pages in flight finish or time out; unstarted ones are marked cancelled.
    await run.finished;
  }
  return waitOn(ctx, run, args.wait_ms ?? 0, toolRun, args);
}
