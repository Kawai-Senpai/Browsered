/**
 * Turning an exploration into something a test harness can consume.
 *
 * browserd already records network, console and exceptions continuously, and
 * the locator ops can name an element the way a durable test must. What was
 * missing is the third thing a Playwright-based harness needs: the sequence of
 * actions that got the page into the state being asserted, expressed in that
 * harness's vocabulary rather than in browserd's.
 *
 * So `qa.record_start` arms a recorder that watches the tool calls themselves.
 * Each mutating page action is captured with its semantic locator resolved *at
 * the moment of the action*, while the element is still on screen and still
 * unique - which is the only time that question has a reliable answer. The
 * recorded steps then come back shaped for the harness.
 *
 * ONE RULE GOVERNS THIS WHOLE FILE. browserd reports what happened; it never
 * decides what should have happened. Auto-QA exists because an agent that
 * writes assertions from observed behaviour encodes today's bugs as tomorrow's
 * permanently-green regression tests, which is worse than having no tests
 * because it manufactures confidence. Everything here that looks like an
 * assertion is therefore emitted as a *candidate* with a null oracle, and
 * `qa.scenario_draft` refuses to present itself as ready to compile until a
 * human or an agent has attached a requirement to each one.
 */
import { AgentBrowserError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import type { OpsContext } from './context.js';
import { candidates } from './locator.js';
import type { SemanticTarget } from './locator.js';

const log = createLogger('qa');

/* -------------------------------- recording ------------------------------- */

/** Actions a scenario step can express. Anything else is evidence, not a step. */
type StepAction =
  | 'goto'
  | 'click'
  | 'fill'
  | 'press'
  | 'hover'
  | 'select'
  | 'keyboard'
  | 'advanceClock'
  | 'setViewport';

export interface RecordedStep {
  index: number;
  at: number;
  tool: string;
  action: StepAction | 'scroll';
  target?: SemanticTarget;
  value?: string;
  key?: string;
  path?: string;
  url?: string;
  duration?: string;
  width?: number;
  height?: number;
  /** The browserd locator that was actually used, kept as a breadcrumb only. */
  located_by?: string;
  target_matches?: number;
  /** Why this step cannot be replayed as written, if it cannot. */
  problem?: string;
  observed_change?: boolean;
  ok?: boolean;
}

interface Recording {
  flow: string;
  started_at: number;
  browser_id?: string;
  target_handle?: string;
  steps: RecordedStep[];
  /** Actions whose locator could not be named semantically. Counted, not hidden. */
  unnameable: number;
}

/**
 * One recording at a time, for the whole daemon.
 *
 * A QA exploration is one flow through one application; making this per-target
 * would invite a half-recorded scenario spread over two tabs, which is not a
 * scenario anybody can review.
 */
let recording: Recording | undefined;

/** How a tool call maps onto a scenario step. */
const ACTION_OF: Record<string, StepAction | 'scroll'> = {
  'page.navigate': 'goto',
  'page.click': 'click',
  'page.type': 'fill',
  'page.press': 'press',
  'page.hover': 'hover',
  'page.select_option': 'select',
  'page.scroll': 'scroll',
  'page.set_viewport': 'setViewport',
  'time.run': 'advanceClock',
  'time.jump': 'advanceClock',
};

const LOCATOR_KEYS = ['selector', 'xpath', 'text', 'ref', 'backend_node_id'] as const;

/**
 * Which argument keys are a locator for this tool.
 *
 * `text` is the odd one out: on most tools it locates an element by its visible
 * text, but on page.type it is the text being typed. Treating it as a locator
 * there would look up an element named after whatever the user is entering.
 */
function locatorKeys(tool: string): readonly string[] {
  return tool === 'page.type' ? LOCATOR_KEYS.filter((key) => key !== 'text') : LOCATOR_KEYS;
}

function hasLocator(tool: string, args: Record<string, unknown>): boolean {
  return locatorKeys(tool).some((key) => args[key] !== undefined);
}

function locatorSummary(tool: string, args: Record<string, unknown>): string | undefined {
  for (const key of locatorKeys(tool)) {
    if (args[key] !== undefined) return `${key}=${String(args[key])}`;
  }
  return undefined;
}

/** Milliseconds from browserd's duration spelling ("5m", "90s", 1500). */
function durationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor =
    unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * factor;
}

