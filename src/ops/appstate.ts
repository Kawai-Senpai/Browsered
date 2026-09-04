/**
 * Application-level error state.
 *
 * console.exceptions answers a platform question: what reached window.onerror.
 * Modern front-end frameworks make that question the wrong one. TanStack Query,
 * SWR, Redux Toolkit and Apollo all catch the errors their own code paths raise
 * and park them in state, so a mutation can throw, be recorded as status
 * 'error', roll its optimistic update back, and leave the console completely
 * empty. The page then looks inert rather than broken.
 *
 * That failure shape cost a real session: a Send button whose handler threw
 * `crypto.randomUUID is not a function` on a non-HTTPS origin. Zero console
 * exceptions, zero failed requests (the throw happened before any request was
 * built), an enabled button, and a working handler. The error was sitting in a
 * React fiber the whole time.
 *
 * These probes read that state directly. They run entirely in the page and
 * return plain data, so nothing here depends on a framework being present: each
 * detector reports what it found and says so when it found nothing.
 */

import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { evaluate } from './element.js';

export interface AppStateArgs {
  browser_id?: string;
  target_id?: string;
  frame_id?: string;
}

async function pageOf(ctx: OpsContext, args: AppStateArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolveTarget(args.target_id);
  return { instance, target };
}

/**
 * Run a probe and hand back its value.
 *
 * Probes are authored as complete IIFEs so nothing leaks into the page's global
 * scope and repeated calls never collide on a redeclared binding - the failure
 * that makes hand-written js.evaluate probes throw SyntaxError on the second
 * run.
 */
async function runProbe(
  instance: BrowserInstance,
  target: ManagedTarget,
  expression: string,
  frameId?: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  const options = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: false,
    timeoutMs,
    ...(frameId ? { frameId } : {}),
  };
  const { result, exceptionText } = await evaluate(instance, target, options);
  if (exceptionText) {
    throw new AgentBrowserError('probe_failed', `Probe threw in the page: ${exceptionText}`);
  }
  return result.value;
}

/* ------------------------------- probe source ------------------------------ */

/**
 * Shared page-side helpers.
 *
 * Kept as one string so each probe embeds only what it needs and the whole
 * thing stays readable as JavaScript rather than as an escaped blob.
 */
const HELPERS = `
  const MAX_STR = 400;
  const clip = (v) => {
    if (v === null || v === undefined) return v;
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    return s.length > MAX_STR ? s.slice(0, MAX_STR) + '…' : s;
  };
  const errText = (e) => {
    if (!e) return null;
    if (typeof e === 'string') return clip(e);
    const name = e.name || 'Error';
    const msg = e.message || String(e);
    return clip(name + ': ' + msg);
  };
  const errStack = (e) => (e && e.stack ? clip(String(e.stack).slice(0, 1200)) : null);
  const fiberKeyOf = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  const propsKeyOf = (el) => Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const roots = () => {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const k = fiberKeyOf(node);
      if (k) out.push(node[k]);
    };
    document.querySelectorAll('*').forEach((el) => {
      if (out.length > 400) return;
      walk(el);
    });
    return out;
  };
`;

/**
 * Detect async-state containers holding an error.
 *
 * Rather than importing framework internals, this shape-matches the state
 * objects React Query and SWR store on hooks: an object carrying both a status
 * and an error/isPending pair. That keeps it working across major versions,
 * where internal APIs do not.
 */
