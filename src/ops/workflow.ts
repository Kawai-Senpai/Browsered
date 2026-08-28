/**
 * Saved, parameterised sequences of tool calls.
 *
 * The point is repetition: fill this form again with different values, walk this
 * checkout again, get back to this screen. Two rules make it trustworthy rather
 * than merely convenient.
 *
 * Locators must be durable. A `ref=eNN` is an index into the snapshot that
 * produced it (instance.snapshotRefs is replaced wholesale on every
 * page.snapshot), so a saved ref silently resolves to a different element on the
 * next run, or to nothing. Refs are refused at save time rather than replayed.
 *
 * Steps must assert. browserd already reports whether an action landed --
 * page.type returns landed_characters, page.click returns observed_change -- and
 * a replay that ignores those reports ten green steps for a run that did
 * nothing. Every step is checked against the outcome it claims.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBrowserError } from '../util/errors.js';
import { homeDir } from '../util/paths.js';
import type { OpsContext } from './context.js';

export interface WorkflowStep {
  tool: string;
  args?: Record<string, unknown>;
  /** Skip the built-in outcome assertion for this step. */
  expect?: boolean;
}

export interface Workflow {
  name: string;
  description?: string;
  vars: string[];
  steps: WorkflowStep[];
  saved_at: string;
}

/** Tool call needed to run a workflow step. Injected so ops stay testable. */
export type ToolInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

let invoker: ToolInvoker | undefined;

/** Wired once at server start; workflow.run drives the same tools a model does. */
export function setToolInvoker(fn: ToolInvoker): void {
  invoker = fn;
}

function workflowDir(): string {
  const dir = join(homeDir(), 'workflows');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Names become filenames, so keep them to something that cannot escape the directory. */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new AgentBrowserError(
      'bad_name',
      `Workflow names must be 1-64 chars of letters, digits, dot, dash or underscore. Got ${JSON.stringify(name)}.`,
    );
  }
}

function pathFor(name: string): string {
  assertSafeName(name);
  return join(workflowDir(), `${name}.json`);
}

function readWorkflow(name: string): Workflow {
  const file = pathFor(name);
  if (!existsSync(file)) {
    const known = listNames();
    throw new AgentBrowserError(
      'no_such_workflow',
      `No workflow named ${JSON.stringify(name)}.` +
        (known.length ? ` Saved: ${known.join(', ')}.` : ' None are saved yet.'),
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Workflow;
}

function listNames(): string[] {
  try {
    return readdirSync(workflowDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/* ------------------------------ placeholders ------------------------------ */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every {{var}} appearing anywhere in the step arguments. */
function placeholdersIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) found.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) placeholdersIn(v, found);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) placeholdersIn(v, found);
  }
  return found;
}

/**
 * Substitute {{var}} throughout the arguments. A placeholder that is the whole
 * string yields the raw value, so a number stays a number rather than becoming
 * "42"; embedded ones interpolate as text.
 */