/**
 * Playwright's clock takes "mm:ss" or "hh:mm:ss"; a scenario schema that types
 * the duration as a string cannot carry a raw millisecond count.
 */
function toClockDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Path plus query, which is what a scenario's goto and urlPath talk about. */
function pathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

export interface PendingStep {
  step: RecordedStep;
}

/**
 * Capture what a step needs *before* the action runs.
 *
 * The semantic locator has to be resolved now: after a click the element may
 * have been replaced, re-rendered or navigated away from, and a locator
 * resolved against the resulting page is a locator for a different element. It
 * never throws - a recorder that can break the tool it observes is worse than
 * no recorder.
 */
export async function beforeAction(
  ctx: OpsContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<PendingStep | undefined> {
  if (!recording) return undefined;
  const action = ACTION_OF[tool];
  if (!action) return undefined;

  const step: RecordedStep = {
    index: recording.steps.length,
    at: Date.now(),
    tool,
    action,
  };

  try {
    switch (action) {
      case 'goto':
        step.url = typeof args.url === 'string' ? args.url : undefined;
        step.path = step.url ? pathOf(step.url) : undefined;
        break;
      case 'fill':
        step.value = typeof args.text === 'string' ? args.text : undefined;
        if (args.clear !== true) {
          step.problem =
            'page.type appends to whatever the field already held, while a scenario fill() replaces it. ' +
            'Confirm the field was empty, or re-record with clear:true.';
        }
        break;
      case 'press':
        step.key = typeof args.key === 'string' ? args.key : undefined;
        // A press with no locator is a keyboard event aimed at whatever has focus.
        if (!hasLocator(tool, args)) step.action = 'keyboard';
        break;
      case 'select': {
        const values = Array.isArray(args.values) ? args.values : undefined;
        const first = values?.[0];
        if (typeof first === 'string') step.value = first;
        if (values && values.length > 1) {
          step.problem = 'A scenario select step carries one value; this call selected several.';
        }
        if (!values && args.labels !== undefined) {
          step.problem = 'Selected by label. A scenario select step takes the option value.';
        }
        break;
      }
      case 'setViewport':
        step.width = typeof args.width === 'number' ? args.width : undefined;
        step.height = typeof args.height === 'number' ? args.height : undefined;
        break;
      case 'advanceClock': {
        const ms = durationMs(args.duration);
        if (ms !== undefined) step.duration = toClockDuration(ms);
        break;
      }
      default:
        break;
    }

    if (hasLocator(tool, args)) {
      step.located_by = locatorSummary(tool, args);
      const resolved = await candidates(ctx, {
        browser_id: typeof args.browser_id === 'string' ? args.browser_id : undefined,
        target_id: typeof args.target_id === 'string' ? args.target_id : undefined,
        selector: typeof args.selector === 'string' ? args.selector : undefined,
        xpath: typeof args.xpath === 'string' ? args.xpath : undefined,
        text: typeof args.text === 'string' && tool !== 'page.type' ? args.text : undefined,
        ref: typeof args.ref === 'string' ? args.ref : undefined,
        backend_node_id: typeof args.backend_node_id === 'number' ? args.backend_node_id : undefined,
        frame_id: typeof args.frame_id === 'string' ? args.frame_id : undefined,
        nth: typeof args.nth === 'number' ? args.nth : undefined,
      });

      const recommended = resolved.recommended as SemanticTarget | undefined;
      const list = (resolved.candidates ?? []) as Array<{ target: SemanticTarget; matches: number }>;
      if (recommended) {
        step.target = recommended;
        step.target_matches = 1;
      } else if (list.length > 0) {
        // Record the best available locator plus the reason it is not usable,
        // rather than dropping the step and leaving a hole in the sequence.
        step.target = list[0]!.target;
        step.target_matches = list[0]!.matches;
        step.problem =
          step.problem ??
          `No locator uniquely addresses this element (best match count: ${list[0]!.matches}). ` +
            'The step is recorded so the sequence stays complete, but it cannot be compiled as written.';
      } else {
        step.problem =
          step.problem ??
          'This element has no locator a durable test can express. See locator.candidates for the detail.';
      }
    }
  } catch (err) {
    step.problem = `Could not resolve a semantic locator: ${(err as Error).message}`;
    log.debug(`qa recorder: ${(err as Error).message}`);
  }

  return { step };
}

/** Fold the tool's own report of what happened into the recorded step. */
export function afterAction(pending: PendingStep | undefined, payload: Record<string, unknown>): void {
  if (!pending || !recording) return;
  const { step } = pending;

  if (typeof payload.observed_change === 'boolean') step.observed_change = payload.observed_change;

  if (step.action === 'goto' && typeof payload.url === 'string') {
    step.url = payload.url;
    step.path = pathOf(payload.url) ?? step.path;
  }

  if (step.action === 'fill') {
    const wanted = Number(payload.characters ?? 0);
    const landed = Number(payload.landed_characters ?? 0);
    if (wanted > 0 && landed < wanted) {
      step.problem = `Only ${landed} of ${wanted} characters landed, so this step did not do what it claims.`;
    }
  }

  step.ok = payload.ok !== false && step.problem === undefined;
  recording.steps.push(step);
  // Only an action that pointed at an element can be unnameable. A navigation
  // or a clock advance has no element, and counting those would make the
  // number meaningless.
  if (step.located_by !== undefined && step.target === undefined) recording.unnameable += 1;
}

function requireRecording(): Recording {
  if (!recording) {
    throw new AgentBrowserError(
      'not_recording',
      'No QA recording is active. Call qa.record_start before driving the flow you want captured.',
    );
  }
  return recording;
}

/* ---------------------------------- ops ----------------------------------- */

export async function recordStart(
  _ctx: OpsContext,
  args: { flow: string; browser_id?: string; target_id?: string },
): Promise<Record<string, unknown>> {
  if (!args.flow || !args.flow.trim()) {
    throw new AgentBrowserError('no_flow', 'Name the flow being recorded, e.g. "create a todo".');
  }
  const replaced = recording?.steps.length;
  recording = {
    flow: args.flow.trim(),
    started_at: Date.now(),
    browser_id: args.browser_id,
    target_handle: args.target_id,
    steps: [],
    unnameable: 0,
  };
  return {
    recording: true,
    flow: recording.flow,
    started_at: new Date(recording.started_at).toISOString(),
    ...(replaced ? { discarded_previous_steps: replaced } : {}),
    records:
      'page.navigate, click, type, press, hover, select_option, scroll, set_viewport, and time.run/jump. ' +
      'Each action resolves its semantic locator before it runs.',
    note:
      'Network, console and exceptions were already being recorded and are not affected by this. ' +
      'qa.evidence reads them for any window, including before this call.',
  };
}

export async function recordStop(
  _ctx: OpsContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const active = requireRecording();
  const summary = {
    recording: false,
    flow: active.flow,
    steps: active.steps.length,
    unnameable: active.unnameable,
    duration_ms: Date.now() - active.started_at,
  };
  // The steps survive the stop: they are what qa.steps and qa.scenario_draft
  // read, and discarding them here would make stopping destructive.
  return { ...summary, next: 'qa.steps, qa.evidence, then qa.scenario_draft.' };
}

export async function recordStatus(
  _ctx: OpsContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!recording) return { recording: false, steps: 0 };
  return {
    recording: true,
    flow: recording.flow,
    started_at: new Date(recording.started_at).toISOString(),
    steps: recording.steps.length,
    unnameable: recording.unnameable,
  };
}

