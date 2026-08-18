import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import type { CdpSession } from '../cdp/session.js';
import type { RemoteObject } from '../cdp/types.js';
import { AgentBrowserError, NotFoundError } from '../util/errors.js';

/** Ways to point at an element. Exactly one primary locator is required. */
export interface ElementLocator {
  /** CSS selector, evaluated with querySelectorAll. */
  selector?: string;
  /** XPath expression. */
  xpath?: string;
  /** Visible text; matches the innermost element containing it. */
  text?: string;
  /** `ref=eNN` handle from a page.snapshot. */
  ref?: string;
  /** Raw CDP backend node id. */
  backend_node_id?: number;
  /** Restrict to a same-process iframe by frame id (see dom.frames). */
  frame_id?: string;
  /** Which match to use when a locator hits several elements. Default 0. */
  nth?: number;
}

export interface ResolvedElement {
  objectId: string;
  backendNodeId: number;
  nodeId: number;
  description: string;
  /** How many elements the locator matched; >1 means `nth` decided it. */
  matchedCount?: number;
  /**
   * Set when the match is a non-interactive node inside a button/link/input.
   * Clicking it usually works by bubbling, but it is a latent failure: on a
   * different layout the same locator lands on something that does nothing.
   */
  interactiveAncestor?: string;
}

const domReady = new WeakMap<CdpSession, boolean>();

/**
 * DOM node ids are only valid after the frontend has pulled a document, and
 * they are invalidated whenever the document changes. Refreshing before each
 * resolution is cheap at depth 0 and removes a whole class of stale-id bugs.
 */
export async function ensureDom(session: CdpSession): Promise<void> {
  if (!domReady.get(session)) {
    await session.trySend('DOM.enable');
    domReady.set(session, true);
  }
  await session.send('DOM.getDocument', { depth: 0 });
}

export interface EvaluateOptions {
  expression: string;
  frameId?: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  /** Exposes DevTools console helpers ($, $$, $x, copy, inspect...). */
  includeCommandLineAPI?: boolean;
  timeoutMs?: number;
  userGesture?: boolean;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionText?: string;
}

/**
 * Runtime.evaluate, optionally pinned to a specific frame's execution context
 * so same-process iframes are reachable.
 */
export async function evaluate(
  instance: BrowserInstance,
  target: ManagedTarget,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const params: Record<string, unknown> = {
    expression: options.expression,
    returnByValue: options.returnByValue ?? false,
    awaitPromise: options.awaitPromise ?? true,
    includeCommandLineAPI: options.includeCommandLineAPI ?? false,
    userGesture: options.userGesture ?? true,
    generatePreview: true,
  };

  if (options.frameId) {
    const ctx = instance.contexts.forFrame(target.handle, options.frameId);
    if (!ctx) {
      throw new NotFoundError(
        'execution context for frame',
        `${options.frameId} (call dom.frames to list frames that currently have one)`,
      );
    }
    params.contextId = ctx.id;
  }

  const response = await target.session.send<{
    result: RemoteObject;
    exceptionDetails?: { text: string; exception?: RemoteObject };
  }>('Runtime.evaluate', params, options.timeoutMs);

  if (response.exceptionDetails) {
    const detail = response.exceptionDetails;
    const message =
      detail.exception?.description ?? (detail.exception?.value as string) ?? detail.text;
    return { result: response.result, exceptionText: message };
  }
  return { result: response.result };
}

function locatorSummary(locator: ElementLocator): string {
  if (locator.ref) return `ref=${locator.ref}`;
  if (locator.selector) return `selector=${locator.selector}`;
  if (locator.xpath) return `xpath=${locator.xpath}`;
  if (locator.text) return `text=${locator.text}`;
  if (locator.backend_node_id !== undefined) return `backend_node_id=${locator.backend_node_id}`;
  return '(no locator)';
}

