import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { toArtifactRef } from '../store/artifact-store.js';
import { unj } from '../store/db.js';
import type { ScreenshotRegions } from './screenshot-regions.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { balanceGrid, measureBalance, renderBalanceView, type BalanceOptions, type Region } from './attention-balance.js';

const execute = promisify(execFile);
const HOTGAZE_VERSION = '0.1.1';
let weightedRun: Promise<unknown> = Promise.resolve();

export interface ModelOptions {
  use_attention_targets?: boolean;
  backend?: 'fast' | 'deep';
  regions?: Region[];
  faces?: boolean;
  balance?: boolean | BalanceOptions;
}

function hotgaze(args: string[]): Promise<string> {
  const deep = args[args.indexOf('--backend') + 1] === 'deep';
  if (!deep && !args.includes('--layers')) return runHotgaze(args, deep);
  // HotGaze uses fixed temporary filenames when downloading model weights.
  const run = weightedRun.then(() => runHotgaze(args, deep));
  weightedRun = run.catch(() => undefined);
  return run;
}

async function runHotgaze(args: string[], deep: boolean): Promise<string> {
  const executable = process.env.AGENTBROWSER_HOTGAZE;
  const requirement = `hotgaze${deep ? '[deep]' : ''}==${HOTGAZE_VERSION}`;
  const command = executable || 'uv';
  const commandArgs = executable ? args : [
    'tool', 'run', '--python', '3.12', '--from', requirement, 'hotgaze', ...args,
  ];
  const timeout = deep ? 300_000 : 120_000;
  try {
    const result = await execute(command, commandArgs, {
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === 'ENOENT') {
      throw new AgentBrowserError('hotgaze_unavailable',
        executable
          ? 'AGENTBROWSER_HOTGAZE must point to an executable on the Browsered host.'
          : 'Install uv on the Browsered host and make it available on the MCP server PATH, or set AGENTBROWSER_HOTGAZE to an existing HotGaze executable.');
    }
    if (failure.killed) {
      throw new AgentBrowserError('hotgaze_timeout',
        `HotGaze exceeded ${timeout / 1000} seconds. First-use downloads may still need to finish on retry, or try the fast backend.`);
    }
    throw new AgentBrowserError('hotgaze_failed', failure.stderr?.trim().slice(-1500) || 'HotGaze failed.');
  }
}

async function pngScreenshot(ctx: OpsContext, id: string) {
  const artifact = ctx.stores.artifacts.require(id);
  if (artifact.kind !== 'screenshot' || artifact.mime !== 'image/png') {
    throw new AgentBrowserError('invalid_screenshot', 'Use a PNG artifact from page.screenshot.');
  }
  const path = resolve(artifact.path);
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
        header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new AgentBrowserError('invalid_screenshot', 'The screenshot artifact has an invalid PNG header.');
    }
    return { artifact, path, width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await file.close();
  }
}

function modelArgs(options: ModelOptions) {
  const args = ['--backend', options.backend ?? 'fast'];
  if (options.faces) args.push('--layers', 'faces');
  return args;
}

function regionArgs(regions: Region[], width: number, height: number) {
  const names = new Set<string>();
  const args: string[] = [];
  for (const region of regions) {
    if (names.has(region.name) || region.x + region.width > width || region.y + region.height > height) {
      throw new AgentBrowserError('invalid_attention_region',
        `Region "${region.name}" needs a unique name and must fit inside the ${width} × ${height} PNG.`);
    }
    names.add(region.name);
    args.push('--region', `${region.name}:${region.x},${region.y},${region.width},${region.height}`);
  }
  return args;
}

