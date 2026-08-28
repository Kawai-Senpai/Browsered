/**
 * Skeleton loading screens measured from the real UI.
 *
 * The approach is boneyard's (github.com/0xGF/boneyard): a placeholder screen
 * is only convincing when its boxes sit exactly where the real content will,
 * and nobody can hand-tune that across three breakpoints. The browser already
 * knows the answer, so measure it rather than guess it. The extraction rules
 * below follow boneyard's `snapshotBones` closely, because each of them encodes
 * a real failure it hit first; the differences are noted where they are
 * deliberate.
 *
 * What a bone is
 *
 * Leaves become bones: text runs, media, form controls, and painted childless
 * boxes. Containers are walked through rather than drawn over, EXCEPT when a
 * container has a visual surface of its own (a background, a background image,
 * or a visible border on a rounded element - a white card is still a card).
 * Those emit a container bone, drawn in a lighter colour underneath their
 * children, which is what makes a skeleton read as a card holding rows rather
 * than as one grey slab.
 *
 * Two places this goes further than boneyard
 *
 * Wrapped text is split per visual line, using Range client rects, so a
 * paragraph becomes stacked bars instead of one tall block. That is what a
 * hand-made skeleton looks like.
 *
 * Bones are identified by their position in the DOM, not by their index in the
 * result, and one capture spans every width. A card that is display:none below
 * 700px is recorded as absent at 375px rather than shifting every later bone
 * into the wrong slot, and the emitted CSS hides it in exactly the breakpoints
 * where it does not exist. boneyard stores an independent snapshot per
 * breakpoint and picks one at runtime; keying by DOM path lets the output be
 * plain CSS with media queries, which needs no runtime at all.
 *
 * Geometry
 *
 * Horizontal geometry is emitted as a percentage of the capture root and
 * vertical geometry in pixels, so between two captured widths the skeleton
 * stretches the way a fluid layout does instead of snapping. The one exception
 * is a circle: a bone with a 50% radius that is square when measured is emitted
 * with its width in pixels, because a percentage width would turn it into an
 * ellipse the moment the container is not exactly the captured size. The stored
 * .bones.json keeps raw CSS pixels, so it is also usable as plain measurement
 * data.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import { homeDir } from '../util/paths.js';
import type { OpsContext } from './context.js';
import { evaluate } from './element.js';
import { navigate } from './page.js';

export interface BoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixels, '50%' for a circle, or a four-corner CSS string for asymmetric corners. */
export type BoneRadius = number | string;

export type BoneShape = 'text' | 'media' | 'control' | 'block' | 'container';

export interface Bone {
  key: string;
  name: string;
  shape: BoneShape;
  radius: BoneRadius;
  /** Drawn lighter, underneath its children. */
  container?: boolean;
  /** Rectangle per captured width, in CSS px relative to the root. Absent = not rendered there. */
  at: Record<string, BoneRect>;
}

export interface Skeleton {
  name: string;
  url: string;
  root: string;
  marker?: string;
  captured_at: string;
  widths: number[];
  sizes: Record<string, { width: number; height: number }>;
  bones: Bone[];
}

/* ------------------------------ persistence ------------------------------ */

function skeletonDir(): string {
  const dir = join(homeDir(), 'skeletons');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Names become filenames, so keep them to something that cannot escape the directory. */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new AgentBrowserError(
      'bad_name',
      `Skeleton names must be 1-64 chars of letters, digits, dot, dash or underscore. Got ${JSON.stringify(name)}.`,
    );
  }
}

function pathFor(name: string): string {
  assertSafeName(name);
  return join(skeletonDir(), `${name}.bones.json`);
}

function listNames(): string[] {
  try {
    return readdirSync(skeletonDir())
      .filter((f) => f.endsWith('.bones.json'))
      .map((f) => f.slice(0, -'.bones.json'.length));
  } catch {
    return [];
  }
}

