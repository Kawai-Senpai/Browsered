import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import type { CdpSession } from '../cdp/session.js';
import type { AXNode, FrameTree } from '../cdp/types.js';
import { AgentBrowserError, NotFoundError, TimeoutError } from '../util/errors.js';
import { toArtifactRef } from '../store/artifact-store.js';
import type { OpsContext } from './context.js';
import {
  boundingBox,
  contentCenter,
  evaluate,
  resolveElement,
  type ElementLocator,
  type ResolvedElement,
} from './element.js';
import { modifiersFromNames, parseChord, resolveKey } from './keys.js';

export interface PageArgs extends ElementLocator {
  browser_id?: string;
  target_id?: string;
}

async function pageOf(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string },
): Promise<{ instance: BrowserInstance; target: ManagedTarget }> {
  const instance = await ctx.registry.resolve(args.browser_id);
  // Page tools open a tab when none exists, so an agent is never blocked by the
  // human having closed the last window.
  const target = await instance.resolvePageOrOpen(args.target_id);
  return { instance, target };
}

// ---------------------------------------------------------------- tabs

export async function listTabs(
  ctx: OpsContext,
  args: { browser_id?: string; include_all_targets?: boolean },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const targets = args.include_all_targets ? instance.targets.list() : instance.targets.listPages();
  const active = await currentActiveTarget(instance);
  return {
    browser_id: instance.id,
    count: targets.length,
    tabs: targets.map((t) => ({
      target_id: t.handle,
      type: t.type,
      url: t.info.url,
      title: t.info.title,
      active: t.handle === active,
      parent_target_id: t.parentHandle,
      cdp_target_id: t.cdpTargetId,
    })),
  };
}

/**
 * Chromium does not report focus directly; the visible page is the best proxy.
 *
 * `document.hasFocus()` is false whenever the OS window is not focused, which
 * is the normal case for an automated browser. Requiring it made every tab
 * report active:false - including the only tab, which cannot be right - so
 * visibility decides, and focus only breaks ties between visible pages.
 */
async function currentActiveTarget(instance: BrowserInstance): Promise<string | null> {
  const pages = instance.targets.listPages();
  const visible: string[] = [];

  for (const target of pages) {
    try {
      const { result } = await evaluate(instance, target, {
        expression: '[document.visibilityState === "visible", document.hasFocus()]',
        returnByValue: true,
        awaitPromise: false,
      });
      const [isVisible, hasFocus] = (result.value ?? []) as [boolean?, boolean?];
      if (isVisible === true && hasFocus === true) return target.handle;
      if (isVisible === true) visible.push(target.handle);
    } catch {
      /* target may be navigating */
    }
  }

  if (visible.length > 0) return visible[0]!;
  // Nothing reported visible (all backgrounded, or every probe failed): with a
  // single page there is still an unambiguous answer.
  return pages.length === 1 ? pages[0]!.handle : null;
}

export async function newTab(
  ctx: OpsContext,
  args: { browser_id?: string; url?: string; background?: boolean },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('page.new_tab');
  const { targetId } = await instance.browserSession.send<{ targetId: string }>(
    'Target.createTarget',
    { url: args.url ?? 'about:blank', background: args.background === true },
  );
  // Auto-attach delivers the session asynchronously; wait for it to land so the
  // caller gets a usable target_id back rather than a race.
  const target = await waitForTarget(instance, targetId, 10_000);
  return {
    browser_id: instance.id,
    target_id: target.handle,
    url: target.info.url,
    cdp_target_id: targetId,
  };
}

export async function waitForTarget(
  instance: BrowserInstance,
  cdpTargetId: string,
  timeoutMs: number,
): Promise<ManagedTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = instance.targets.getByCdpTargetId(cdpTargetId);
    if (found) return found;
    await delay(25);
  }
  throw new TimeoutError(`attach to target ${cdpTargetId}`, timeoutMs);
}

export async function activateTab(ctx: OpsContext, args: PageArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.activate');
  await instance.browserSession.send('Target.activateTarget', { targetId: target.cdpTargetId });
  return { target_id: target.handle, activated: true, url: target.info.url };
}

export async function closeTab(ctx: OpsContext, args: PageArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.close');
  await instance.browserSession.send('Target.closeTarget', { targetId: target.cdpTargetId });
  return { target_id: target.handle, closed: true };
}