/** Finds the innermost element whose own text contains the needle. */
const TEXT_FINDER = `(needle, nth) => {
  const wanted = String(needle).trim().toLowerCase();
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '')
        .join(' ')
        .trim()
        .toLowerCase();
      if (own.includes(wanted)) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  if (out.length === 0) {
    for (const el of document.querySelectorAll('input,button,textarea,select,[aria-label],[title],[placeholder]')) {
      const label = (el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().toLowerCase();
      if (label.includes(wanted)) out.push(el);
    }
  }
  return { node: out[nth] || null, count: out.length };
}`;

/** Pierces open shadow roots, which a bare querySelectorAll would miss. */
const CSS_FINDER = `(sel, nth) => {
  const out = [];
  const walk = (root) => {
    let found;
    try { found = root.querySelectorAll(sel); } catch (e) { throw new Error('Invalid selector: ' + sel); }
    out.push(...found);
    const all = root.querySelectorAll('*');
    for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return { node: out[nth] || null, count: out.length };
}`;

const XPATH_FINDER = `(expr, nth) => {
  const it = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return { node: it.snapshotItem(nth) || null, count: it.snapshotLength };
}`;

interface FinderResult {
  objectId: string | null;
  count: number;
}

/**
 * Run a finder and pull out both the chosen node and how many matched.
 *
 * The node has to come back by reference (an objectId) while the count is a
 * plain number, so the wrapper object is kept alive and its `node` property is
 * fetched separately rather than serialised.
 */
async function callFinder(
  instance: BrowserInstance,
  target: ManagedTarget,
  fn: string,
  arg: string,
  nth: number,
  frameId?: string,
): Promise<FinderResult> {
  const expression = `(${fn})(${JSON.stringify(arg)}, ${nth})`;
  const options: EvaluateOptions = { expression, returnByValue: false, awaitPromise: false };
  if (frameId) options.frameId = frameId;
  const { result, exceptionText } = await evaluate(instance, target, options);
  if (exceptionText) throw new AgentBrowserError('locator_failed', exceptionText);
  if (!result.objectId) return { objectId: null, count: 0 };

  const wrapperId = result.objectId;
  try {
    const countResponse = await target.session.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      { objectId: wrapperId, returnByValue: true, functionDeclaration: 'function () { return this.count; }' },
    );
    const count = Number(countResponse.result.value ?? 0);

    const nodeResponse = await target.session.send<{ result: RemoteObject }>('Runtime.callFunctionOn', {
      objectId: wrapperId,
      returnByValue: false,
      functionDeclaration: 'function () { return this.node; }',
    });
    const node = nodeResponse.result;
    if (node.subtype === 'null' || node.type === 'undefined') return { objectId: null, count };
    return { objectId: node.objectId ?? null, count };
  } finally {
    await target.session.trySend('Runtime.releaseObject', { objectId: wrapperId });
  }
}

