import { setTimeout as delay } from 'node:timers/promises';
import type { CdpSession } from '../cdp/session.js';
import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { ensureDom, evaluate, resolveElement, type ElementLocator } from './element.js';
import { drawLayerView, loadLayerImages, type LayerCamera, type LayerMode, type LayerScene, type Rect, type ViewLayer } from './layer-view-render.js';
import { screenshot, serializeCapture, waitForTarget, type PageArgs } from './page.js';

const titles: Record<LayerMode, string> = {
  dom: 'DOM hierarchy',
  z_index: 'Stacking contexts',
  composited: 'Composited layers',
};
const styles = ['z-index', 'visibility'];
const overlaps = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] &&
  a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

interface Snapshot {
  strings: string[];
  documents: Array<{
    nodes: { parentIndex: number[]; nodeType: number[]; nodeName: number[]; backendNodeId: number[]; attributes: number[][] };
    layout: { nodeIndex: number[]; bounds: Rect[]; styles: number[][]; stackingContexts: { index: number[] }; paintOrders?: number[] };
  }>;
}

async function documentLayers(session: CdpSession, view: { pageX: number; pageY: number }, mode: 'dom' | 'z_index') {
  const { strings, documents } = await session.send<Snapshot>('DOMSnapshot.captureSnapshot', {
    computedStyles: styles,
    includePaintOrder: true,
  });
  const doc = documents[0];
  if (!doc) return [];
  const { nodes, layout } = doc;
  const stacking = new Set(layout.stackingContexts.index);
  const contexts = new Set([...stacking].map(index => layout.nodeIndex[index]));
  const depths: number[] = [];
  for (let index = 0; index < nodes.parentIndex.length; index++) {
    const parent = nodes.parentIndex[index]!;
    depths[index] = parent < 0 ? 0 : (depths[parent] ?? 0) + 1;
  }
  const layers: ViewLayer[] = [];
  for (const [index, node] of layout.nodeIndex.entries()) {
    if (nodes.nodeType[node] !== 1 || (mode === 'z_index' && !stacking.has(index))) continue;
    const rect = layout.bounds[index];
    const computed = layout.styles[index] ?? [];
    if (!rect || rect[2] <= 0 || rect[3] <= 0 || strings[computed[1]!] === 'hidden') continue;
    const attributes = nodes.attributes[node] ?? [];
    const tag = strings[nodes.nodeName[node]!]!.toLowerCase();
    let id = '';
    let className = '';
    for (let attr = 0; attr < attributes.length; attr += 2) {
      const name = strings[attributes[attr]!];
      const value = strings[attributes[attr + 1]!] ?? '';
      if (name === 'id') id = value;
      if (name === 'class') className = value.trim().split(/\s+/)[0] ?? '';
    }
    const paintOrder = layout.paintOrders?.[index];
    let parent = nodes.parentIndex[node] ?? -1;
    if (mode === 'z_index') {
      while (parent >= 0 && !contexts.has(parent)) parent = nodes.parentIndex[parent] ?? -1;
    }
    layers.push({
      label: (id ? `${tag}#${id}` : className ? `${tag}.${className}` : tag).slice(0, 100),
      backend_node_id: nodes.backendNodeId[node],
      parent_backend_node_id: nodes.backendNodeId[parent],
      bounds: [rect[0] - view.pageX, rect[1] - view.pageY, rect[2], rect[3]],
      level: mode === 'z_index' ? (paintOrder ?? 0) : depths[node]!,
      z_index: strings[computed[0]!],
      paint_order: paintOrder,
    });
  }
  return layers;
}

interface CompositorLayer {
  layerId: string; parentLayerId?: string; backendNodeId?: number;
  offsetX: number; offsetY: number; width: number; height: number; transform?: number[];
  anchorX?: number; anchorY?: number; anchorZ?: number; drawsContent: boolean; paintCount: number;
}