function readSkeleton(name: string): Skeleton {
  const file = pathFor(name);
  if (!existsSync(file)) {
    const known = listNames();
    throw new AgentBrowserError(
      'no_such_skeleton',
      `No skeleton named ${JSON.stringify(name)}.` +
        (known.length ? ` Saved: ${known.join(', ')}.` : ' None are captured yet.'),
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Skeleton;
}

/* -------------------------------- capture -------------------------------- */

/**
 * Runs in the page. Returns one entry per bone at the current viewport width,
 * each keyed by its DOM path so the caller can merge widths together.
 */
const MEASURE_FN = `(function (rootSelector, markerAttr, opts) {
  const root = (rootSelector ? document.querySelector(rootSelector) : null) || document.body;
  const rootRect = root.getBoundingClientRect();

  const leafTags = new Set(opts.leafTags);
  const excludeTags = new Set(opts.excludeTags);
  const excludeSelectors = opts.excludeSelectors;
  const MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME']);
  const CONTROL = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
  // Table cells inherit a radius from an overflow:hidden ancestor that they do
  // not actually paint, so a rounded table would give every cell rounded corners.
  const TABLE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

  const pathKey = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== root && node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    return parts.join('/');
  };

  const label = (el) => {
    const out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean)[0];
    return cls ? out + '.' + cls : out;
  };

  const hidden = (el, style) =>
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number(style.opacity) === 0 ||
    (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0);

  /** Children that are actually rendered. A container whose only child is
   *  display:none is a leaf, and treating it as a container draws nothing. */
  const visibleChildren = (el) =>
    Array.prototype.filter.call(el.children, (child) => !hidden(child, getComputedStyle(child)));

  const rel = (rect) => ({
    x: Math.round(rect.left - rootRect.left),
    y: Math.round(rect.top - rootRect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  });

  const px = (value) => parseFloat(value) || 0;

  /**
   * Border radius as something a stylesheet can use directly.
   *
   * The distinction that matters: border-radius:50% on a square is a circle and
   * must stay one at any container width, while 9999px on a rectangle is a pill
   * and must not become an ellipse. They are different values, not one rounded
   * number, which is why this can return a string.
   */
  const parseRadius = (style, rect, isTable) => {
    if (isTable) return 0;
    const tl = px(style.borderTopLeftRadius);
    const tr = px(style.borderTopRightRadius);
    const br = px(style.borderBottomRightRadius);
    const bl = px(style.borderBottomLeftRadius);
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return 0;

    const squarish = rect.width > 0 && rect.height > 0 && Math.abs(rect.width - rect.height) < 4;
    // A percentage radius stays a percentage in the computed value.
    if (String(style.borderTopLeftRadius).indexOf('%') !== -1) return '50%';
    // rounded-full and friends: a circle when square, a pill when not.
    if (Math.max(tl, tr, br, bl) > 9998) return squarish ? '50%' : 9999;
    if (tl === tr && tr === br && br === bl) return squarish && tl >= rect.width / 2 - 1 ? '50%' : Math.round(tl);
    return Math.round(tl) + 'px ' + Math.round(tr) + 'px ' + Math.round(br) + 'px ' + Math.round(bl) + 'px';
  };

  const bones = [];
  const push = (key, name, shape, radius, rect, container) => {
    if (bones.length >= opts.maxBones) return false;
    if (rect.w < opts.minSize || rect.h < opts.minSize) return false;
    // A bone entirely outside the root is a fixed header or an off-screen menu:
    // drawing it would put grey boxes over unrelated parts of the page.
    if (rect.x + rect.w < 0 || rect.y + rect.h < 0) return false;
    if (rect.x > rootRect.width || rect.y > rootRect.height) return false;
    const bone = { key: key, name: name, shape: shape, radius: radius, rect: rect };
    if (container) bone.container = true;
    bones.push(bone);
    return true;
  };

  /** Each visual line of a text run, so wrapped copy reads as stacked bars. */
  const textLines = (el) => {
    const out = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) out.push(rect);
        if (out.length >= opts.maxLines) return out;
      }
    }
    return out;
  };

  const hasOwnText = (el) =>
    Array.prototype.some.call(
      el.childNodes,
      (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
    );

  /** A surface the user can see: a background, an image, or a bordered card. */
  const surfaceOf = (style) => {
    const bg = style.backgroundColor;
    const hasBg = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasImage = style.backgroundImage !== 'none';
    const borderWidth = px(style.borderTopWidth);
    const borderColor = style.borderTopColor;
    const hasBorder =
      opts.captureRoundedBorders &&
      borderWidth > 0 &&
      borderColor !== 'rgba(0, 0, 0, 0)' &&
      borderColor !== 'transparent';
    const rounded =
      px(style.borderTopLeftRadius) > 0 || String(style.borderTopLeftRadius).indexOf('%') !== -1;
    return hasBg || hasImage || (hasBorder && rounded);
  };

  const excluded = (el, tag) => {
    if (excludeTags.has(tag)) return true;
    for (const selector of excludeSelectors) {
      try {
        if (el.matches(selector)) return true;
      } catch (e) {
        // An invalid selector must not abort the whole capture.
      }
    }
    return false;
  };

  const marked = markerAttr ? root.querySelectorAll('[' + markerAttr + ']') : [];

  if (marked.length > 0) {
    // Explicit markers win: the author has already said what a placeholder is.
    for (const el of marked) {
      const style = getComputedStyle(el);
      if (hidden(el, style)) continue;
      const tag = el.tagName.toLowerCase();
      if (excluded(el, tag)) continue;
      const rect = el.getBoundingClientRect();
      const name = el.getAttribute(markerAttr) || label(el);
      const shape = MEDIA.has(el.tagName) ? 'media' : CONTROL.has(el.tagName) ? 'control' : 'block';
      let radius = parseRadius(style, rect, TABLE.has(tag));
      if (radius === 0) radius = opts.defaultRadius;
      push(pathKey(el), name, shape, radius, rel(rect), false);
    }
  } else {
    const walk = (el) => {
      if (bones.length >= opts.maxBones) return;
      const style = getComputedStyle(el);
      if (hidden(el, style)) return;
      const tag = el.tagName.toLowerCase();
      if (excluded(el, tag)) return;

      const rect = el.getBoundingClientRect();
      const isTable = TABLE.has(tag);
      let radius = parseRadius(style, rect, isTable);

      if (MEDIA.has(el.tagName)) {
        if (radius === 0) radius = opts.defaultRadius;
        push(pathKey(el), label(el), 'media', radius, rel(rect), false);
        return;
      }
      if (CONTROL.has(el.tagName)) {
        if (radius === 0) radius = opts.defaultRadius;
        push(pathKey(el), label(el), 'control', radius, rel(rect), false);
        return;
      }

      const kids = visibleChildren(el);
      const ownText = hasOwnText(el);
      const surface = surfaceOf(style);

      // A container with a surface of its own is drawn underneath its children,
      // so a card reads as a card rather than as free-floating rows.
      if (opts.containers && kids.length > 0 && surface) {
        push(pathKey(el), label(el), 'container', radius, rel(rect), true);
      }

      if (ownText) {
        const key = pathKey(el);
        const textRadius =
          typeof radius === 'number' && radius > 0 ? Math.min(radius, opts.textRadius) : opts.textRadius;
        const lines = textLines(el);
        for (let i = 0; i < lines.length; i++) {
          push(key + ':L' + i, label(el), 'text', textRadius, rel(lines[i]), false);
        }
        // An element can hold both text and children (a paragraph with a link),
        // so keep going rather than returning here.
      }

      if (kids.length === 0) {
        if (!ownText && (surface || leafTags.has(tag))) {
          if (radius === 0) radius = opts.defaultRadius;
          push(pathKey(el), label(el), 'block', radius, rel(rect), false);
        }
        return;
      }

      for (const child of kids) walk(child);
    };
    for (const child of visibleChildren(root)) walk(child);
  }

  return {
    root: { width: Math.round(rootRect.width), height: Math.round(rootRect.height) },
    marker_matches: marked.length,
    bones: bones,
  };
})`;

interface MeasuredBone {
  key: string;
  name: string;
  shape: BoneShape;
  radius: BoneRadius;
  rect: BoneRect;
  container?: boolean;
}

interface MeasureResult {
  root: { width: number; height: number };
  marker_matches: number;
  bones: MeasuredBone[];
}

/** boneyard's leaf tags: block-level text elements captured as one unit. */
const DEFAULT_LEAF_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th'];

/**
 * Document order from the DOM-path keys, so a container bone is always emitted
 * before its descendants and therefore paints underneath them.
 */
function comparePaths(a: string, b: string): number {
  const [pathA, lineA] = a.split(':L');
  const [pathB, lineB] = b.split(':L');
  const segA = pathA!.length ? pathA!.split('/').map(Number) : [];
  const segB = pathB!.length ? pathB!.split('/').map(Number) : [];
  for (let i = 0; i < Math.max(segA.length, segB.length); i++) {
    const x = segA[i];
    const y = segB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return Number(lineA ?? -1) - Number(lineB ?? -1);
}

export async function captureSkeleton(
  ctx: OpsContext,
  args: {
    browser_id?: string;
    target_id?: string;
    name: string;
    url?: string;
    selector?: string;
    marker?: string;
    widths?: number[];
    height?: number;
    min_size?: number;
    max_bones?: number;
    max_lines?: number;
    leaf_tags?: string[];
    exclude_tags?: string[];
    exclude_selectors?: string[];
    containers?: boolean;
    capture_rounded_borders?: boolean;
    default_radius?: number;
    device_scale_factor?: number;
    mobile?: boolean;
    replace?: boolean;
    save_path?: string;
    include_bones?: boolean;
  },
): Promise<Record<string, unknown>> {
  assertSafeName(args.name);
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  instance.requireControl('skeleton.capture');

  const widths = [
    ...new Set(
      (args.widths?.length ? args.widths : [375, 768, 1280]).map((w) =>
        Math.min(Math.max(Math.round(w), 200), 4000),
      ),
    ),
  ].sort((a, b) => a - b);
  const height = Math.min(Math.max(args.height ?? 900, 200), 4000);
  const marker = args.marker ?? 'data-skeleton';
  const root = args.selector ?? 'body';
  const opts = {
    minSize: args.min_size ?? 1,
    maxBones: Math.min(args.max_bones ?? 400, 2000),
    maxLines: Math.min(args.max_lines ?? 12, 40),
    leafTags: [...new Set([...DEFAULT_LEAF_TAGS, ...(args.leaf_tags ?? []).map((t) => t.toLowerCase())])],
    excludeTags: (args.exclude_tags ?? []).map((t) => t.toLowerCase()),
    excludeSelectors: args.exclude_selectors ?? [],
    containers: args.containers !== false,
    captureRoundedBorders: args.capture_rounded_borders !== false,
    defaultRadius: args.default_radius ?? 8,
    textRadius: 4,
  };

  if (args.url) {
    await navigate(ctx, {
      browser_id: instance.id,
      target_id: target.handle,
      url: args.url,
      wait_until: 'load',
    });
  }

  const byKey = new Map<string, Bone>();
  const sizes: Record<string, { width: number; height: number }> = {};
  let markerMatches = 0;

  try {
    for (const width of widths) {
      // mobile:true is deliberately opt-in. Mobile emulation gives a page with
      // no <meta name="viewport"> a 980px *layout* viewport, so its media
      // queries evaluate at 980 while the window says 375, and every measured
      // box comes back describing the desktop layout at a narrow scale. What a
      // skeleton needs is the geometry at a CSS width, which plain metrics
      // override gives correctly whether or not the page opts into mobile.
      await target.session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: args.device_scale_factor ?? 1,
        mobile: args.mobile === true,
      });
      // Let the relayout and any width-driven media queries settle.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { result, exceptionText } = await evaluate(instance, target, {
        expression: `(${MEASURE_FN})(${JSON.stringify(args.selector ?? null)}, ${JSON.stringify(marker)}, ${JSON.stringify(opts)})`,
        returnByValue: true,
        awaitPromise: false,
      });
      if (exceptionText) {
        throw new AgentBrowserError('measure_failed', `Skeleton measurement threw in the page: ${exceptionText}`);
      }
      const measured = result.value as MeasureResult | undefined;
      if (!measured) {
        throw new AgentBrowserError('measure_failed', 'Skeleton measurement returned nothing.');
      }

      markerMatches = Math.max(markerMatches, measured.marker_matches);
      sizes[String(width)] = measured.root;
      for (const bone of measured.bones) {
        const existing = byKey.get(bone.key);
        if (existing) {
          existing.at[String(width)] = bone.rect;
          // A circle at one width must stay a circle: a string radius is a
          // shape decision and outranks a plain pixel value measured elsewhere.
          if (typeof bone.radius === 'string' && typeof existing.radius === 'number') {
            existing.radius = bone.radius;
          }
        } else {
          const created: Bone = {
            key: bone.key,
            name: bone.name,
            shape: bone.shape,
            radius: bone.radius,
            at: { [String(width)]: bone.rect },
          };
          if (bone.container) created.container = true;
          byKey.set(bone.key, created);
        }
      }
    }
  } finally {
    // Always hand the page back at its real size, even if a probe threw.
    await target.session.trySend('Emulation.clearDeviceMetricsOverride');
  }

  const allWidths = [...widths];

  /*
   * Preserve widths from an earlier capture of the same root.
   *
   * boneyard learned this the hard way (its issue #81): a run only visits what
   * it can reach, and regenerating from that run alone silently drops
   * everything it did not visit. Re-capturing at one width must not throw away
   * the other two.
   */
  if (!args.replace && existsSync(pathFor(args.name))) {
    try {
      const previous = readSkeleton(args.name);
      if (previous.root === root) {
        const kept = previous.widths.filter((w) => !widths.includes(w));
        for (const width of kept) {
          const key = String(width);
          if (previous.sizes[key]) sizes[key] = previous.sizes[key]!;
          allWidths.push(width);
        }
        if (kept.length > 0) {
          for (const bone of previous.bones) {
            const merged = byKey.get(bone.key);
            for (const width of kept) {
              const rect = bone.at[String(width)];
              if (!rect) continue;
              if (merged) merged.at[String(width)] = rect;
              else byKey.set(bone.key, { ...bone, at: { [String(width)]: rect } });
            }
          }
        }
      }
    } catch {
      // An unreadable previous capture is not a reason to lose this one.
    }
  }
  allWidths.sort((a, b) => a - b);

  const bones = [...byKey.values()].sort((a, b) => comparePaths(a.key, b.key));

  if (bones.length === 0) {
    throw new AgentBrowserError(
      'no_bones',
      `Nothing measurable under ${root}. The page may not have rendered yet, or the root selector matches an empty container. Try page.wait_for first, or a different selector.`,
    );
  }

  const skeleton: Skeleton = {
    name: args.name,
    url: target.info.url,
    root,
    ...(markerMatches > 0 ? { marker } : {}),
    captured_at: new Date().toISOString(),
    widths: allWidths,
    sizes,
    bones,
  };

  const file = pathFor(args.name);
  const json = JSON.stringify(skeleton, null, 2);
  writeFileSync(file, json, 'utf8');

  const artifact = ctx.stores.artifacts.put('skeleton', Buffer.from(json, 'utf8'), {
    browserId: instance.id,
    label: args.name,
    mime: 'application/json',
    sourceRef: target.handle,
  });

  const out: Record<string, unknown> = {
    name: args.name,
    url: skeleton.url,
    root,
    widths: allWidths,
    widths_captured_now: widths,
    bones: bones.length,
    by_shape: bones.reduce<Record<string, number>>((acc, b) => {
      acc[b.shape] = (acc[b.shape] ?? 0) + 1;
      return acc;
    }, {}),
    sizes,
    responsive_bones: bones.filter((b) => Object.keys(b.at).length !== allWidths.length).length,
    source: markerMatches > 0 ? `marker:${marker}` : 'auto',
    file,
    artifact: toArtifactRef(artifact),
    hint:
      markerMatches > 0
        ? `Measured ${markerMatches} marked elements. skeleton.emit turns this into a component; skeleton.preview draws it over the live page.`
        : `No [${marker}] elements found, so the layout was decomposed automatically. Mark the elements you want placeholders for, narrow with selector, or pass exclude_selectors, if the result is too busy.`,
  };
  if (args.include_bones) out.bone_list = bones;
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/* -------------------------------- registry ------------------------------- */