export async function steps(
  _ctx: OpsContext,
  args: { include_problems?: boolean },
): Promise<Record<string, unknown>> {
  const active = requireRecording();
  const problems = active.steps.filter((step) => step.problem !== undefined);

  return {
    flow: active.flow,
    started_at: new Date(active.started_at).toISOString(),
    count: active.steps.length,
    steps: active.steps,
    ...(problems.length > 0
      ? {
          problems: args.include_problems === false ? problems.length : problems.map((step) => ({
            index: step.index,
            tool: step.tool,
            problem: step.problem,
          })),
          warning:
            `${problems.length} step(s) cannot be compiled as recorded. Fix them at the source - a better locator, ` +
            'a test id, or re-driving the flow - rather than by loosening the step.',
        }
      : {}),
  };
}

/* -------------------------------- evidence -------------------------------- */

interface EvidenceArgs {
  browser_id?: string;
  target_id?: string;
  since?: number;
  until?: number;
  origin?: string;
}

/** Group key for a request assertion: the method and the path, without query. */
function requestKey(url: string, method: string): { key: string; urlIncludes: string } | undefined {
  try {
    const parsed = new URL(url);
    return { key: `${method} ${parsed.pathname}`, urlIncludes: parsed.pathname };
  } catch {
    return undefined;
  }
}

