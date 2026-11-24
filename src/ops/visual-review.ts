import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { auditLayout } from './audit.js';
import * as attention from './attention.js';
import { screenshot } from './page.js';
import { layerView } from './layer-view.js';
import { evaluate } from './element.js';
import { diffPixels, readVisualPng } from './visual-diff.js';
import type { DesignAuditOptions } from './design-audit.js';
import type { AttentionTarget, PixelBox, ScreenshotRegions } from './screenshot-regions.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError, describeError } from '../util/errors.js';
import type { OpsContext, TargetRef, ToolRun } from './context.js';
import { renderVisualReview } from './visual-review-view.js';

type AttentionConfig = Pick<attention.ModelOptions, 'backend' | 'balance' | 'faces'>;
type ReviewOptions = TargetRef & {
  widths?: number[];
  height?: number;
  design?: DesignAuditOptions;
  attention?: boolean | AttentionConfig;
  attention_targets?: AttentionTarget[];
  mask_selectors?: string[];
  baseline?: string;
  threshold?: number;
  return_image?: boolean;
};
type Issue = { code: string; selector?: string; detail: Record<string, unknown>; box?: PixelBox };
type ArtifactRef = ReturnType<typeof toArtifactRef>;
export type Capture = {
  width: number;
  height: number;
  pixel_width: number;
  pixel_height: number;
  url: string;
  theme: string;
  scroll: [number, number];
  stable: boolean;
  capture_diagnostic?: Record<string, unknown>;
  screenshot: ArtifactRef;
  masks: PixelBox[];
  horizontal_scroll: boolean;
  counts: Record<string, number>;
  findings: Issue[];
  attention?: Record<string, unknown>;
  comparison?: Record<string, unknown>;
};
type Review = {
  version: 1; mask_selectors: string[]; design: DesignAuditOptions;
  attention_targets: AttentionTarget[]; attention: boolean | AttentionConfig; viewports: Capture[];
};
type Baseline = { name: string; report_handle: string; approved_at: number };
const REPORT_LABEL = 'visual-review-data';

function baselineRow(ctx: OpsContext, name: string): Baseline | undefined {
  return ctx.stores.db.prepare('SELECT name, report_handle, approved_at FROM visual_baselines WHERE name = ?').get(name) as Baseline | undefined;
}