/** Does the renderer answer at all? Any reply counts, including an exception. */
async function responsive(target: ManagedTarget, timeoutMs: number): Promise<boolean> {
  try {
    const reply = await target.session.send<{ exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      timeoutMs,
    );
    // A terminateExecution with nothing running is held for the next script,
    // which is this probe. Probe once more so the caller's next evaluate is
    // not the one that gets terminated.
    if (reply.exceptionDetails) {
      await target.session.send('Runtime.evaluate', { expression: '1', returnByValue: true }, timeoutMs);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Unstick one tab without closing Chromium.
 *
 * A page whose script never yields, or an evaluate whose promise never
 * settles, leaves every later command on that tab queued behind it. "soft"
 * fails the in-flight commands locally, terminates the running script, stops
 * the load and parks the tab on about:blank (or `url`). "recreate" replaces
 * the tab with a fresh one. "auto" (default) tries soft and escalates only if
 * the renderer still does not answer.
 */
export async function resetTarget(
  ctx: OpsContext,
  args: PageArgs & { mode?: 'auto' | 'soft' | 'recreate'; url?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('page.reset_target');
  const target = instance.resolvePage(args.target_id);
  const mode = args.mode ?? 'auto';
  const parkAt = args.url ?? 'about:blank';
  const steps: string[] = [];

  const cancelled = target.session.cancelPending('cancelled by page.reset_target');
  if (cancelled) steps.push(`failed ${cancelled} in-flight command(s)`);

  if (mode !== 'recreate') {
    const attempt = async (method: string, params: Record<string, unknown> = {}): Promise<void> => {
      try {
        await target.session.send(method, params, 3_000);
        steps.push(method);
      } catch (err) {
        steps.push(`${method} failed: ${(err as Error).message}`);
      }
    };
    await attempt('Runtime.terminateExecution');
    await attempt('Page.stopLoading');
    await attempt('Page.navigate', { url: parkAt });
    if (await responsive(target, 3_000)) {
      return { target_id: target.handle, mode: 'soft', responsive: true, url: parkAt, steps };
    }
    steps.push('renderer still unresponsive');
    if (mode === 'soft') {
      return {
        target_id: target.handle,
        mode: 'soft',
        responsive: false,
        steps,
        hint: 'Call again with mode:"recreate" to replace the tab.',
      };
    }
  }

  const { targetId } = await instance.browserSession.send<{ targetId: string }>(
    'Target.createTarget',
    { url: parkAt, background: true },
  );
  const fresh = await waitForTarget(instance, targetId, 10_000);
  steps.push(`opened ${fresh.handle}`);
  try {
    await instance.browserSession.send('Target.closeTarget', { targetId: target.cdpTargetId }, 5_000);
    steps.push(`closed ${target.handle}`);
  } catch (err) {
    steps.push(`closing ${target.handle} failed: ${(err as Error).message}`);
  }
  return {
    target_id: fresh.handle,
    replaced_target_id: target.handle,
    mode: 'recreate',
    responsive: await responsive(fresh, 5_000),
    url: parkAt,
    steps,
    hint: `The old target_id is gone; use ${fresh.handle} from now on.`,
  };
}

// ---------------------------------------------------------------- navigation

/**
 * Wait for a page lifecycle milestone. `networkIdle` is Chromium's own signal,
 * which is more trustworthy than counting in-flight requests ourselves.
 */
async function waitForLifecycle(
  session: CdpSession,
  event: 'load' | 'DOMContentLoaded' | 'networkIdle' | 'firstMeaningfulPaint',
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = session.on('Page.lifecycleEvent', (params) => {
      if ((params as { name: string }).name === event) {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
}

export async function navigate(
  ctx: OpsContext,
  args: PageArgs & { url: string; wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'none'; timeout_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.navigate');
  const timeout = args.timeout_ms ?? 30_000;
  const waitUntil = args.wait_until ?? 'load';

  const lifecycle =
    waitUntil === 'none'
      ? null
      : waitForLifecycle(
          target.session,
          waitUntil === 'domcontentloaded'
            ? 'DOMContentLoaded'
            : waitUntil === 'networkidle'
              ? 'networkIdle'
              : 'load',
          timeout,
        );

  const result = await target.session.send<{ frameId: string; loaderId?: string; errorText?: string }>(
    'Page.navigate',
    { url: args.url },
    timeout,
  );
  const settled = lifecycle ? await lifecycle : null;

  const current = await currentUrl(instance, target);
  const landed = await documentIdentity(instance, target);

  /*
   * The committed document title is the cheapest identity check there is, and
   * the one that catches "this port is serving a different project" - a dev
   * server collision between sibling repos is an extremely common setup.
   */
  const status = documentStatus(ctx, instance.id, target.handle, current);
  const committed = result.errorText ? false : current !== 'about:blank';

  return {
    target_id: target.handle,
    requested_url: args.url,
    url: current,
    title: landed.title,
    ...(status === null ? {} : { http_status: status }),
    committed,
    frame_id: result.frameId,
    error: result.errorText ?? null,
    wait_until: waitUntil,
    settled: settled === null ? undefined : settled,
    ...(settled === false
      ? {
          reason: committed
            ? `${waitUntil} was not reached within ${timeout}ms; the document did commit and is at ${current}.`
            : `${waitUntil} was not reached within ${timeout}ms and no document committed.`,
        }
      : {}),
  };
}

/** Committed URL and title of the document actually on screen. */
async function documentIdentity(
  instance: BrowserInstance,
  target: ManagedTarget,
): Promise<{ url: string; title: string | null }> {
  try {
    const { result } = await evaluate(instance, target, {
      expression: '[location.href, document.title]',
      returnByValue: true,
      awaitPromise: false,
    });
    const [url, title] = (result.value ?? []) as [string?, string?];
    return { url: url ?? target.info.url, title: title ?? null };
  } catch {
    return { url: target.info.url, title: target.info.title ?? null };
  }
}

/** The status of the main-frame document request, from the recorder. */
function documentStatus(
  ctx: OpsContext,
  browserId: string,
  targetHandle: string,
  url: string,
): number | null {
  try {
    const rows = ctx.stores.network.list({
      browserId,
      targetHandle,
      resourceType: 'Document',
      limit: 10,
      order: 'desc',
    });
    const match = rows.find((row) => row.url === url) ?? rows[0];
    return match?.status ?? null;
  } catch {
    return null;
  }
}

async function currentUrl(instance: BrowserInstance, target: ManagedTarget): Promise<string> {
  try {
    const { result } = await evaluate(instance, target, {
      expression: 'location.href',
      returnByValue: true,
      awaitPromise: false,
    });
    return String(result.value ?? target.info.url);
  } catch {
    return target.info.url;
  }
}

export async function reload(
  ctx: OpsContext,
  args: PageArgs & { ignore_cache?: boolean; wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'none'; timeout_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.reload');
  const timeout = args.timeout_ms ?? 30_000;
  const waitUntil = args.wait_until ?? 'load';
  const lifecycle =
    waitUntil === 'none'
      ? null
      : waitForLifecycle(
          target.session,
          waitUntil === 'domcontentloaded' ? 'DOMContentLoaded' : waitUntil === 'networkidle' ? 'networkIdle' : 'load',
          timeout,
        );
  await target.session.send('Page.reload', { ignoreCache: args.ignore_cache === true });
  const settled = lifecycle ? await lifecycle : null;
  return { target_id: target.handle, url: await currentUrl(instance, target), timed_out: settled === false };
}

export async function goBack(
  ctx: OpsContext,
  args: PageArgs & { delta?: number },
): Promise<Record<string, unknown>> {
  return historyMove(ctx, args, -(Math.abs(args.delta ?? 1)));
}

export async function goForward(
  ctx: OpsContext,
  args: PageArgs & { delta?: number },
): Promise<Record<string, unknown>> {
  return historyMove(ctx, args, Math.abs(args.delta ?? 1));
}

async function historyMove(
  ctx: OpsContext,
  args: PageArgs,
  delta: number,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.history');
  const history = await target.session.send<{
    currentIndex: number;
    entries: Array<{ id: number; url: string; title: string }>;
  }>('Page.getNavigationHistory');
  const index = history.currentIndex + delta;
  const entry = history.entries[index];
  if (!entry) {
    return { target_id: target.handle, moved: false, reason: 'no history entry in that direction' };
  }
  await target.session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  return { target_id: target.handle, moved: true, url: entry.url, title: entry.title };
}

export async function history(
  ctx: OpsContext,
  args: PageArgs & { limit?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);

  // Two different questions: what this tab can go back to right now, and what
  // the recorder actually saw happen. The second survives tab close and
  // includes same-document navigations that never enter session history.
  const result = await target.session.send<{
    currentIndex: number;
    entries: Array<{ id: number; url: string; title: string; transitionType: string }>;
  }>('Page.getNavigationHistory');

  const recorded = ctx.stores.targets.listNavigations({
    browserId: instance.id,
    ...(args.target_id ? { targetHandle: args.target_id } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });

  return {
    target_id: target.handle,
    current_index: result.currentIndex,
    entries: result.entries.map((e, i) => ({
      index: i,
      url: e.url,
      title: e.title,
      transition: e.transitionType,
      current: i === result.currentIndex,
    })),
    navigations: recorded.map((n) => ({
      nav_id: n.nav_handle,
      target_id: n.target_handle,
      url: n.url,
      kind: n.kind,
      at: new Date(n.ts).toISOString(),
    })),
  };
}

// ---------------------------------------------------------------- vision

// ---------------------------------------------------------------- capture helpers

/**
 * Captures are serialised per target. Chromium answers exactly one
 * Page.captureScreenshot at a time; issuing a second while a full_page capture
 * is still stitching does not queue politely, it hangs until the timeout - the
 * single most reported browserd failure.
 */
const captureLocks = new Map<string, Promise<unknown>>();

async function serializeCapture<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = captureLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  captureLocks.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (captureLocks.get(key) === run) captureLocks.delete(key);
  }
}

/**
 * Wait for entrance animations to finish before capturing.
 *
 * A screenshot is the evidence an agent judges a design by, and a capture taken
 * 40% through a fade invents a defect that no user ever sees. document
 * .getAnimations() already knows; polling it costs a few milliseconds.
 */
const RUNNING_ANIMATIONS_FN = `(() => {
  if (typeof document.getAnimations !== 'function') return 0;
  let n = 0;
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    // Infinite animations (spinners, marquees) never settle; waiting on them
    // would turn every capture into a timeout.
    const timing = typeof a.effect?.getComputedTiming === 'function' ? a.effect.getComputedTiming() : null;
    const duration = timing ? timing.duration : null;
    if (duration === Infinity || duration === null || duration === undefined) continue;
    if (timing && timing.iterations === Infinity) continue;
    n++;
  }
  return n;
})()`;

async function settleAnimations(
  instance: BrowserInstance,
  target: ManagedTarget,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  let running = 0;
  do {
    try {
      const { result } = await evaluate(instance, target, {
        expression: RUNNING_ANIMATIONS_FN,
        returnByValue: true,
        awaitPromise: false,
      });
      running = Number(result.value ?? 0);
    } catch {
      return 0;
    }
    if (running === 0) return 0;
    await delay(100);
  } while (Date.now() < deadline);
  return running;
}

/**
 * Walk the page top to bottom so IntersectionObserver-driven content (the
 * `whileInView` pattern every marketing page uses) actually reveals itself.
 * Without this a full_page capture returns large blank bands where sections
 * are still at opacity 0, which reads as an application bug.
 */
const SCROLL_THROUGH_FN = `(async () => {
  const step = Math.max(200, Math.round(innerHeight * 0.8));
  const start = window.scrollY;
  const height = document.documentElement.scrollHeight;
  for (let y = 0; y < height; y += step) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo({ top: height, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 80));
  window.scrollTo({ top: start, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 80));
  return height;
})()`;

async function triggerLazyContent(instance: BrowserInstance, target: ManagedTarget): Promise<void> {
  try {
    await evaluate(instance, target, {
      expression: SCROLL_THROUGH_FN,
      returnByValue: true,
      awaitPromise: true,
    });
  } catch {
    /* Best effort: a capture without the sweep beats no capture. */
  }
}

async function pageIsHidden(instance: BrowserInstance, target: ManagedTarget): Promise<boolean> {
  try {
    const { result } = await evaluate(instance, target, {
      expression: 'document.visibilityState',
      returnByValue: true,
      awaitPromise: false,
    });
    return result.value === 'hidden';
  } catch {
    return false;
  }
}

/** Resolve after `count` animation frames, or after `timeoutMs` if frames never come. */
async function waitForFrames(
  instance: BrowserInstance,
  target: ManagedTarget,
  count: number,
  timeoutMs: number,
): Promise<void> {
  try {
    await evaluate(instance, target, {
      expression: `new Promise((done) => {
        const stop = setTimeout(done, ${timeoutMs});
        let left = ${count};
        const tick = () => { if (--left <= 0) { clearTimeout(stop); done(true); } else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })`,
      returnByValue: true,
      awaitPromise: true,
    });
  } catch {
    /* Best effort: a capture without the wait beats no capture. */
  }
}

/** Cheap post-mortem for a capture that never came back. */
async function captureDiagnostics(
  instance: BrowserInstance,
  target: ManagedTarget,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    target_id: target.handle,
    url: target.info.url,
    attached: instance.targets.get(target.handle) !== undefined,
  };
  try {
    const { result } = await evaluate(instance, target, {
      expression: '[location.href, document.readyState, document.title]',
      returnByValue: true,
      awaitPromise: false,
    });
    const [url, readyState, title] = (result.value ?? []) as [string?, string?, string?];
    out.url = url ?? out.url;
    out.load_state = readyState ?? null;
    out.title = title ?? null;
    out.renderer_responsive = true;
  } catch {
    out.renderer_responsive = false;
    out.load_state = null;
  }
  return out;
}

export async function screenshot(
  ctx: OpsContext,
  args: PageArgs & {
    mode?: 'viewport' | 'full_page' | 'element';
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    save_path?: string;
    return_image?: boolean;
    highlight?: string;
    label?: string;
    timeout_ms?: number;
    settle?: boolean;
    settle_timeout_ms?: number;
    trigger_lazy_content?: boolean;
    max_width?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const mode = args.mode ?? 'viewport';
  const format = args.format ?? 'png';
  // 60s was the old default and it never once produced an image: a viewport
  // capture that has not returned in a few seconds is wedged, not slow.
  const timeout = Math.min(Math.max(args.timeout_ms ?? 15_000, 1_000), 120_000);
  const params: Record<string, unknown> = { format, captureBeyondViewport: false };
  if (format !== 'png' && args.quality !== undefined) params.quality = args.quality;

  /*
   * Reveal lazily-animated content before measuring anything. Default on for
   * full_page, where a stitched capture otherwise shows blank bands wherever an
   * IntersectionObserver never fired.
   */
  const sweep = args.trigger_lazy_content ?? mode === 'full_page';
  if (sweep) await triggerLazyContent(instance, target);

  // Downscaling is done by Chromium at capture time via the clip scale, so a
  // wide desktop screenshot costs a fraction of the bytes without a resize step.
  let scale = 1;
  if (mode === 'full_page') {
    const metrics = await target.session.send<{
      cssContentSize: { width: number; height: number };
    }>('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    if (args.max_width && size.width > args.max_width) scale = args.max_width / size.width;
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale };
    params.captureBeyondViewport = true;
  } else if (mode === 'viewport' && args.max_width) {
    const metrics = await target.session.send<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics');
    const view = metrics.cssLayoutViewport;
    if (view.clientWidth > args.max_width) scale = args.max_width / view.clientWidth;
    params.clip = { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight, scale };
  } else if (mode === 'element') {
    const element = await resolveElement(instance, target, args);
    const box = await boundingBox(target.session, element.objectId);
    if (!box) throw new AgentBrowserError('not_visible', 'Element has no box to capture.');
    params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    params.captureBeyondViewport = true;
  }

  /*
   * A one-shot highlight: draw it, capture, then always clear. page.highlight
   * persists by design, which means a separate cleanup call; for "is the box on
   * the right control" the overlay should not outlive the screenshot.
   */
  let highlighted: string | undefined;
  if (args.highlight) {
    const element = await resolveElement(instance, target, { selector: args.highlight });
    await target.session.trySend('Overlay.enable');
    await target.session.trySend('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId });
    await target.session.trySend('Overlay.highlightNode', {
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
        borderColor: { r: 255, g: 82, b: 82, a: 0.9 },
      },
      backendNodeId: element.backendNodeId,
    });
    highlighted = element.description;
  }

  /*
   * A hidden page (a background tab) paints no new frames: Page.captureScreenshot
   * then returns whatever was on screen when it was last visible, often a
   * loader or skeleton long since replaced, and requestAnimationFrame-driven
   * motion stays frozen mid-entrance. Focus emulation alone does not make
   * Chromium paint it, and forcing a capture beyond the viewport hangs, so the
   * tab is brought to the front for the capture and the tab that was in front
   * before is restored afterwards. (Covered windows are already handled by the
   * --disable-backgrounding-occluded-windows launch flag.)
   */
  const wasHidden = await pageIsHidden(instance, target);
  let restoreTo: string | null = null;
  if (wasHidden) {
    restoreTo = await currentActiveTarget(instance);
    await instance.browserSession.trySend('Target.activateTarget', { targetId: target.cdpTargetId });
    await waitForFrames(instance, target, 3, 2_000);
  }

  /*
   * Settle last, after the lazy sweep and the highlight: scrolling and overlays
   * both start animations of their own.
   */
  let animationsRunning = 0;
  if (args.settle !== false) {
    animationsRunning = await settleAnimations(instance, target, args.settle_timeout_ms ?? 2_000);
  }

  let data: string;
  try {
    data = await serializeCapture(`${instance.id}:${target.handle}`, async () => {
      const shot = await target.session.send<{ data: string }>('Page.captureScreenshot', params, timeout);
      return shot.data;
    });
  } catch (error) {
    if (error instanceof TimeoutError || /timed out/i.test(String((error as Error)?.message))) {
      const diagnostics = await captureDiagnostics(instance, target);
      throw new AgentBrowserError(
        'screenshot_timeout',
        `Page.captureScreenshot did not return within ${timeout}ms (target is at ${String(diagnostics.url)}, load_state: ${String(diagnostics.load_state)}).`,
        {
          operation: 'page.screenshot',
          ms: timeout,
          mode,
          ...diagnostics,
          hint: diagnostics.renderer_responsive
            ? 'The renderer answers JavaScript, so the compositor is the stuck part. Retry once; a plain mode:"viewport" capture usually succeeds.'
            : 'The renderer is not answering at all. Check for a blocking dialog (page.list_dialogs) or a wedged tab.',
        },
      );
    }
    throw error;
  } finally {
    if (args.highlight) await target.session.trySend('Overlay.hideHighlight');
    if (restoreTo && restoreTo !== target.handle) {
      const previous = instance.targets.get(restoreTo);
      if (previous) await instance.browserSession.trySend('Target.activateTarget', { targetId: previous.cdpTargetId });
    }
  }
  const buffer = Buffer.from(data, 'base64');
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  // A caller-supplied label groups a run of screenshots into one investigation,
  // which is how artifact.list is filtered afterwards.
  const artifact = ctx.stores.artifacts.put('screenshot', buffer, {
    browserId: instance.id,
    label: args.label ?? `${mode}-${new URL(await currentUrl(instance, target), 'http://x').hostname || 'page'}`,
    mime,
    sourceRef: target.handle,
    meta: { mode, url: target.info.url, ...(args.label ? { label: args.label } : {}) },
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    mode,
    format,
    size_bytes: buffer.length,
    artifact: toArtifactRef(artifact),
    url: await currentUrl(instance, target),
    title: target.info.title,
    ...(scale === 1 ? {} : { scaled: Number(scale.toFixed(3)) }),
    ...(sweep ? { scrolled_through: true } : {}),
    ...(highlighted ? { highlighted } : {}),
    ...(wasHidden
      ? { rendered_in_background: true, note: 'The tab was in the background, so it was brought to the front for this capture (the frame is current) and the previous tab was put back.' }
      : {}),
    ...(animationsRunning > 0
      ? {
          warning:
            `${animationsRunning} animation(s) were still running at capture time, so this image may show a mid-transition state that no user sees. ` +
            'Raise settle_timeout_ms, or treat dimmed/blank regions as suspect rather than as defects.',
        }
      : {}),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  // The image itself rides back as MCP image content unless suppressed.
  if (args.return_image !== false) {
    out._image = { data, mime };
  }
  return out;
}

// ---------------------------------------------------------------- snapshot

interface SnapshotOptions extends PageArgs {
  max_nodes?: number;
  interactive_only?: boolean;
  root_selector?: string;
  format?: 'refs' | 'aria';
}

/**
 * Rendering Chrome's accessibility tree in Playwright's aria-snapshot dialect.
 *
 * The two trees are not the same shape, and the differences are not cosmetic:
 * a snapshot carrying Chrome's own node names does not parse as an expectation
 * at all, so the assertion fails before it compares anything. Each rule below
 * was derived by diffing this output against `locator.ariaSnapshot()` on a
 * fixture covering labels, landmarks, lists and named-by-reference controls.
 *
 * The mapping is:
 *   - RootWebArea, generic and LabelText carry no meaning in the dialect, so
 *     they are dropped and their children rise to their depth.
 *   - `<form>` and `<region>` are only landmarks when they have an accessible
 *     name; unnamed ones are dropped the same way.
 *   - StaticText becomes `- text: ...`, unless it is simply repeating the
 *     accessible name of the element containing it, where the dialect leaves it
 *     out. ListMarker (the bullet) has no representation and is dropped.
 *   - `level` appears on headings only, though Chrome also reports it on list
 *     items.
 */
const ARIA_TEXT_ROLES = new Set(['StaticText', 'InlineTextBox']);
const ARIA_TRANSPARENT_ROLES = new Set(['RootWebArea', 'generic', 'LabelText', 'none', 'presentation', '']);
/** Landmarks that only count as landmarks once they are named. */
const ARIA_NAME_REQUIRED_ROLES = new Set(['form', 'region']);
const ARIA_STATE_PROPS = new Set(['checked', 'disabled', 'expanded', 'pressed', 'selected']);

const normaliseText = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** `[checked]` for true, `[checked=mixed]` for anything else meaningful, nothing for false. */
function ariaStateAttrs(node: AXNode): string {
  const attrs: string[] = [];
  const role = String(node.role?.value ?? '');
  for (const prop of node.properties ?? []) {
    const value = prop.value?.value;
    if (value === undefined || value === null) continue;

    if (prop.name === 'level') {
      // Chrome reports level on list items too; the dialect only takes it on
      // headings, and an extra attribute makes the node unmatchable.
      if (role === 'heading') attrs.push(`level=${String(value)}`);
      continue;
    }
    if (!ARIA_STATE_PROPS.has(prop.name)) continue;
    if (value === false || value === 'false') continue;
    attrs.push(value === true || value === 'true' ? prop.name : `${prop.name}=${String(value)}`);
  }
  return attrs.map((attr) => ` [${attr}]`).join('');
}

interface AriaRender {
  lines: string[];
  emitted: number;
  truncated: boolean;
}

function renderAriaSnapshot(byId: Map<string, AXNode>, rootId: string, maxNodes: number): AriaRender {
  const out: AriaRender = { lines: [], emitted: 0, truncated: false };

  /**
   * `suppress` is the accessible name of the nearest rendered ancestor. Text
   * inside it that merely restates that name is what the element was named
   * from, so the dialect does not repeat it as a child.
   */
  const render = (nodeId: string, depth: number, suppress: string): string[] => {
    if (out.emitted >= maxNodes) {
      out.truncated = true;
      return [];
    }
    const node = byId.get(nodeId);
    if (!node) return [];

    const role = String(node.role?.value ?? '');
    const indent = '  '.repeat(depth);

    /*
     * An ignored node is not rendered, but its children still are. Chrome marks
     * html and body ignored on most pages, so returning early here empties the
     * whole snapshot - which is exactly what it did before this was fixed.
     */
    if (node.ignored) {
      return (node.childIds ?? []).flatMap((childId) => render(childId, depth, suppress));
    }

    if (role === 'ListMarker') return [];

    if (ARIA_TEXT_ROLES.has(role)) {
      const text = normaliseText(node.name?.value ?? node.value?.value);
      if (!text) return [];
      if (suppress && suppress.includes(text)) return [];
      out.emitted++;
      return [`${indent}- text: ${text}`];
    }

    const name = normaliseText(node.name?.value);
    if (ARIA_TRANSPARENT_ROLES.has(role) || (ARIA_NAME_REQUIRED_ROLES.has(role) && !name)) {
      return (node.childIds ?? []).flatMap((childId) => render(childId, depth, suppress));
    }

    const header = `${indent}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${ariaStateAttrs(node)}`;
    out.emitted++;
    const children = (node.childIds ?? []).flatMap((childId) =>
      render(childId, depth + 1, name || suppress),
    );
    return children.length > 0 ? [`${header}:`, ...children] : [header];
  };

  out.lines = render(rootId, 0, '');
  return out;
}

/**
 * An accessibility-tree outline of the page with stable `ref=` handles.
 *
 * This is what an agent should read before acting: it is two orders of
 * magnitude smaller than the HTML, it names things the way a human would, and
 * every line carries a ref that click/type accept directly.
 */
export async function snapshot(ctx: OpsContext, args: SnapshotOptions): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  await target.session.trySend('Accessibility.enable');
  const { nodes } = await target.session.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');

  const byId = new Map<string, AXNode>();
  for (const node of nodes) byId.set(node.nodeId, node);

  const refs = new Map<string, number>();
  const lines: string[] = [];
  const maxNodes = Math.min(Math.max(args.max_nodes ?? 1500, 10), 10_000);
  const aria = args.format === 'aria';
  let refCounter = 0;
  let emitted = 0;
  let truncated = false;

  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'menuitem',
    'option',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textarea',
  ]);

  const walk = (nodeId: string, depth: number): void => {
    if (emitted >= maxNodes) {
      truncated = true;
      return;
    }
    const node = byId.get(nodeId);
    if (!node) return;

    const role = String(node.role?.value ?? '');
    const name = String(node.name?.value ?? '').trim();
    const skip = node.ignored || role === 'none' || role === 'presentation' || role === 'InlineTextBox';

    let childDepth = depth;
    if (!skip) {
      const wanted = !args.interactive_only || interactiveRoles.has(role) || name.length > 0;
      if (wanted) {
        const parts = [`- ${role || 'generic'}`];
        if (name) parts.push(` ${JSON.stringify(name)}`);

        const value = node.value?.value;
        if (value !== undefined && value !== null && String(value) !== '') {
          parts.push(` value=${JSON.stringify(String(value))}`);
        }
        for (const prop of node.properties ?? []) {
          if (['focused', 'disabled', 'checked', 'expanded', 'required', 'selected'].includes(prop.name)) {
            if (prop.value?.value !== false && prop.value?.value !== undefined) {
              parts.push(` ${prop.name}=${prop.value.value}`);
            }
          }
        }
        if (node.backendDOMNodeId !== undefined) {
          const ref = `e${++refCounter}`;
          refs.set(ref, node.backendDOMNodeId);
          parts.push(` [ref=${ref}]`);
        }
        lines.push(`${'  '.repeat(depth)}${parts.join('')}`);
        emitted++;
        childDepth = depth + 1;
      }
    }
    for (const childId of node.childIds ?? []) walk(childId, childDepth);
  };

  /*
   * A root_selector scopes the walk to one subtree. Pages that render a large
   * visually-hidden SEO block ahead of the real content otherwise spend the
   * whole node budget before reaching anything interactive.
   */
  let root = nodes[0];
  let rootNote: string | undefined;
  if (args.root_selector) {
    const element = await resolveElement(instance, target, { selector: args.root_selector });
    const scoped = nodes.find((n) => n.backendDOMNodeId === element.backendNodeId);
    if (scoped) {
      root = scoped;
    } else {
      rootNote = `root_selector "${args.root_selector}" resolved to ${element.description}, but that node is not in the accessibility tree (it may be aria-hidden or display:none). Snapshotting the whole document instead.`;
    }
  }
  if (root) {
    if (aria) {
      // A different dialect entirely, so a separate renderer rather than a
      // conditional threaded through the ref walk.
      const rendered = renderAriaSnapshot(byId, root.nodeId, maxNodes);
      lines.push(...rendered.lines);
      emitted = rendered.emitted;
      truncated = rendered.truncated;
    } else {
      walk(root.nodeId, 0);
    }
  }

  /*
   * An empty tree over a non-empty DOM is the failure that makes an agent
   * conclude "the page is broken" and abandon refs for CSS selectors. Say what
   * actually happened, and where the budget went.
   */
  let emptyWarning: string | undefined;
  if (emitted <= 1) {
    try {
      const { result } = await evaluate(instance, target, {
        expression:
          '({children: document.body ? document.body.children.length : 0, interactive: document.querySelectorAll("a,button,input,select,textarea,[role],[onclick],[tabindex]").length})',
        returnByValue: true,
        awaitPromise: false,
      });
      const dom = (result.value ?? {}) as { children?: number; interactive?: number };
      if ((dom.children ?? 0) > 0) {
        emptyWarning =
          `The snapshot produced ${emitted} node(s) but the DOM has ${dom.children} body children and ` +
          `${dom.interactive ?? 0} interactive elements. The accessibility tree is not reflecting this page. ` +
          'Try root_selector to scope to the content region, raise max_nodes, or fall back to dom.query.';
      }
    } catch {
      /* Diagnosis is a bonus; the snapshot itself already returned. */
    }
  }

  // Refs are only meaningful against the snapshot that produced them. An aria
  // snapshot mints none, and must not wipe the refs a previous snapshot handed
  // out - asking for a different view of the page should not break the handles
  // you were about to act on.
  if (!aria) instance.snapshotRefs.set(target.handle, refs);

  return {
    target_id: target.handle,
    url: await currentUrl(instance, target),
    title: target.info.title,
    node_count: emitted,
    truncated,
    max_nodes: maxNodes,
    ...(truncated ? { truncation_reason: `max_nodes=${maxNodes} reached; raise max_nodes or pass root_selector to scope the walk.` } : {}),
    ax_nodes_available: nodes.length,
    ...(args.root_selector ? { root_selector: args.root_selector } : {}),
    ...(rootNote ? { root_note: rootNote } : {}),
    ...(emptyWarning ? { warning: emptyWarning } : {}),
    ...(aria ? {} : { ref_count: refs.size }),
    format: aria ? 'aria' : 'refs',
    snapshot: lines.join('\n'),
    ...(aria
      ? {
          hint:
            'Playwright aria-snapshot dialect, ready for a toMatchAriaSnapshot assertion. It carries no refs, and it ' +
            'left the existing ones alone.',
          verify:
            "This is Chrome's accessibility tree rendered in Playwright's dialect, not Playwright's own output. " +
            'The dialect is checked against the real toMatchAriaSnapshot matcher by tests/playwright-interop.mjs, ' +
            'but on one fixture: a page built from constructs it does not cover can still render differently. ' +
            'It is also deliberately a subset, which a partial match accepts. Run the assertion once before ' +
            'committing it.',
        }
      : {
          hint: 'Pass ref="eNN" to page.click / page.type / dom.inspect. Refs expire on the next snapshot.',
        }),
  };
}

// ---------------------------------------------------------------- interaction

/**
 * Locator diagnostics worth echoing on an action: how many elements matched,
 * and whether the chosen one is a passive node inside something clickable.
 */
function locatorNotes(element: ResolvedElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (element.matchedCount !== undefined && element.matchedCount > 1) {
    out.matched_count = element.matchedCount;
    out.chose = 'first';
  }
  if (element.interactiveAncestor) {
    out.warning =
      `Resolved to ${element.description}, a non-interactive node inside <${element.interactiveAncestor}>. ` +
      'The event bubbles so this usually works, but target the interactive ancestor to be safe.';
  }
  return out;
}

/** CDP mouse events are in CSS pixels; screenshots are in device pixels. */
async function pointReport(
  instance: BrowserInstance,
  target: ManagedTarget,
  point: { x: number; y: number },
): Promise<Record<string, unknown>> {
  let dpr = 1;
  try {
    const { result } = await evaluate(instance, target, {
      expression: 'devicePixelRatio',
      returnByValue: true,
      awaitPromise: false,
    });
    dpr = Number(result.value ?? 1) || 1;
  } catch {
    /* A ratio of 1 is right for the overwhelming majority of targets. */
  }
  const css = { x: Math.round(point.x), y: Math.round(point.y) };
  return {
    ...css,
    css,
    device: { x: Math.round(point.x * dpr), y: Math.round(point.y * dpr) },
    dpr,
  };
}

/**
 * Arm a mutation counter so an action can report whether the page reacted.
 *
 * `clicked: true` only ever meant "input events were dispatched at these
 * coordinates". When a synthetic click lands on the right element but the
 * framework handler never runs, that reads as an application bug and sends an
 * agent off diagnosing code that is fine.
 */
const ARM_MUTATION_FN = `(() => {
  const w = window;
  if (w.__browserdMo) { try { w.__browserdMo.disconnect(); } catch (e) {} }
  w.__browserdMutations = 0;
  const mo = new MutationObserver((records) => { w.__browserdMutations += records.length; });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  w.__browserdMo = mo;
  return true;
})()`;

const READ_MUTATION_FN = `(() => {
  const w = window;
  const n = w.__browserdMutations || 0;
  if (w.__browserdMo) { try { w.__browserdMo.disconnect(); } catch (e) {} w.__browserdMo = null; }
  return n;
})()`;

async function armMutationWatch(instance: BrowserInstance, target: ManagedTarget): Promise<boolean> {
  try {
    await evaluate(instance, target, {
      expression: ARM_MUTATION_FN,
      returnByValue: true,
      awaitPromise: false,
    });
    return true;
  } catch {
    return false;
  }
}

async function readMutationWatch(instance: BrowserInstance, target: ManagedTarget): Promise<number> {
  try {
    const { result } = await evaluate(instance, target, {
      expression: READ_MUTATION_FN,
      returnByValue: true,
      awaitPromise: false,
    });
    return Number(result.value ?? 0);
  } catch {
    // The execution context is gone, which means the click navigated. That is
    // the largest possible change.
    return -1;
  }
}

/**
 * Did the page react? Optionally retry through the element's own .click(),
 * which drives framework handlers even when synthetic input does not.
 */
async function verifyClick(
  instance: BrowserInstance,
  target: ManagedTarget,
  element: ResolvedElement,
  armed: boolean,
  verifyMs: number,
  retry: boolean,
): Promise<Record<string, unknown>> {
  if (!armed) return {};
  await delay(verifyMs);
  const mutations = await readMutationWatch(instance, target);
  if (mutations !== 0) {
    return {
      observed_change: true,
      ...(mutations < 0 ? { changed_by: 'navigation' } : { dom_mutations: mutations }),
    };
  }
  if (!retry) {
    return {
      observed_change: false,
      note:
        `No DOM mutation followed the click within ${verifyMs}ms. The events were dispatched at the right element, but the app may not have handled them ` +
        '(or the click legitimately changes nothing). Pass retry_if_unchanged:true to fall back to the element own .click().',
    };
  }
  const rearmed = await armMutationWatch(instance, target);
  try {
    await target.session.send('Runtime.callFunctionOn', {
      objectId: element.objectId,
      functionDeclaration: 'function () { this.click(); }',
      awaitPromise: false,
    });
  } catch {
    return { observed_change: false, retried_via: 'dom_click', retry_error: 'element.click() threw' };
  }
  if (!rearmed) return { observed_change: false, retried_via: 'dom_click' };
  await delay(verifyMs);
  const after = await readMutationWatch(instance, target);
  return {
    observed_change: after !== 0,
    retried_via: 'dom_click',
    ...(after > 0 ? { dom_mutations: after } : {}),
    ...(after !== 0
      ? {
          note:
            'Synthetic input did nothing; the element own .click() did. The app is fine - the input path was not reaching its handler.',
        }
      : {}),
  };
}

export async function click(
  ctx: OpsContext,
  args: PageArgs & {
    button?: 'left' | 'right' | 'middle';
    click_count?: number;
    modifiers?: string[];
    force?: boolean;
    verify?: boolean;
    verify_ms?: number;
    retry_if_unchanged?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.click');
  const element = await resolveElement(instance, target, args);
  const center = await contentCenter(target.session, element.objectId);
  const modifiers = modifiersFromNames(args.modifiers);
  const button = args.button ?? 'left';
  const clickCount = args.click_count ?? 1;
  const verify = args.verify !== false;
  const verifyMs = Math.min(Math.max(args.verify_ms ?? 300, 50), 5_000);
  const armed = verify ? await armMutationWatch(instance, target) : false;

  const finish = async (
    input: 'mouse' | 'touch',
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const at = await pointReport(instance, target, center);
    const out: Record<string, unknown> = {
      target_id: target.handle,
      clicked: element.description,
      at,
      input,
      click_count: clickCount,
      ...extra,
      ...locatorNotes(element),
    };
    if (!armed) {
      out.hint =
        'clicked means input events were dispatched at these coordinates, not that the app handled them. Pair this with page.wait_for on a real consequence.';
    }
    return out;
  };

  // Under touch emulation a mouse event is not what the page listens for, so
  // dispatch a real tap instead.
  if (instance.touchTargets.has(target.handle)) {
    const touchPoint = { x: center.x, y: center.y, radiusX: 1, radiusY: 1, force: 1, id: 1 };
    await target.session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touchPoint],
      modifiers,
    });
    await target.session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers,
    });
    return finish(
      'touch',
      await verifyClick(instance, target, element, armed, verifyMs, args.retry_if_unchanged === true),
    );
  }

  /*
   * `buttons` is the pressed-button bitmask. Chromium synthesises PointerEvents
   * from these, and a pointerdown carrying buttons:0 is one a framework can
   * legitimately ignore - a plausible cause of "the click reported success but
   * nothing happened".
   */
  const buttonsMask = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const base = { x: center.x, y: center.y, button, modifiers, clickCount, pointerType: 'mouse' };
  await target.session.send('Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseMoved',
    button: 'none',
    buttons: 0,
    clickCount: 0,
  });
  await target.session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: buttonsMask });
  await target.session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });

  return finish('mouse', {
    button,
    ...(await verifyClick(instance, target, element, armed, verifyMs, args.retry_if_unchanged === true)),
  });
}