const QUERY_STATE_PROBE = `(() => {
  ${HELPERS}
  if (typeof document === 'undefined') return { framework: null, reason: 'no document' };

  const fibers = roots();
  if (!fibers.length) return { framework: null, reason: 'no React fibers found on any element' };

  const found = [];
  const seenFibers = new Set();

  const isAsyncState = (s) =>
    s && typeof s === 'object' &&
    ('status' in s) &&
    ('isPending' in s || 'isLoading' in s || 'isError' in s || 'error' in s);

  const scanFiber = (fiber) => {
    let node = fiber;
    let depth = 0;
    while (node && depth < 60) {
      if (!seenFibers.has(node)) {
        seenFibers.add(node);
        const name = typeof node.type === 'function'
          ? (node.type.displayName || node.type.name || '(anonymous)')
          : null;
        if (name) {
          let hook = node.memoizedState;
          let i = 0;
          while (hook && i < 60) {
            const s = hook.memoizedState;
            if (isAsyncState(s)) {
              const status = s.status;
              const hasError = status === 'error' || s.isError === true || (s.error != null);
              if (hasError) {
                found.push({
                  component: name,
                  hook_index: i,
                  status: status ?? null,
                  is_pending: s.isPending ?? s.isLoading ?? null,
                  failure_count: s.failureCount ?? null,
                  error: errText(s.error),
                  error_stack: errStack(s.error),
                });
              }
            }
            hook = hook.next;
            i++;
          }
        }
      }
      node = node.return;
      depth++;
    }
  };

  for (const f of fibers) {
    if (found.length > 40) break;
    scanFiber(f);
  }

  // De-duplicate: the same hook is reachable from many DOM nodes.
  const uniq = [];
  const key = new Set();
  for (const f of found) {
    const k = f.component + '#' + f.hook_index + '#' + (f.error || '');
    if (key.has(k)) continue;
    key.add(k);
    uniq.push(f);
  }

  return {
    framework: 'react',
    fibers_scanned: seenFibers.size,
    errors: uniq,
  };
})()`;

/** Redux / Zustand style stores that expose an error field. */
const STORE_PROBE = `(() => {
  ${HELPERS}
  const out = [];

  // Redux DevTools registers every store it knows about.
  try {
    const hook = window.__REDUX_DEVTOOLS_EXTENSION__;
    if (hook && typeof hook.connect === 'function') out.push({ store: 'redux', detected: true, note: 'Redux DevTools hook present; state not read (no stable public accessor).' });
  } catch { /* ignore */ }

  const scanPlain = (obj, label) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      const looksError = /error|failure|exception/i.test(k);
      if (looksError && v !== false) {
        out.push({ store: label, key: k, value: clip(v) });
      }
    }
  };

  // Common globals apps attach for debugging.
  for (const g of ['__APP_STATE__', '__STORE__', 'store', '__ZUSTAND__']) {
    try {
      const cand = window[g];
      if (cand && typeof cand.getState === 'function') scanPlain(cand.getState(), g);
      else if (cand && typeof cand === 'object') scanPlain(cand, g);
    } catch { /* ignore */ }
  }

  return { entries: out };
})()`;

/**
 * Secure context and the APIs it gates.
 *
 * An app served over plain http:// on a bare IP silently loses a set of
 * browser APIs that exist on localhost, which is why "works on my machine"
 * survives local testing and dies on staging.
 */
const CAPABILITY_PROBE = `(() => {
  const gated = {
    'crypto.randomUUID': typeof (window.crypto && window.crypto.randomUUID),
    'crypto.subtle': typeof (window.crypto && window.crypto.subtle),
    'navigator.clipboard': typeof navigator.clipboard,
    'navigator.serviceWorker': typeof navigator.serviceWorker,
    'navigator.geolocation': typeof navigator.geolocation,
    'navigator.mediaDevices': typeof navigator.mediaDevices,
  };
  const missing = Object.entries(gated)
    .filter(([, t]) => t === 'undefined')
    .map(([name]) => name);
  return {
    is_secure_context: window.isSecureContext === true,
    origin: location.origin,
    protocol: location.protocol,
    gated_apis: gated,
    missing_apis: missing,
  };
})()`;

/* --------------------------------- ops ------------------------------------ */

/**
 * Every error the application is holding that the console never showed.
 *
 * Start here when a control does nothing and console.exceptions is empty:
 * an empty console is not evidence that nothing threw.
 */