async function readReport(ctx: OpsContext, id: string): Promise<Review> {
  const artifact = ctx.stores.artifacts.require(id);
  if (artifact.kind !== 'other' || artifact.label !== REPORT_LABEL || artifact.mime !== 'application/json') {
    throw new AgentBrowserError('invalid_visual_review', 'Pass the report_data artifact ID returned by visual.review.');
  }
  let json: string;
  try {
    json = await readFile(artifact.path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new AgentBrowserError('visual_review_artifact_missing', 'The saved visual review file is missing. Create a new review before approving or comparing it.');
  }
  const review = JSON.parse(json) as Review;
  if (review.version !== 1) throw new AgentBrowserError('invalid_visual_review', 'Unsupported visual review data version.');
  return review;
}

const artifactId = (ref: ArtifactRef) => ref.artifact_id as string;

function findingsOf(value: unknown) {
  type Row = Record<string, unknown>;
  const layout = value as {
    horizontal_scroll: boolean;
    overflowing: Row[]; overflowing_outermost_total: number;
    touch_targets_below: Row[]; touch_targets_below_total: number;
    clipped_text: Row[]; clipped_text_total: number;
    design: { counts: Record<string, number>; findings: Record<string, Row[]> };
  };
  const groups: Record<string, Row[]> = {
    horizontal_overflow: layout.overflowing,
    small_touch_target: layout.touch_targets_below,
    clipped_text: layout.clipped_text,
    ...layout.design.findings,
  };
  const counts = {
    horizontal_overflow: layout.overflowing_outermost_total,
    small_touch_target: layout.touch_targets_below_total,
    clipped_text: layout.clipped_text_total,
    ...layout.design.counts,
  };
  const findings: Issue[] = Object.entries(groups).flatMap(([code, rows]) => rows.flatMap(detail => {
    const selectors = [detail.selector, ...(Array.isArray(detail.buttons) ? detail.buttons.map(b => b.selector) : [])];
    return [...new Set(selectors.filter((selector): selector is string => typeof selector === 'string'))].map(selector =>
      ({ code, selector, detail }),
    ).concat(selectors.some(selector => typeof selector === 'string') ? [] : [{ code, selector: '', detail }]);
  }));
  return { horizontal_scroll: layout.horizontal_scroll, counts, findings };
}

function compareFindings(before: Capture, after: Capture) {
  const keys = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  const identity = (issue: Issue) => JSON.stringify([issue.code, issue.selector, issue.detail.role]);
  const minus = (a: Issue[], b: Issue[]) => {
    const known = new Set(b.map(identity));
    return a.filter(issue => !known.has(identity(issue))).map(({ code, selector }) => ({ code, selector }));
  };
  return {
    new_samples: minus(after.findings, before.findings),
    resolved_samples: minus(before.findings, after.findings),
    count_delta: Object.fromEntries([...keys].flatMap(code => {
      const delta = (after.counts[code] ?? 0) - (before.counts[code] ?? 0);
      return delta ? [[code, delta]] : [];
    })),
  };
}

async function compareCapture(ctx: OpsContext, before: Capture, after: Capture, threshold: number, sameRules: boolean, comparableGoals: Set<string>) {
  const findings = sameRules ? compareFindings(before, after) : { status: 'different_design_rules' };
  const baseline = before.screenshot;
  if (before.theme !== after.theme || before.scroll.some((offset, i) => offset !== after.scroll[i])) {
    return { baseline, status: 'capture_state_mismatch', hint: 'Use the same color preference and scroll position as the approved capture.' };
  }
  if (!after.stable) return { baseline, status: 'unstable_capture', findings };
  const [a, b] = await Promise.all([
    readVisualPng(ctx, artifactId(before.screenshot)), readVisualPng(ctx, artifactId(after.screenshot)),
  ]);
  if (a.png.width !== b.png.width || a.png.height !== b.png.height) return { baseline, status: 'dimensions_mismatch', findings };
  const { png, ...stats } = diffPixels(a.png, b.png, [...before.masks, ...after.masks], threshold, true);
  if (stats.compared_pixels === 0) return { baseline, status: 'fully_masked', findings };
  const diff = png && stats.changed_pixels ? toArtifactRef(ctx.stores.artifacts.put('other', png, {
    mime: 'image/png', label: 'visual-diff', sourceRef: artifactId(after.screenshot),
  })) : undefined;
  const prior = before.attention;
  const current = after.attention;
  const goals = (current?.backend === prior?.backend && current?.faces === prior?.faces)
    ? attentionDelta(prior, current).filter(goal => comparableGoals.has(goal.name)) : [];
  return { baseline, status: 'compared', ...stats, findings, ...(diff ? { diff } : {}), attention_targets: goals };
}

function attentionDelta(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  type Scored = { name: string; share: number | null };
  const prior = new Map(((before?.attention_targets ?? []) as Scored[]).map(row => [row.name, row.share]));
  return ((after?.attention_targets ?? []) as Scored[]).flatMap(row => {
    const share = prior.get(row.name);
    return share == null || row.share == null ? [] : [{
      name: row.name, delta_percentage_points: Number(((row.share - share) * 100).toFixed(2)),
    }];
  });
}

export async function review(ctx: OpsContext, args: ReviewOptions, run?: ToolRun) {
  const row = args.baseline ? baselineRow(ctx, args.baseline) : undefined;
  const prior = row ? await readReport(ctx, row.report_handle) : undefined;
  const masks = [...new Set(args.mask_selectors ?? prior?.mask_selectors ?? [])].sort();
  if (prior && JSON.stringify(masks) !== JSON.stringify(prior.mask_selectors)) {
    throw new AgentBrowserError('baseline_mask_mismatch', 'Use the approved mask selectors or omit mask_selectors to inherit them.');
  }
  const widths = [...new Set(args.widths ?? prior?.viewports.map(view => view.width) ?? [320, 414, 1280])];
  const height = args.height ?? prior?.viewports[0]?.height ?? 800;
  const viewports: Capture[] = [];
  const design = { geometry: true, ...prior?.design, ...args.design } satisfies DesignAuditOptions;
  const attentionTargets = args.attention_targets ?? prior?.attention_targets ?? [];
  const priorGoals = new Map(prior?.attention_targets.map(goal => [goal.name, JSON.stringify(goal)]));
  const comparableGoals = new Set(attentionTargets.filter(goal => JSON.stringify(goal) === priorGoals.get(goal.name)).map(goal => goal.name));
  const attentionMode = args.attention ?? prior?.attention ?? true;
  await auditLayout(ctx, { browser_id: args.browser_id, target_id: args.target_id, widths, height, design },
    async (instance, target, width, layout) => {
      run?.signal?.throwIfAborted();
      run?.progress?.(viewports.length, widths.length, 'Capturing ' + width + ' px');
      const measured = findingsOf(layout);
      const selectors = [...new Set(measured.findings.map(issue => issue.selector).filter(Boolean))] as string[];
      const captureArgs = {
        browser_id: instance.id, target_id: target.handle, attention_targets: attentionTargets,
        mask_selectors: masks, evidence_selectors: selectors.slice(0, 100), return_image: false, measure_regions: true,
      };
      const state = async () => {
        const { result, exceptionText } = await evaluate(instance, target, {
          expression: "({url:location.href,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',scroll:[scrollX,scrollY]})",
          returnByValue: true,
        });
        if (exceptionText) throw new AgentBrowserError('visual_state_failed', exceptionText);
        return result.value as Pick<Capture, 'url' | 'theme' | 'scroll'>;
      };
      const start = await state();
      let previous: Awaited<ReturnType<typeof readVisualPng>> | undefined;
      let previousMasks: PixelBox[] = [];
      let shot: Record<string, unknown> = {};
      let stable = false;
      let diagnostic: Record<string, unknown> = {};
      for (let i = 0; i < 4; i++) {
        run?.signal?.throwIfAborted();
        // Native overlay scrollbars can fade after a resize independently of
        // document animations. Space retries so transient paint can settle.
        if (i > 0) await delay(i * 150, undefined, { signal: run?.signal });
        shot = await screenshot(ctx, { ...captureArgs, settle: i === 0 });
        const current = await readVisualPng(ctx, artifactId(shot.artifact as ArtifactRef));
        const regions = shot.screenshot_regions as ScreenshotRegions;
        const comparable = !shot.stale_frame && !shot.moving_regions && (!masks.length || !regions.mapping_error);
        diagnostic = {
          ...(shot.stale_frame ? { stale_frame: true } : {}),
          ...(shot.moving_regions ? { moving_regions: true } : {}),
          ...(regions.mapping_error ? { mapping_error: regions.mapping_error } : {}),
        };
        if (previous && comparable && previous.png.width === current.png.width && previous.png.height === current.png.height) {
          const diff = diffPixels(previous.png, current.png, [...previousMasks, ...regions.masks], 0, false);
          diagnostic.changed_pixels_between_captures = diff.changed_pixels;
          diagnostic.compared_pixels = diff.compared_pixels;
          if (diff.compared_pixels > 0 && diff.changed_pixels === 0) {
            stable = true;
            break;
          }
        }
        previous = comparable ? current : undefined;
        previousMasks = regions.masks;
      }
      const end = await state();
      if (JSON.stringify(start) !== JSON.stringify(end)) {
        stable = false;
        diagnostic.state_changed = true;
      }
      const regions = shot.screenshot_regions as ScreenshotRegions;
      const boxes = new Map(regions.evidence.map(region => [region.name, region.box]));
      for (const issue of measured.findings) {
        if (issue.selector) issue.box = boxes.get(issue.selector);
      }
      viewports.push({
        width, height, pixel_width: regions.width, pixel_height: regions.height,
        ...end, stable, ...(!stable ? { capture_diagnostic: diagnostic } : {}), screenshot: shot.artifact as ArtifactRef, masks: regions.masks,
        ...measured,
      });
    },
  );
  for (const view of viewports) {
    run?.signal?.throwIfAborted();
    const config = typeof attentionMode === 'object' ? attentionMode : {};
    if (attentionMode !== false && (view.stable || args.attention)) {
      try {
        const { analysis, ...result } = await attention.analyze(ctx, {
          balance: true, ...config, screenshot_id: artifactId(view.screenshot), return_image: false,
        });
        view.attention = result;
      } catch (error) {
        view.attention = { error: describeError(error) };
      }
    }
    if (args.baseline) {
      const before = prior?.viewports.find(other => other.width === view.width && other.height === view.height && other.url === view.url);
      const sameRules = JSON.stringify(design) === JSON.stringify(prior?.design);
      view.comparison = before ? await compareCapture(ctx, before, view, args.threshold ?? 0.1, sameRules, comparableGoals) :
        { status: prior ? 'no_matching_viewport_or_url' : 'no_approved_baseline' };
    }
  }
  const report: Review = { version: 1, mask_selectors: masks, design, attention_targets: attentionTargets, attention: attentionMode, viewports };
  // Retain one level of comparison in the display, with no previous report chain.
  const data = ctx.stores.artifacts.put('other', Buffer.from(JSON.stringify(report)), {
    mime: 'application/json', label: REPORT_LABEL,
  });
  const html = await renderVisualReview(ctx, viewports);
  const viewer = ctx.stores.artifacts.put('other', Buffer.from(html), {
    mime: 'text/html', label: 'visual-review', sourceRef: data.artifact_handle,
  });
  run?.progress?.(widths.length, widths.length, 'Visual review saved');
  return {
    report_data: toArtifactRef(data), report_view: toArtifactRef(viewer), baseline: row ?? null, ...report,
    ...(args.return_image && viewports[0] ? {
      _image: { mime: 'image/png', data: (await readVisualPng(ctx, artifactId(viewports[0].screenshot))).bytes.toString('base64') },
    } : {}),
  };
}

export async function approveBaseline(ctx: OpsContext, args: { name: string; report_id: string; replace_report_id?: string }) {
  const report = await readReport(ctx, args.report_id);
  if (!report.viewports.length || report.viewports.some(view => !view.stable)) {
    throw new AgentBrowserError('unstable_visual_baseline', 'Approve a report whose screenshots stabilized at every requested viewport.');
  }
  await Promise.all(report.viewports.map(view => readVisualPng(ctx, artifactId(view.screenshot))));
  const db = ctx.stores.db;
  const approved = db.transaction(() => {
    const current = baselineRow(ctx, args.name);
    if (current?.report_handle === args.report_id) return current;
    if (current?.report_handle !== args.replace_report_id) {
      throw new AgentBrowserError('visual_baseline_conflict',
        'The approved baseline changed. Pass its current report_handle as replace_report_id to replace it.',
        { current_report_id: current?.report_handle ?? null });
    }
    db.prepare('INSERT INTO visual_baselines (name, report_handle, approved_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET report_handle = excluded.report_handle, approved_at = excluded.approved_at')
      .run(args.name, args.report_id, Date.now());
    return baselineRow(ctx, args.name)!;
  }).immediate();
  return { baseline: approved, viewports: report.viewports.map(({ url, width, height, theme }) => ({ url, width, height, theme })) };
}

export async function listBaselines(ctx: OpsContext, args: { limit?: number }) {
  const baselines = ctx.stores.db.prepare(
    'SELECT name, report_handle, approved_at FROM visual_baselines ORDER BY approved_at DESC, name LIMIT ?',
  ).all(args.limit ?? 100);
  return { baselines };
}

export async function inspectTarget(ctx: OpsContext, args: TargetRef & { selector?: string; point?: { x: number; y: number } }) {
  if (Boolean(args.selector) === Boolean(args.point)) {
    throw new AgentBrowserError('invalid_visual_target', 'Pass either a selector or viewport point.');
  }
  return layerView(ctx, { ...args, mode: 'z_index', radius: 144, max_layers: 12 });
}