/**
 * What browserd observed during the flow, shaped as things a scenario could
 * assert - each one still missing its oracle.
 *
 * This is the part no live-driving tool can do after the fact: the recording
 * was always running, so the window can be chosen once the flow is over and the
 * interesting question is known.
 */
export async function evidence(ctx: OpsContext, args: EvidenceArgs): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const since = args.since ?? recording?.started_at ?? Date.now() - 300_000;
  const until = args.until ?? Date.now();

  const requests = ctx.stores.network.list({
    browserId: instance.id,
    ...(args.target_id ? { targetHandle: args.target_id } : {}),
    since,
    until,
    limit: 2000,
    order: 'asc',
  });

  let origin = args.origin;
  if (!origin) {
    const document = requests.find((row) => row.resource_type === 'Document');
    if (document) {
      try {
        origin = new URL(document.url).origin;
      } catch {
        /* An unparseable document URL just means first-party cannot be inferred. */
      }
    }
  }

  const isFirstParty = (url: string): boolean => {
    if (!origin) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  /* --- requests worth asserting on ---------------------------------------- */

  const grouped = new Map<string, { method: string; urlIncludes: string; seen: number; sample: string }>();
  const httpErrors: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const navigations: string[] = [];

  for (const row of requests) {
    if (row.resource_type === 'Document') {
      const path = pathOf(row.url);
      if (path && navigations[navigations.length - 1] !== path) navigations.push(path);
    }

    const first = isFirstParty(row.url);
    if (row.status !== null && row.status >= 400) {
      httpErrors.push({ method: row.method, url: row.url, status: row.status, first_party: first });
    }
    if (row.error_text) {
      failures.push({ method: row.method, url: row.url, failure: row.error_text, first_party: first });
    }

    // An assertion about "the app called its API" is about XHR and fetch, not
    // about every image and stylesheet the page happened to pull.
    if (row.resource_type !== 'XHR' && row.resource_type !== 'Fetch') continue;
    if (!first) continue;

    const key = requestKey(row.url, row.method);
    if (!key) continue;
    const existing = grouped.get(key.key);
    if (existing) existing.seen += 1;
    else grouped.set(key.key, { method: row.method, urlIncludes: key.urlIncludes, seen: 1, sample: row.url });
  }

  const consoleErrors = ctx.stores.console.listEntries({
    browserId: instance.id,
    ...(args.target_id ? { targetHandle: args.target_id } : {}),
    level: 'error',
    since,
    until,
    limit: 100,
    order: 'asc',
  });

  const exceptions = ctx.stores.console.listExceptions({
    browserId: instance.id,
    ...(args.target_id ? { targetHandle: args.target_id } : {}),
    since,
    until,
    limit: 100,
    order: 'asc',
  });

  const candidateAssertions = [...grouped.values()].map((entry) => ({
    assertion: { type: 'requestSeen', method: entry.method, urlIncludes: entry.urlIncludes },
    observed: { count: entry.seen, sample_url: entry.sample },
    oracle: null,
  }));

  if (navigations.length > 0) {
    const last = navigations[navigations.length - 1]!;
    candidateAssertions.push({
      assertion: { type: 'urlPath', path: last } as never,
      observed: { count: 1, sample_url: last },
      oracle: null,
    });
  }

  return {
    browser_id: instance.id,
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    ...(origin ? { first_party_origin: origin } : { first_party_origin: null }),
    navigations,
    candidate_assertions: candidateAssertions,
    findings: [
      ...consoleErrors.map((row) => ({
        category: 'console',
        severity: 'medium',
        summary: (row.text ?? '').slice(0, 300),
        at: new Date(row.ts).toISOString(),
      })),
      ...exceptions.map((row) => ({
        category: 'console',
        severity: 'high',
        summary: `Uncaught: ${row.text}`.slice(0, 300),
        at: new Date(row.ts).toISOString(),
      })),
      ...failures
        .filter((entry) => entry.first_party === true)
        .map((entry) => ({
          category: 'network',
          severity: 'high',
          summary: `${entry.method} ${entry.url} failed: ${entry.failure}`,
        })),
    ],
    http_errors: httpErrors,
    counts: {
      requests: requests.length,
      console_errors: consoleErrors.length,
      exceptions: exceptions.length,
      http_errors: httpErrors.length,
      network_failures: failures.length,
    },
    oracle_warning:
      'Every candidate here is an observation, not a requirement. An assertion built from these alone will pass ' +
      'against the current behaviour whether or not that behaviour is correct, which is how a bug becomes a ' +
      'permanently-green regression test. Attach a requirement to each one before compiling it.',
  };
}