const pendingTrees = new WeakMap<CdpSession, Promise<unknown>>();
function withCompositorTree<T>(session: CdpSession, captureKey: string, inspect: (layers: CompositorLayer[]) => Promise<T>) {
  const previous = pendingTrees.get(session);
  const capture = (async () => {
    await previous?.catch(() => {});
    let unsubscribe = () => {};
    const changed = new Promise<CompositorLayer[]>(resolve => {
      unsubscribe = session.on('LayerTree.layerTreeDidChange', ({ layers }) => {
        if (Array.isArray(layers)) resolve(layers as CompositorLayer[]);
      });
    });
    const deadline = new AbortController();
    try {
      // LayerTree's renderer agent depends on the DOM agent after navigation.
      await ensureDom(session);
      await session.send('DOM.getDocument', { depth: 0 }, 3_000);
      await session.send('LayerTree.enable', {}, 3_000);
      const refresh = delay(250, undefined, { signal: deadline.signal }).then(() =>
        // An idle page can need a compositor frame before delivering its layer event.
        serializeCapture(captureKey, async () => {
          if (!deadline.signal.aborted) {
            await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 25, captureBeyondViewport: false }, 2_000);
          }
        }),
      ).catch(() => {});
      const layers = await Promise.race([changed, delay(3_000, undefined, { signal: deadline.signal }).then(() => {
        throw new AgentBrowserError('layer_tree_unavailable', 'Chromium did not publish a compositor tree. Try again with the tab visible.');
      })]);
      deadline.abort();
      await refresh;
      return await inspect(layers);
    } finally {
      deadline.abort();
      unsubscribe();
      await session.send('LayerTree.disable', {}, 1_000).catch(() => {});
    }
  })();
  pendingTrees.set(session, capture);
  void capture.finally(() => {
    if (pendingTrees.get(session) === capture) pendingTrees.delete(session);
  }).catch(() => {});
  return capture;
}

function layerGeometry(layers: CompositorLayer[]) {
  const byId = new Map(layers.map(layer => [layer.layerId, layer]));
  return layers.filter(layer => layer.width > 0 && layer.height > 0).map((layer, index) => {
    const chain: CompositorLayer[] = [];
    for (let node: CompositorLayer | undefined = layer; node && chain.length < layers.length; node = byId.get(node.parentLayerId ?? '')) {
      chain.push(node);
    }
    const corners = [[0, 0], [layer.width, 0], [layer.width, layer.height], [0, layer.height]].map(([x, y]) => {
      let point = [x!, y!, 0, 1];
      for (const ancestor of chain) {
        const anchor = [(ancestor.anchorX ?? 0) * ancestor.width, (ancestor.anchorY ?? 0) * ancestor.height, ancestor.anchorZ ?? 0];
        const matrix = ancestor.transform;
        if (matrix?.length === 16) {
          const local = point.map((value, index) => value - (anchor[index] ?? 0) * point[3]!);
          point = local.map((_, row) => local.reduce((total, value, column) => total + value * matrix[column * 4 + row]!, 0));
        }
        point[0]! += (ancestor.offsetX + (matrix ? anchor[0]! : 0)) * point[3]!;
        point[1]! += (ancestor.offsetY + (matrix ? anchor[1]! : 0)) * point[3]!;
        if (matrix) point[2]! += anchor[2]! * point[3]!;
      }
      return [point[0]! / (point[3] || 1), point[1]! / (point[3] || 1)];
    });
    const xs = corners.map(point => point[0]!);
    const ys = corners.map(point => point[1]!);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      label: `Layer ${layer.layerId}`,
      bounds: [x, y, Math.max(...xs) - x, Math.max(...ys) - y] as Rect,
      level: index,
      tree_depth: chain.length - 1,
      layer_id: layer.layerId,
      parent_layer_id: layer.parentLayerId,
      backend_node_id: layer.backendNodeId,
      draws_content: layer.drawsContent,
      paint_count: layer.paintCount,
      estimated_rgba_bytes: layer.drawsContent ? layer.width * layer.height * 4 : 0,
      offset: [layer.offsetX, layer.offsetY] as [number, number],
      transform: layer.transform,
    };
  });
}