export async function listSkeletons(
  _ctx: OpsContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const skeletons = listNames().map((name) => {
    try {
      const s = readSkeleton(name);
      return {
        name: s.name,
        url: s.url,
        root: s.root,
        widths: s.widths,
        bones: s.bones.length,
        captured_at: s.captured_at,
      };
    } catch {
      return { name, error: 'unreadable' };
    }
  });
  return { skeletons, count: skeletons.length, directory: skeletonDir() };
}

export async function showSkeleton(
  _ctx: OpsContext,
  args: { name: string; width?: number; limit?: number },
): Promise<Record<string, unknown>> {
  const skeleton = readSkeleton(args.name);
  const limit = args.limit ?? 100;

  if (args.width === undefined) {
    return {
      ...skeleton,
      bones: skeleton.bones.slice(0, limit),
      bones_total: skeleton.bones.length,
      truncated: skeleton.bones.length > limit,
    };
  }

  const width = nearestWidth(skeleton, args.width);
  const bones = skeleton.bones
    .filter((b) => b.at[String(width)])
    .map((b) => ({
      name: b.name,
      shape: b.shape,
      radius: b.radius,
      ...(b.container ? { container: true } : {}),
      ...b.at[String(width)]!,
    }));
  return {
    name: skeleton.name,
    width,
    size: skeleton.sizes[String(width)],
    bones: bones.slice(0, limit),
    bones_total: bones.length,
    truncated: bones.length > limit,
  };
}

