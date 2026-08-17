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

/** Chromium does not report focus directly; the visible page is the best proxy. */
async function currentActiveTarget(instance: BrowserInstance): Promise<string | null> {
  for (const target of instance.targets.listPages()) {
    try {
      const { result } = await evaluate(instance, target, {
        expression: 'document.visibilityState === "visible" && document.hasFocus()',
        returnByValue: true,
        awaitPromise: false,
      });
      if (result.value === true) return target.handle;
    } catch {
      /* target may be navigating */
    }
  }
  return null;
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

async function waitForTarget(
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
  return {
    target_id: target.handle,
    requested_url: args.url,
    url: current,
    frame_id: result.frameId,
    error: result.errorText ?? null,
    wait_until: waitUntil,
    settled: settled === null ? undefined : settled,
    timed_out: settled === false,
  };
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

export async function screenshot(
  ctx: OpsContext,
  args: PageArgs & {
    mode?: 'viewport' | 'full_page' | 'element';
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    save_path?: string;
    return_image?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const mode = args.mode ?? 'viewport';
  const format = args.format ?? 'png';
  const params: Record<string, unknown> = { format, captureBeyondViewport: false };
  if (format !== 'png' && args.quality !== undefined) params.quality = args.quality;

  if (mode === 'full_page') {
    const metrics = await target.session.send<{
      cssContentSize: { width: number; height: number };
    }>('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
    params.captureBeyondViewport = true;
  } else if (mode === 'element') {
    const element = await resolveElement(instance, target, args);
    const box = await boundingBox(target.session, element.objectId);
    if (!box) throw new AgentBrowserError('not_visible', 'Element has no box to capture.');
    params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    params.captureBeyondViewport = true;
  }

  const { data } = await target.session.send<{ data: string }>(
    'Page.captureScreenshot',
    params,
    60_000,
  );
  const buffer = Buffer.from(data, 'base64');
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const artifact = ctx.stores.artifacts.put('screenshot', buffer, {
    browserId: instance.id,
    label: `${mode}-${new URL(await currentUrl(instance, target), 'http://x').hostname || 'page'}`,
    mime,
    sourceRef: target.handle,
    meta: { mode, url: target.info.url },
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    mode,
    format,
    size_bytes: buffer.length,
    artifact: toArtifactRef(artifact),
    url: await currentUrl(instance, target),
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

  const root = nodes[0];
  if (root) walk(root.nodeId, 0);

  // Refs are only meaningful against the snapshot that produced them.
  instance.snapshotRefs.set(target.handle, refs);

  return {
    target_id: target.handle,
    url: await currentUrl(instance, target),
    title: target.info.title,
    node_count: emitted,
    truncated,
    ref_count: refs.size,
    snapshot: lines.join('\n'),
    hint: 'Pass ref="eNN" to page.click / page.type / dom.inspect. Refs expire on the next snapshot.',
  };
}

// ---------------------------------------------------------------- interaction

export async function click(
  ctx: OpsContext,
  args: PageArgs & {
    button?: 'left' | 'right' | 'middle';
    click_count?: number;
    modifiers?: string[];
    force?: boolean;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('page.click');
  const element = await resolveElement(instance, target, args);
  const center = await contentCenter(target.session, element.objectId);
  const modifiers = modifiersFromNames(args.modifiers);
  const button = args.button ?? 'left';
  const clickCount = args.click_count ?? 1;

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
    return {
      target_id: target.handle,
      clicked: element.description,
      at: { x: Math.round(center.x), y: Math.round(center.y) },
      input: 'touch',
      click_count: clickCount,
    };
  }

  const base = { x: center.x, y: center.y, button, modifiers, clickCount };
  await target.session.send('Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseMoved',
    button: 'none',
    clickCount: 0,
  });
  await target.session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await target.session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });

  return {
    target_id: target.handle,
    clicked: element.description,
    at: { x: Math.round(center.x), y: Math.round(center.y) },
    input: 'mouse',
    button,
    click_count: clickCount,
  };
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
    at: { x: Math.round(center.x), y: Math.round(center.y) },
  };
}

export async function typeText(
  ctx: OpsContext,
  args: PageArgs & {
    text: string;
    clear?: boolean;
    delay_ms?: number;
    fast?: boolean;
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

  if (args.fast) {
    await target.session.send('Input.insertText', { text: args.text });
  } else {
    for (const char of args.text) {
      await dispatchChar(target.session, char);
      if (args.delay_ms) await delay(args.delay_ms);
    }
  }

  if (args.press_enter) await pressKey(target.session, 'Enter', 0);

  return {
    target_id: target.handle,
    typed_into: element.description,
    characters: [...args.text].length,
    cleared: args.clear === true,
    pressed_enter: args.press_enter === true,
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
  await target.session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(metrics.cssLayoutViewport.clientWidth / 2),
    y: Math.round(metrics.cssLayoutViewport.clientHeight / 2),
    deltaX: args.delta_x ?? 0,
    deltaY: args.delta_y ?? 400,
  });
  const { result } = await evaluate(instance, target, {
    expression: '[window.scrollX, window.scrollY]',
    returnByValue: true,
  });
  return {
    target_id: target.handle,
    delta_x: args.delta_x ?? 0,
    delta_y: args.delta_y ?? 400,
    position: result.value,
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

export async function extractText(
  ctx: OpsContext,
  args: PageArgs & { max_chars?: number; include_hidden?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const hasLocator =
    args.selector !== undefined || args.ref !== undefined || args.xpath !== undefined || args.backend_node_id !== undefined;

  let text: string;
  if (hasLocator) {
    const element = await resolveElement(instance, target, args);
    const response = await target.session.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      {
        objectId: element.objectId,
        returnByValue: true,
        functionDeclaration: `function (includeHidden) {
          return includeHidden ? (this.textContent || '') : (this.innerText || this.textContent || '');
        }`,
        arguments: [{ value: args.include_hidden === true }],
      },
    );
    text = String(response.result.value ?? '');
  } else {
    const { result } = await evaluate(instance, target, {
      expression: args.include_hidden
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
    text: body,
  };
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

export async function waitFor(
  ctx: OpsContext,
  args: PageArgs & {
    selector?: string;
    text?: string;
    gone?: boolean;
    timeout_ms?: number;
    poll_ms?: number;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const timeout = Math.min(args.timeout_ms ?? 10_000, 120_000);
  const poll = Math.max(args.poll_ms ?? 100, 25);
  const deadline = Date.now() + timeout;

  if (!args.selector && !args.text) {
    throw new AgentBrowserError('no_condition', 'Provide selector or text to wait for.');
  }

  const expression = args.selector
    ? `!!document.querySelector(${JSON.stringify(args.selector)})`
    : `(document.body ? document.body.innerText : '').includes(${JSON.stringify(args.text)})`;

  while (Date.now() < deadline) {
    try {
      const { result } = await evaluate(instance, target, {
        expression,
        returnByValue: true,
        awaitPromise: false,
      });
      const present = result.value === true;
      if (present !== (args.gone === true)) {
        return {
          target_id: target.handle,
          matched: true,
          waited_ms: timeout - (deadline - Date.now()),
          condition: args.gone ? 'gone' : 'present',
        };
      }
    } catch {
      // Navigation destroys the context mid-poll; keep waiting.
    }
    await delay(poll);
  }
  throw new TimeoutError(
    `wait for ${args.selector ? `selector ${args.selector}` : `text "${args.text}"`} to be ${args.gone ? 'gone' : 'present'}`,
    timeout,
  );
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
