import { AgentBrowserError } from '../util/errors.js';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Region extends Rect { name: string }
export interface BalanceOptions {
  region?: Rect;
  target_left?: number;
  target_top?: number;
  tolerance?: number;
}
type Shares = Array<{ name: string; share: number }>;

export function balanceGrid(options: BalanceOptions, width: number, height: number, regions: Region[]) {
  const scope = options.region ?? { x: 0, y: 0, width, height };
  if (scope.width < 4 || scope.height < 4 || scope.x + scope.width > width || scope.y + scope.height > height) {
    throw new AgentBrowserError('invalid_balance_region', 'The balance region must be at least 4 × 4 pixels and inside the screenshot.');
  }
  let stem = '_browserd_balance';
  while (regions.some(region => region.name.startsWith(stem))) stem += '_';
  const cells = Array.from({ length: 16 }, (_, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = Math.round(scope.width * col / 4);
    const y = Math.round(scope.height * row / 4);
    return {
      name: `${stem}_${i}`, col, row,
      x: scope.x + x, y: scope.y + y,
      width: Math.round(scope.width * (col + 1) / 4) - x,
      height: Math.round(scope.height * (row + 1) / 4) - y,
    };
  });
  return { scope, cells, options, names: new Set(cells.map(cell => cell.name)) };
}

export function measureBalance(grid: ReturnType<typeof balanceGrid>, scores: Shares) {
  const shares = new Map(scores.map(row => [row.name, row.share]));
  let total = 0;
  let left = 0;
  let top = 0;
  let weightedX = 0;
  let weightedY = 0;
  const quadrants = [0, 0, 0, 0];
  for (const cell of grid.cells) {
    const weight = shares.get(cell.name);
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new AgentBrowserError('hotgaze_balance_output', 'HotGaze omitted a predicted attention share for the balance grid.');
    }
    const leftHalf = cell.col < 2;
    const topHalf = cell.row < 2;
    total += weight;
    if (leftHalf) left += weight;
    if (topHalf) top += weight;
    weightedX += (cell.x + cell.width / 2) * weight;
    weightedY += (cell.y + cell.height / 2) * weight;
    quadrants[(topHalf ? 0 : 2) + (leftHalf ? 0 : 1)]! += weight;
  }
  if (total <= 0.000001) return { status: 'insufficient_attention' } as const;
  const round = (value: number) => Number(value.toFixed(4));
  const { scope, options } = grid;
  const leftShare = left / total;
  const topShare = top / total;
  const centerX = (weightedX / total - scope.x) / scope.width;
  const centerY = (weightedY / total - scope.y) / scope.height;
  const targetLeft = options.target_left ?? 0.5;
  const tolerance = options.tolerance ?? 0.15;
  const warnings: string[] = [];
  if (Math.abs(leftShare - targetLeft) > tolerance) warnings.push(leftShare > targetLeft ? 'left_heavy' : 'right_heavy');
  if (options.target_top !== undefined && Math.abs(topShare - options.target_top) > tolerance) {
    warnings.push(topShare > options.target_top ? 'top_heavy' : 'bottom_heavy');
  }
  return {
    status: warnings.length ? 'review' : 'within_target',
    region: scope,
    scope_attention_share: round(total),
    shares: { left: round(leftShare), right: round(1 - leftShare), top: round(topShare), bottom: round(1 - topShare) },
    quadrants: {
      top_left: round(quadrants[0]! / total), top_right: round(quadrants[1]! / total),
      bottom_left: round(quadrants[2]! / total), bottom_right: round(quadrants[3]! / total),
    },
    estimated_center: { x: round(centerX), y: round(centerY), units: 'fraction_of_region' },
    target: { left: targetLeft, ...(options.target_top !== undefined ? { top: options.target_top } : {}), tolerance },
    warnings,
  };
}

type Balance = ReturnType<typeof measureBalance>;
export interface BalancePanel {
  title: string; width: number; height: number; png: string; balance: Balance;
}

export function renderBalanceView(panels: BalancePanel[]) {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]!));
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Browsered visual balance</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101723;color:#eef5ff;font:16px system-ui}
main{max-width:1280px;margin:auto;padding:32px 25px}h1{font-size:30px;margin:0 0 6px}
p{margin:0;color:#b7c8dc} .panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:20px;margin-top:22px}
article{background:#182435;border:1px solid #304159;border-radius:12px;padding:14px}h2{font-size:17px;margin:0 0 8px}
figure{margin:0;position:relative}img{width:100%;height:auto;display:block;border-radius:6px}
svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
.stats div{padding:8px;border-radius:6px;background:#23324a;color:#bed0e5;font-size:13px}
.stats strong{display:block;color:#fff;font-size:19px}
.note{margin:10px 0 0;font-size:13px}.key{margin-top:10px;font-size:14px}.point{color:#ffb575}
</style><main><h1>Visual balance</h1><p>Predicted attention across the captured screen</p>
<p class="key">Dashed crosshair = region center · <span class="point">Orange point = estimated attention center</span></p>
<div class="panels">${panels.map(({ title, png, width, height, balance }) => {
    const source = `<img src="data:image/png;base64,${png}" alt="Captured viewport">`;
    if (!balance.shares) return `<article><h2>${escape(title)}</h2>${source}<p class="note">Insufficient attention to estimate balance.</p></article>`;
    const r = balance.region;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const wx = r.x + r.width * balance.estimated_center.x;
    const wy = r.y + r.height * balance.estimated_center.y;
    const guidance = balance.warnings.length ? balance.warnings.join(', ').replace(/_/g, ' ') : 'Within the selected target';
    const axes = `M ${cx} ${r.y} V ${r.y + r.height} M ${r.x} ${cy} H ${r.x + r.width}`;
    return `<article><h2>${escape(title)}</h2><figure>${source}
<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke="#67e8f9" stroke-width="2" fill="none"/>
<path d="${axes}" stroke="#111827" stroke-width="4" stroke-dasharray="7 6"/>
<path d="${axes}" stroke="#dffaff" stroke-width="2" stroke-dasharray="7 6"/>
<path d="M ${cx} ${cy} L ${wx} ${wy}" stroke="#101723" stroke-width="6"/>
<path d="M ${cx} ${cy} L ${wx} ${wy}" stroke="#ffb575" stroke-width="3"/>
<circle cx="${wx}" cy="${wy}" r="9" fill="#ffb575" stroke="#101723" stroke-width="3"/>
</svg></figure><div class="stats">${Object.entries(balance.shares).map(([side, value]) =>
    `<div>${side}<strong>${percent(value)}</strong></div>`).join('')}</div><p class="note">${escape(guidance)}.</p></article>`;
  }).join('')}</div></main></html>`;
}