export async function deleteSkeleton(
  _ctx: OpsContext,
  args: { name: string },
): Promise<Record<string, unknown>> {
  const file = pathFor(args.name);
  if (!existsSync(file)) {
    throw new AgentBrowserError('no_such_skeleton', `No skeleton named ${JSON.stringify(args.name)}.`);
  }
  rmSync(file);
  return { deleted: true, name: args.name };
}

function nearestWidth(skeleton: Skeleton, width: number): number {
  return skeleton.widths.reduce((best, w) => (Math.abs(w - width) < Math.abs(best - width) ? w : best));
}

/* ---------------------------------- emit --------------------------------- */

type Animation = 'pulse' | 'shimmer' | 'solid';

/**
 * Class name for one bone. Indexed rather than derived from the DOM path,
 * because a path contains slashes and colons and a bone name is not unique.
 */
function boneClass(prefix: string, index: number): string {
  return `${prefix}__b${index}`;
}

/**
 * Selector for one bone, qualified by the shared rule's own selector.
 *
 * This is not cosmetic. The shared rule is `.p__in > i`, specificity (0,1,1);
 * a bare `.p__b12` is (0,1,0) and LOSES to it, so every per-breakpoint override
 * was silently ignored while the base rule kept painting. Breakpoint at-rules
 * add no specificity of their own, so the override has to out-specify the rule
 * it is overriding: `.p__in > i.p__b12` is (0,1,2) and wins.
 */
