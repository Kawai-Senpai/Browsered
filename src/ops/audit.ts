import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { DESIGN_AUDIT, type DesignAuditOptions } from './design-audit.js';
import { evaluate } from './element.js';
import { viewportOverrides } from './emulation.js';
import { navigate, settleAnimations } from './page.js';

const sweeps = new WeakMap<ManagedTarget['session'], Promise<void>>();

/**
 * The responsive-layout probe every frontend agent otherwise rewrites by hand,
 * badly, once per session.
 *
 * Two details are baked in because both cost a wrong answer the first time they
 * are met: `position: fixed` is skipped (a sticky header legitimately spans the
 * viewport), and the overflow list is collapsed to the outermost offender (a
 * 600px table otherwise reports itself plus all 69 of its descendants).
 */
const AUDIT_FN = `(function (minTouch) {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;

  const describe = (el) => {
    const parts = [];
    let node = el;
    for (; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const index = node.parentElement ? Array.prototype.indexOf.call(node.parentElement.children,node) + 1 : 0;
      parts.unshift(node.localName + (index ? ':nth-child(' + index + ')' : ''));
    }
    return parts.join(' > ');
  };

  const hidden = (el, style) =>
    style.display === 'none' || style.visibility === 'hidden' || (el.offsetWidth === 0 && el.offsetHeight === 0);

  const overflowRaw = [];
  const touchTargetsBelow = [];
  const clippedText = [];
  const interactive = 'a,button,input,select,textarea,[role="button"],[role="link"],[onclick]';

  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (hidden(el, style)) continue;
    const rect = el.getBoundingClientRect();

    // Fixed elements are positioned against the viewport on purpose.
    if (style.position !== 'fixed' && (rect.right > vw + 1 || rect.left < -1)) {
      overflowRaw.push({ el: el, selector: describe(el), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) });
    }

    if (el.matches(interactive) && rect.width > 0 && rect.height > 0) {
      const min = Math.min(rect.width, rect.height);
      if (min < minTouch) {
        touchTargetsBelow.push({
          selector: describe(el),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
    if (!scrollable && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.children.length === 0) {
      clippedText.push({
        selector: describe(el),
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        content_width: el.scrollWidth,
        visible_width: el.clientWidth,
      });
    }
  }

  const outermost = overflowRaw.filter(
    (o) => !overflowRaw.some((other) => other.el !== o.el && other.el.contains(o.el)),
  );

  return {
    viewport_width: vw,
    scroll_width: doc.scrollWidth,
    horizontal_scroll: doc.scrollWidth > vw + 1,
    overflowing: outermost.slice(0, 15).map((o) => ({
      selector: o.selector, left: o.left, right: o.right, width: o.width, outermost: true,
    })),
    overflowing_total: overflowRaw.length,
    overflowing_outermost_total: outermost.length,
    touch_targets_below: touchTargetsBelow.slice(0, 15),
    touch_targets_below_total: touchTargetsBelow.length,
    clipped_text: clippedText.slice(0, 15),
    clipped_text_total: clippedText.length,
  };
})`;

/**
 * Measure one page (or a list of them) at several widths and report what is
 * actually broken, rather than leaving an agent to judge it from a screenshot.
 */
