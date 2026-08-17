import { AgentBrowserError } from '../util/errors.js';
import { toArtifactRef } from '../store/artifact-store.js';
import type { OpsContext } from './context.js';
import { evaluate, resolveElement, type ElementLocator } from './element.js';

export interface CssArgs extends ElementLocator {
  browser_id?: string;
  target_id?: string;
}

interface CssStyle {
  cssProperties?: Array<{ name: string; value: string }>;
  styleSheetId?: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

interface RuleMatch {
  rule: {
    selectorList: { text: string; selectors: Array<{ text: string }> };
    origin: string;
    style: CssStyle;
    styleSheetId?: string;
    media?: Array<{ text: string }>;
  };
  matchingSelectors: number[];
}

async function pageOf(ctx: OpsContext, args: CssArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  await target.session.trySend('CSS.enable');
  return { instance, target };
}

const INTERESTING_COMPUTED = [
  'display',
  'visibility',
  'opacity',
  'position',
  'z-index',
  'overflow',
  'overflow-x',
  'overflow-y',
  'width',
  'height',
  'max-width',
  'max-height',
  'margin',
  'padding',
  'border',
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'line-height',
  'text-align',
  'flex',
  'flex-direction',
  'justify-content',
  'align-items',
  'grid-template-columns',
  'transform',
  'transition',
  'pointer-events',
  'clip-path',
  'inset',
  'top',
  'left',
  'right',
  'bottom',
];

export async function computed(
  ctx: OpsContext,
  args: CssArgs & { properties?: string[]; all?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const element = await resolveElement(instance, target, args);

  const result = await target.session.send<{
    computedStyle: Array<{ name: string; value: string }>;
  }>('CSS.getComputedStyleForNode', { nodeId: element.nodeId });

  const wanted = args.all
    ? null
    : new Set((args.properties ?? INTERESTING_COMPUTED).map((p) => p.toLowerCase()));

  const styles: Record<string, string> = {};
  for (const prop of result.computedStyle) {
    if (wanted && !wanted.has(prop.name)) continue;
    styles[prop.name] = prop.value;
  }

  return {
    target_id: target.handle,
    element: element.description,
    property_count: Object.keys(styles).length,
    total_available: result.computedStyle.length,
    computed: styles,
  };
}

/**
 * The cascade as DevTools shows it: which rule in which stylesheet at which
 * line actually set each property, plus what got overridden.
 */
export async function matchedRules(
  ctx: OpsContext,
  args: CssArgs & { property?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const element = await resolveElement(instance, target, args);

  const matched = await target.session.send<{
    inlineStyle?: CssStyle;
    attributesStyle?: CssStyle;
    matchedCSSRules?: RuleMatch[];
    inherited?: Array<{ inlineStyle?: CssStyle; matchedCSSRules?: RuleMatch[] }>;
    pseudoElements?: Array<{ pseudoType: string; matches: RuleMatch[] }>;
  }>('CSS.getMatchedStylesForNode', { nodeId: element.nodeId });

  const sheetUrls = new Map<string, string>();
  const describeSheet = async (styleSheetId: string | undefined): Promise<string> => {
    if (!styleSheetId) return '<inline>';
    const cached = sheetUrls.get(styleSheetId);
    if (cached) return cached;
    try {
      // The header carries the source URL and whether it came from a <style> tag.
      const header = await target.session.send<{ text: string }>('CSS.getStyleSheetText', {
        styleSheetId,
      });
      void header;
    } catch {
      /* not fatal */
    }
    sheetUrls.set(styleSheetId, styleSheetId);
    return styleSheetId;
  };

  const renderRule = async (match: RuleMatch, source: string): Promise<Record<string, unknown>> => {
    const properties = (match.rule.style.cssProperties ?? [])
      .filter((p) => p.value !== '')
      .filter((p) => !args.property || p.name === args.property);
    return {
      source,
      selector: match.rule.selectorList.text,
      matched_selectors: match.matchingSelectors.map((i) => match.rule.selectorList.selectors[i]?.text ?? ''),
      origin: match.rule.origin,
      media: match.rule.media?.map((m) => m.text) ?? [],
      style_sheet_id: match.rule.styleSheetId ?? null,
      location: match.rule.style.range
        ? { line: match.rule.style.range.startLine + 1, column: match.rule.style.range.startColumn + 1 }
        : null,
      properties: Object.fromEntries(properties.map((p) => [p.name, p.value])),
      sheet: await describeSheet(match.rule.styleSheetId),
    };
  };

  // CDP returns matched rules weakest-first; reversing puts the winner on top.
  const rules: Array<Record<string, unknown>> = [];
  for (const match of [...(matched.matchedCSSRules ?? [])].reverse()) {
    rules.push(await renderRule(match, 'stylesheet'));
  }

  const inherited: Array<Record<string, unknown>> = [];
  for (const [depth, entry] of (matched.inherited ?? []).entries()) {
    for (const match of [...(entry.matchedCSSRules ?? [])].reverse()) {
      inherited.push({ ...(await renderRule(match, `inherited(depth ${depth + 1})`)), depth: depth + 1 });
    }
  }

  const inlineProps = (matched.inlineStyle?.cssProperties ?? []).filter((p) => p.value !== '');

  return {
    target_id: target.handle,
    element: element.description,
    ...(args.property ? { filtered_property: args.property } : {}),
    inline_style: Object.fromEntries(inlineProps.map((p) => [p.name, p.value])),
    matched_rules: rules,
    inherited_rules: inherited,
    pseudo_elements: (matched.pseudoElements ?? []).map((p) => ({
      type: p.pseudoType,
      selectors: p.matches.map((m) => m.rule.selectorList.text),
    })),
    hint: 'matched_rules is ordered strongest-first: the first rule setting a property is the one that wins.',
  };
}

export async function setStyle(
  ctx: OpsContext,
  args: CssArgs & { properties: Record<string, string> },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('css.set_style');
  const element = await resolveElement(instance, target, args);

  // Inline style via the DOM: it survives without owning a stylesheet range and
  // behaves exactly like editing element.style in DevTools.
  const response = await target.session.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', {
    objectId: element.objectId,
    returnByValue: true,
    functionDeclaration: `function (props) {
      const applied = {};
      for (const [name, value] of Object.entries(props)) {
        this.style.setProperty(name, value);
        applied[name] = this.style.getPropertyValue(name);
      }
      return applied;
    }`,
    arguments: [{ value: args.properties }],
  });
  if (response.exceptionDetails) {
    throw new AgentBrowserError('set_style_failed', response.exceptionDetails.text);
  }
  return { target_id: target.handle, element: element.description, applied: response.result.value };
}

export async function listStyleSheets(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const { result } = await evaluate(instance, target, {
    returnByValue: true,
    expression: `Array.from(document.styleSheets).map((s, i) => ({
      index: i,
      href: s.href,
      disabled: s.disabled,
      media: s.media ? s.media.mediaText : '',
      rule_count: (() => { try { return s.cssRules.length; } catch (e) { return 'cross-origin'; } })(),
      owner: s.ownerNode ? s.ownerNode.nodeName.toLowerCase() : null,
    }))`,
  });
  return { target_id: target.handle, stylesheets: result.value };
}

export async function getStyleSheetText(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string; style_sheet_id: string; save_path?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const { text } = await target.session.send<{ text: string }>('CSS.getStyleSheetText', {
    styleSheetId: args.style_sheet_id,
  });
  const artifact = ctx.stores.artifacts.put('dom_export', Buffer.from(text, 'utf8'), {
    browserId: instance.id,
    label: 'stylesheet',
    mime: 'text/css',
    sourceRef: args.style_sheet_id,
  });
  const out: Record<string, unknown> = {
    style_sheet_id: args.style_sheet_id,
    length: text.length,
    artifact: toArtifactRef(artifact),
    text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${text.length} chars)` : text,
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/**
 * Answers "why can't I see this?" by checking the element and every ancestor
 * for the handful of things that actually hide content, and naming the culprit
 * rather than dumping a stylesheet.
 */
export async function explainVisibility(
  ctx: OpsContext,
  args: CssArgs,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const element = await resolveElement(instance, target, args);

  const response = await target.session.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', {
    objectId: element.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const describe = (el) => {
        let s = el.tagName ? el.tagName.toLowerCase() : String(el.nodeName);
        if (el.id) s += '#' + el.id;
        const cls = (el.getAttribute && el.getAttribute('class') || '').trim();
        if (cls) s += '.' + cls.split(/\\s+/).slice(0, 2).join('.');
        return s;
      };
      const problems = [];
      const chain = [];
      let el = this;
      let depth = 0;

      while (el && el.nodeType === 1 && depth < 40) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const entry = {
          element: describe(el),
          depth,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          position: style.position,
          z_index: style.zIndex,
          overflow: style.overflow,
          size: { width: Math.round(rect.width), height: Math.round(rect.height) },
        };
        chain.push(entry);

        if (style.display === 'none') problems.push({ element: describe(el), depth, reason: 'display: none' });
        if (style.visibility === 'hidden') problems.push({ element: describe(el), depth, reason: 'visibility: hidden' });
        if (parseFloat(style.opacity) === 0) problems.push({ element: describe(el), depth, reason: 'opacity: 0' });
        if (rect.width === 0 || rect.height === 0) {
          problems.push({ element: describe(el), depth, reason: 'zero size (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ')' });
        }
        if (style.contentVisibility === 'hidden') problems.push({ element: describe(el), depth, reason: 'content-visibility: hidden' });
        if (el.hasAttribute && el.hasAttribute('hidden')) problems.push({ element: describe(el), depth, reason: 'hidden attribute' });
        if (depth > 0 && (style.overflow === 'hidden' || style.overflow === 'clip')) {
          const child = chain[depth - 1];
          problems.push({ element: describe(el), depth, reason: 'overflow: ' + style.overflow + ' on an ancestor may clip ' + child.element });
        }

        el = el.parentElement;
        depth++;
      }

      const self = this.getBoundingClientRect();
      const inViewport = self.top < innerHeight && self.bottom > 0 && self.left < innerWidth && self.right > 0;

      // Anything painted on top at the element's centre point.
      let occluder = null;
      if (self.width > 0 && self.height > 0 && inViewport) {
        const cx = Math.min(Math.max(self.left + self.width / 2, 1), innerWidth - 1);
        const cy = Math.min(Math.max(self.top + self.height / 2, 1), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== this && !this.contains(top)) {
          const ts = getComputedStyle(top);
          occluder = {
            element: describe(top),
            z_index: ts.zIndex,
            position: ts.position,
            note: 'This element is painted over the target at its centre point; a click there would hit it instead.',
          };
        }
      }

      return {
        visible: problems.length === 0 && inViewport,
        in_viewport: inViewport,
        box: { x: Math.round(self.x), y: Math.round(self.y), width: Math.round(self.width), height: Math.round(self.height) },
        problems,
        occluded_by: occluder,
        ancestor_chain: chain,
      };
    }`,
  });
  if (response.exceptionDetails) {
    throw new AgentBrowserError('explain_failed', response.exceptionDetails.text);
  }

  const payload = response.result.value as Record<string, unknown>;
  const problems = (payload.problems as Array<{ reason: string; element: string }>) ?? [];
  const occluded = payload.occluded_by as { element: string } | null;

  let verdict: string;
  if (payload.visible && !occluded) verdict = 'Element is visible and in the viewport.';
  else if (problems.length > 0) {
    verdict = `Hidden by: ${problems.map((p) => `${p.element} (${p.reason})`).join('; ')}`;
  } else if (!payload.in_viewport) verdict = 'Element is rendered but scrolled outside the viewport.';
  else if (occluded) verdict = `Element is rendered but covered by ${occluded.element}.`;
  else verdict = 'Element is visible.';

  return {
    target_id: target.handle,
    element: element.description,
    verdict,
    ...payload,
    hint: 'Follow up with css.matched_rules on the element named in `problems` to see which rule set that property.',
  };
}
