import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { evaluate } from './element.js';

export interface TimeArgs {
  browser_id?: string;
  target_id?: string;
}

/**
 * Clock control without Playwright.
 *
 * The daemon speaks raw CDP, so there is no `BrowserContext.clock` to lean on.
 * Instead a fake-timer shim is installed with `Page.addScriptToEvaluateOnNewDocument`
 * so it is present before any page script runs, and the same shim is injected
 * into the live document so an already-loaded page can be controlled without a
 * reload. Semantics deliberately mirror Playwright's Clock API:
 *
 *   run(d)    advance and fire every timer that comes due, in order
 *   jump(d)   leap forward, firing each due timer at most once
 *   freeze()  pin the clock and stop timer progression until resumed
 *   fixed()   pin Date only, leaving real timers running
 *
 * One clock per target, owned by the daemon, so two tools cannot stack two
 * independent fake clocks on one page.
 */
const CLOCK_SHIM = String.raw`
(() => {
  if (globalThis.__browserdClock) return;

  const realNow = Date.now.bind(Date);
  const RealDate = Date;
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const realClearInterval = globalThis.clearInterval.bind(globalThis);
  const realRAF = globalThis.requestAnimationFrame
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : null;
  const realPerfNow = globalThis.performance
    ? globalThis.performance.now.bind(globalThis.performance)
    : realNow;

  const state = {
    installed: false,
    // Fake wall time in ms. Timers are scheduled against this.
    now: realNow(),
    // When paused, fake time only moves when run/jump is called.
    paused: false,
    // fixedDate pins Date.now() without touching the timer queue.
    fixedDate: null,
    origin: realNow(),
    lastRealSync: realNow(),
    seq: 1,
    timers: new Map(),
    firedCount: 0,
  };

  const nowFn = () => {
    if (state.fixedDate !== null) return state.fixedDate;
    if (!state.installed) return realNow();
    if (!state.paused) {
      // Free-running fake clock: track real elapsed time from the last sync.
      const real = realNow();
      state.now += real - state.lastRealSync;
      state.lastRealSync = real;
    }
    return state.now;
  };

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowFn());
      else super(...args);
    }
    static now() {
      return nowFn();
    }
  }
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;

  const schedule = (fn, delay, args, repeat) => {
    const id = state.seq++;
    state.timers.set(id, {
      id,
      fn,
      args,
      // Timers due at or before the current fake instant still queue one tick
      // out, matching minimum-delay behaviour rather than firing inline.
      due: nowFn() + Math.max(Number(delay) || 0, 0),
      interval: repeat ? Math.max(Number(delay) || 0, 1) : null,
    });
    return id;
  };

  const fireDue = (until, oncePerTimer) => {
    let fired = 0;
    const alreadyFired = new Set();
    // Bounded so a self-rescheduling timer cannot spin forever.
    for (let guard = 0; guard < 100000; guard++) {
      let next = null;
      for (const timer of state.timers.values()) {
        if (timer.due > until) continue;
        if (oncePerTimer && alreadyFired.has(timer.id)) continue;
        if (next === null || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) {
          next = timer;
        }
      }
      if (next === null) break;

      state.now = Math.max(state.now, next.due);
      alreadyFired.add(next.id);
      if (next.interval === null) state.timers.delete(next.id);
      else next.due = next.due + next.interval;

      fired++;
      state.firedCount++;
      try {
        if (typeof next.fn === 'function') next.fn.apply(globalThis, next.args || []);
        else if (typeof next.fn === 'string') (0, eval)(next.fn);
      } catch (err) {
        // A throwing timer must not abort the rest of the queue, exactly as
        // an uncaught timer error would not in a real event loop.
        try { console.error(err); } catch (_) {}
      }
    }
    state.now = Math.max(state.now, until);
    return fired;
  };

  const api = {
    install(atMs) {
      if (!state.installed) {
        globalThis.Date = FakeDate;
        globalThis.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
        globalThis.clearTimeout = (id) => { state.timers.delete(id); };
        globalThis.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
        globalThis.clearInterval = (id) => { state.timers.delete(id); };
        if (realRAF) {
          globalThis.requestAnimationFrame = (fn) => schedule(() => fn(nowFn() - state.origin), 16, [], false);
          globalThis.cancelAnimationFrame = (id) => { state.timers.delete(id); };
        }
        if (globalThis.performance) {
          try {
            Object.defineProperty(globalThis.performance, 'now', {
              configurable: true,
              value: () => nowFn() - state.origin,
            });
          } catch (_) {}
        }
        state.installed = true;
      }
      if (typeof atMs === 'number') state.now = atMs;
      state.origin = state.now;
      state.lastRealSync = realNow();
      state.paused = false;
      return api.status();
    },
    freeze(atMs) {
      if (!state.installed) api.install(typeof atMs === 'number' ? atMs : undefined);
      if (typeof atMs === 'number') state.now = atMs;
      state.paused = true;
      return api.status();
    },
    resume() {
      state.paused = false;
      state.lastRealSync = realNow();
      return api.status();
    },
    run(ms) {
      if (!state.installed) api.install();
      const fired = fireDue(nowFn() + ms, false);
      return Object.assign(api.status(), { timers_fired: fired });
    },
    jump(ms) {
      if (!state.installed) api.install();
      const fired = fireDue(nowFn() + ms, true);
      return Object.assign(api.status(), { timers_fired: fired });
    },
    setFixedDate(atMs) {
      state.fixedDate = atMs;
      return api.status();
    },
    clearFixedDate() {
      state.fixedDate = null;
      return api.status();
    },
    setSystemTime(atMs) {
      if (!state.installed) api.install(atMs);
      else state.now = atMs;
      return api.status();
    },
    uninstall() {
      if (state.installed) {
        globalThis.Date = RealDate;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        if (realRAF) globalThis.requestAnimationFrame = realRAF;
        if (globalThis.performance) {
          try {
            Object.defineProperty(globalThis.performance, 'now', {
              configurable: true,
              value: realPerfNow,
            });
          } catch (_) {}
        }
      }
      state.installed = false;
      state.paused = false;
      state.fixedDate = null;
      state.timers.clear();
      return api.status();
    },
    status() {
      return {
        installed: state.installed,
        paused: state.paused,
        fake_time: new RealDate(nowFn()).toISOString(),
        fake_time_ms: nowFn(),
        real_time: new RealDate(realNow()).toISOString(),
        skew_ms: nowFn() - realNow(),
        fixed_date: state.fixedDate === null ? null : new RealDate(state.fixedDate).toISOString(),
        pending_timers: state.timers.size,
        timers_fired_total: state.firedCount,
      };
    },
  };

  globalThis.__browserdClock = api;
})();
`;