export async function auditLayout(
  ctx: OpsContext,
  args: {
    browser_id?: string;
    target_id?: string;
    widths?: number[];
    height?: number;
    urls?: string[];
    min_touch_target?: number;
    device_scale_factor?: number;
    design?: boolean | DesignAuditOptions;
  },
  onWidth?: (instance: BrowserInstance, target: ManagedTarget, width: number, layout: unknown) => Promise<void>,
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  instance.requireControl('page.audit_layout');

  const widths = (args.widths?.length ? args.widths : [320, 414, 768, 1280]).map((w) =>
    Math.min(Math.max(Math.round(w), 200), 4000),
  );
  const height = Math.min(Math.max(args.height ?? 800, 200), 4000);
  const minTouch = args.min_touch_target ?? 24;
  const pages = args.urls?.length ? args.urls : [null];

  const results: Array<Record<string, unknown>> = [];
  const previous = sweeps.get(target.session);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  sweeps.set(target.session, current);
  await previous;
  let scroll: { url: string; x: number; y: number } | undefined;
  const restoreScroll = async () => {
    if (!scroll) return;
    await target.session.trySend('Runtime.evaluate', {
      expression: `if (location.href === ${JSON.stringify(scroll.url)} && (scrollX !== ${scroll.x} || scrollY !== ${scroll.y})) scrollTo({left:${scroll.x},top:${scroll.y},behavior:'instant'})`,
    });
  };
  try {
    if (onWidth) {
      const { result } = await evaluate(instance, target, {
        expression: '({url:location.href,x:scrollX,y:scrollY})', returnByValue: true,
      });
      scroll = result.value as typeof scroll;
    }
    for (const url of pages) {
      if (url) {
        await navigate(ctx, { browser_id: instance.id, target_id: target.handle, url, wait_until: 'load' });
      }
      const perWidth: Record<string, unknown> = {};
      for (const width of widths) {
        await target.session.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: args.device_scale_factor ?? 1,
          mobile: width <= 480,
        });
        // Let the relayout and any width-driven media queries settle.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (onWidth) {
          await restoreScroll();
          await settleAnimations(instance, target, 1_000);
        }
        const layout = `(${AUDIT_FN})(${minTouch})`;
        const design = args.design ? `(${DESIGN_AUDIT})(${JSON.stringify(args.design === true ? {} : args.design)},${width})` : null;
        const { result, exceptionText } = await evaluate(instance, target, {
          expression: design ? `({...(${layout}),design:${design}})` : layout,
          returnByValue: true,
          awaitPromise: false,
        });
        if (exceptionText) throw new AgentBrowserError('layout_audit_failed', exceptionText);
        perWidth[String(width)] = result.value ?? null;
        if (onWidth) await onWidth(instance, target, width, result.value ?? null);
      }
      results.push({
        url: url ?? target.info.url,
        widths: perWidth,
      });
    }
  } finally {
    try {
      // Restore this tab's prior Browsered viewport even if capture failed.
      const restore = viewportOverrides.get(target.session);
      if (restore) await target.session.trySend('Emulation.setDeviceMetricsOverride', restore);
      else await target.session.trySend('Emulation.clearDeviceMetricsOverride');
      await restoreScroll();
    } finally {
      release();
      if (sweeps.get(target.session) === current) sweeps.delete(target.session);
    }
  }

  const broken = results.filter((page) =>
    Object.values(page.widths as Record<string, { horizontal_scroll?: boolean }>).some(
      (w) => w?.horizontal_scroll === true,
    ),
  );

  if (results.length === 0) {
    throw new AgentBrowserError('nothing_audited', 'No page to audit: pass urls, or open a page first.');
  }

  return {
    target_id: target.handle,
    widths_tested: widths,
    min_touch_target: minTouch,
    pages_audited: results.length,
    pages_with_horizontal_scroll: broken.length,
    ...(args.design ? { design_checks: {
      measured: ['low_text_contrast', 'clipped_control', 'clipped_text_content', 'missing_mobile_viewport', 'mobile_layout_wider_than_device'],
      review: ['fragmented_typography', 'inconsistent_button_heights', 'repeated_gradient_surfaces', ...(typeof args.design === 'object' && args.design.geometry ? ['misaligned_peers', 'inconsistent_peer_spacing'] : [])],
      project_rules: ['off_scale_font_size', 'off_scale_button_height'],
      contrast_scope: 'Computed foreground and simple backgrounds. Check unresolved text, imagery, overlays, and complex color effects visually.',
    } } : {}),
    results,
    hint:
      broken.length === 0
        ? 'No page overflowed its viewport at any tested width. Check touch_targets_below and clipped_text for the subtler problems.'
        : 'Each overflowing entry is the outermost offender; its children inherit the overflow and are not listed. The prior viewport was restored.',
  };
}