export async function hover(ctx: OpsContext, args: PageArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.hover');
  const element = await resolveElement(instance, target, args);
  const center = await contentCenter(target.session, element.objectId);
  await target.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: center.x,
    y: center.y,
    button: 'none',
  });
  return {
    target_id: target.handle,
    hovered: element.description,
    at: await pointReport(instance, target, center),
  };
}

/** What kind of field are we typing into? Newline handling depends on it. */
async function fieldKind(
  target: ManagedTarget,
  objectId: string,
): Promise<{ tag: string; type: string | null; multiline: boolean }> {
  try {
    const response = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        return {
          tag: this.tagName || '',
          type: this.type || null,
          multiline: this.tagName === 'TEXTAREA' || this.isContentEditable === true,
        };
      }`,
    });
    const value = (response.result.value ?? {}) as { tag?: string; type?: string | null; multiline?: boolean };
    return { tag: value.tag ?? '', type: value.type ?? null, multiline: value.multiline === true };
  } catch {
    return { tag: '', type: null, multiline: false };
  }
}

/** Read back what the field actually holds, so `characters` is not a guess. */
async function fieldLength(target: ManagedTarget, objectId: string): Promise<number | null> {
  try {
    const response = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const v = typeof this.value === 'string' ? this.value : (this.isContentEditable ? this.innerText : null);
        return v === null ? null : v.length;
      }`,
    });
    const value = response.result.value;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