function boneSelector(prefix: string, index: number): string {
  return `.${prefix}__in > i.${boneClass(prefix, index)}`;
}

function radiusCss(radius: BoneRadius): string {
  return typeof radius === 'number' ? `${radius}px` : radius;
}

function keyframes(animation: Animation, prefix: string): string {
  if (animation === 'shimmer') {
    return `@keyframes ${prefix}-shimmer { 100% { transform: translateX(100%); } }`;
  }
  if (animation === 'pulse') {
    return `@keyframes ${prefix}-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }`;
  }
  return '';
}

interface Palette {
  color: string;
  highlight: string;
  container: string;
}

function boneBaseCss(
  prefix: string,
  animation: Animation,
  palette: Palette,
  mode: BreakpointMode,
): string {
  const inner = `${prefix}__in`;
  const lines = [
    // The root is the query container and holds no geometry of its own; the
    // inner wrapper carries the height, because an element cannot answer a
    // container query about itself.
    mode === 'container'
      ? `.${prefix} { container-type: inline-size; width: 100%; }`
      : `.${prefix} { width: 100%; }`,
    `.${inner} { position: relative; width: 100%; }`,
    `.${inner} > i { position: absolute; display: block; background: ${palette.color}; overflow: hidden; }`,
    // Container bones sit underneath their children and must read as the
    // surface, not as content: lighter, and never animated on their own.
    `.${inner} > i.${prefix}--surface { background: ${palette.container}; }`,
  ];
  if (animation === 'pulse') {
    lines.push(`.${inner} > i { animation: ${prefix}-pulse 1.5s ease-in-out infinite; }`);
    lines.push(`.${inner} > i.${prefix}--surface { animation: none; }`);
  }
  if (animation === 'shimmer') {
    lines.push(
      `.${inner} > i:not(.${prefix}--surface)::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); ` +
        `background: linear-gradient(90deg, transparent, ${palette.highlight}, transparent); ` +
        `animation: ${prefix}-shimmer 1.4s infinite; }`,
    );
  }
  lines.push(
    `@media (prefers-reduced-motion: reduce) { .${inner} > i, .${inner} > i::after { animation: none; } }`,
  );
  return lines.join('\n');
}

