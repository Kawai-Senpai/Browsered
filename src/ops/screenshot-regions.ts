import type { Region } from './attention-balance.js';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { AgentBrowserError } from '../util/errors.js';
import { evaluate } from './element.js';

export type AttentionTarget = { name: string } & ({ selector: string } | { text: string });
export type PixelBox = Omit<Region, 'name'>;
type Bounds = [number, number, number, number];
type Located = { name: string; status: string; bounds?: Bounds };
type CaptureGeometry = {
  view: { x: number; y: number; width: number; height: number; scale: number; scrollbarX: number; scrollbarY: number };
  goals: Located[];
  masks: Located[];
  evidence: Located[];
};

export async function measureCaptureRegions(
  instance: BrowserInstance, target: ManagedTarget, goals: AttentionTarget[], masks: string[], evidence: string[],
): Promise<CaptureGeometry> {
  const { result, exceptionText } = await evaluate(instance, target, {
    expression: `((goals, masks, evidence) => {
      const visual = window.visualViewport;
      const visible = el => el.getClientRects().length > 0 &&
        (!el.checkVisibility || el.checkVisibility({visibilityProperty:true,opacityProperty:true}));
      const box = el => { const r = el.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]; };
      const find = ({name,selector,text}) => {
        let rows;
        try {
          rows = selector ? [...document.querySelectorAll(selector)] :
            [...document.querySelectorAll('button,a,input,select,textarea,[role],[aria-label]')].filter(el =>
              (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\\s+/g,' ') === text);
        } catch { return {name,status:'invalid_selector'}; }
        const shown = rows.filter(visible);
        if (shown.length === 1) return {name,status:'visible',bounds:box(shown[0])};
        return {name,status:shown.length ? 'ambiguous' : rows.length ? 'hidden' : 'missing'};
      };
      const mask = name => {
        try {
          return [...document.querySelectorAll(name)].filter(visible).slice(0,201).map(el=>({name,status:'visible',bounds:box(el)}));
        } catch { return [{name,status:'invalid_selector'}]; }
      };
      return {
        view:{x:visual.offsetLeft,y:visual.offsetTop,width:visual.width,height:visual.height,
          scale:visual.scale * devicePixelRatio,
          scrollbarX:Math.max(0,innerWidth-document.documentElement.clientWidth),
          scrollbarY:Math.max(0,innerHeight-document.documentElement.clientHeight)},
        goals:goals.map(find),masks:masks.flatMap(mask),
        evidence:evidence.map(selector=>find({name:selector,selector})),
      };
    })(${JSON.stringify(goals)},${JSON.stringify(masks)},${JSON.stringify(evidence)})`,
    returnByValue: true,
  });
  if (exceptionText || !result.value) throw new AgentBrowserError('screenshot_regions_failed', exceptionText ?? 'Could not measure screenshot regions.');
  return result.value as CaptureGeometry;
}

export function regionsInPng(geometry: CaptureGeometry, png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const { view } = geometry;
  if (view.width <= 0 || view.height <= 0) throw new AgentBrowserError('screenshot_regions_failed', 'The visual viewport has no area.');
  const sx = view.scale;
  const sy = view.scale;
  // The PNG can include painted scrollbars that visualViewport excludes.
  // DPR and the visual viewport's zoom give the content's actual pixel scale.
  const fits = (pixels: number, content: number, scrollbar: number) =>
    pixels >= content * view.scale - 3 && pixels <= (content + scrollbar) * view.scale + 3;
  const mappingError = !fits(width, view.width, view.scrollbarX) || !fits(height, view.height, view.scrollbarY);
  const map = ({ name, status, bounds }: Located) => {
    if (!bounds) return { name, status };
    if (mappingError) return { name, status: 'viewport_geometry_mismatch' };
    const [left, top, right, bottom] = bounds;
    const x = Math.max(0, Math.floor((left - view.x) * sx));
    const y = Math.max(0, Math.floor((top - view.y) * sy));
    const w = Math.min(width, Math.ceil((right - view.x) * sx)) - x;
    const h = Math.min(height, Math.ceil((bottom - view.y) * sy)) - y;
    return w > 0 && h > 0 ? { name, status, box: { x, y, width: w, height: h } } : { name, status: 'offscreen' };
  };
  const masks = geometry.masks.map(map);
  if (masks.some(row => row.status === 'invalid_selector') || masks.length > 200) {
    throw new AgentBrowserError('invalid_review_mask', 'Mask selectors must be valid CSS and match at most 200 visible elements total.');
  }
  return { width, height, mapping_error: mappingError ? { viewport: view, png: { width, height } } : undefined, goals: geometry.goals.map(map), evidence: geometry.evidence.map(map), masks: masks.flatMap(row => row.box ? [row.box] : []) };
}

export type ScreenshotRegions = ReturnType<typeof regionsInPng>;
