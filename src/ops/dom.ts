import type { DomNode } from '../cdp/types.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { boundingBox, describeNode, evaluate, resolveElement, type ElementLocator } from './element.js';

export interface DomArgs extends ElementLocator {
  browser_id?: string;
  target_id?: string;
}

async function pageOf(ctx: OpsContext, args: DomArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

function attributesToObject(attributes: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (let i = 0; i + 1 < attributes.length; i += 2) out[attributes[i]!] = attributes[i + 1]!;
  return out;
}

/**
 * Structural outline of the document instead of its markup.
 *
 * A real page is tens of thousands of lines of HTML; the shape of it is a few
 * dozen. Agents should read this first and only pull markup for the branch
 * they actually care about.
 */
export async function summary(
  ctx: OpsContext,
  args: DomArgs & { max_depth?: number; max_nodes?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const maxDepth = Math.min(Math.max(args.max_depth ?? 6, 1), 20);
  const maxNodes = Math.min(Math.max(args.max_nodes ?? 400, 20), 5000);

  const rootExpression = args.selector
    ? `document.querySelector(${JSON.stringify(args.selector)})`
    : 'document.body || document.documentElement';

  const { result, exceptionText } = await evaluate(instance, target, {
    returnByValue: true,
    expression: `(() => {
      const root = ${rootExpression};
      if (!root) return { error: 'root element not found' };
      let budget = ${maxNodes};
      const label = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        const cls = (el.getAttribute('class') || '').trim();
        if (cls) s += '.' + cls.split(/\\s+/).slice(0, 3).join('.');
        const role = el.getAttribute('role');
        if (role) s += '[role=' + role + ']';
        return s;
      };
      const ownText = (el) => Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .replace(/\\s+/g, ' ')
        .slice(0, 60);
      const walk = (el, depth) => {
        if (budget-- <= 0) return null;
        const node = { tag: label(el), depth };
        const text = ownText(el);
        if (text) node.text = text;
        const kids = Array.from(el.children);
        if (depth < ${maxDepth} && kids.length) {
          node.children = [];
          for (const kid of kids) {
            const child = walk(kid, depth + 1);
            if (child) node.children.push(child);
          }
        } else if (kids.length) {
          node.collapsed_children = kids.length;
        }
        return node;
      };
      return { tree: walk(root, 0), budget_left: budget };
    })()`,
  });
  if (exceptionText) throw new AgentBrowserError('dom_summary_failed', exceptionText);

  const payload = result.value as
    | { error?: string; tree?: Record<string, unknown>; budget_left?: number }
    | undefined;
  if (payload?.error) throw new AgentBrowserError('not_found', payload.error);

  const lines: string[] = [];
  const render = (node: Record<string, unknown> | null | undefined, indent: string): void => {
    if (!node) return;
    const text = node.text ? `  "${node.text}"` : '';
    const collapsed = node.collapsed_children ? `  (+${node.collapsed_children} children)` : '';
    lines.push(`${indent}${node.tag as string}${text}${collapsed}`);
    for (const child of (node.children as Array<Record<string, unknown>>) ?? []) {
      render(child, `${indent}  `);
    }
  };
  render(payload?.tree, '');

  return {
    target_id: target.handle,
    max_depth: maxDepth,
    node_count: lines.length,
    truncated: (payload?.budget_left ?? 1) <= 0,
    tree: lines.join('\n'),
  };
}

export async function query(
  ctx: OpsContext,
  args: DomArgs & { selector: string; limit?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);

  const options: Parameters<typeof evaluate>[2] = {
    returnByValue: true,
    expression: `(() => {
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(${JSON.stringify(args.selector)})); }
      catch (e) { return { error: e.message }; }
      const total = nodes.length;
      return {
        total,
        items: nodes.slice(0, ${limit}).map((el, i) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: (el.getAttribute('class') || '').trim() || null,
            text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
            box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0',
            attributes: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value.slice(0, 200)])),
          };
        }),
      };
    })()`,
  };
  if (args.frame_id) options.frameId = args.frame_id;

  const { result, exceptionText } = await evaluate(instance, target, options);
  if (exceptionText) throw new AgentBrowserError('query_failed', exceptionText);
  const payload = result.value as { error?: string; total?: number; items?: unknown[] };
  if (payload.error) throw new AgentBrowserError('bad_selector', payload.error);

  return {
    target_id: target.handle,
    selector: args.selector,
    total_matches: payload.total ?? 0,
    returned: payload.items?.length ?? 0,
    matches: payload.items ?? [],
    hint: 'Use nth=N with the same selector to act on a specific match.',
  };
}

export async function inspect(ctx: OpsContext, args: DomArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const element = await resolveElement(instance, target, args);

  const { node } = await target.session.send<{ node: DomNode }>('DOM.describeNode', {
    objectId: element.objectId,
    depth: 1,
  });
  const box = await boundingBox(target.session, element.objectId);

  const detail = await target.session.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
    objectId: element.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const style = getComputedStyle(this);
      const r = this.getBoundingClientRect();
      return {
        text: (this.innerText || this.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 400),
        value: 'value' in this ? this.value : undefined,
        checked: 'checked' in this ? this.checked : undefined,
        disabled: 'disabled' in this ? this.disabled : undefined,
        href: this.href || undefined,
        src: this.src || undefined,
        visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0',
        in_viewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
        selector_path: (() => {
          const parts = [];
          let el = this;
          while (el && el.nodeType === 1 && parts.length < 8) {
            let part = el.tagName.toLowerCase();
            if (el.id) { parts.unshift(part + '#' + el.id); break; }
            const parent = el.parentElement;
            if (parent) {
              const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
            }
            parts.unshift(part);
            el = el.parentElement;
          }
          return parts.join(' > ');
        })(),
        child_count: this.children.length,
      };
    }`,
  });

  const { outerHTML } = await target.session.send<{ outerHTML: string }>('DOM.getOuterHTML', {
    backendNodeId: element.backendNodeId,
  });
  const htmlTruncated = outerHTML.length > 8000;

  return {
    target_id: target.handle,
    description: element.description,
    backend_node_id: element.backendNodeId,
    tag: node.nodeName.toLowerCase(),
    attributes: attributesToObject(node.attributes),
    box,
    ...(detail.result.value as Record<string, unknown>),
    outer_html: htmlTruncated ? `${outerHTML.slice(0, 8000)}\n… (${outerHTML.length} chars total, use dom.get_html)` : outerHTML,
    outer_html_length: outerHTML.length,
  };
}

export async function getHtml(
  ctx: OpsContext,
  args: DomArgs & { max_chars?: number; save_path?: string; whole_document?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);

  let html: string;
  let label: string;
  const hasLocator =
    args.selector !== undefined || args.ref !== undefined || args.xpath !== undefined || args.backend_node_id !== undefined;

  if (hasLocator && !args.whole_document) {
    const element = await resolveElement(instance, target, args);
    const response = await target.session.send<{ outerHTML: string }>('DOM.getOuterHTML', {
      backendNodeId: element.backendNodeId,
    });
    html = response.outerHTML;
    label = 'element';
  } else {
    const { root } = await target.session.send<{ root: DomNode }>('DOM.getDocument', { depth: 0 });
    const response = await target.session.send<{ outerHTML: string }>('DOM.getOuterHTML', {
      nodeId: root.nodeId,
    });
    html = response.outerHTML;
    label = 'document';
  }

  const artifact = ctx.stores.artifacts.put('dom_export', Buffer.from(html, 'utf8'), {
    browserId: instance.id,
    label: `${label}-html`,
    mime: 'text/html',
    sourceRef: target.handle,
    meta: { url: target.info.url, selector: args.selector ?? null },
  });

  const max = Math.min(Math.max(args.max_chars ?? 20_000, 500), 400_000);
  const truncated = html.length > max;

  const out: Record<string, unknown> = {
    target_id: target.handle,
    scope: label,
    length: html.length,
    truncated,
    html: truncated ? html.slice(0, max) : html,
    artifact: toArtifactRef(artifact),
  };
  if (truncated) {
    out.hint =
      'Full markup is in the artifact. Use artifact.search / artifact.read_lines instead of pulling it all in.';
  }
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

export async function setHtml(
  ctx: OpsContext,
  args: DomArgs & { html: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('dom.set_html');
  const element = await resolveElement(instance, target, args);
  await target.session.send('DOM.setOuterHTML', {
    nodeId: element.nodeId,
    outerHTML: args.html,
  });
  return { target_id: target.handle, replaced: element.description, new_length: args.html.length };
}

export async function setAttribute(
  ctx: OpsContext,
  args: DomArgs & { name: string; value?: string; remove?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('dom.set_attribute');
  const element = await resolveElement(instance, target, args);
  if (args.remove) {
    await target.session.send('DOM.removeAttribute', { nodeId: element.nodeId, name: args.name });
    return { target_id: target.handle, element: element.description, removed_attribute: args.name };
  }
  if (args.value === undefined) {
    throw new AgentBrowserError('missing_value', 'Provide `value`, or set `remove: true`.');
  }
  await target.session.send('DOM.setAttributeValue', {
    nodeId: element.nodeId,
    name: args.name,
    value: args.value,
  });
  return {
    target_id: target.handle,
    element: element.description,
    attribute: args.name,
    value: args.value,
  };
}

export async function removeElement(ctx: OpsContext, args: DomArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('dom.remove');
  const element = await resolveElement(instance, target, args);
  await target.session.send('DOM.removeNode', { nodeId: element.nodeId });
  return { target_id: target.handle, removed: element.description };
}

/** Full document dump including shadow roots and iframe content documents. */
export async function exportDom(
  ctx: OpsContext,
  args: DomArgs & { save_path?: string; include_shadow_dom?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const { root } = await target.session.send<{ root: DomNode }>('DOM.getDocument', {
    depth: -1,
    pierce: args.include_shadow_dom !== false,
  });

  const lines: string[] = [];
  let nodeCount = 0;
  const walk = (node: DomNode, depth: number): void => {
    nodeCount++;
    const indent = '  '.repeat(depth);
    if (node.nodeType === 3) {
      const value = node.nodeValue.trim();
      if (value) lines.push(`${indent}#text ${JSON.stringify(value.slice(0, 200))}`);
    } else {
      const attrs = attributesToObject(node.attributes);
      const attrText = Object.entries(attrs)
        .map(([k, v]) => `${k}=${JSON.stringify(v.slice(0, 200))}`)
        .join(' ');
      lines.push(
        `${indent}${describeNode(node.nodeName, node.attributes)}${attrText ? ` ${attrText}` : ''}` +
          `${node.shadowRootType ? ` (shadow:${node.shadowRootType})` : ''}`,
      );
    }
    for (const shadow of node.shadowRoots ?? []) walk(shadow, depth + 1);
    if (node.contentDocument) walk(node.contentDocument, depth + 1);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);

  const artifact = ctx.stores.artifacts.put('dom_export', Buffer.from(lines.join('\n'), 'utf8'), {
    browserId: instance.id,
    label: 'dom-tree',
    mime: 'text/plain',
    sourceRef: target.handle,
    meta: { url: target.info.url, node_count: nodeCount },
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    node_count: nodeCount,
    artifact: toArtifactRef(artifact),
    hint: 'Search it with artifact.search rather than reading the whole tree.',
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}