async function report(args: string[]): Promise<Record<string, unknown>> {
  try {
    // Weight download progress can precede the final single-line JSON on stdout.
    const stdout = (await hotgaze([...args, '--json'])).trimEnd();
    const output = JSON.parse(stdout.slice(stdout.lastIndexOf('\n') + 1));
    if (output?.schema === 1) return output;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new AgentBrowserError('hotgaze_output', 'Expected HotGaze schema-v1 JSON. Check the installed HotGaze version.');
}

function removeBalanceRegions<T extends { name: string; rank: number }>(rows: T[], names: Set<string>) {
  const excludedRanks = rows.filter(row => names.has(row.name)).map(row => row.rank);
  return rows.filter(row => !names.has(row.name)).map(row => ({
    ...row, rank: row.rank - excludedRanks.filter(rank => rank < row.rank).length,
  }));
}

type Shot = Awaited<ReturnType<typeof pngScreenshot>>;
type RegionScore = { name: string; share: number; rank: number };

function capturedTargets(shot: Shot, use: boolean | undefined) {
  return use === false ? [] : unj<{ attention_targets?: ScreenshotRegions['goals'] }>(shot.artifact.meta)?.attention_targets ?? [];
}

function targetRegions(targets: ScreenshotRegions['goals']): Region[] {
  return targets.flatMap(target => target.box ? [{ name: target.name, ...target.box }] : []);
}

function targetScores(shot: Shot, targets: ScreenshotRegions['goals'], rows: RegionScore[]) {
  const byName = new Map(rows.map(row => [row.name, row]));
  return targets.map(target => {
    const row = byName.get(target.name);
    const box = target.box;
    return box && row ? { ...target, share: row.share, rank: row.rank,
      density_vs_viewport: Number((row.share * shot.width * shot.height / (box.width * box.height)).toFixed(3)),
    } : { ...target, share: null };
  });
}

export async function analyze(ctx: OpsContext, args: ModelOptions & {
  screenshot_id: string;
  overlay?: boolean;
  return_image?: boolean;
}) {
  const shot = await pngScreenshot(ctx, args.screenshot_id);
  const model = modelArgs(args);
  const targets = capturedTargets(shot, args.use_attention_targets);
  const requested = [...(args.regions ?? []), ...targetRegions(targets)];
  const grid = args.balance ? balanceGrid(args.balance === true ? {} : args.balance, shot.width, shot.height, requested) : undefined;
  const regions = regionArgs([...requested, ...(grid?.cells ?? [])], shot.width, shot.height);
  const analysis = await report(['score', shot.path, ...model, ...regions]);
  const result: Record<string, unknown> = {
    screenshot_id: args.screenshot_id,
    width: shot.width,
    height: shot.height,
    backend: args.backend ?? 'fast',
    faces: args.faces ?? false,
    analysis,
  };
  if (grid) {
    const rows = analysis.regions as Array<{ name: string; share: number; rank: number }>;
    const balance = measureBalance(grid, rows);
    result.visual_balance = balance;
    analysis.regions = removeBalanceRegions(rows, grid.names);
    if (args.overlay !== false) {
      const png = (await readFile(shot.path)).toString('base64');
      const html = renderBalanceView([{ title: 'Captured viewport', width: shot.width, height: shot.height, png, balance }]);
      result.balance_view = toArtifactRef(ctx.stores.artifacts.put('other', Buffer.from(html), {
        mime: 'text/html', label: 'visual-balance', browserId: shot.artifact.browser_id, sourceRef: shot.artifact.artifact_handle,
      }));
    }
  }
  if (targets.length) result.attention_targets = targetScores(shot, targets, analysis.regions as RegionScore[]);
  if (args.overlay === false) return result;

  const dir = await mkdtemp(join(tmpdir(), 'browserd-attention-'));
  try {
    const path = join(dir, 'overlay.png');
    await hotgaze(['run', shot.path, ...model, '--output', path]);
    const png = await readFile(path);
    const overlay = ctx.stores.artifacts.put('attention_overlay', png, {
      mime: 'image/png',
      browserId: shot.artifact.browser_id,
      sourceRef: shot.artifact.artifact_handle,
      meta: { backend: result.backend, faces: result.faces },
    });
    result.overlay = toArtifactRef(overlay);
    if (args.return_image !== false) result._image = { data: png.toString('base64'), mime: 'image/png' };
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function compare(ctx: OpsContext, args: ModelOptions & {
  baseline_id: string;
  candidate_id: string;
}) {
  const [baseline, candidate] = await Promise.all([
    pngScreenshot(ctx, args.baseline_id),
    pngScreenshot(ctx, args.candidate_id),
  ]);
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    throw new AgentBrowserError('attention_size_mismatch', 'Capture both screenshots with the same pixel dimensions.');
  }
  const baselineGoals = capturedTargets(baseline, args.use_attention_targets);
  const candidateGoals = capturedTargets(candidate, args.use_attention_targets);
  const requested = [...(args.regions ?? []), ...targetRegions(baselineGoals), ...targetRegions(candidateGoals)];
  const grid = args.balance ? balanceGrid(args.balance === true ? {} : args.balance, baseline.width, baseline.height, requested) : undefined;
  const model = modelArgs(args);
  const regions = regionArgs(args.regions ?? [], baseline.width, baseline.height);
  const analysis = await report(['compare', baseline.path, candidate.path, ...model, ...regions]);
  let visualBalance: Record<string, unknown> | undefined;
  let goals: Record<string, unknown>[] | undefined;
  if (grid || baselineGoals.length || candidateGoals.length) {
    // Each image owns its goal rectangles, even when an element moved.
    const score = async (shot: Shot, targets: ScreenshotRegions['goals']) => {
      const boxes = regionArgs([...targetRegions(targets), ...(grid?.cells ?? [])], shot.width, shot.height);
      const output = await report(['score', shot.path, ...model, ...boxes]);
      return output.regions as RegionScore[];
    };
    const [baselineScore, candidateScore] = await Promise.all([
      score(baseline, baselineGoals), score(candidate, candidateGoals),
    ]);
    if (baselineGoals.length || candidateGoals.length) {
      const goalOnly = (rows: RegionScore[]) => grid ? removeBalanceRegions(rows, grid.names) : rows;
      const before = new Map(targetScores(baseline, baselineGoals, goalOnly(baselineScore)).map(row => [row.name, row]));
      const after = new Map(targetScores(candidate, candidateGoals, goalOnly(candidateScore)).map(row => [row.name, row]));
      goals = [...new Set([...before.keys(), ...after.keys()])].map(name => {
        const a = before.get(name) ?? null;
        const b = after.get(name) ?? null;
        return { name, baseline: a, candidate: b,
          delta_percentage_points: a?.share != null && b?.share != null ? Number(((b.share - a.share) * 100).toFixed(2)) : null };
      });
    }
    if (grid) {
      const before = measureBalance(grid, baselineScore);
      const after = measureBalance(grid, candidateScore);
      visualBalance = { baseline: before, candidate: after };
      if (before.shares && after.shares) {
        const pp = (a: number, b: number) => Number(((b - a) * 100).toFixed(2));
        visualBalance.delta_percentage_points = {
          left: pp(before.shares.left, after.shares.left),
          top: pp(before.shares.top, after.shares.top),
        };
      }
    }
  }
  return {
    baseline_id: args.baseline_id,
    candidate_id: args.candidate_id,
    width: baseline.width,
    height: baseline.height,
    backend: args.backend ?? 'fast',
    faces: args.faces ?? false,
    analysis,
    ...(visualBalance ? { visual_balance: visualBalance } : {}),
    ...(goals ? { attention_targets: goals } : {}),
  };
}