export async function typeText(
  ctx: OpsContext,
  args: PageArgs & {
    text: string;
    clear?: boolean;
    delay_ms?: number;
    fast?: boolean;
    insert_text?: boolean;
    press_enter?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.type');
  const element = await resolveElement(instance, target, args);
  await target.session.trySend('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId });
  await target.session.send('DOM.focus', { objectId: element.objectId });

  if (args.clear) {
    // Select-all then delete, so React-style controlled inputs see the change.
    await pressKey(target.session, 'a', modifiersFromNames([process.platform === 'darwin' ? 'Meta' : 'Control']));
    await pressKey(target.session, 'Delete', 0);
  }

  const kind = await fieldKind(target, element.objectId);
  const newlines = (args.text.match(/\n/g) ?? []).length;
  const insert = args.insert_text === true || args.fast === true;
  let droppedNewlines = 0;

  if (insert) {
    // insertText carries newlines verbatim, which is why it is the right mode
    // for pasting multi-line content.
    await target.session.send('Input.insertText', { text: args.text });
  } else {
    for (const char of args.text) {
      if (char === '\n') {
        /*
         * A newline is not a character a key event can carry. Typing it as one
         * silently flattened multi-line content onto a single line - the field
         * looked fine, the markdown preview did not.
         */
        if (kind.multiline) {
          await pressKey(target.session, 'Enter', 0);
        } else {
          droppedNewlines++;
        }
        continue;
      }
      await dispatchChar(target.session, char);
      if (args.delay_ms) await delay(args.delay_ms);
    }
  }

  if (args.press_enter) await pressKey(target.session, 'Enter', 0);

  const landed = await fieldLength(target, element.objectId);
  return {
    target_id: target.handle,
    typed_into: element.description,
    characters: [...args.text].length,
    landed_characters: landed,
    ...(newlines ? { newlines, newlines_typed: insert || kind.multiline ? newlines : 0 } : {}),
    mode: insert ? 'insert_text' : 'keystrokes',
    cleared: args.clear === true,
    pressed_enter: args.press_enter === true,
    ...(droppedNewlines
      ? {
          warning:
            `${droppedNewlines} newline(s) could not be typed into <${kind.tag.toLowerCase() || 'element'}>, which is a single-line field. ` +
            'The text landed on one line. Use a textarea/contenteditable target, or insert_text:true if the field really should hold them.',
        }
      : {}),
  };
}

async function dispatchChar(session: CdpSession, char: string): Promise<void> {
  const def = resolveKey(char);
  const shift = /^[A-Z]$/.test(char) || '~!@#$%^&*()_+{}|:"<>?'.includes(char);
  const modifiers = shift ? 8 : 0;
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    text: def.text ?? char,
    unmodifiedText: def.text ?? char,
    modifiers,
  });
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  });
}