function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(value);
    if (whole) return vars[whole[1]!];
    return value.replace(PLACEHOLDER, (_m, key: string) => String(vars[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

/* -------------------------------- assertions ------------------------------ */

/**
 * Did the step actually do what it claims? browserd's own reporting is the
 * source of truth here; this only refuses to look away from it.
 */
function assertOutcome(tool: string, result: Record<string, unknown>): string | undefined {
  if (tool === 'page.type') {
    const landed = Number(result.landed_characters ?? 0);
    const wanted = Number(result.characters ?? 0);
    if (wanted > 0 && landed === 0) {
      return `typed ${wanted} characters but none landed (field readonly, disabled, or not accepting input)`;
    }
    if (landed < wanted) return `only ${landed} of ${wanted} characters landed`;
  }
  if (tool === 'page.expect' && result.ok === false) {
    return String(result.detail ?? result.message ?? 'expectation not met');
  }
  if (result.ok === false && result.error) return String(result.error);
  return undefined;
}

/* ---------------------------------- ops ----------------------------------- */

export async function saveWorkflow(
  _ctx: OpsContext,
  args: { name: string; steps: WorkflowStep[]; vars?: string[]; description?: string },
): Promise<Record<string, unknown>> {
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    throw new AgentBrowserError('no_steps', 'A workflow needs at least one step.');
  }

  const refSteps: number[] = [];
  args.steps.forEach((step, i) => {
    if (!step || typeof step.tool !== 'string' || !step.tool) {
      throw new AgentBrowserError('bad_step', `Step ${i} has no tool name.`);
    }
    if (step.args && typeof step.args.ref === 'string') refSteps.push(i);
  });
  if (refSteps.length > 0) {
    throw new AgentBrowserError(
      'ref_not_replayable',
      `Steps ${refSteps.join(', ')} use a snapshot ref. Refs are only valid for the snapshot that produced them, ` +
        'so they resolve to the wrong element on replay. Save a selector, xpath or text locator instead.',
    );
  }

  // Anything the steps interpolate is a variable, whether or not it was declared.
  const used = placeholdersIn(args.steps);
  const declared = new Set(args.vars ?? []);
  const vars = [...new Set([...declared, ...used])];

  const workflow: Workflow = {
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    vars,
    steps: args.steps,
    saved_at: new Date().toISOString(),
  };
  writeFileSync(pathFor(args.name), JSON.stringify(workflow, null, 2), 'utf8');

  return {
    saved: true,
    name: args.name,
    steps: args.steps.length,
    vars,
    undeclared: [...used].filter((v) => !declared.has(v)),
    path: pathFor(args.name),
  };
}

export async function listWorkflows(
  _ctx: OpsContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workflows = listNames().map((name) => {
    try {
      const w = readWorkflow(name);
      return {
        name: w.name,
        description: w.description,
        steps: w.steps.length,
        vars: w.vars,
        saved_at: w.saved_at,
      };
    } catch {
      return { name, error: 'unreadable' };
    }
  });
  return { workflows, count: workflows.length, directory: workflowDir() };
}

export async function showWorkflow(
  _ctx: OpsContext,
  args: { name: string },
): Promise<Record<string, unknown>> {
  return { ...readWorkflow(args.name) };
}

export async function deleteWorkflow(
  _ctx: OpsContext,
  args: { name: string },
): Promise<Record<string, unknown>> {
  const file = pathFor(args.name);
  if (!existsSync(file)) throw new AgentBrowserError('no_such_workflow', `No workflow named ${JSON.stringify(args.name)}.`);
  rmSync(file);
  return { deleted: true, name: args.name };
}

export async function runWorkflow(
  _ctx: OpsContext,
  args: {
    name: string;
    vars?: Record<string, unknown>;
    continue_on_error?: boolean;
    dry_run?: boolean;
  },
): Promise<Record<string, unknown>> {
  const workflow = readWorkflow(args.name);
  const supplied = args.vars ?? {};

  // Resolve {{secrets}} from the environment so a workflow file never has to
  // hold a credential: WORKFLOW_VAR_PASS=... supplies {{pass}}.
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of workflow.vars) {
    if (key in supplied) resolved[key] = supplied[key];
    else if (process.env[`WORKFLOW_VAR_${key.toUpperCase()}`] !== undefined) {
      resolved[key] = process.env[`WORKFLOW_VAR_${key.toUpperCase()}`];
    } else missing.push(key);
  }
  // Fail before driving anything: a half-run workflow leaves the page in a
  // state neither the caller nor the next run can reason about.
  if (missing.length > 0) {
    throw new AgentBrowserError(
      'missing_vars',
      `Workflow ${JSON.stringify(workflow.name)} needs ${missing.join(', ')}. ` +
        `Pass them in vars, or set ${missing.map((m) => `WORKFLOW_VAR_${m.toUpperCase()}`).join(', ')}.`,
    );
  }

  const planned = workflow.steps.map((step, index) => ({
    index,
    tool: step.tool,
    args: substitute(step.args ?? {}, resolved) as Record<string, unknown>,
  }));

  if (args.dry_run) {
    return { name: workflow.name, dry_run: true, steps: planned };
  }

  if (!invoker) {
    throw new AgentBrowserError('no_invoker', 'Workflow execution is not wired up in this process.');
  }

  const steps: Array<Record<string, unknown>> = [];
  let ok = true;
  for (const step of planned) {
    const started = Date.now();
    try {
      const result = await invoker(step.tool, step.args);
      const problem = workflow.steps[step.index]!.expect === false ? undefined : assertOutcome(step.tool, result);
      if (problem) {
        ok = false;
        steps.push({ index: step.index, tool: step.tool, ok: false, error: problem, ms: Date.now() - started });
        if (!args.continue_on_error) break;
      } else {
        steps.push({ index: step.index, tool: step.tool, ok: true, ms: Date.now() - started });
      }
    } catch (err) {
      ok = false;
      steps.push({
        index: step.index,
        tool: step.tool,
        ok: false,
        error: (err as Error).message,
        ms: Date.now() - started,
      });
      if (!args.continue_on_error) break;
    }
  }

  return {
    name: workflow.name,
    ok,
    completed: steps.filter((s) => s.ok).length,
    total: planned.length,
    steps,
    ...(ok ? {} : { hint: 'A failed step reports what browserd observed, not just what was dispatched.' }),
  };
}
