import { readFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import type { PixelBox } from './screenshot-regions.js';

export async function readVisualPng(ctx: OpsContext, id: string) {
  const row = ctx.stores.artifacts.require(id);
  if (row.kind !== 'screenshot' || row.mime !== 'image/png') {
    throw new AgentBrowserError('invalid_visual_png', 'The review must reference a viewport PNG.');
  }
  const bytes = await readFile(row.path);
  try {
    return { bytes, png: PNG.sync.read(bytes) };
  } catch {
    throw new AgentBrowserError('invalid_visual_png', 'The review references an invalid PNG.');
  }
}

export function diffPixels(before: PNG, after: PNG, boxes: PixelBox[], threshold: number, render: boolean) {
  const { width, height } = after;
  if (before.width !== width || before.height !== height) {
    throw new AgentBrowserError('visual_size_mismatch', 'The screenshots have different pixel dimensions.');
  }
  const mask = boxes.length ? new Uint8Array(width * height) : undefined;
  if (mask) {
    for (const box of boxes) for (let y = box.y; y < Math.min(height, box.y + box.height); y++) {
      mask.fill(1, y * width + box.x, y * width + Math.min(width, box.x + box.width));
    }
  }
  const output = render ? new PNG({ width, height }) : undefined;
  const changed = pixelmatch(before.data, after.data, output?.data, width, height, {
    threshold, ignoreMask: mask, diffMask: true, includeAA: !render,
  });
  const compared = width * height - (mask?.reduce((sum, value) => sum + value, 0) ?? 0);
  const regions: Array<PixelBox & { changed_pixels: number }> = [];
  if (output && changed) {
    // Coarse tiles let the agent locate the largest changes without making the
    // pixel diff sensitive to narrow bridges between otherwise separate edits.
    const tileSize = Math.max(24, Math.ceil(Math.max(width, height) / 20));
    for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) {
      const w = Math.min(tileSize, width - x);
      const h = Math.min(tileSize, height - y);
      let pixels = 0;
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
        if (output.data[(row * width + col) * 4 + 3]) pixels++;
      }
      if (pixels) regions.push({ x, y, width: w, height: h, changed_pixels: pixels });
    }
    regions.sort((a, b) => b.changed_pixels - a.changed_pixels);
  }
  return {
    changed_pixels: changed,
    compared_pixels: compared,
    changed_percentage: compared ? 100 * changed / compared : null,
    largest_changed_regions: regions.slice(0, 12),
    png: output ? PNG.sync.write(output) : undefined,
  };
}