/* ------------------------------ scenario draft ---------------------------- */

interface DraftArgs {
  id: string;
  name: string;
  requirement_source?: string;
  start_path?: string;
  role?: string;
  viewport?: string;
  browser_id?: string;
  target_id?: string;
}

/**
 * The recorded flow, shaped as a scenario, with the assertions left empty on
 * purpose.
 *
 * A harness schema requires at least one assertion, so this draft does not
 * validate as it stands. That is the design: the missing pieces are exactly the
 * two an agent must not invent - what the requirement says, and which of the
 * observed behaviours the requirement actually mandates.
 */
export async function scenarioDraft(ctx: OpsContext, args: DraftArgs): Promise<Record<string, unknown>> {
  const active = requireRecording();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.id ?? '')) {
    throw new AgentBrowserError(
      'bad_id',
      'Scenario ids are lowercase letters, numbers and hyphens, e.g. "todo-create".',
    );
  }

  const usable = active.steps.filter((step) => step.action !== 'scroll' && step.problem === undefined);
  const dropped = active.steps.filter((step) => step.action === 'scroll' || step.problem !== undefined);

  /* The first navigation becomes startPath; the compiler emits it separately. */
  const firstGoto = usable.find((step) => step.action === 'goto');
  const startPath = args.start_path ?? firstGoto?.path ?? '/';

  const scenarioSteps: Array<Record<string, unknown>> = [];
  for (const step of usable) {
    if (step.action === 'goto') {
      // The compiler emits startPath itself, so the navigation that produced it
      // must not also appear as a step or the test loads the page twice.
      if (step === firstGoto) continue;
      scenarioSteps.push({ action: 'goto', path: step.path ?? '/' });
      continue;
    }
    switch (step.action) {
      case 'click':
      case 'hover':
        if (step.target) scenarioSteps.push({ action: step.action, target: step.target });
        break;
      case 'fill':
        if (step.target) scenarioSteps.push({ action: 'fill', target: step.target, value: step.value ?? '' });
        break;
      case 'press':
        if (step.target) scenarioSteps.push({ action: 'press', target: step.target, key: step.key ?? 'Enter' });
        break;
      case 'select':
        if (step.target) scenarioSteps.push({ action: 'select', target: step.target, value: step.value ?? '' });
        break;
      case 'keyboard':
        scenarioSteps.push({ action: 'keyboard', key: step.key ?? 'Enter' });
        break;
      case 'advanceClock':
        if (step.duration) scenarioSteps.push({ action: 'advanceClock', duration: step.duration });
        break;
      case 'setViewport':
        if (step.width && step.height) {
          scenarioSteps.push({ action: 'setViewport', width: step.width, height: step.height });
        }
        break;
      default:
        break;
    }
  }

  const observed = await evidence(ctx, {
    browser_id: args.browser_id,
    target_id: args.target_id,
    since: active.started_at,
  });

  return {
    scenario: {
      id: args.id,
      name: args.name,
      requirementSource: args.requirement_source ?? null,
      startPath,
      ...(args.role ? { role: args.role } : {}),
      ...(args.viewport ? { viewport: args.viewport } : {}),
      steps: scenarioSteps,
      assertions: [],
    },
    ready_to_compile: false,
    blocking: [
      ...(args.requirement_source
        ? []
        : ['requirementSource is null. Name the requirement document that says what this flow should do.']),
      'assertions is empty. Choose from candidate_assertions below, and only those a requirement actually mandates.',
    ],
    candidate_assertions: (observed.candidate_assertions as unknown[]) ?? [],
    findings: (observed.findings as unknown[]) ?? [],
    ...(dropped.length > 0
      ? {
          dropped_steps: dropped.map((step) => ({
            index: step.index,
            tool: step.tool,
            reason:
              step.action === 'scroll'
                ? 'A scenario has no scroll step; Playwright scrolls into view on its own.'
                : step.problem,
          })),
        }
      : {}),
    oracle_warning:
      'This draft records what happened. It does not know what should have happened, and nothing here should be ' +
      'promoted into an assertion because "that is what the app did".',
  };
}

