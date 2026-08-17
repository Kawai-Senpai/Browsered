import type { DomNode } from '../cdp/types.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { boundingBox, describeNode, resolveElement, type ElementLocator } from './element.js';

export interface InspectorArgs extends ElementLocator {
  browser_id?: string;
  target_id?: string;
}

async function pageOf(ctx: OpsContext, args: InspectorArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  await target.session.trySend('DOM.enable');
  await target.session.trySend('Overlay.enable');
  return { instance, target };
}

/**
 * Turn on the DevTools element picker. The human then clicks an element and the
 * daemon records it; the AI reads the result with inspector.picked(). This is
 * the human-to-AI handoff: "the broken thing is *this* one".
 */
export async function pick(
  ctx: OpsContext,
  args: InspectorArgs & { mode?: 'searchForNode' | 'searchForUAShadowDOM' | 'none'; timeout_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('inspector.pick');

  const mode = args.mode ?? 'searchForNode';
  if (mode === 'none') {
    await target.session.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    instance.pickedNodes.delete(target.handle);
    return { target_id: target.handle, inspect_mode: 'off' };
  }

  // Arm the listener before inspect mode, so a fast click cannot be missed.
  if (!instance.pickListeners.has(target.handle)) {
    target.session.on('Overlay.inspectNodeRequested', (params) => {
      const backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
      if (backendNodeId === undefined) return;
      instance.pickedNodes.set(target.handle, { backendNodeId, at: Date.now() });
      // The picker is single-shot, exactly as DevTools behaves.
      void target.session.trySend('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    });
    instance.pickListeners.add(target.handle);
  }

  await target.session.send('Overlay.setInspectMode', {
    mode,
    highlightConfig: {
      showInfo: true,
      showStyles: true,
      contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
      paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
      borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
      marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
    },
  });

  const timeout = Math.min(Math.max(args.timeout_ms ?? 0, 0), 300_000);
  if (timeout === 0) {
    return {
      target_id: target.handle,
      inspect_mode: mode,
      waiting: false,
      hint: 'The picker is armed. Ask the human to click the element, then call inspector.picked().',
    };
  }

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const picked = instance.pickedNodes.get(target.handle);
    if (picked && picked.at >= Date.now() - timeout) {
      return picked_result(target.handle, picked.backendNodeId, picked.at);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    target_id: target.handle,
    inspect_mode: mode,
    picked: false,
    timed_out: true,
    hint: 'Nobody clicked yet. The picker is still armed; call inspector.picked() later.',
  };
}

function picked_result(targetHandle: string, backendNodeId: number, at: number): Record<string, unknown> {
  return {
    target_id: targetHandle,
    picked: true,
    backend_node_id: backendNodeId,
    picked_at: new Date(at).toISOString(),
    hint: `Pass backend_node_id=${backendNodeId} to inspector.element, dom.inspect, css.matched_rules or page.click.`,
  };
}

export async function picked(ctx: OpsContext, args: InspectorArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const found = instance.pickedNodes.get(target.handle);
  if (!found) {
    return {
      target_id: target.handle,
      picked: false,
      hint: 'Call inspector.pick first, then have the human click an element.',
    };
  }
  return picked_result(target.handle, found.backendNodeId, found.at);
}

/**
 * Everything DevTools shows in one panel for one element: markup, box model,
 * computed styles, listeners, accessibility, ancestors.
 */
export async function element(
  ctx: OpsContext,
  args: InspectorArgs & { include_listeners?: boolean; include_accessibility?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const resolved = await resolveElement(instance, target, args);

  const { node } = await target.session.send<{ node: DomNode }>('DOM.describeNode', {
    objectId: resolved.objectId,
    depth: 1,
  });
  const box = await boundingBox(target.session, resolved.objectId);

  const out: Record<string, unknown> = {
    target_id: target.handle,
    element: resolved.description,
    backend_node_id: resolved.backendNodeId,
    tag: node.nodeName.toLowerCase(),
    box,
  };

  const computed = await target.session
    .send<{ computedStyle: Array<{ name: string; value: string }> }>('CSS.getComputedStyleForNode', {
      nodeId: resolved.nodeId,
    })
    .catch(() => null);
  if (computed) {
    const interesting = new Set(['display', 'position', 'z-index', 'visibility', 'opacity', 'overflow', 'color', 'background-color', 'font-size']);
    out.computed = Object.fromEntries(
      computed.computedStyle.filter((p) => interesting.has(p.name)).map((p) => [p.name, p.value]),
    );
  }

  if (args.include_listeners !== false) {
    const listeners = await target.session
      .send<{
        listeners: Array<{ type: string; useCapture: boolean; passive: boolean; once: boolean; scriptId: string; lineNumber: number; columnNumber: number; handler?: { description?: string } }>;
      }>('DOMDebugger.getEventListeners', { objectId: resolved.objectId })
      .catch(() => null);
    if (listeners) {
      out.event_listeners = listeners.listeners.map((l) => ({
        type: l.type,
        capture: l.useCapture,
        passive: l.passive,
        once: l.once,
        // 0-indexed in CDP; DevTools shows 1-indexed.
        location: `script ${l.scriptId}:${l.lineNumber + 1}:${l.columnNumber + 1}`,
        handler: l.handler?.description?.slice(0, 200) ?? null,
      }));
    }
  }

  if (args.include_accessibility !== false) {
    await target.session.trySend('Accessibility.enable');
    const ax = await target.session
      .send<{ nodes: Array<Record<string, unknown>> }>('Accessibility.getPartialAXTree', {
        backendNodeId: resolved.backendNodeId,
        fetchRelatives: false,
      })
      .catch(() => null);
    const self = ax?.nodes?.[0];
    if (self) {
      const value = (key: string): unknown => (self[key] as { value?: unknown } | undefined)?.value;
      out.accessibility = {
        role: value('role'),
        name: value('name'),
        description: value('description'),
        ignored: self.ignored ?? false,
      };
    }
  }

  return out;
}

export async function parent(ctx: OpsContext, args: InspectorArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const resolved = await resolveElement(instance, target, args);
  const response = await target.session.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', {
    objectId: resolved.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const chain = [];
      let el = this.parentElement;
      let depth = 1;
      while (el && depth <= 12) {
        const r = el.getBoundingClientRect();
        let label = el.tagName.toLowerCase();
        if (el.id) label += '#' + el.id;
        const cls = (el.getAttribute('class') || '').trim();
        if (cls) label += '.' + cls.split(/\\s+/).slice(0, 3).join('.');
        const s = getComputedStyle(el);
        chain.push({
          depth,
          element: label,
          display: s.display,
          position: s.position,
          z_index: s.zIndex,
          overflow: s.overflow,
          box: { width: Math.round(r.width), height: Math.round(r.height) },
        });
        el = el.parentElement;
        depth++;
      }
      return chain;
    }`,
  });
  if (response.exceptionDetails) throw new AgentBrowserError('inspect_failed', response.exceptionDetails.text);
  return { target_id: target.handle, element: resolved.description, ancestors: response.result.value };
}

export async function children(
  ctx: OpsContext,
  args: InspectorArgs & { limit?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const resolved = await resolveElement(instance, target, args);
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 300);
  const response = await target.session.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', {
    objectId: resolved.objectId,
    returnByValue: true,
    functionDeclaration: `function (limit) {
      const kids = Array.from(this.children);
      return {
        total: kids.length,
        children: kids.slice(0, limit).map((el, i) => {
          const r = el.getBoundingClientRect();
          let label = el.tagName.toLowerCase();
          if (el.id) label += '#' + el.id;
          const cls = (el.getAttribute('class') || '').trim();
          if (cls) label += '.' + cls.split(/\\s+/).slice(0, 3).join('.');
          return {
            index: i,
            element: label,
            text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
            box: { width: Math.round(r.width), height: Math.round(r.height) },
          };
        }),
      };
    }`,
    arguments: [{ value: limit }],
  });
  if (response.exceptionDetails) throw new AgentBrowserError('inspect_failed', response.exceptionDetails.text);
  return { target_id: target.handle, element: resolved.description, ...(response.result.value as Record<string, unknown>) };
}

/**
 * DOMSnapshot: structure, layout and selected computed styles in one pass,
 * flattened across shadow roots and iframes. Written straight to an artifact
 * because it is large by nature.
 */
export async function snapshot(
  ctx: OpsContext,
  args: InspectorArgs & { computed_styles?: string[]; save_path?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  await target.session.trySend('DOMSnapshot.enable');

  const styles = args.computed_styles ?? ['display', 'position', 'z-index', 'visibility', 'opacity'];
  const captured = await target.session.send<{
    documents: Array<Record<string, unknown>>;
    strings: string[];
  }>('DOMSnapshot.captureSnapshot', {
    computedStyles: styles,
    includePaintOrder: true,
    includeDOMRects: true,
  });

  const artifact = ctx.stores.artifacts.put(
    'dom_export',
    Buffer.from(JSON.stringify(captured, null, 2), 'utf8'),
    {
      browserId: instance.id,
      label: 'dom-snapshot',
      mime: 'application/json',
      sourceRef: target.handle,
      meta: { url: target.info.url, computed_styles: styles },
    },
  );

  const firstDoc = captured.documents[0] as { nodes?: { nodeName?: number[] } } | undefined;
  const nodeCount = firstDoc?.nodes?.nodeName?.length ?? 0;

  const out: Record<string, unknown> = {
    target_id: target.handle,
    document_count: captured.documents.length,
    node_count: nodeCount,
    string_table_size: captured.strings.length,
    computed_styles: styles,
    artifact: toArtifactRef(artifact),
    hint: 'Query it with artifact.json_query, e.g. $.documents[0].layout, rather than reading the whole snapshot.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/** Full accessibility tree, as a screen reader would traverse it. */
export async function accessibilityTree(
  ctx: OpsContext,
  args: InspectorArgs & { max_nodes?: number; save_path?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  await target.session.trySend('Accessibility.enable');
  const { nodes } = await target.session.send<{ nodes: Array<Record<string, unknown>> }>(
    'Accessibility.getFullAXTree',
  );

  const byId = new Map(nodes.map((n) => [String(n.nodeId), n]));
  const lines: string[] = [];
  const max = Math.min(Math.max(args.max_nodes ?? 500, 20), 5000);

  const render = (node: Record<string, unknown> | undefined, depth: number): void => {
    if (!node || lines.length >= max) return;
    if (node.ignored !== true) {
      const role = (node.role as { value?: string } | undefined)?.value ?? '?';
      const name = (node.name as { value?: string } | undefined)?.value ?? '';
      lines.push(`${'  '.repeat(depth)}${role}${name ? ` "${String(name).slice(0, 80)}"` : ''}`);
    }
    for (const childId of (node.childIds as string[]) ?? []) render(byId.get(childId), depth + 1);
  };
  render(nodes[0], 0);

  const artifact = ctx.stores.artifacts.put('dom_export', Buffer.from(JSON.stringify(nodes, null, 2), 'utf8'), {
    browserId: instance.id,
    label: 'ax-tree',
    mime: 'application/json',
    sourceRef: target.handle,
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    node_count: nodes.length,
    rendered_nodes: lines.length,
    truncated: lines.length >= max,
    tree: lines.join('\n'),
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/** Open the real DevTools window, for the human rather than the model. */
export async function openDevTools(
  ctx: OpsContext,
  args: InspectorArgs & { panel?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('devtools.open');
  const PANELS = ['elements', 'console', 'network', 'sources', 'resources', 'timeline', 'recorder', 'heap-profiler', 'lighthouse', 'security'];
  if (args.panel && !PANELS.includes(args.panel)) {
    throw new AgentBrowserError('unknown_panel', `Unknown panel "${args.panel}". Available: ${PANELS.join(', ')}.`);
  }
  try {
    const response = await instance.browserSession.send<{ targetId: string }>('Target.openDevTools', {
      targetId: target.info.targetId,
      ...(args.panel ? { panel: args.panel } : {}),
    });
    return {
      target_id: target.handle,
      devtools_target_id: response.targetId,
      panel: args.panel ?? 'default',
      note: 'A real DevTools window is now open for the human. Keep using the CDP-backed tools for machine work.',
    };
  } catch (err) {
    throw new AgentBrowserError(
      'open_devtools_failed',
      `Target.openDevTools is experimental and this Chromium refused it: ${(err as Error).message}`,
    );
  }
}

/** Node label helper shared with dom.export, kept here for inspector output. */
export function label(node: DomNode): string {
  return describeNode(node.nodeName, node.attributes);
}