export async function appErrorState(
  ctx: OpsContext,
  args: AppStateArgs & { include_capabilities?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);

  const [queryState, stores, capabilities] = await Promise.all([
    runProbe(instance, target, QUERY_STATE_PROBE, args.frame_id).catch((e) => ({
      framework: null,
      probe_error: String(e instanceof Error ? e.message : e),
    })),
    runProbe(instance, target, STORE_PROBE, args.frame_id).catch(() => ({ entries: [] })),
    args.include_capabilities === false
      ? Promise.resolve(null)
      : runProbe(instance, target, CAPABILITY_PROBE, args.frame_id).catch(() => null),
  ]);

  const qs = queryState as Record<string, unknown>;
  const errors = Array.isArray(qs?.errors) ? (qs.errors as unknown[]) : [];
  const storeEntries = Array.isArray((stores as Record<string, unknown>)?.entries)
    ? ((stores as Record<string, unknown>).entries as unknown[])
    : [];
  const caps = capabilities as Record<string, unknown> | null;

  const notes: string[] = [];
  if (errors.length === 0 && storeEntries.length === 0) {
    notes.push(
      'No framework-held errors found. If a control still does nothing, the handler may be returning early at a guard: read its props with inspector.element and check each condition.',
    );
  }
  if (caps && caps.is_secure_context === false) {
    const missing = Array.isArray(caps.missing_apis) ? (caps.missing_apis as string[]) : [];
    if (missing.length) {
      notes.push(
        `This origin is NOT a secure context, so ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} undefined here but present on localhost. Code calling them throws only in this environment.`,
      );
    }
  }

  return {
    target_id: target.handle,
    url: target.info?.url ?? null,
    framework_errors: errors,
    store_errors: storeEntries,
    capabilities: caps,
    fibers_scanned: qs?.fibers_scanned ?? null,
    notes,
    hint: 'Errors here never reached window.onerror, so console.exceptions cannot show them. A framework that caught an error also usually rolled its optimistic update back, which is why the UI looks unchanged.',
  };
}

/**
 * Click something and report what the application actually did about it.
 *
 * page.click answers "did the DOM move". That is not the same question as "did
 * the app handle this", and on a re-rendering page the two answers differ. This
 * samples error state and request counts either side of the click so a dead
 * control reports as dead rather than as twelve DOM mutations.
 */
/**
 * Real click listeners on an element, via CDP.
 *
 * Page JavaScript cannot enumerate addEventListener registrations, so a probe
 * alone can only ever report "no React prop", which is not the same as "no
 * handler". DOMDebugger answers the actual question, and the difference decides
 * whether a dead control is unwired or merely guarded.
 */
async function clickListenerCount(
  instance: BrowserInstance,
  target: ManagedTarget,
  selector: string | null,
  text: string | null,
): Promise<number | null> {
  try {
    const expr = selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : `[...document.querySelectorAll('button,a,[role=button],input[type=submit]')].find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text ?? '')}))`;
    const { result } = await evaluate(instance, target, {
      expression: expr,
      returnByValue: false,
      awaitPromise: false,
      timeoutMs: 5_000,
    });
    if (!result.objectId) return null;
    const listeners = await target.session
      .send<{ listeners: Array<{ type: string }> }>('DOMDebugger.getEventListeners', {
        objectId: result.objectId,
      })
      .catch(() => null);
    if (!listeners) return null;
    return listeners.listeners.filter((l) => l.type === 'click').length;
  } catch {
    return null;
  }
}