/** "5m", "90s", "2h", "1d", "250ms", or a plain number of milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) {
    throw new AgentBrowserError('bad_duration', `Cannot parse duration "${value}". Use forms like "5m", "90s", "1500ms".`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor =
    unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * factor;
}

function parseInstant(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new AgentBrowserError('bad_time', `Cannot parse time "${value}". Use an ISO 8601 timestamp.`);
  }
  return parsed;
}

async function pageOf(ctx: OpsContext, args: TimeArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

/**
 * Install the shim on the live document and arm it for future documents, so a
 * navigation does not silently drop the controlled clock.
 */
async function ensureShim(
  ctx: OpsContext,
  args: TimeArgs,
): Promise<{ instance: Awaited<ReturnType<typeof pageOf>>['instance']; target: Awaited<ReturnType<typeof pageOf>>['target'] }> {
  const { instance, target } = await pageOf(ctx, args);
  if (!instance.clockShimTargets.has(target.handle)) {
    await target.session.trySend('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    instance.clockShimTargets.add(target.handle);
  }
  const { exceptionText } = await evaluate(instance, target, {
    expression: CLOCK_SHIM,
    returnByValue: true,
  });
  if (exceptionText) throw new AgentBrowserError('clock_install_failed', exceptionText);
  return { instance, target };
}

async function callClock(
  ctx: OpsContext,
  args: TimeArgs,
  operation: string,
  expression: string,
  mutating = true,
): Promise<Record<string, unknown>> {
  const { instance, target } = await ensureShim(ctx, args);
  if (mutating) instance.requireControl(operation);
  const { result, exceptionText } = await evaluate(instance, target, {
    expression,
    returnByValue: true,
  });
  if (exceptionText) throw new AgentBrowserError('clock_failed', exceptionText);
  return { target_id: target.handle, ...(result.value as Record<string, unknown>) };
}

export async function status(ctx: OpsContext, args: TimeArgs): Promise<Record<string, unknown>> {
  return {
    ...(await callClock(ctx, args, 'time.status', '__browserdClock.status()', false)),
    hint:
      'skew_ms is how far the page clock is ahead of real time. Use time.run to fire timers, time.jump to skip them.',
  };
}

export async function install(
  ctx: OpsContext,
  args: TimeArgs & { time?: string | number },
): Promise<Record<string, unknown>> {
  const at = parseInstant(args.time);
  return callClock(
    ctx,
    args,
    'time.install',
    `__browserdClock.install(${at === undefined ? 'undefined' : at})`,
  );
}

export async function freeze(
  ctx: OpsContext,
  args: TimeArgs & { at?: string | number },
): Promise<Record<string, unknown>> {
  const at = parseInstant(args.at);
  return callClock(ctx, args, 'time.freeze', `__browserdClock.freeze(${at === undefined ? 'undefined' : at})`);
}

export async function resume(ctx: OpsContext, args: TimeArgs): Promise<Record<string, unknown>> {
  return callClock(ctx, args, 'time.resume', '__browserdClock.resume()');
}

/** Advance and fire every timer that comes due, in order. */
export async function run(
  ctx: OpsContext,
  args: TimeArgs & { duration: string | number },
): Promise<Record<string, unknown>> {
  const ms = parseDuration(args.duration);
  const out = await callClock(ctx, args, 'time.run', `__browserdClock.run(${ms})`);
  return { ...out, advanced_ms: ms, mode: 'run (all due timers fired in order)' };
}

/** Leap forward, firing each due timer at most once: the "closed laptop" case. */
export async function jump(
  ctx: OpsContext,
  args: TimeArgs & { duration: string | number },
): Promise<Record<string, unknown>> {
  const ms = parseDuration(args.duration);
  const out = await callClock(ctx, args, 'time.jump', `__browserdClock.jump(${ms})`);
  return { ...out, advanced_ms: ms, mode: 'jump (each due timer fired at most once)' };
}

/** Pin Date only. Timers, animations and polling keep running normally. */
export async function setFixedDate(
  ctx: OpsContext,
  args: TimeArgs & { time: string | number },
): Promise<Record<string, unknown>> {
  const at = parseInstant(args.time)!;
  return callClock(ctx, args, 'time.set_fixed_date', `__browserdClock.setFixedDate(${at})`);
}

export async function clearFixedDate(ctx: OpsContext, args: TimeArgs): Promise<Record<string, unknown>> {
  return callClock(ctx, args, 'time.clear_fixed_date', '__browserdClock.clearFixedDate()');
}

/** Move perceived wall time without firing timers to get there. */
export async function setWallClock(
  ctx: OpsContext,
  args: TimeArgs & { time: string | number },
): Promise<Record<string, unknown>> {
  const at = parseInstant(args.time)!;
  return callClock(ctx, args, 'time.set_wall_clock', `__browserdClock.setSystemTime(${at})`);
}

export async function uninstall(ctx: OpsContext, args: TimeArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('time.uninstall');
  instance.clockShimTargets.delete(target.handle);
  const { result, exceptionText } = await evaluate(instance, target, {
    // Safe if the shim was never installed or was lost to a navigation.
    expression: `globalThis.__browserdClock ? __browserdClock.uninstall() : { installed: false }`,
    returnByValue: true,
  });
  if (exceptionText) throw new AgentBrowserError('clock_failed', exceptionText);
  return {
    target_id: target.handle,
    ...(result.value as Record<string, unknown>),
    note: 'New documents will no longer get the fake clock. Reload for a fully pristine timer stack.',
  };
}

/**
 * Chromium's own virtual-time system. Stronger than the shim (it also governs
 * loading and rendering) but it is experimental and cannot coexist with the
 * shim, so the daemon refuses to run both on one target.
 */
export async function virtualTime(
  ctx: OpsContext,
  args: TimeArgs & {
    policy?: 'advance' | 'pause' | 'pauseIfNetworkFetchesPending';
    budget_ms?: number;
    initial_time?: string | number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('time.virtual');
  if (instance.clockShimTargets.has(target.handle)) {
    throw new AgentBrowserError(
      'clock_conflict',
      'The fake-timer clock is installed on this target. Call time.uninstall before using CDP virtual time; layering both produces nonsense.',
    );
  }
  const initial = parseInstant(args.initial_time);
  const response = await target.session.send<{ virtualTimeTicksBase?: number }>(
    'Emulation.setVirtualTimePolicy',
    {
      policy: args.policy ?? 'pauseIfNetworkFetchesPending',
      ...(args.budget_ms === undefined ? {} : { budget: args.budget_ms }),
      ...(initial === undefined ? {} : { initialVirtualTime: initial / 1000 }),
    },
  );
  return {
    target_id: target.handle,
    mode: 'cdp_virtual',
    policy: args.policy ?? 'pauseIfNetworkFetchesPending',
    budget_ms: args.budget_ms ?? null,
    virtual_time_ticks_base: response.virtualTimeTicksBase ?? null,
    hint: 'Chromium emits virtualTimeBudgetExpired when the budget runs out; call again to grant more.',
  };
}