async function collectPaint(session: CdpSession, layers: ViewLayer[], paint: boolean) {
  await Promise.all(layers.map(async layer => {
    if (!layer.backend_node_id) return;
    try {
      const { node } = await session.send<{ node: { localName: string; attributes?: string[] } }>(
        'DOM.describeNode', { backendNodeId: layer.backend_node_id }, 2_000,
      );
      const attributes = node.attributes ?? [];
      const id = attributes.findIndex((name, index) => index % 2 === 0 && name === 'id');
      if (node.localName) layer.label += ` · ${node.localName}${id < 0 ? '' : '#' + attributes[id + 1]}`.slice(0, 80);
    } catch { /* Layers with missing DOM nodes retain their compositor ID. */ }
  }));
  const drawable = layers.filter(layer => layer.draws_content).slice(-8);
  await Promise.all(drawable.map(async layer => {
    const layerId = layer.layer_id!;
    try {
      const { compositingReasons } = await session.send<{ compositingReasons: string[] }>('LayerTree.compositingReasons', { layerId }, 2_000);
      layer.reasons = compositingReasons;
    } catch { /* Layer may have disappeared since the tree was captured. */ }
    if (!paint) return;
    try {
      const { snapshotId } = await session.send<{ snapshotId: string }>('LayerTree.makeSnapshot', { layerId }, 2_000);
      try {
        const { dataURL } = await session.send<{ dataURL: string }>('LayerTree.replaySnapshot', { snapshotId, scale: 0.5 }, 3_000);
        if (dataURL.startsWith('data:image/png;base64,') && dataURL.length < 1_000_000) layer.paint = dataURL;
      } finally {
        await session.send('LayerTree.releaseSnapshot', { snapshotId }, 1_000).catch(() => {});
      }
    } catch { /* Keep the geometry when an individual layer cannot be replayed. */ }
  }));
}