export async function diagnoseInteraction(
  ctx: OpsContext,
  args: AppStateArgs & { selector?: string; ref?: string; text?: string; settle_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('app.diagnose_interaction');

  if (!args.selector && !args.ref && !args.text) {
    throw new AgentBrowserError('no_locator', 'Provide selector, ref or text naming the control to click.');
  }

  const settle = Math.min(Math.max(args.settle_ms ?? 1500, 200), 15_000);

  /*
   * Instrumentation is installed, the click is driven from inside the page, and
   * the counters are read back after settling. Doing the click in-page keeps
   * the whole sequence on one side of the CDP boundary, so a handler that runs
   * synchronously cannot finish before instrumentation is armed.
   */
  const probe = `(() => {
    ${HELPERS}
    const sel = ${JSON.stringify(args.selector ?? null)};
    const txt = ${JSON.stringify(args.text ?? null)};

    let el = null;
    if (sel) el = document.querySelector(sel);
    if (!el && txt) {
      el = [...document.querySelectorAll('button,a,[role=button],input[type=submit]')]
        .find((n) => (n.textContent || '').trim().includes(txt)) || null;
    }
    if (!el) return { found: false };

    const pk = propsKeyOf(el);
    const props = pk ? el[pk] : null;

    const before = {
      disabled: el.disabled === true,
      disabled_prop: props ? props.disabled === true : null,
      has_click_handler: props ? typeof props.onClick === 'function' : null,
      handler_source: props && typeof props.onClick === 'function'
        ? clip(String(props.onClick).slice(0, 300))
        : null,
      text_inputs: [...document.querySelectorAll('input,textarea')].map((n) => n.value),
    };

    const calls = [];
    const of = window.fetch;
    const ox = XMLHttpRequest.prototype.open;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      window.fetch = of;
      XMLHttpRequest.prototype.open = ox;
    };
    window.fetch = function (...a) {
      calls.push({ kind: 'fetch', method: (a[1] && a[1].method) || 'GET', url: clip(String(a[0])) });
      return of.apply(this, a);
    };
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      calls.push({ kind: 'xhr', method: String(m), url: clip(String(u)) });
      return ox.call(this, m, u, ...r);
    };

    let threw = null;
    let returnedNormally = false;
    try {
      el.click();
      returnedNormally = true;
    } catch (e) {
      threw = { error: errText(e), stack: errStack(e) };
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        restore();
        const after = {
          text_inputs: [...document.querySelectorAll('input,textarea')].map((n) => n.value),
        };
        const inputsChanged = JSON.stringify(before.text_inputs) !== JSON.stringify(after.text_inputs);
        resolve({
          found: true,
          before,
          handler_returned_normally: returnedNormally,
          handler_threw: threw,
          requests_initiated: calls,
          inputs_changed: inputsChanged,
        });
      }, ${settle});
    });
  })()`;

  const clickResult = (await runProbe(instance, target, probe, args.frame_id, settle + 10_000)) as Record<
    string,
    unknown
  >;

  if (clickResult?.found === false) {
    return {
      target_id: target.handle,
      found: false,
      hint: 'No element matched. Take a page.snapshot and use a ref, or pass a more specific selector.',
    };
  }

  // Read error state after the interaction, which is where a swallowed throw lands.
  const errState = await appErrorState(ctx, { ...args, include_capabilities: true });
  const listenerCount = await clickListenerCount(instance, target, args.selector ?? null, args.text ?? null);

  const requests = Array.isArray(clickResult.requests_initiated)
    ? (clickResult.requests_initiated as unknown[])
    : [];
  const frameworkErrors = Array.isArray(errState.framework_errors)
    ? (errState.framework_errors as unknown[])
    : [];
  const before = (clickResult.before ?? {}) as Record<string, unknown>;

  /*
   * Order matters: facts about THIS element beat app-wide state. An unrelated
   * failed query elsewhere on the page must not be reported as the reason a
   * handler-less button did nothing.
   */
  let verdict: string;
  if (clickResult.handler_threw) {
    verdict = 'The click handler threw synchronously. See handler_threw.';
  } else if (requests.length === 0 && (before.has_click_handler === false || listenerCount === 0)) {
    verdict = 'No click handler is attached to this element. The click had nothing to run.';
  } else if (requests.length === 0 && before.disabled_prop === true) {
    verdict = 'The element is disabled, so its handler never ran.';
  } else if (requests.length === 0 && frameworkErrors.length > 0) {
    verdict =
      'No request was initiated and the application is holding an error. The handler most likely threw inside an async-state callback, which the framework caught. See framework_errors.';
  } else if (requests.length === 0) {
    verdict =
      'The handler ran and returned without initiating a request. It probably hit an early-return guard: read handler_source and check each condition against live state.';
  } else {
    verdict = `The handler ran and initiated ${requests.length} request${requests.length === 1 ? '' : 's'}.`;
  }

  return {
    target_id: target.handle,
    found: true,
    verdict,
    handler_attached: before.has_click_handler ?? (listenerCount === null ? null : listenerCount > 0),
    click_listeners: listenerCount,
    handler_source: before.handler_source ?? null,
    element_disabled: before.disabled_prop ?? before.disabled ?? null,
    handler_returned_normally: clickResult.handler_returned_normally ?? null,
    handler_threw: clickResult.handler_threw ?? null,
    requests_initiated: requests,
    inputs_changed: clickResult.inputs_changed ?? null,
    framework_errors: frameworkErrors,
    capabilities: errState.capabilities ?? null,
    notes: errState.notes ?? [],
    hint: 'inputs_changed:false alongside requests_initiated:[] is the signature of a guard that returned early: the app never consumed the input.',
  };
}