/**
 * One CSS block per captured width. The narrowest width is the base rule and
 * every wider one is a min-width override, so the output is mobile-first and a
 * width between two captures inherits the nearer smaller layout.
 *
 * The breakpoints are CONTAINER queries by default, not media queries, and that
 * distinction is the whole point. A skeleton's geometry is relative to the
 * element it was captured from, so the width that should select a breakpoint is
 * that element's width. The viewport is a different number: measured on Hacker
 * News, the capture root was 796px inside a 764px viewport, so media queries
 * picked the 375px layout and the placeholder rendered 1200px too tall. It is
 * worse for a component that is not full-bleed - a 400px sidebar card would
 * pick its breakpoint from the window, which says nothing about the sidebar.
 *
 * `mode: 'media'` restores viewport breakpoints for browsers older than
 * container-query support (Chrome 105, Safari 16, Firefox 110); it is only
 * correct when the skeleton fills the viewport width.
 */
function layoutCss(skeleton: Skeleton, prefix: string, mode: BreakpointMode): string {
  const blocks: string[] = [];
  const inner = `${prefix}__in`;
  skeleton.widths.forEach((width, i) => {
    const key = String(width);
    const size = skeleton.sizes[key];
    const rules: string[] = [];
    if (size) rules.push(`.${inner} { height: ${size.height}px; }`);

    skeleton.bones.forEach((bone, index) => {
      const rect = bone.at[key];
      const cls = boneSelector(prefix, index);
      if (!rect) {
        // Present at another width, absent here. This has to be emitted at
        // every width including the base one: a bone that first appears at
        // 768px would otherwise inherit `display: block` from the shared rule
        // and render on mobile as a zero-geometry box in the top-left corner.
        rules.push(`${cls} { display: none; }`);
        return;
      }
      const rootWidth = size?.width || width;
      const left = ((rect.x / rootWidth) * 100).toFixed(3);
      // A circle must survive the container being any width at all, so it keeps
      // its pixel width. Everything else scales with the root.
      const circle = bone.radius === '50%' && Math.abs(rect.w - rect.h) < 4;
      const boxWidth = circle ? `${rect.w}px` : `${((rect.w / rootWidth) * 100).toFixed(3)}%`;
      rules.push(
        `${cls} { display: block; left: ${left}%; top: ${rect.y}px; width: ${boxWidth}; height: ${rect.h}px;` +
          (bone.radius ? ` border-radius: ${radiusCss(bone.radius)};` : '') +
          ` }`,
      );
    });

    const at = mode === 'container' ? '@container' : '@media';
    blocks.push(
      i === 0
        ? rules.join('\n')
        : `${at} (min-width: ${width}px) {\n${rules.map((r) => '  ' + r).join('\n')}\n}`,
    );
  });
  return blocks.join('\n\n');
}