/* ------------------------------ session events ---------------------------- */

/**
 * The recording as an event log a QA harness can ingest directly.
 *
 * Deliberately returned rather than written to the harness's own directory:
 * that path is constrained by the harness on purpose, and a second process
 * writing into it would route around the boundary it exists to enforce.
 */
export async function sessionEvents(
  ctx: OpsContext,
  args: EvidenceArgs,
): Promise<Record<string, unknown>> {
  const active = requireRecording();
  const observed = await evidence(ctx, { ...args, since: args.since ?? active.started_at });

  const events: Array<Record<string, unknown>> = [];

  for (const step of active.steps) {
    if (step.action === 'advanceClock' || step.action === 'setViewport' || step.action === 'keyboard') continue;
    events.push({
      type: 'action',
      action: step.action,
      ...(step.target ? { target: step.target } : {}),
      ...(step.value === undefined ? {} : { value: step.value }),
      ...(step.key === undefined ? {} : { key: step.key }),
      ...(step.path === undefined ? {} : { path: step.path }),
      ...(step.url === undefined ? {} : { urlAfter: step.url }),
    });
  }

  for (const finding of (observed.findings as Array<Record<string, unknown>>) ?? []) {
    if (finding.category === 'console') {
      // Only error-level output and uncaught exceptions reach the findings list,
      // so every console event emitted here is an error.
      events.push({ type: 'console', level: 'error', text: String(finding.summary ?? '') });
    } else {
      events.push({
        type: 'finding',
        category: String(finding.category ?? 'functional'),
        severity: String(finding.severity ?? 'medium'),
        summary: String(finding.summary ?? ''),
        evidence: [],
      });
    }
  }

  for (const candidate of (observed.candidate_assertions as Array<Record<string, unknown>>) ?? []) {
    const assertion = candidate.assertion as Record<string, unknown>;
    if (assertion?.type !== 'requestSeen') continue;
    events.push({
      type: 'network',
      method: String(assertion.method),
      url: String((candidate.observed as Record<string, unknown>)?.sample_url ?? assertion.urlIncludes),
      occurred: true,
    });
  }

  return {
    flow: active.flow,
    count: events.length,
    events,
    how_to_use:
      'Pass each event to the harness one at a time (Auto-QA: qa_record_event with the session id from ' +
      'qa_begin_session). Candidate assertions are not included as assertions - they carry no oracle.',
  };
}