export async function resolveElement(
  instance: BrowserInstance,
  target: ManagedTarget,
  locator: ElementLocator,
): Promise<ResolvedElement> {
  const nth = locator.nth ?? 0;
  let objectId: string | null = null;
  let matchedCount: number | undefined;

  if (locator.ref !== undefined || locator.backend_node_id !== undefined) {
    let backendNodeId = locator.backend_node_id;
    if (locator.ref !== undefined) {
      const refs = instance.snapshotRefs.get(target.handle);
      const found = refs?.get(locator.ref);
      if (found === undefined) {
        throw new NotFoundError(
          'snapshot ref',
          `${locator.ref} (refs expire when the page changes; take a fresh page.snapshot)`,
        );
      }
      backendNodeId = found;
    }
    const resolved = await target.session.send<{ object: RemoteObject }>('DOM.resolveNode', {
      backendNodeId,
    });
    objectId = resolved.object.objectId ?? null;
  } else if (locator.selector !== undefined) {
    ({ objectId, count: matchedCount } = await callFinder(instance, target, CSS_FINDER, locator.selector, nth, locator.frame_id));
  } else if (locator.xpath !== undefined) {
    ({ objectId, count: matchedCount } = await callFinder(instance, target, XPATH_FINDER, locator.xpath, nth, locator.frame_id));
  } else if (locator.text !== undefined) {
    ({ objectId, count: matchedCount } = await callFinder(instance, target, TEXT_FINDER, locator.text, nth, locator.frame_id));
  } else {
    throw new AgentBrowserError(
      'no_locator',
      'Provide one of: selector, xpath, text, ref, backend_node_id.',
    );
  }

  if (!objectId) {
    throw new NotFoundError('element', locatorSummary(locator));
  }

  await ensureDom(target.session);
  const described = await target.session.send<{
    node: { backendNodeId: number; nodeName: string; attributes?: string[] };
  }>('DOM.describeNode', { objectId });

  let nodeId = 0;
  try {
    const requested = await target.session.send<{ nodeId: number }>('DOM.requestNode', { objectId });
    nodeId = requested.nodeId;
  } catch {
    // Some nodes (in detached trees) have no frontend id; backendNodeId still works.
  }

  /*
   * A text locator often lands on the <span> inside a button. The click still
   * works by bubbling, so nothing looks wrong until a layout change puts a
   * non-interactive node in the same place and the click silently does nothing.
   */
  let interactiveAncestor: string | undefined;
  if (locator.text !== undefined || locator.selector !== undefined) {
    try {
      const probe = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const interactive = 'button, a[href], input, select, textarea, [role=button], [role=link], [onclick], [tabindex]';
          if (this.matches && this.matches(interactive)) return null;
          const ancestor = this.closest && this.closest(interactive);
          if (!ancestor) return null;
          return ancestor.tagName.toLowerCase() + (ancestor.id ? '#' + ancestor.id : '');
        }`,
      });
      const value = probe.result.value;
      if (typeof value === 'string' && value) interactiveAncestor = value;
    } catch {
      // Advisory only; never fail a resolution over it.
    }
  }

  return {
    objectId,
    backendNodeId: described.node.backendNodeId,
    nodeId,
    description: describeNode(described.node.nodeName, described.node.attributes),
    ...(matchedCount === undefined ? {} : { matchedCount }),
    ...(interactiveAncestor ? { interactiveAncestor } : {}),
  };
}

export function describeNode(nodeName: string, attributes?: string[]): string {
  const tag = nodeName.toLowerCase();
  if (!attributes?.length) return `<${tag}>`;
  const attrs: string[] = [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const name = attributes[i]!;
    const value = attributes[i + 1]!;
    if (name === 'id') attrs.unshift(`#${value}`);
    else if (name === 'class' && value) attrs.push(`.${value.trim().split(/\s+/).join('.')}`);
  }
  return `<${tag}${attrs.length ? ` ${attrs.join('')}` : ''}>`;
}

export interface BoxCenter {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Centre of the element's first content quad. Quads beat the box model here:
 * they follow CSS transforms and handle inline elements that wrap lines.
 */
export async function contentCenter(
  session: CdpSession,
  objectId: string,
): Promise<BoxCenter> {
  await session.trySend('DOM.scrollIntoViewIfNeeded', { objectId });
  const { quads } = await session.send<{ quads: number[][] }>('DOM.getContentQuads', { objectId });
  const quad = quads?.find((q) => quadArea(q) > 1);
  if (!quad) {
    throw new AgentBrowserError(
      'not_visible',
      'Element has no visible content box (display:none, zero size, or fully clipped).',
    );
  }
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function quadArea(q: number[]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = q[(i * 2) % 8]!;
    const y1 = q[(i * 2 + 1) % 8]!;
    const x2 = q[(i * 2 + 2) % 8]!;
    const y2 = q[(i * 2 + 3) % 8]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export async function boundingBox(
  session: CdpSession,
  objectId: string,
): Promise<BoxCenter | null> {
  try {
    const { model } = await session.send<{
      model: { content: number[]; width: number; height: number };
    }>('DOM.getBoxModel', { objectId });
    const c = model.content;
    return {
      x: Math.min(c[0]!, c[2]!, c[4]!, c[6]!),
      y: Math.min(c[1]!, c[3]!, c[5]!, c[7]!),
      width: model.width,
      height: model.height,
    };
  } catch {
    return null;
  }
}