/** Breakpoints keyed on the skeleton's own container, or on the viewport. */
export type BreakpointMode = 'container' | 'media';

function bonesMarkup(skeleton: Skeleton, prefix: string, indent: string): string {
  return skeleton.bones
    .map((bone, index) => {
      const cls = bone.container
        ? `${boneClass(prefix, index)} ${prefix}--surface`
        : boneClass(prefix, index);
      return `${indent}<i class="${cls}" data-bone="${bone.name}"></i>`;
    })
    .join('\n');
}

/** The full element: query container, sizing wrapper, then the bones. */
function markup(skeleton: Skeleton, prefix: string, indent: string, attrs: string): string {
  return (
    `${indent}<div class="${prefix}"${attrs}>\n` +
    `${indent}  <div class="${prefix}__in">\n` +
    bonesMarkup(skeleton, prefix, `${indent}    `) +
    `\n${indent}  </div>\n` +
    `${indent}</div>`
  );
}

/**
 * Blend a colour towards transparency for the container surface.
 *
 * Only rgb/rgba and #rrggbb are understood; anything else (a CSS variable, a
 * colour function) is passed through unchanged, because guessing at it would
 * produce an invalid declaration rather than a slightly wrong colour.
 */
function containerColor(color: string, factor = 0.45): string {
  const rgba = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/i.exec(color);
  if (rgba) {
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${(alpha * factor).toFixed(3)})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1]!;
    return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${factor.toFixed(3)})`;
  }
  return color;
}

function paletteFor(args: { color?: string; highlight?: string; container_color?: string }): Palette {
  const color = args.color ?? 'rgba(128, 128, 128, 0.18)';
  return {
    color,
    highlight: args.highlight ?? 'rgba(128, 128, 128, 0.32)',
    container: args.container_color ?? containerColor(color),
  };
}

export async function emitSkeleton(
  ctx: OpsContext,
  args: {
    name: string;
    format?: 'html' | 'css' | 'react' | 'vue' | 'svelte' | 'json';
    animation?: Animation;
    color?: string;
    highlight?: string;
    container_color?: string;
    class_prefix?: string;
    component?: string;
    breakpoints?: BreakpointMode;
    save_path?: string;
  },
): Promise<Record<string, unknown>> {
  const skeleton = readSkeleton(args.name);
  const format = args.format ?? 'html';
  const animation: Animation = args.animation ?? 'shimmer';
  const mode: BreakpointMode = args.breakpoints ?? 'container';
  const palette = paletteFor(args);
  const prefix = (args.class_prefix ?? `skeleton-${skeleton.name}`).replace(/[^A-Za-z0-9_-]/g, '-');
  const component =
    args.component ??
    `${skeleton.name.replace(/(^|[^A-Za-z0-9])([a-z])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')}Skeleton`;

  const css = [
    keyframes(animation, prefix),
    boneBaseCss(prefix, animation, palette, mode),
    layoutCss(skeleton, prefix, mode),
  ]
    .filter(Boolean)
    .join('\n\n');

  const a11y = ' role="status" aria-busy="true" aria-label="Loading"';
  let source: string;
  let extension: string;
  let mime = 'text/plain';

  if (format === 'json') {
    source = JSON.stringify(skeleton, null, 2);
    extension = 'json';
    mime = 'application/json';
  } else if (format === 'css') {
    source = css;
    extension = 'css';
    mime = 'text/css';
  } else if (format === 'html') {
    source = `<style>\n${css}\n</style>\n${markup(skeleton, prefix, '', a11y)}\n`;
    extension = 'html';
    mime = 'text/html';
  } else if (format === 'react') {
    source =
      `const css = \`\n${css.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\n\`;\n\n` +
      `export function ${component}() {\n` +
      `  return (\n` +
      `    <>\n` +
      `      <style>{css}</style>\n` +
      markup(skeleton, prefix, '      ', a11y)
        .replace(/class=/g, 'className=')
        .replace(/><\/i>/g, ' />') +
      `\n    </>\n  );\n}\n`;
    extension = 'jsx';
  } else if (format === 'vue') {
    source =
      `<template>\n${markup(skeleton, prefix, '  ', a11y)}\n</template>\n\n<style scoped>\n${css}\n</style>\n`;
    extension = 'vue';
  } else {
    source = `${markup(skeleton, prefix, '', a11y)}\n\n<style>\n${css}\n</style>\n`;
    extension = 'svelte';
  }

  const artifact = ctx.stores.artifacts.put('skeleton_source', Buffer.from(source, 'utf8'), {
    label: `${skeleton.name}.${extension}`,
    mime,
  });

  const out: Record<string, unknown> = {
    name: skeleton.name,
    format,
    animation,
    class_prefix: prefix,
    breakpoints: mode,
    bones: skeleton.bones.length,
    container_bones: skeleton.bones.filter((b) => b.container).length,
    widths: skeleton.widths,
    bytes: Buffer.byteLength(source, 'utf8'),
    artifact: toArtifactRef(artifact),
    source,
  };
  if (format === 'react' || format === 'vue' || format === 'svelte') out.component = component;
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/* -------------------------------- preview -------------------------------- */

const OVERLAY_ID = 'browserd-skeleton-overlay';

const PREVIEW_FN = `(function (id, rootSelector, css, html, remove) {
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  if (remove) return { removed: !!existing };

  const anchor = (rootSelector ? document.querySelector(rootSelector) : null) || document.body;
  const rect = anchor.getBoundingClientRect();

  const host = document.createElement('div');
  host.id = id;
  host.style.cssText =
    'position:absolute;z-index:2147483646;pointer-events:none;' +
    'left:' + (rect.left + window.scrollX) + 'px;' +
    'top:' + (rect.top + window.scrollY) + 'px;' +
    'width:' + rect.width + 'px;';

  // A shadow root keeps the generated class names from colliding with the page,
  // and keeps the page's own CSS from restyling the bones.
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const body = document.createElement('div');
  body.innerHTML = html;
  shadow.appendChild(style);
  shadow.appendChild(body);
  document.body.appendChild(host);

  return {
    shown: true,
    anchored_to: rootSelector || 'body',
    width: Math.round(rect.width),
    bones: body.querySelectorAll('i').length,
  };
})`;

export async function previewSkeleton(
  ctx: OpsContext,
  args: {
    browser_id?: string;
    target_id?: string;
    name: string;
    selector?: string;
    animation?: Animation;
    color?: string;
    highlight?: string;
    container_color?: string;
    breakpoints?: BreakpointMode;
    remove?: boolean;
  },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  instance.requireControl('skeleton.preview');

  if (args.remove) {
    const { result } = await evaluate(instance, target, {
      expression: `(${PREVIEW_FN})(${JSON.stringify(OVERLAY_ID)}, null, '', '', true)`,
      returnByValue: true,
      awaitPromise: false,
    });
    return { target_id: target.handle, ...(result.value as Record<string, unknown>) };
  }

  const skeleton = readSkeleton(args.name);
  const animation: Animation = args.animation ?? 'shimmer';
  const palette = paletteFor(args);
  const prefix = 'sk';
  // The overlay host is sized to the anchor element, so a container query is
  // asking exactly the right question: how wide is the thing being covered.
  const mode: BreakpointMode = args.breakpoints ?? 'container';
  const css = [
    keyframes(animation, prefix),
    boneBaseCss(prefix, animation, palette, mode),
    layoutCss(skeleton, prefix, mode),
  ]
    .filter(Boolean)
    .join('\n');
  const html = markup(skeleton, prefix, '', '');

  const { result, exceptionText } = await evaluate(instance, target, {
    expression: `(${PREVIEW_FN})(${JSON.stringify(OVERLAY_ID)}, ${JSON.stringify(args.selector ?? skeleton.root)}, ${JSON.stringify(css)}, ${JSON.stringify(html)}, false)`,
    returnByValue: true,
    awaitPromise: false,
  });
  if (exceptionText) {
    throw new AgentBrowserError('preview_failed', `Skeleton preview threw in the page: ${exceptionText}`);
  }

  return {
    target_id: target.handle,
    name: skeleton.name,
    animation,
    ...(result.value as Record<string, unknown>),
    hint: 'The overlay is a shadow-DOM element outside the app tree; page.screenshot captures it. Call skeleton.preview{remove:true} to take it down.',
  };
}
