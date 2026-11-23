/// <reference lib="dom" />

export type LayerMode = 'dom' | 'z_index' | 'composited';
export type Rect = [number, number, number, number];
export interface ViewLayer {
  label: string;
  bounds: Rect;
  level: number;
  backend_node_id?: number;
  parent_backend_node_id?: number;
  z_index?: string;
  paint_order?: number;
  layer_id?: string;
  parent_layer_id?: string;
  draws_content?: boolean;
  paint_count?: number;
  tree_depth?: number;
  estimated_rgba_bytes?: number;
  reasons?: string[];
  offset?: [number, number];
  transform?: number[];
  paint?: string;
}
export interface LayerScene {
  mode: LayerMode;
  width: number;
  height: number;
  layers: ViewLayer[];
  focus: number;
  total: number;
  simplified: number;
  reference?: string;
  region: Rect;
  point?: { x: number; y: number };
}
export interface LayerCamera { angle: number; tilt: number; explode: number }

// Self-contained so the same renderer can run in Chromium and the exported viewer.
export function drawLayerView(canvas: HTMLCanvasElement, scene: LayerScene, camera: LayerCamera, images: Map<number, HTMLImageElement>, heading: string, selected = scene.focus, isolate = false) {
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#101723';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#eef5ff';
  g.font = 'bold 25px system-ui';
  g.fillText(heading, 30, 43);
  g.fillStyle = '#a5b6cb';
  g.font = '14px system-ui';
  const dimension = { dom: 'DOM depth', z_index: 'Chromium paint order', composited: 'Chromium compositor layer order' }[scene.mode];
  const count = isolate && selected >= 0 ? 'Selected layer isolated' : `${scene.layers.length} of ${scene.total} layers shown`;
  const simplified = scene.simplified > 0 ? ` · ${scene.simplified} simplified in overview` : '';
  g.fillText(`${dimension} · ${count}${simplified}`, 30, 68);

  const yaw = camera.angle * Math.PI / 180;
  const tilt = camera.tilt * Math.PI / 180;
  const project = (x: number, y: number, z: number) => {
    const u = x * Math.cos(yaw) - y * Math.sin(yaw);
    const v = x * Math.sin(yaw) + y * Math.cos(yaw);
    return [u, v * Math.sin(tilt) - z * Math.cos(tilt)];
  };
  const corners = ([x, y, w, h]: Rect, z: number) => [
    project(x, y, z), project(x + w, y, z), project(x + w, y + h, z), project(x, y + h, z),
  ];
  const levels = [...new Set(scene.layers.map(layer => layer.level))].sort((a, b) => a - b);
  const [rx, ry, rw, rh] = scene.region;
  const ground = corners(scene.region, 0);
  const interval = camera.explode * Math.min(1, 7 / Math.max(1, levels.length));
  const plates = scene.layers.map((layer, index) => {
    const z = (levels.indexOf(layer.level) + 1) * interval;
    const [x, y, w, h] = layer.bounds;
    const left = Math.max(rx, x);
    const top = Math.max(ry, y);
    const bounds: Rect = [left, top, Math.min(rx + rw, x + w) - left, Math.min(ry + rh, y + h) - top];
    return { points: corners(bounds, z), texturePoints: corners(layer.bounds, z), index };
  });
  const all = [...ground, ...plates.flatMap(plate => plate.points)];
  const minX = Math.min(...all.map(point => point[0]!));
  const minY = Math.min(...all.map(point => point[1]!));
  const maxX = Math.max(...all.map(point => point[0]!));
  const maxY = Math.max(...all.map(point => point[1]!));
  const paneWidth = canvas.width - 340;
  const paneHeight = canvas.height - 133;
  const scale = Math.min(paneWidth / Math.max(1, maxX - minX), paneHeight / Math.max(1, maxY - minY), 3);
  const ox = 30 + (paneWidth - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = 101 + (paneHeight - (maxY - minY) * scale) / 2 - minY * scale;
  const projectToImage = ([x, y]: number[]): [number, number] => [Math.round(ox + x! * scale), Math.round(oy + y! * scale)];
  function polygon(points: number[][]) {
    g.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) g.moveTo(ox + x! * scale, oy + y! * scale);
      else g.lineTo(ox + x! * scale, oy + y! * scale);
    });
    g.closePath();
  }
  function drawTexture(image: HTMLImageElement, points: number[][], opacity: number) {
    const [a, b, , d] = points;
    g.save();
    g.clip();
    g.globalAlpha = opacity;
    g.transform((b![0]! - a![0]!) * scale / image.width, (b![1]! - a![1]!) * scale / image.width,
      (d![0]! - a![0]!) * scale / image.height, (d![1]! - a![1]!) * scale / image.height,
      ox + a![0]! * scale, oy + a![1]! * scale);
    g.drawImage(image, 0, 0);
    g.restore();
  }
  polygon(ground);
  g.fillStyle = '#1c293a';
  g.fill();
  const reference = images.get(-1);
  if (reference) drawTexture(reference, corners([0, 0, scene.width, scene.height], 0), .72);
  g.strokeStyle = '#536e8d';
  g.stroke();
  const hue = (index: number) => (170 + index * 67) % 360;
  const mappedPlates = [];
  for (const { points, texturePoints, index } of plates) {
    const focused = index === selected;
    if (isolate && selected >= 0 && !focused) continue;
    mappedPlates.push({ number: index + 1, polygon: points.map(projectToImage) });
    polygon(points);
    g.fillStyle = `hsla(${hue(index)},70%,63%,${focused ? .23 : .07})`;
    g.fill();
    const image = images.get(index);
    if (image) drawTexture(image, texturePoints, .82);
    g.lineWidth = focused ? 3 : 1;
    g.strokeStyle = `hsl(${hue(index)},80%,${focused ? 85 : 68}%)`;
    g.stroke();
  }
  const focusedPlate = plates[selected];
  if (focusedPlate) {
    const [x, y, w, h] = scene.layers[selected]!.bounds;
    const centerX = Math.max(rx, x) + (Math.min(rx + rw, x + w) - Math.max(rx, x)) / 2;
    const centerY = Math.max(ry, y) + (Math.min(ry + rh, y + h) - Math.max(ry, y)) / 2;
    const base = projectToImage(project(centerX, centerY, 0));
    const raised = projectToImage([(focusedPlate.points[0]![0]! + focusedPlate.points[2]![0]!) / 2,
      (focusedPlate.points[0]![1]! + focusedPlate.points[2]![1]!) / 2]);
    g.beginPath();
    g.moveTo(...base);
    g.lineTo(...raised);
    g.setLineDash([4, 4]);
    g.strokeStyle = '#fce996';
    g.lineWidth = 2;
    g.stroke();
    g.setLineDash([]);
  }
  if (scene.point) {
    const [x, y] = project(scene.point.x, scene.point.y, 0);
    g.beginPath();
    g.arc(ox + x! * scale, oy + y! * scale, 6, 0, Math.PI * 2);
    g.fillStyle = '#fce996';
    g.fill();
    g.strokeStyle = '#192130';
    g.lineWidth = 2;
    g.stroke();
  }
  // Draw identifiers last so raised plates cannot cover labels below them.
  const legend = plates.slice(-13).reverse();
  if (focusedPlate && !legend.includes(focusedPlate)) legend.unshift(focusedPlate);
  g.font = 'bold 12px system-ui';
  const labels: number[][] = [];
  for (const { points, index } of legend) {
    if (isolate && selected >= 0 && index !== selected) continue;
    const [x, y] = points[0]!;
    const px = ox + x! * scale;
    const py = oy + y! * scale;
    if (index !== selected && labels.some(([lx, ly]) => Math.abs(px - lx!) < 25 && Math.abs(py - ly!) < 19)) continue;
    labels.push([px, py]);
    g.fillStyle = '#0b1420';
    g.fillRect(ox + x! * scale, oy + y! * scale - 16, 23, 17);
    g.fillStyle = `hsl(${hue(index)},85%,78%)`;
    g.fillText(String(index + 1), ox + x! * scale + 3, oy + y! * scale - 3);
  }
  const legendX = canvas.width - 280;
  g.fillStyle = '#182435';
  g.fillRect(legendX - 12, 93, 264, canvas.height - 117);
  g.fillStyle = '#eef5ff';
  g.font = 'bold 15px system-ui';
  g.fillText('Layers · highest first', legendX, 118);
  legend.forEach(({ index }, row) => {
    const layer = scene.layers[index]!;
    const y = 146 + row * 31;
    if (index === selected) {
      g.fillStyle = '#2a3b50';
      g.fillRect(legendX - 5, y - 17, 249, 29);
    }
    g.font = 'bold 13px system-ui';
    g.fillStyle = `hsl(${hue(index)},85%,78%)`;
    g.fillText(String(index + 1), legendX, y);
    g.font = '13px monospace';
    g.fillStyle = '#eef5ff';
    g.fillText(layer.label, legendX + 26, y, 207);
    g.font = '11px system-ui';
    g.fillStyle = '#a5b6cb';
    const detail = layer.layer_id ? `Depth ${layer.tree_depth} · ${layer.paint ? 'Paint replay' : 'Geometry'}` :
      scene.mode === 'dom' ? `Depth ${layer.level}` : `Paint ${layer.paint_order ?? '—'} · z-index ${layer.z_index ?? 'auto'}`;
    g.fillText(detail, legendX + 26, y + 12);
  });
  return {
    plates: mappedPlates,
    legend: legend.map(({ index }, row) => ({ number: index + 1, bounds: [legendX - 5, 129 + row * 31, 249, 30] })),
  };
}

export async function loadLayerImages(scene: LayerScene) {
  const images = new Map<number, HTMLImageElement>();
  const sources = scene.layers.map((layer, index) => ({ src: layer.paint, index }));
  sources.push({ src: scene.reference, index: -1 });
  await Promise.all(sources.map(async ({ src, index }) => {
    if (!src) return;
    const image = new Image();
    await new Promise<void>(resolve => {
      image.onload = () => { images.set(index, image); resolve(); };
      image.onerror = () => resolve();
      image.src = src;
    });
  }));
  return images;
}