const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function viewerHtml(scene: LayerScene, camera: LayerCamera, isolate: boolean) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Browsered layer view</title>
<style>
body{margin:0;background:#101723;color:#eef5ff;font:15px system-ui}
main{max-width:1150px;margin:auto;padding:16px}
.controls{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:12px 15px;background:#182435;border-radius:10px}
label{display:flex;gap:7px;align-items:center}button,select{color:inherit;background:#263950;border:1px solid #607894;border-radius:6px;padding:6px}
canvas{width:100%;height:auto;display:block;touch-action:none}
output{display:block;padding:10px 14px;background:#182435;border-radius:8px;min-height:21px;color:#c6d5e9}
</style>
<main><div class="controls">
<label>Explode <input id="explode" type="range" min="0" max="200" value="${camera.explode}"></label>
<label>Rotate <input id="angle" type="range" min="-180" max="180" value="${camera.angle}"></label>
<label>Tilt <input id="tilt" type="range" min="15" max="85" value="${camera.tilt}"></label>
<label>Focus <select id="focus"><option value="-1">All layers</option></select></label>
<label><input id="isolate" type="checkbox"${isolate ? ' checked' : ''}> Isolate layer</label>
<button id="animate">Animate explode</button></div>
<canvas width="1150" height="620" aria-label="Exploded layer view"></canvas>
<output id="selection">Select a plane or legend row to inspect it.</output></main>
<script>
const scene = ${safeJson(scene)};
const draw = ${drawLayerView.toString()};
const load = ${loadLayerImages.toString()};
const canvas = document.querySelector('canvas');
const inputs = Object.fromEntries(['explode','angle','tilt','focus','isolate'].map(id => [id,document.getElementById(id)]));
scene.layers.forEach((layer,index) => inputs.focus.add(new Option((index+1) + ' · ' + layer.label,index)));
inputs.focus.value = scene.focus;
load(scene).then(images => {
  let diagram;
  const render = () => {
    const active = +inputs.focus.value;
    diagram = draw(canvas, scene, {angle:+inputs.angle.value, tilt:+inputs.tilt.value, explode:+inputs.explode.value}, images, ${safeJson(titles[scene.mode])}, active, inputs.isolate.checked);
    const layer = scene.layers[active];
    document.getElementById('selection').textContent = layer ? [
      layer.label, layer.backend_node_id && 'Backend node ' + layer.backend_node_id,
      layer.parent_backend_node_id && 'Parent node ' + layer.parent_backend_node_id,
      layer.layer_id && 'Compositor layer ' + layer.layer_id,
      layer.paint_order !== undefined && 'Paint order ' + layer.paint_order,
      layer.reasons?.join(', '),
    ].filter(Boolean).join(' · ') : 'Select a plane or legend row to inspect it.';
  };
  for (const input of Object.values(inputs)) input.addEventListener('input', render);
  canvas.addEventListener('click', event => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX-rect.left)*canvas.width/rect.width;
    const y = (event.clientY-rect.top)*canvas.height/rect.height;
    const row = diagram.legend.find(({bounds:[left,top,width,height]}) => x>=left && x<left+width && y>=top && y<top+height);
    const plane = row || [...diagram.plates].reverse().find(({polygon}) => {
      const path = new Path2D();
      polygon.forEach(([px,py],i) => i===0 ? path.moveTo(px,py) : path.lineTo(px,py));
      path.closePath();
      return canvas.getContext('2d').isPointInPath(path,x,y);
    });
    if(!plane) return;
    inputs.focus.value = plane.number-1;
    render();
  });
  let frame;
  document.getElementById('animate').onclick = () => {
    cancelAnimationFrame(frame);
    const start = performance.now();
    const distance = Math.max(40, +inputs.explode.value);
    const step = now => {
      const progress = Math.min(1,(now-start)/850);
      inputs.explode.value = distance*(1-(1-progress)**3);
      render();
      if(progress<1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };
  render();
});
</script>`;
}

export async function layerView(ctx: OpsContext, args: PageArgs & {
  mode?: LayerMode; angle?: number; tilt?: number; explode?: number; max_layers?: number;
  paint?: boolean; return_image?: boolean; interactive?: boolean; save_path?: string;
  point?: { x: number; y: number }; radius?: number; detail?: 'overview' | 'all';
  isolate?: boolean;
}) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);
  const mode = args.mode ?? 'z_index';
  const { cssVisualViewport: view } = await target.session.send<{
    cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  }>('Page.getLayoutMetrics');
  const viewport: Rect = [0, 0, view.clientWidth, view.clientHeight];
  const locator: ElementLocator = { selector: args.selector, backend_node_id: args.backend_node_id };
  const focusNode = locator.selector === undefined && locator.backend_node_id === undefined ? undefined :
    await resolveElement(instance, target, locator, { preferVisible: true });
  const focusId = focusNode?.backendNodeId;
  let point = args.point;
  if (!point && focusNode && args.radius !== undefined) {
    try {
      const { result } = await target.session.send<{ result: { value?: { x: number; y: number } } }>('Runtime.callFunctionOn', {
        objectId: focusNode.objectId, returnByValue: true,
        functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }',
      });
      point = result.value;
    } finally {
      await target.session.trySend('Runtime.releaseObject', { objectId: focusNode.objectId });
    }
  } else if (focusNode) {
    await target.session.trySend('Runtime.releaseObject', { objectId: focusNode.objectId });
  }
  if (args.radius !== undefined && !point) throw new AgentBrowserError('missing_layer_focus', 'Provide a selector, backend_node_id, or point when setting radius.');
  if (point && (point.x < 0 || point.y < 0 || point.x >= view.clientWidth || point.y >= view.clientHeight)) {
    throw new AgentBrowserError('layer_focus_offscreen', 'The focus point is outside the viewport. Scroll it into view and retry.');
  }
  const radius = args.radius;
  let region = viewport;
  if (point && radius !== undefined) {
    const x = Math.max(0, point.x - radius);
    const y = Math.max(0, point.y - radius);
    region = [x, y, Math.min(view.clientWidth, point.x + radius) - x, Math.min(view.clientHeight, point.y + radius) - y];
  }
  const hitTest = point ? await evaluate(instance, target, {
    expression: `document.elementsFromPoint(${point.x},${point.y}).slice(0,12).map(e => ({
      tag: e.localName, id: e.id || undefined, role: e.getAttribute('role') || undefined,
      z_index: getComputedStyle(e).zIndex
    }))`,
    returnByValue: true,
    awaitPromise: false,
  }) : undefined;
  function selectScene(layers: ViewLayer[]): LayerScene {
    const visible = layers.filter(layer => overlaps(layer.bounds, region));
    const focus = focusId === undefined ? undefined : visible.find(layer => layer.backend_node_id === focusId);
    const limit = args.max_layers ?? 16;
    const overview = args.detail !== 'all' && mode !== 'composited';
    const neighborhood: Rect | undefined = point ? [point.x, point.y, 0.01, 0.01] : undefined;
    const intersection = (a: Rect, b: Rect) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
      Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const ranked = visible.filter(layer => layer !== focus).map(layer => {
      const area = intersection(layer.bounds, region);
      const underPoint = Boolean(neighborhood && overlaps(layer.bounds, neighborhood));
      // Favor identifiable UI over generic wrappers with identical geometry.
      const semantic = /^(main|article|section|aside|nav|header|footer|dialog|button|input|h[1-6])(?:[.#]|$)/.test(layer.label);
      return {
        layer, area, underPoint,
        score: area * (overview && semantic ? 1.7 : 1),
        nearFocus: Boolean(focus && overlaps(layer.bounds, focus.bounds)),
      };
    }).sort((a, b) =>
      Number(b.underPoint) - Number(a.underPoint) ||
      Number(b.layer.draws_content ?? true) - Number(a.layer.draws_content ?? true) ||
      Number(b.nearFocus) - Number(a.nearFocus) ||
      b.score - a.score ||
      b.layer.level - a.layer.level);
    const selected = focus ? [focus] : [];
    const minArea = Math.min(900, region[2] * region[3] * 0.003);
    let simplified = 0;
    for (const candidate of ranked) {
      const { layer, area, underPoint } = candidate;
      const decorative = layer.label.startsWith('::') || area < minArea;
      const duplicate = overview && mode === 'dom' && selected.some(other => {
        const match = intersection(layer.bounds, other.bounds);
        return match / (layer.bounds[2] * layer.bounds[3] + other.bounds[2] * other.bounds[3] - match) > 0.94;
      });
      if (overview && !underPoint && (decorative || duplicate)) {
        simplified++;
      } else if (selected.length < limit) {
        selected.push(layer);
      }
    }
    selected.sort((a, b) => a.level - b.level || (a.paint_order ?? 0) - (b.paint_order ?? 0));
    return { mode, width: view.clientWidth, height: view.clientHeight, region, point, layers: selected, focus: focus ? selected.indexOf(focus) : -1, total: visible.length, simplified };
  }
  const scene = mode === 'composited' ? await withCompositorTree(target.session, `${instance.id}:${target.handle}`, async tree => {
    const captured = selectScene(layerGeometry(tree));
    await collectPaint(target.session, captured.layers, args.paint !== false);
    return captured;
  }) : selectScene(await documentLayers(target.session, view, mode));
  const isolate = args.isolate === true;
  if (isolate && scene.focus < 0) {
    throw new AgentBrowserError('no_layer_to_isolate', 'Provide a visible selector or backend_node_id that owns a layer in this mode.');
  }
  const reference = await screenshot(ctx, {
    browser_id: instance.id, target_id: target.handle, format: 'jpeg', quality: 78,
    label: 'layer-view-reference', settle: false,
  });
  const image = reference._image as { data: string; mime: string } | undefined;
  if (image && !reference.stale_frame) scene.reference = `data:${image.mime};base64,${image.data}`;
  const camera: LayerCamera = { angle: args.angle ?? -24, tilt: args.tilt ?? 35, explode: args.explode ?? 64 };
  const { targetId } = await instance.browserSession.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true });
  let rendered: { data: string; diagram: ReturnType<typeof drawLayerView> };
  try {
    const scratch = await waitForTarget(instance, targetId, 10_000);
    const { result, exceptionText } = await evaluate(instance, scratch, {
      expression: `(async () => {
        const scene = ${safeJson(scene)};
        const canvas = document.createElement('canvas');
        canvas.width = 1150;
        canvas.height = 620;
        const load = ${loadLayerImages.toString()};
        const draw = ${drawLayerView.toString()};
        const diagram = draw(canvas, scene, ${safeJson(camera)}, await load(scene), ${safeJson(titles[mode])}, scene.focus, ${isolate});
        return {data:canvas.toDataURL('image/png').split(',')[1], diagram};
      })()`,
      returnByValue: true, awaitPromise: true, timeoutMs: 10_000,
    });
    rendered = result.value as typeof rendered;
    if (typeof rendered?.data !== 'string') throw new AgentBrowserError('layer_render_failed', 'Could not draw layer view.', { reason: exceptionText });
  } finally {
    await instance.browserSession.send('Target.closeTarget', { targetId }, 2_000).catch(() => {});
  }
  const { data, diagram } = rendered;
  const info = { browserId: instance.id, sourceRef: target.handle, meta: { mode, url: target.info.url } };
  const artifact = ctx.stores.artifacts.put('screenshot', Buffer.from(data, 'base64'), { ...info, label: `layers-${mode}`, mime: 'image/png' });
  const interactive = args.interactive === false ? undefined : ctx.stores.artifacts.put('other', Buffer.from(viewerHtml(scene, camera, isolate)), {
    ...info, label: `layers-${mode}-viewer`, mime: 'text/html',
  });
  return {
    target_id: target.handle, mode, camera, viewport: { width: scene.width, height: scene.height },
    region: scene.region,
    ...(point ? { point, hit_test_front_to_back: hitTest?.result.value ?? [] } : {}),
    total_layers: scene.total,
    simplified_layers: scene.simplified,
    ...(isolate ? { isolated: true } : {}),
    diagram: { units: 'image_px', width: 1150, height: 620, ...diagram },
    artifact: toArtifactRef(artifact),
    ...(scene.reference ? { reference_screenshot: reference.artifact } : {}),
    ...(args.save_path ? { saved_to: ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path) } : {}),
    ...(interactive ? { interactive_viewer: toArtifactRef(interactive) } : {}),
    layers: scene.layers.map(({ paint, ...layer }, index) => ({ number: index + 1, ...layer, ...(mode === 'composited' ? { paint_replayed: Boolean(paint) } : {}) })),
    ...(focusId ? { focus_backend_node_id: focusId } : {}),
    ...(focusId && scene.focus < 0 ? { focus_note: 'That node is outside the region or does not have a layer in this mode.' } : {}),
    note: mode === 'composited'
      ? 'Shows compositor layer order and bounding rectangles. Paint replay is available for up to eight drawn layers.'
      : 'Geometry is from the main document and uses bounding rectangles. Use inspector.element with a backend_node_id for details.',
    ...(args.return_image === false ? {} : { _image: { data, mime: 'image/png' } }),
  };
}
