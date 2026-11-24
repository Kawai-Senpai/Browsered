import { readFile } from 'node:fs/promises';
import type { OpsContext } from './context.js';
import type { PixelBox } from './screenshot-regions.js';
import type { Capture } from './visual-review.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
);

type Annotation = { box: PixelBox; label: string };
type Goal = { name: string; status: string; box?: PixelBox; share?: number };
type Ref = Record<string, unknown>;
type Balance = {
  shares?: { left: number; right: number; top: number; bottom: number };
};

async function png(ctx: OpsContext, ref: Ref) {
  const artifact = ctx.stores.artifacts.require(ref.artifact_id as string);
  return 'data:image/png;base64,' + (await readFile(artifact.path)).toString('base64');
}

function boxes(annotations: Annotation[], width: number, height: number) {
  const unit = Math.max(1, width / 640);
  const badgeWidth = 22 * unit;
  const badgeHeight = 19 * unit;
  const used: { x: number; y: number }[] = [];
  const outlines: string[] = [];
  const labels: string[] = [];
  for (const { box, label } of annotations) {
    const x = Math.min(width - badgeWidth, box.x);
    const candidates = [-1, -2, 0, -3, 1, 2].map(row => box.y + row * (badgeHeight + 2));
    const y = candidates.find(candidate => candidate >= 0 && candidate + badgeHeight <= height &&
      used.every(badge => Math.abs(badge.y - candidate) >= badgeHeight + 1 || Math.abs(badge.x - x) >= badgeWidth + 1));
    outlines.push(`<rect class="outline" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"/>`);
    if (y === undefined) continue;
    used.push({ x, y });
    labels.push(`<line class="leader" x1="${x + badgeWidth / 2}" y1="${y + badgeHeight / 2}" x2="${box.x + box.width / 2}" y2="${box.y}"/>`);
    labels.push(`<rect class="badge" x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}"/>
      <text x="${x + badgeWidth / 2}" y="${y + 14 * unit}" style="font-size:${12 * unit}px">${escape(label)}</text>`);
  }
  return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${outlines.join('')}${labels.join('')}</svg>`;
}

function figure(title: string, image: string, annotation = '', overlay?: string) {
  return `<figure><figcaption>${escape(title)}</figcaption><div class="image">
    <img src="${image}" alt="${escape(title)}">${overlay ? `<img class="diff" src="${overlay}" alt="Changed pixels in red">` : ''}${annotation}
    </div></figure>`;
}

export async function renderVisualReview(ctx: OpsContext, views: Capture[]) {
  const sections = await Promise.all(views.map(async view => {
    const current = await png(ctx, view.screenshot);
    const imageWidth = view.pixel_width;
    const imageHeight = view.pixel_height;
    const markers = view.findings.flatMap((issue, index) => issue.box ? [{ box: issue.box, label: String(index + 1) }] : []);
    const attention = view.attention;
    const goals = (attention?.attention_targets ?? []) as Goal[];
    const overlay = attention?.overlay as Ref | undefined;
    const balance = attention?.visual_balance as Balance | undefined;
    const weights = balance?.shares;
    const comparison = view.comparison;
    const baseline = comparison?.baseline as Ref | undefined;
    const diff = comparison?.diff as Ref | undefined;
    const notes = [
      view.stable ? 'Stable capture' : 'Capture did not stabilize',
      view.horizontal_scroll ? 'Horizontal overflow' : '',
      comparison?.status === 'compared' && typeof comparison.changed_percentage === 'number'
        ? `${comparison.changed_percentage.toFixed(2)}% of compared pixels changed`
        : comparison ? String(comparison.status).replaceAll('_', ' ') : '',
    ].filter(Boolean);
    const issueList = view.findings.map((issue, index) => {
      const deviation = issue.detail.deviation_px;
      const ratio = issue.detail.ratio;
      const detail = typeof deviation === 'number' ? `${deviation > 0 ? '+' : ''}${deviation} px`
        : typeof ratio === 'number' ? `${ratio.toFixed(2)}:1 contrast`
          : typeof issue.detail.text === 'string' ? issue.detail.text : '';
      return `<li value="${index + 1}"><strong>${escape(issue.code.replaceAll('_', ' '))}</strong>
        ${detail ? ` <span>${escape(detail)}</span>` : ''}${issue.selector ? `<code>${escape(issue.selector)}</code>` : ''}</li>`;
    }).join('');
    const changes = comparison?.findings as { new_samples?: unknown[]; resolved_samples?: unknown[] } | undefined;
    const delta = changes?.new_samples && changes.resolved_samples
      ? `<p>${changes.new_samples.length} new and ${changes.resolved_samples.length} resolved audit samples</p>` : '';
    const percent = (value: number) => `${(100 * value).toFixed(1)}%`;
    const weightSummary = weights ? `<p>Predicted visual balance · ${percent(weights.left)} left · ${percent(weights.right)} right · ${percent(weights.top)} top · ${percent(weights.bottom)} bottom</p>` : '';
    const goalList = goals.map(goal => `<li>${escape(goal.name)} <strong>${goal.share == null ? escape(goal.status) : `${(goal.share * 100).toFixed(2)}%`}</strong></li>`).join('');
    return `<section${view.width <= 480 ? ' class="narrow"' : ''}><h2>${view.width} × ${view.height} CSS px</h2><p>${escape(notes.join(' · '))}</p>
      ${weightSummary}${delta}
      <div class="panels">${figure('Current with audit markers', current, boxes(markers, imageWidth, imageHeight))}
      ${baseline ? figure('Approved baseline', await png(ctx, baseline)) : ''}
      ${diff ? figure('Changed pixels', current, '', await png(ctx, diff)) : ''}
      ${overlay ? figure('Predicted attention', await png(ctx, overlay),
        boxes(goals.flatMap((goal, i) => goal.box ? [{ box: goal.box, label: String(i + 1) }] : []), imageWidth, imageHeight)) : ''}
      </div>
      ${goalList ? `<h3>Attention targets</h3><ol>${goalList}</ol>` : ''}
      ${issueList ? `<details><summary>Audit findings · ${view.findings.length} samples</summary><ol>${issueList}</ol></details>` : ''}
      </section>`;
  }));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual review</title><style>
*{box-sizing:border-box}body{margin:0;background:#f1f3f6;color:#182238;font:15px/1.5 system-ui,sans-serif}
main{max-width:1550px;margin:auto;padding:clamp(14px,3vw,40px)}h1,h2,h3,p{margin:0 0 .4em}
section{margin:24px 0;padding:clamp(10px,2vw,25px);background:#fff;border:1px solid #cdd6e2;border-radius:8px}
p,figcaption{color:#42536b;overflow-wrap:anywhere}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:18px;margin-top:14px}
.narrow .panels{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),360px))}
figure{margin:0;min-width:0}figcaption{padding-bottom:5px;font-weight:600}.image{position:relative;background:#fff;outline:1px solid #ccd5df}
img{width:100%;height:auto;display:block}svg,.diff{display:block;position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.outline,.leader{stroke:#d0205a;stroke-width:1.5;fill:none;vector-effect:non-scaling-stroke}.badge{fill:#a70943}
text{font:bold 13px system-ui;fill:white;text-anchor:middle}details,h3{margin-top:16px}summary{cursor:pointer}
li{margin:.3em 0}code{display:block;overflow-wrap:anywhere;color:#415372}li span{color:#42536b}
</style><main><h1>Visual review</h1><p>${escape(views[0]?.url)}</p>${sections.join('')}</main></html>`;
}