async function pressKey(session: CdpSession, keyName: string, modifiers: number): Promise<void> {
  const def = resolveKey(keyName);
  const common = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await session.send('Input.dispatchKeyEvent', {
    ...common,
    type: def.text && modifiers === 0 ? 'keyDown' : 'rawKeyDown',
    ...(def.text && modifiers === 0 ? { text: def.text, unmodifiedText: def.text } : {}),
  });
  await session.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
}

export async function press(
  ctx: OpsContext,
  args: PageArgs & { key: string; repeat?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.press');
  if (args.selector || args.ref || args.xpath || args.text || args.backend_node_id !== undefined) {
    const element = await resolveElement(instance, target, args);
    await target.session.send('DOM.focus', { objectId: element.objectId });
  }
  const { modifiers, key, names } = parseChord(args.key);
  const repeat = Math.min(Math.max(args.repeat ?? 1, 1), 100);

  for (let i = 0; i < repeat; i++) {
    await pressKey(target.session, key.key === ' ' ? 'Space' : key.key, modifiers);
  }
  return { target_id: target.handle, key: args.key, modifiers: names, repeat };
}

export async function scroll(
  ctx: OpsContext,
  args: PageArgs & { delta_y?: number; delta_x?: number; to?: 'top' | 'bottom' },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.scroll');

  // Scrolling to an element is a distinct intent from wheeling by an amount.
  const hasLocator =
    args.selector !== undefined ||
    args.ref !== undefined ||
    args.xpath !== undefined ||
    args.text !== undefined ||
    args.backend_node_id !== undefined;

  if (hasLocator && args.delta_y === undefined && args.delta_x === undefined && !args.to) {
    const element = await resolveElement(instance, target, args);
    await target.session.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId });
    return { target_id: target.handle, scrolled_to: element.description };
  }

  if (args.to) {
    const expression =
      args.to === 'top'
        ? 'window.scrollTo({top: 0, behavior: "instant"}); [scrollX, scrollY]'
        : 'window.scrollTo({top: document.documentElement.scrollHeight, behavior: "instant"}); [scrollX, scrollY]';
    const { result } = await evaluate(instance, target, { expression, returnByValue: true });
    return { target_id: target.handle, scrolled_to: args.to, position: result.value };
  }

  // Wheel events need a cursor position; the viewport centre is the neutral choice.
  const metrics = await target.session.send<{
    cssLayoutViewport: { clientWidth: number; clientHeight: number };
  }>('Page.getLayoutMetrics');
  const deltaX = args.delta_x ?? 0;
  const deltaY = args.delta_y ?? 400;

  /*
   * Input.dispatchMouseEvent for a wheel can stall for the full CDP timeout on
   * a page whose compositor is busy, while window.scrollBy does the same job
   * instantly. Give the real wheel a short window, then fall back rather than
   * burning 30 seconds on a scroll.
   */
  let via: 'wheel' | 'script' = 'wheel';
  try {
    await target.session.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: Math.round(metrics.cssLayoutViewport.clientWidth / 2),
        y: Math.round(metrics.cssLayoutViewport.clientHeight / 2),
        deltaX,
        deltaY,
      },
      5_000,
    );
  } catch {
    via = 'script';
    await evaluate(instance, target, {
      expression: `window.scrollBy({left: ${deltaX}, top: ${deltaY}, behavior: 'instant'})`,
      returnByValue: true,
    });
  }

  const { result } = await evaluate(instance, target, {
    expression: '[window.scrollX, window.scrollY]',
    returnByValue: true,
  });
  return {
    target_id: target.handle,
    delta_x: deltaX,
    delta_y: deltaY,
    via,
    position: result.value,
    ...(via === 'script'
      ? { note: 'Wheel dispatch did not return within 5s, so the scroll was done programmatically. Momentum and wheel listeners did not run.' }
      : {}),
  };
}

export async function selectOption(
  ctx: OpsContext,
  args: PageArgs & { values?: string[]; labels?: string[] },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.select_option');
  const element = await resolveElement(instance, target, args);
  // callFunctionOn keeps the element identity rather than re-querying it, so a
  // re-render between resolve and act cannot swap the target out from under us.
  const response = await target.session.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', {
    objectId: element.objectId,
    returnByValue: true,
    functionDeclaration: `function (values, labels) {
      if (this.tagName !== 'SELECT') throw new Error('Not a <select>: ' + this.tagName);
      const wantValues = new Set(values || []);
      const wantLabels = new Set((labels || []).map((l) => String(l).trim()));
      const selected = [];
      for (const option of this.options) {
        const hit = wantValues.has(option.value) || wantLabels.has(option.textContent.trim());
        option.selected = hit;
        if (hit) selected.push({ value: option.value, label: option.textContent.trim() });
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return selected;
    }`,
    arguments: [{ value: args.values ?? [] }, { value: args.labels ?? [] }],
  });
  if (response.exceptionDetails) {
    throw new AgentBrowserError('select_failed', response.exceptionDetails.text);
  }
  return { target_id: target.handle, selected: response.result.value };
}

export async function uploadFiles(
  ctx: OpsContext,
  args: PageArgs & { files: string[] },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.upload_files');
  const element = await resolveElement(instance, target, args);
  await target.session.send('DOM.setFileInputFiles', {
    files: args.files,
    objectId: element.objectId,
  });
  return { target_id: target.handle, input: element.description, files: args.files };
}

// ---------------------------------------------------------------- highlight

