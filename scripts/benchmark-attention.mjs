/**
 * Evaluate the production attention scores against recorded fixation maps at
 * the same grid resolution as a fixed, content-independent center prior.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { analyze } from '../dist/ops/attention.js';
import { createStores } from '../dist/store/index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: 'string', default: 'fast' },
    grid: { type: 'string', default: '16' },
  },
});
const [manifestPath] = positionals;
const backend = values.backend;
const grid = Number(values.grid);
if (positionals.length !== 1 || !['fast', 'deep'].includes(backend) || !Number.isInteger(grid) || grid < 4 || grid > 24) {
  throw new Error('Usage: node scripts/benchmark-attention.mjs MANIFEST.json [--backend fast|deep] [--grid 4..24]');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest) || !manifest.length) throw new Error('The manifest must contain at least one screenshot and fixation map pair.');
const base = dirname(resolve(manifestPath));
const home = await mkdtemp(join(tmpdir(), 'browserd-attention-benchmark-'));
process.env.AGENTBROWSER_HOME = home;
const stores = createStores();
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function scores(predicted, fixations) {
  const average = mean(predicted);
  const sd = Math.sqrt(mean(predicted.map(value => (value - average) ** 2)));
  const totalFixations = fixations.reduce((sum, count) => sum + count, 0);
  const negative = predicted.filter((_value, index) => !fixations[index]);
  if (!totalFixations || !negative.length) return null;
  const nss = sd ? predicted.reduce((sum, score, index) => sum + fixations[index] * (score - average) / sd, 0) / totalFixations : 0;
  const wins = predicted.reduce((sum, score, index) => {
    if (!fixations[index]) return sum;
    return sum + fixations[index] * negative.reduce((total, value) => total + (score > value ? 1 : score === value ? 0.5 : 0), 0);
  }, 0);
  return { auc_grid: wins / (totalFixations * negative.length), nss_grid: nss };
}

try {
  const screens = [];
  for (const { image, fixations, category = 'uncategorized' } of manifest) {
    const imageBytes = await readFile(resolve(base, image));
    const { width, height } = PNG.sync.read(imageBytes);
    const gaze = PNG.sync.read(await readFile(resolve(base, fixations)));
    if (width < grid || height < grid || Math.abs(gaze.width / gaze.height - width / height) > 0.015) {
      throw new Error(image + ' has incompatible screenshot and fixation-map dimensions.');
    }
    const regions = Array.from({ length: grid * grid }, (_, index) => {
      const col = index % grid;
      const row = Math.floor(index / grid);
      const x = Math.round(width * col / grid);
      const y = Math.round(height * row / grid);
      return { name: 'c' + index, x, y, width: Math.round(width * (col + 1) / grid) - x, height: Math.round(height * (row + 1) / grid) - y };
    });
    const counts = new Array(regions.length).fill(0);
    for (let y = 0; y < gaze.height; y++) for (let x = 0; x < gaze.width; x++) {
      const offset = (y * gaze.width + x) * 4;
      if (gaze.data[offset + 3] < 128 || gaze.data[offset] < 128) continue;
      counts[Math.floor(y * grid / gaze.height) * grid + Math.floor(x * grid / gaze.width)]++;
    }
    const shot = stores.artifacts.put('screenshot', imageBytes, { mime: 'image/png', label: 'benchmark' });
    const { analysis } = await analyze({ stores }, {
      screenshot_id: shot.artifact_handle, overlay: false, backend, regions,
    });
    const shares = new Map(analysis.regions.map(region => [region.name, region.share]));
    const predicted = regions.map(region => shares.get(region.name) / (region.width * region.height));
    if (predicted.some(score => !Number.isFinite(score))) throw new Error('Missing attention grid score for ' + image);
    // A fixed Gaussian with a standard deviation of 20% of each image dimension.
    // The prior is deliberately set before reading any fixation maps.
    const center = regions.map(region => Math.exp(-0.5 * (
      (((region.x + region.width / 2) / width - 0.5) / 0.2) ** 2
      + (((region.y + region.height / 2) / height - 0.5) / 0.2) ** 2
    )));
    const model = scores(predicted, counts);
    const center_prior = scores(center, counts);
    screens.push({ image, category, model, center_prior, fixation_pixels: counts.reduce((sum, count) => sum + count, 0) });
    console.error('Scored ' + image);
  }
  const categories = [...new Set(screens.map(screen => screen.category))];
  const summarize = items => {
    const valid = items.filter(item => item.model);
    const averages = key => ({
      auc_grid: valid.length ? mean(valid.map(item => item[key].auc_grid)) : null,
      nss_grid: valid.length ? mean(valid.map(item => item[key].nss_grid)) : null,
    });
    return { screens: valid.length, skipped: items.length - valid.length, model: averages('model'), center_prior: averages('center_prior') };
  };
  console.log(JSON.stringify({
    backend, grid, summary: summarize(screens),
    categories: Object.fromEntries(categories.map(category => [category, summarize(screens.filter(screen => screen.category === category))])),
    screens,
  }, null, 2));
} finally {
  stores.close();
  await rm(home, { recursive: true, force: true });
}