export async function highlight(
  ctx: OpsContext,
  args: PageArgs & { color?: string; duration_ms?: number; scroll_into_view?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const element = await resolveElement(instance, target, args);
  await target.session.trySend('Overlay.enable');
  if (args.scroll_into_view !== false) {
    await target.session.trySend('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId });
  }

  const highlightConfig = {
    showInfo: true,
    showStyles: true,
    contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
    paddingColor: { r: 147, g: 196, b: 125, a: 0.35 },
    borderColor: { r: 255, g: 229, b: 153, a: 0.45 },
    marginColor: { r: 246, g: 178, b: 107, a: 0.35 },
  };
  await target.session.send('Overlay.highlightNode', {
    highlightConfig,
    backendNodeId: element.backendNodeId,
  });

  const box = await boundingBox(target.session, element.objectId);
  if (args.duration_ms) {
    // Clear on a timer so an unattended highlight does not stay on the user's screen.
    setTimeout(() => {
      void target.session.trySend('Overlay.hideHighlight');
    }, args.duration_ms).unref?.();
  }

  return {
    target_id: target.handle,
    highlighted: element.description,
    backend_node_id: element.backendNodeId,
    box,
    cleared_after_ms: args.duration_ms ?? null,
    hint: 'Take a page.screenshot now to visually confirm the right element was found.',
  };
}

export async function unhighlight(ctx: OpsContext, args: PageArgs): Promise<Record<string, unknown>> {
  const { target } = await pageOf(ctx, args);
  await target.session.trySend('Overlay.hideHighlight');
  return { target_id: target.handle, cleared: true };
}

// ---------------------------------------------------------------- text + waiting

/**
 * Text as a sighted reader sees it.
 *
 * innerText already drops display:none, but not the visually-hidden SEO/LLM
 * block that marketing pages put at the top of <body>: it is clipped, not
 * hidden, so it survives - and then the first 1500 characters of every read are
 * boilerplate nobody asked for.
 */
/** Shared with the document capture path in ops/document.ts; keep one copy. */
export const VISIBLE_TEXT_FN = `function (root) {
  const clipped = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    if (s.clipPath && s.clipPath !== 'none') return true;
    if (s.clip && s.clip !== 'auto') return true;
    if (Math.abs(parseFloat(s.textIndent) || 0) > 9000) return true;
    const r = el.getBoundingClientRect();
    // Both dimensions collapsed is the sr-only signature. One collapsed
    // dimension is an ordinary layout artefact, so it is left alone.
    if (r.width <= 1 && r.height <= 1) return true;
    return false;
  };
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
      if (clipped(child)) continue;
      walk(child);
      if (getComputedStyle(child).display !== 'inline') out += '\\n';
    }
  };
  walk(root);
  return out.replace(/[ \\t]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`;

export async function extractText(
  ctx: OpsContext,
  args: PageArgs & { max_chars?: number; include_hidden?: boolean; visible_only?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const hasLocator =
    args.selector !== undefined ||
    args.ref !== undefined ||
    args.xpath !== undefined ||
    args.text !== undefined ||
    args.backend_node_id !== undefined;

  const visibleOnly = args.visible_only === true && args.include_hidden !== true;

  let text: string;
  if (hasLocator) {
    const element = await resolveElement(instance, target, args);
    const response = await target.session.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      {
        objectId: element.objectId,
        returnByValue: true,
        functionDeclaration: visibleOnly
          ? `function () { return (${VISIBLE_TEXT_FN})(this); }`
          : `function (includeHidden) {
          return includeHidden ? (this.textContent || '') : (this.innerText || this.textContent || '');
        }`,
        arguments: visibleOnly ? [] : [{ value: args.include_hidden === true }],
      },
    );
    text = String(response.result.value ?? '');
  } else {
    const { result } = await evaluate(instance, target, {
      expression: visibleOnly
        ? `document.body ? (${VISIBLE_TEXT_FN})(document.body) : ''`
        : args.include_hidden
          ? 'document.documentElement.textContent || ""'
          : 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    text = String(result.value ?? '');
  }

  const max = Math.min(Math.max(args.max_chars ?? 20_000, 100), 500_000);
  const truncated = text.length > max;
  const body = truncated ? text.slice(0, max) : text;

  const out: Record<string, unknown> = {
    target_id: target.handle,
    url: await currentUrl(instance, target),
    length: text.length,
    truncated,
    ...(visibleOnly ? { visible_only: true } : {}),
    text: body,
  };
  if (text.length === 0) {
    out.hint = hasLocator
      ? 'The element resolved but holds no text. Check you are on the right node with dom.inspect, or drop visible_only if the text is deliberately hidden.'
      : 'The page has no readable text yet. It may still be loading (page.wait_for), or the content may live in an iframe (page.list_frames).';
  } else if (!visibleOnly && text.length > 20_000) {
    out.hint =
      'Large text dumps on marketing pages usually start with a visually-hidden SEO block. Pass visible_only:true to read what a person sees, or a selector to read one region.';
  }
  if (truncated) {
    const artifact = ctx.stores.artifacts.put('dom_export', Buffer.from(text, 'utf8'), {
      browserId: instance.id,
      label: 'page-text',
      mime: 'text/plain',
      sourceRef: target.handle,
    });
    out.full_text_artifact = toArtifactRef(artifact);
  }
  return out;
}

/** One thing to wait for. Bare selector/text on the call is sugar for a single condition. */
export interface WaitCondition {
  selector?: string;
  text?: string;
  gone?: boolean;
}

/** Stable label for a condition, echoed back so the caller knows which one fired. */
function conditionLabel(c: WaitCondition): string {
  const what = c.selector !== undefined ? `selector:${c.selector}` : `text:${c.text}`;
  return c.gone ? `${what}:gone` : what;
}

/**
 * Build the in-page predicate for one condition.
 *
 * `normalize` collapses runs of whitespace and lowercases both haystack and
 * needle. Without it a wait for "START WITH A PROMPT" fails against a DOM that
 * renders the same words with different casing or line breaks, and a failed
 * wait is indistinguishable from a genuinely absent element.
 */
function conditionExpression(c: WaitCondition, normalize: boolean): string {
  if (c.selector !== undefined) {
    return `(document.querySelector(${JSON.stringify(c.selector)}) ? 1 : 0)`;
  }
  /*
   * innerText is what a reader sees, and is the right first answer. But it is
   * layout-dependent: a detached, still-painting or oddly-styled subtree can
   * hold text that innerText does not report, and a wait that times out on text
   * which is demonstrably in the DOM is worse than a slightly looser match. So
   * fall back to textContent and say which path matched: 1 = rendered text,
   * 2 = DOM text only.
   */
  const rendered = `(document.body ? document.body.innerText : '')`;
  const raw = `(document.body ? document.body.textContent : '')`;
  const norm = (v: string) => (normalize ? `${v}.replace(/\\s+/g, ' ').trim().toLowerCase()` : v);
  const needle = norm(JSON.stringify(c.text));
  return `(${norm(rendered)}.includes(${needle}) ? 1 : (${norm(raw)}.includes(${needle}) ? 2 : 0))`;
}

/**
 * On timeout, look for evidence that the caller was close: a relaxed count for
 * selectors, or the nearest matching line for text. Turning a dead end into a
 * lead is most of the value of a timeout message.
 */
const NEAR_MISS_FN = `(conds) => {
  const out = [];
  for (const c of conds) {
    if (c.selector !== undefined) {
      const relaxed = String(c.selector).split(/[\\s>+~]+/).filter(Boolean).pop() || c.selector;
      let count = 0;
      try { count = document.querySelectorAll(relaxed).length; } catch (e) { count = 0; }
      out.push({ condition: c.label, relaxed_selector: relaxed, relaxed_match_count: count });
    } else {
      const needle = String(c.text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const rendered = ((document.body ? document.body.innerText : '') || '');
      const domText = ((document.body ? document.body.textContent : '') || '');
      const scan = (haystack) => {
        const lines = haystack.split('\\n').map((l) => l.replace(/\\s+/g, ' ').trim()).filter(Boolean);
        let best = null; let bestScore = 0;
        const words = needle.split(' ').filter(Boolean);
        for (const line of lines) {
          const low = line.toLowerCase();
          let score = 0;
          for (const w of words) if (low.includes(w)) score++;
          if (score > bestScore) { bestScore = score; best = line; }
        }
        return { best: best, score: bestScore, words: words.length };
      };
      const primary = scan(rendered);
      const fallback = primary.score === 0 ? scan(domText) : null;
      const chosen = fallback && fallback.score > 0 ? fallback : primary;
      out.push({
        condition: c.label,
        closest_text: chosen.best ? chosen.best.slice(0, 200) : null,
        matched_words: chosen.score + '/' + chosen.words,
        searched: fallback && fallback.score > 0 ? 'textContent (innerText had no match)' : 'innerText',
        ...(chosen.best ? {} : {
          why: rendered.length === 0 && domText.length === 0
            ? 'The document has no text at all: it is blank, or still loading.'
            : 'No line shares a single word with the target. The text is not on this page - check the URL and the frame (page.list_frames).',
          text_length: rendered.length,
        }),
      });
    }
  }
  return out;
}`;

export async function waitFor(
  ctx: OpsContext,
  args: PageArgs & {
    selector?: string;
    text?: string;
    gone?: boolean;
    any_of?: WaitCondition[];
    all_of?: WaitCondition[];
    normalize?: boolean;
    timeout_ms?: number;
    poll_ms?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const timeout = Math.min(args.timeout_ms ?? 10_000, 120_000);
  const poll = Math.max(args.poll_ms ?? 100, 25);
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  if (args.any_of && args.all_of) {
    throw new AgentBrowserError('ambiguous_condition', 'Pass any_of or all_of, not both.');
  }

  const mode: 'any' | 'all' = args.all_of ? 'all' : 'any';
  const conditions: WaitCondition[] =
    args.any_of ??
    args.all_of ??
    (args.selector !== undefined || args.text !== undefined
      ? [{ ...(args.selector !== undefined ? { selector: args.selector } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.gone === true ? { gone: true } : {}) }]
      : []);

  if (conditions.length === 0) {
    throw new AgentBrowserError(
      'no_condition',
      'Provide selector, text, any_of or all_of to wait for.',
    );
  }
  for (const c of conditions) {
    if (c.selector === undefined && c.text === undefined) {
      throw new AgentBrowserError('no_condition', 'Every condition needs a selector or text.');
    }
  }

  const normalize = args.normalize === true;
  // One evaluate per poll regardless of how many conditions there are.
  const expression = `[${conditions.map((c) => conditionExpression(c, normalize)).join(',')}]`;

  let last: boolean[] = conditions.map(() => false);
  let matchedVia: string[] = conditions.map(() => 'rendered_text');
  while (Date.now() < deadline) {
    try {
      const { result } = await evaluate(instance, target, {
        expression,
        returnByValue: true,
        awaitPromise: false,
      });
      const raw = Array.isArray(result.value) ? (result.value as unknown[]) : [];
      // A "gone" condition is satisfied by the absence of its target.
      const present = conditions.map((_, i) => Number(raw[i] ?? 0) > 0);
      const met = conditions.map((c, i) => present[i] !== (c.gone === true));
      matchedVia = conditions.map((_, i) => (Number(raw[i] ?? 0) === 2 ? 'dom_text' : 'rendered_text'));
      last = met;

      if (mode === 'any') {
        const index = met.findIndex(Boolean);
        if (index >= 0) {
          const condition = conditions[index]!;
          return {
            target_id: target.handle,
            matched: conditionLabel(condition),
            index,
            ...(condition.text !== undefined && condition.gone !== true
              ? {
                  matched_via: matchedVia[index],
                  ...(matchedVia[index] === 'dom_text'
                    ? { note: 'Matched textContent, not innerText: the text is in the DOM but not rendered as visible layout text.' }
                    : {}),
                }
              : {}),
            waited_ms: Date.now() - startedAt,
            mode,
            ...(conditions.length > 1
              ? { conditions: conditions.map((c, i) => ({ condition: conditionLabel(c), met: met[i] === true })) }
              : {}),
          };
        }
      } else if (met.every(Boolean)) {
        return {
          target_id: target.handle,
          matched: conditions.map(conditionLabel),
          waited_ms: Date.now() - startedAt,
          mode,
        };
      }
    } catch {
      // Navigation destroys the context mid-poll; keep waiting.
    }
    await delay(poll);
  }

  // Timed out: report which conditions were unmet and what was nearby.
  let nearMiss: unknown = null;
  try {
    const probe = conditions.map((c, i) => ({
      label: conditionLabel(c),
      ...(c.selector !== undefined ? { selector: c.selector } : {}),
      ...(c.text !== undefined ? { text: c.text } : {}),
      met: last[i] === true,
    }));
    const { result } = await evaluate(instance, target, {
      expression: `(${NEAR_MISS_FN})(${JSON.stringify(probe)})`,
      returnByValue: true,
      awaitPromise: false,
    });
    nearMiss = result.value ?? null;
  } catch {
    // Best effort only; the timeout itself is the real answer.
  }

  const unmet = conditions.filter((_, i) => last[i] !== true).map(conditionLabel);
  throw new AgentBrowserError(
    'timeout',
    `wait (${mode}_of) timed out after ${timeout}ms; unmet: ${unmet.join(', ')}`,
    {
      operation: 'page.wait_for',
      ms: timeout,
      mode,
      unmet,
      near_miss: nearMiss,
      ...(normalize ? {} : { hint: 'Text matching is exact. Retry with normalize:true for case- and whitespace-insensitive matching.' }),
    },
  );
}

/**
 * Read the observable state of one element in a single round trip. Written as
 * a DOM function so every property is sampled at the same instant.
 */
const OBSERVE_STATE_FN = `function () {
  const el = this;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  const hiddenByStyle = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  const visible = !hiddenByStyle && rect.width > 0 && rect.height > 0;
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return {
    visible: visible,
    enabled: !disabled,
    checked: typeof el.checked === 'boolean' ? el.checked : null,
    focused: document.activeElement === el,
    value: typeof el.value === 'string' ? el.value : null,
    text: text.slice(0, 500),
    in_viewport: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}`;

/**
 * Assert several things about one element at once, returning pass/fail plus the
 * state actually observed. Compresses the common evaluate-then-eyeball-the-JSON
 * loop into one call that reads clearly in a transcript.
 */
export async function expect(
  ctx: OpsContext,
  args: PageArgs & {
    visible?: boolean;
    enabled?: boolean;
    checked?: boolean;
    focused?: boolean;
    in_viewport?: boolean;
    text_contains?: string;
    value?: string;
    timeout_ms?: number;
    poll_ms?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const timeout = Math.min(args.timeout_ms ?? 0, 120_000);
  const poll = Math.max(args.poll_ms ?? 100, 25);
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  const expectations: Array<[string, unknown]> = [];
  for (const key of ['visible', 'enabled', 'checked', 'focused', 'in_viewport'] as const) {
    if (args[key] !== undefined) expectations.push([key, args[key]]);
  }
  if (args.text_contains !== undefined) expectations.push(['text_contains', args.text_contains]);
  if (args.value !== undefined) expectations.push(['value', args.value]);
  if (expectations.length === 0) {
    throw new AgentBrowserError('no_expectation', 'Provide at least one expectation, e.g. visible:true.');
  }

  let state: Record<string, unknown> = {};
  let failures: Array<Record<string, unknown>> = [];
  let notFound: string | null = null;

  // With no timeout this runs exactly once; with one it retries until the
  // expectations hold, so a passing assertion is never a race.
  for (;;) {
    notFound = null;
    try {
      const element = await resolveElement(instance, target, args);
      const response = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
        objectId: element.objectId,
        returnByValue: true,
        functionDeclaration: OBSERVE_STATE_FN,
      });
      state = (response.result.value ?? {}) as Record<string, unknown>;

      failures = [];
      for (const [key, want] of expectations) {
        if (key === 'text_contains') {
          const actual = String(state.text ?? '');
          if (!actual.includes(String(want))) {
            failures.push({ expectation: 'text_contains', expected: want, actual });
          }
          continue;
        }
        const actual = state[key];
        if (actual !== want) failures.push({ expectation: key, expected: want, actual: actual ?? null });
      }
      if (failures.length === 0) break;
    } catch (err) {
      if (err instanceof NotFoundError) {
        notFound = err.message;
        failures = [{ expectation: 'element_exists', expected: true, actual: false }];
      } else {
        throw err;
      }
    }
    if (Date.now() >= deadline) break;
    await delay(poll);
  }

  const pass = failures.length === 0;
  return {
    target_id: target.handle,
    pass,
    ...(notFound ? { error: notFound } : {}),
    ...(pass ? {} : { failures }),
    observed: state,
    checked_expectations: expectations.map(([k]) => k),
    waited_ms: Date.now() - startedAt,
  };
}

/**
 * Sample predicates on a fixed interval and return the timeline.
 *
 * Hand-rolling this as a promise loop inside js.evaluate is both boilerplate
 * and a place for the measurement harness itself to be buggy; the interesting
 * signal (how long the UI sat locked, when a step actually appeared) is a
 * property of the timeline, not of any single reading.
 */
export async function observe(
  ctx: OpsContext,
  args: PageArgs & {
    sample?: Record<string, string>;
    selector?: string;
    every_ms?: number;
    for_ms?: number;
    stop_when?: string;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const every = Math.max(args.every_ms ?? 250, 25);
  const duration = Math.min(args.for_ms ?? 10_000, 300_000);

  /*
   * Watching one element change over time is the common case by a wide margin -
   * a retry counter, a status line, a progress label. Requiring the caller to
   * write the expression for it is what pushes agents into polling by hand.
   */
  const sample: Record<string, string> =
    args.sample && Object.keys(args.sample).length > 0
      ? args.sample
      : args.selector
        ? {
            text: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : null; })()`,
          }
        : {};
  const keys = Object.keys(sample);
  if (keys.length === 0) {
    throw new AgentBrowserError(
      'no_sample',
      'Provide selector to watch one element, or sample as {name: "js expression"} pairs.',
    );
  }

  /*
   * Every expression is evaluated in one object literal per tick, so the whole
   * row shares a timestamp instead of drifting across several round trips.
   */
  const rowExpression = `({${keys
    .map((k) => `${JSON.stringify(k)}: (() => { try { return (${sample[k]}); } catch (e) { return '<error: ' + e.message + '>'; } })()`)
    .join(',')}})`;
  const stopExpression = args.stop_when
    ? `(() => { try { return !!(${args.stop_when}); } catch (e) { return false; } })()`
    : null;

  const startedAt = Date.now();
  const deadline = startedAt + duration;
  const samples: Array<Record<string, unknown>> = [];
  let stopped = false;

  while (Date.now() < deadline) {
    const t = Date.now() - startedAt;
    try {
      const { result } = await evaluate(instance, target, {
        expression: stopExpression ? `[${rowExpression}, ${stopExpression}]` : rowExpression,
        returnByValue: true,
        awaitPromise: false,
      });
      if (stopExpression) {
        const pair = (result.value ?? []) as unknown[];
        samples.push({ t, ...(pair[0] as Record<string, unknown>) });
        if (pair[1] === true) {
          stopped = true;
          break;
        }
      } else {
        samples.push({ t, ...((result.value ?? {}) as Record<string, unknown>) });
      }
    } catch {
      // Navigation tears down the context; record the gap and keep sampling.
      samples.push({ t, _unavailable: true });
    }
    const drift = every - ((Date.now() - startedAt) % every);
    await delay(drift > 0 ? drift : every);
  }

  /* Runs of an unchanged value are the thing worth reading: a stall is a run. */
  const transitions: Array<Record<string, unknown>> = [];
  for (const key of keys) {
    let previous: string | undefined;
    let since = 0;
    for (const sample of samples) {
      // Samples taken while the context was gone say nothing about the value.
      if (sample._unavailable === true) continue;
      const encoded = JSON.stringify(sample[key] ?? null);
      const t = sample.t as number;
      if (previous === undefined) {
        previous = encoded;
        since = t;
        continue;
      }
      if (encoded !== previous) {
        transitions.push({
          key,
          from: JSON.parse(previous),
          to: sample[key] ?? null,
          at_ms: t,
          held_ms: t - since,
        });
        previous = encoded;
        since = t;
      }
    }
  }
  transitions.sort((a, b) => (a.at_ms as number) - (b.at_ms as number));

  return {
    target_id: target.handle,
    sampled: keys,
    ...(args.selector ? { selector: args.selector } : {}),
    every_ms: every,
    duration_ms: Date.now() - startedAt,
    sample_count: samples.length,
    stopped_early: stopped,
    transitions,
    samples,
  };
}

// ---------------------------------------------------------------- dialogs + viewport

export async function listDialogs(
  ctx: OpsContext,
  args: { browser_id?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  return {
    browser_id: instance.id,
    dialogs: instance.pages.listDialogs().map((d) => ({
      target_id: d.targetHandle,
      type: d.type,
      message: d.message,
      default_prompt: d.defaultPrompt ?? null,
      url: d.url,
      opened_at: new Date(d.openedAt).toISOString(),
    })),
  };
}

export async function handleDialog(
  ctx: OpsContext,
  args: PageArgs & { accept: boolean; prompt_text?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.handle_dialog');
  const dialog = instance.pages.getDialog(target.handle);
  if (!dialog) throw new NotFoundError('open dialog on target', target.handle);
  await target.session.send('Page.handleJavaScriptDialog', {
    accept: args.accept,
    ...(args.prompt_text === undefined ? {} : { promptText: args.prompt_text }),
  });
  instance.pages.clearDialog(target.handle);
  return { target_id: target.handle, handled: true, accepted: args.accept, message: dialog.message };
}

export async function setViewport(
  ctx: OpsContext,
  args: PageArgs & {
    width: number;
    height: number;
    device_scale_factor?: number;
    mobile?: boolean;
    reset?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.set_viewport');
  if (args.reset) {
    await target.session.send('Emulation.clearDeviceMetricsOverride');
    return { target_id: target.handle, reset: true };
  }
  await target.session.send('Emulation.setDeviceMetricsOverride', {
    width: args.width,
    height: args.height,
    deviceScaleFactor: args.device_scale_factor ?? 1,
    mobile: args.mobile === true,
  });
  return {
    target_id: target.handle,
    width: args.width,
    height: args.height,
    mobile: args.mobile === true,
  };
}

export async function listFrames(ctx: OpsContext, args: PageArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const { frameTree } = await target.session.send<{ frameTree: FrameTree }>('Page.getFrameTree');
  const contexts = instance.contexts.list(target.handle);

  const frames: Array<Record<string, unknown>> = [];
  const walk = (node: FrameTree, depth: number): void => {
    const ctxForFrame = contexts.find((c) => c.frameId === node.frame.id);
    frames.push({
      frame_id: node.frame.id,
      parent_frame_id: node.frame.parentId ?? null,
      depth,
      url: node.frame.url,
      name: node.frame.name ?? null,
      origin: node.frame.securityOrigin,
      has_execution_context: ctxForFrame !== undefined,
      execution_context_id: ctxForFrame?.id ?? null,
    });
    for (const child of node.childFrames ?? []) walk(child, depth + 1);
  };
  walk(frameTree, 0);

  return {
    target_id: target.handle,
    frame_count: frames.length,
    frames,
    hint: 'Pass frame_id to dom/js operations to work inside a same-process iframe. Cross-origin iframes appear as their own target_id in page.list_tabs(include_all_targets=true).',
  };
}

// ---------------------------------------------------------------- filmstrip

export interface FilmstripArgs extends PageArgs {
  duration_ms?: number;
  frames?: number;
  columns?: number;
  frame_width?: number;
  quality?: number;
  label?: string;
  save_path?: string;
  return_image?: boolean;
  scroll_by?: number;
  hover?: string;
  reload?: boolean;
}

interface FilmFrame {
  data: string;
  /** ms since recording started */
  at: number;
}

/**
 * Even sampling across the recording.
 *
 * The screencast pushes a frame whenever the compositor produces one, so they
 * arrive at irregular intervals and there are usually far more than wanted.
 * Taking the first N would show the first fraction of a second and nothing
 * else, which is the obvious mistake here; this picks the frame nearest each
 * evenly spaced timestamp instead.
 */
function sampleFrames(frames: FilmFrame[], want: number): FilmFrame[] {
  if (frames.length <= want) return frames;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return frames.slice(0, want);
  const span = last.at - first.at;
  if (span <= 0) return frames.slice(0, want);
  const used = new Set<number>();
  const out: FilmFrame[] = [];
  for (let i = 0; i < want; i += 1) {
    const wanted = first.at + (span * i) / (want - 1 || 1);
    let best = -1;
    let bestGap = Infinity;
    frames.forEach((f, idx) => {
      if (used.has(idx)) return;
      const gap = Math.abs(f.at - wanted);
      if (gap < bestGap) {
        bestGap = gap;
        best = idx;
      }
    });
    const chosen = best >= 0 ? frames[best] : undefined;
    if (chosen) {
      used.add(best);
      out.push(chosen);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Record the page for a moment and tile the frames into ONE image.
 *
 * WHY THIS EXISTS. A screenshot is a single instant, which is the wrong
 * instrument for most questions about a modern page: does the entrance land or
 * stall, does the hover move anything, does the reveal fire, does a scrubbed
 * effect track the scroll. Repeated page.screenshot calls do not answer them
 * either - each forces its own frame at an arbitrary moment, and a
 * backgrounded or occluded window may not be producing frames at all in
 * between, so every capture looks identical and frozen.
 *
 * The screencast pushes frames as the compositor makes them, and laying the
 * samples out as a contact sheet is what makes them readable: the same element
 * at t0, t1, t2 with its position changing reads as motion, where three
 * separate screenshots read as three unrelated pictures.
 *
 * NO IMAGE LIBRARY. This package depends on no image toolkit, and adding one
 * to tile a few JPEGs would be a heavy dependency for a single feature (sharp
 * ships prebuilt native binaries per platform). The browser already has a
 * capable 2D compositor, so the frames are drawn onto a canvas in a SCRATCH
 * TAB and exported as one JPEG. It has to be a scratch tab: drawing into the
 * page under test would mutate the thing being measured.
 */
export async function filmstrip(
  ctx: OpsContext,
  args: FilmstripArgs,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);

  const durationMs = Math.min(Math.max(args.duration_ms ?? 2_000, 200), 15_000);
  const want = Math.min(Math.max(args.frames ?? 8, 2), 24);
  const columns = Math.min(Math.max(args.columns ?? 4, 1), 6);
  const frameWidth = Math.min(Math.max(args.frame_width ?? 320, 120), 800);
  const quality = Math.min(Math.max(args.quality ?? 72, 1), 100);

  const frames: FilmFrame[] = [];
  const started = Date.now();

  /*
   * Frames MUST be acknowledged or Chromium stops sending after the first
   * couple. The ack carries the sessionId the frame arrived with.
   */
  const off = target.session.on('Page.screencastFrame', (params) => {
    const p = params as { data?: string; sessionId?: number };
    if (typeof p.data !== 'string') return;
    frames.push({ data: p.data, at: Date.now() - started });
    if (typeof p.sessionId === 'number') {
      void target.session.trySend('Page.screencastFrameAck', { sessionId: p.sessionId });
    }
  });

  try {
    await target.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: Math.min(quality + 10, 100),
      maxWidth: Math.round(frameWidth * 2),
      everyNthFrame: 1,
    });

    /*
     * The optional actions run INSIDE the recording window, which is the whole
     * point: an entrance, a hover response or a scrubbed scroll effect only
     * exists while something is happening.
     */
    if (args.reload) await target.session.trySend('Page.reload', { ignoreCache: false });

    if (args.hover) {
      const point = await evaluate(instance, target, {
        expression:
          '(() => { const el = document.querySelector(' +
          JSON.stringify(args.hover) +
          '); if (!el) return null; const r = el.getBoundingClientRect(); ' +
          'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()',
        returnByValue: true,
        awaitPromise: false,
      }).catch(() => null);
      const value = point?.result?.value as { x: number; y: number } | null | undefined;
      if (value) {
        await target.session.trySend('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: value.x,
          y: value.y,
        });
      }
    }

    if (args.scroll_by) {
      // Stepped, not jumped: a scrubbed effect is only visible if the scroll
      // actually passes through the intermediate positions.
      const steps = 12;
      for (let i = 0; i < steps; i += 1) {
        await target.session.trySend('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 10,
          y: 10,
          deltaX: 0,
          deltaY: args.scroll_by / steps,
        });
        await delay(Math.max(16, durationMs / steps / 2));
      }
    }

    await delay(durationMs);
  } finally {
    await target.session.trySend('Page.stopScreencast');
    off();
  }

  if (!frames.length) {
    throw new AgentBrowserError(
      'no_frames',
      'The screencast produced no frames, so there is nothing to tile.',
      {
        operation: 'page.filmstrip',
        hint:
          'A backgrounded or occluded window may not composite at all. Bring it on screen with browser.reveal, ' +
          'or give the page a reason to paint via reload / hover / scroll_by.',
      },
    );
  }

  const picked = sampleFrames(frames, want);

  const { targetId } = await instance.browserSession.send<{ targetId: string }>(
    'Target.createTarget',
    { url: 'about:blank', background: true },
  );
  const scratch = await waitForTarget(instance, targetId, 10_000);

  let sheet = '';
  let sheetW = 0;
  let sheetH = 0;
  try {
    const script =
      '(async () => {' +
      '  const srcs = ' + JSON.stringify(picked.map((f) => f.data)) + ';' +
      '  const labels = ' + JSON.stringify(picked.map((f) => String(f.at) + 'ms')) + ';' +
      '  const cols = ' + columns + ';' +
      '  const fw = ' + frameWidth + ';' +
      '  const imgs = await Promise.all(srcs.map((d) => new Promise((res, rej) => {' +
      '    const im = new Image();' +
      '    im.onload = () => res(im);' +
      '    im.onerror = rej;' +
      '    im.src = "data:image/jpeg;base64," + d;' +
      '  })));' +
      '  const ratio = imgs[0].naturalHeight / imgs[0].naturalWidth;' +
      '  const fh = Math.round(fw * ratio);' +
      '  const rows = Math.ceil(imgs.length / cols);' +
      '  const pad = 6; const bar = 18;' +
      '  const c = document.createElement("canvas");' +
      '  c.width = cols * fw + pad * (cols + 1);' +
      '  c.height = rows * (fh + bar) + pad * (rows + 1);' +
      '  const g = c.getContext("2d");' +
      '  g.fillStyle = "#111"; g.fillRect(0, 0, c.width, c.height);' +
      '  imgs.forEach((im, i) => {' +
      '    const x = pad + (i % cols) * (fw + pad);' +
      '    const y = pad + Math.floor(i / cols) * (fh + bar + pad);' +
      '    g.drawImage(im, x, y, fw, fh);' +
      '    g.fillStyle = "#7fffd4";' +
      '    g.font = "12px ui-monospace, monospace";' +
      '    g.fillText((i + 1) + "  " + labels[i], x + 2, y + fh + 13);' +
      '  });' +
      '  return { data: c.toDataURL("image/jpeg", ' + quality / 100 + ').split(",")[1], w: c.width, h: c.height };' +
      '})()';

    const composed = await evaluate(instance, scratch, {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = composed.result.value as { data: string; w: number; h: number };
    sheet = value.data;
    sheetW = value.w;
    sheetH = value.h;
  } finally {
    await instance.browserSession
      .send('Target.closeTarget', { targetId })
      .catch(() => undefined);
  }

  const buffer = Buffer.from(sheet, 'base64');
  const artifact = ctx.stores.artifacts.put('screenshot', buffer, {
    browserId: instance.id,
    label: args.label ?? 'filmstrip',
    mime: 'image/jpeg',
    sourceRef: target.handle,
    meta: { kind: 'filmstrip', frames: picked.length, url: target.info.url },
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    url: await currentUrl(instance, target),
    duration_ms: durationMs,
    frames_captured: frames.length,
    frames_in_sheet: picked.length,
    columns,
    sheet_size: { width: sheetW, height: sheetH },
    timestamps_ms: picked.map((f) => f.at),
    size_bytes: buffer.length,
    artifact: toArtifactRef(artifact),
    hint:
      'Frames run left to right, top to bottom, each labelled with its offset from the start of the recording. ' +
      'Compare the SAME element across cells to read the motion; identical cells mean nothing moved.',
  };

  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  if (args.return_image !== false) {
    out._image = { data: sheet, mime: 'image/jpeg' };
  }
  return out;
}
