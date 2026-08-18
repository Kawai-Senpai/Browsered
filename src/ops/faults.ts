import type { BrowserInstance } from '../browser/instance.js';
import { globToRegExp, ruleMatches, type FaultRule } from '../browser/faults.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { AgentBrowserError, NotFoundError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import type { OpsContext } from './context.js';
import { parseDuration } from './time.js';

export interface FaultArgs {
  browser_id?: string;
  target_id?: string;
}

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
  resourceType?: string;
  responseStatusCode?: number;
}

async function pageOf(ctx: OpsContext, args: FaultArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

/**
 * Arm Fetch interception once per browser and route every paused request
 * through the rule list. Interception is deliberately lazy: with no rules the
 * Fetch domain stays off, so ordinary browsing pays nothing for the feature.
 */
async function armRouter(instance: BrowserInstance, target: ManagedTarget): Promise<void> {
  if (instance.faultRouterArmed) return;
  instance.faultRouterArmed = true;

  target.session.on('Fetch.requestPaused', (params) => {
    void handlePaused(instance, target, params as unknown as PausedRequest);
  });

  await target.session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
}

async function handlePaused(
  instance: BrowserInstance,
  target: ManagedTarget,
  event: PausedRequest,
): Promise<void> {
  const url = event.request.url;
  const rule = [...instance.faults.values()].find((r) => ruleMatches(r, url, event.resourceType));

  // Unmatched traffic must continue untouched, or interception would hang the page.
  if (!rule) {
    await target.session.trySend('Fetch.continueRequest', { requestId: event.requestId });
    return;
  }

  rule.matched++;
  /*
   * A glob is tested against the whole URL, so `**\/prompt-studio/**` spans the
   * host and happily matches the frontend route as well as the API it was meant
   * for. Recording the first few hits is what turns that from a confusing dead
   * end into a five-second fix.
   */
  if (!rule.matchedUrls) rule.matchedUrls = [];
  if (rule.matchedUrls.length < 5) rule.matchedUrls.push(url);
  if (rule.remaining !== undefined) rule.remaining--;

  try {
    switch (rule.action) {
      case 'abort':
      case 'drop':
        await target.session.send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: rule.errorReason ?? (rule.action === 'drop' ? 'ConnectionRefused' : 'Failed'),
        });
        return;

      case 'delay':
        // Stall the request without blocking the CDP connection.
        await new Promise((resolve) => setTimeout(resolve, rule.delayMs ?? 0));
        await target.session.send('Fetch.continueRequest', { requestId: event.requestId });
        return;

      case 'replace_response': {
        const body = rule.body ?? '';
        const headers = Object.entries(rule.headers ?? { 'content-type': 'application/json' }).map(
          ([name, value]) => ({ name, value }),
        );
        await target.session.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: rule.status ?? 200,
          responseHeaders: headers,
          body: Buffer.from(body, 'utf8').toString('base64'),
        });
        return;
      }

      case 'modify_headers': {
        const merged = { ...event.request.headers, ...(rule.requestHeaders ?? {}) };
        await target.session.send('Fetch.continueRequest', {
          requestId: event.requestId,
          headers: Object.entries(merged).map(([name, value]) => ({ name, value })),
        });
        return;
      }
    }
  } catch {
    // A rule that fails must never strand the request: let it through.
    await target.session.trySend('Fetch.continueRequest', { requestId: event.requestId });
  }
}

async function addRule(
  ctx: OpsContext,
  args: FaultArgs,
  rule: Omit<FaultRule, 'id' | 'matched' | 'createdAt'>,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl(`fault.network.${rule.action}`);
  await armRouter(instance, target);

  const id = mintId('flt');
  const full: FaultRule = { ...rule, id, matched: 0, matchedUrls: [], createdAt: Date.now() };
  instance.faults.set(id, full);

  /*
   * Dry-run the pattern against what has already been recorded, before the
   * caller goes and reproduces anything. A rule that matches nothing and a rule
   * that matches the app itself are the two failure modes, and both are silent
   * without this.
   */
  const preview = matchPreview(ctx, instance.id, full, target.info.url);

  return {
    browser_id: instance.id,
    target_id: target.handle,
    fault_id: id,
    action: rule.action,
    url_pattern: rule.urlPattern,
    ...(rule.remaining === undefined ? {} : { applies_to_next: rule.remaining }),
    ...preview,
    hint: 'Reproduce the behaviour, then check network.list_requests and console.query for how the page coped. fault.list shows what the rule actually fired on.',
  };
}

/**
 * What would this pattern do, judged against the traffic already on record.
 *
 * The recorder is holding the URLs anyway, so this costs nothing and makes
 * pattern authoring verifiable rather than hopeful.
 */
function matchPreview(
  ctx: OpsContext,
  browserId: string,
  rule: FaultRule,
  currentPageUrl: string,
): Record<string, unknown> {
  let rows: Array<{ url: string; resource_type: string | null }>;
  try {
    rows = ctx.stores.network.list({ browserId, limit: 3000, offset: 0 });
  } catch {
    return {};
  }
  const seen = new Set<string>();
  const samples: string[] = [];
  let matched = 0;
  let matchedDocuments = 0;
  for (const row of rows) {
    if (!ruleMatches({ ...rule, remaining: undefined }, row.url, row.resource_type ?? undefined)) continue;
    matched++;
    if (row.resource_type === 'Document') matchedDocuments++;
    if (!seen.has(row.url) && samples.length < 5) {
      seen.add(row.url);
      samples.push(row.url);
    }
  }

  const hitsCurrentPage = globToRegExp(rule.urlPattern).test(currentPageUrl);
  const out: Record<string, unknown> = {
    matches_in_recording: matched,
    ...(samples.length ? { matched_so_far: samples } : {}),
  };
  if (matched === 0) {
    out.warning =
      `This pattern matches none of the ${rows.length} recorded requests. It may still fire on traffic yet to happen, ` +
      'but if you expected a hit now, check the glob with network.summarize(group_by:"domain"). Note that `**` spans the host, and a pattern is anchored end to end.';
  } else if (hitsCurrentPage || matchedDocuments > 0) {
    // Failing the page's own document means the app never loads, so whatever
    // offline behaviour was being tested is not what gets observed.
    out.warning =
      'This pattern also matches the Document request for the page you are driving' +
      (hitsCurrentPage ? ` (${currentPageUrl})` : '') +
      '. The app itself will fail to load, which is almost never the intent - scope the pattern to the API origin, e.g. "http://localhost:5000/**".';
  }
  return out;
}

/** Dry-run a glob against the recording without creating a rule. */
export async function test(
  ctx: OpsContext,
  args: FaultArgs & { url: string; resource_types?: string[]; limit?: number },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const probe: FaultRule = {
    id: 'dry-run',
    urlPattern: args.url,
    action: 'abort',
    matched: 0,
    createdAt: Date.now(),
    ...(args.resource_types ? { resourceTypes: args.resource_types } : {}),
  };

  const rows = ctx.stores.network.list({ browserId: instance.id, limit: 3000, offset: 0 });
  const matched: string[] = [];
  const notMatched: string[] = [];
  const seenMatch = new Set<string>();
  const seenMiss = new Set<string>();
  for (const row of rows) {
    const hit = ruleMatches(probe, row.url, row.resource_type ?? undefined);
    const bucket = hit ? matched : notMatched;
    const seen = hit ? seenMatch : seenMiss;
    if (!seen.has(row.url) && bucket.length < limit) {
      seen.add(row.url);
      bucket.push(row.url);
    }
  }
  const total = rows.filter((row) => ruleMatches(probe, row.url, row.resource_type ?? undefined)).length;

  return {
    browser_id: instance.id,
    url_pattern: args.url,
    requests_considered: rows.length,
    matches: total,
    sample_matches: matched,
    sample_non_matches: notMatched,
    ...matchPreview(ctx, instance.id, probe, target.info.url),
    hint:
      'No rule was created. `*` and `**` both match any run of characters and span the host; `?` is literal; a pattern is anchored end to end but a trailing query string or fragment is still matched.',
  };
}

export async function abort(
  ctx: OpsContext,
  args: FaultArgs & { url: string; error_reason?: string; count?: number; resource_types?: string[] },
): Promise<Record<string, unknown>> {
  return addRule(ctx, args, {
    urlPattern: args.url,
    action: 'abort',
    ...(args.error_reason ? { errorReason: args.error_reason } : {}),
    ...(args.count === undefined ? {} : { remaining: args.count }),
    ...(args.resource_types ? { resourceTypes: args.resource_types } : {}),
  });
}

export async function delay(
  ctx: OpsContext,
  args: FaultArgs & { url: string; delay: string | number; count?: number; resource_types?: string[] },
): Promise<Record<string, unknown>> {
  const delayMs = parseDuration(args.delay);
  if (delayMs > 120_000) {
    throw new AgentBrowserError('delay_too_long', 'Delays are capped at 120s so a rule cannot wedge the browser.');
  }
  return addRule(ctx, args, {
    urlPattern: args.url,
    action: 'delay',
    delayMs,
    ...(args.count === undefined ? {} : { remaining: args.count }),
    ...(args.resource_types ? { resourceTypes: args.resource_types } : {}),
  });
}

export async function replaceResponse(
  ctx: OpsContext,
  args: FaultArgs & {
    url: string;
    status?: number;
    body?: string | Record<string, unknown>;
    headers?: Record<string, string>;
    count?: number;
  },
): Promise<Record<string, unknown>> {
  const body = typeof args.body === 'string' ? args.body : args.body ? JSON.stringify(args.body) : '';
  return addRule(ctx, args, {
    urlPattern: args.url,
    action: 'replace_response',
    status: args.status ?? 200,
    body,
    ...(args.headers ? { headers: args.headers } : {}),
    ...(args.count === undefined ? {} : { remaining: args.count }),
  });
}

export async function dropNext(
  ctx: OpsContext,
  args: FaultArgs & { url: string; count?: number },
): Promise<Record<string, unknown>> {
  return addRule(ctx, args, {
    urlPattern: args.url,
    action: 'drop',
    errorReason: 'ConnectionRefused',
    remaining: args.count ?? 1,
  });
}

export async function modifyHeaders(
  ctx: OpsContext,
  args: FaultArgs & { url: string; headers: Record<string, string>; count?: number },
): Promise<Record<string, unknown>> {
  return addRule(ctx, args, {
    urlPattern: args.url,
    action: 'modify_headers',
    requestHeaders: args.headers,
    ...(args.count === undefined ? {} : { remaining: args.count }),
  });
}

export async function list(ctx: OpsContext, args: FaultArgs): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  return {
    browser_id: instance.id,
    interception_active: instance.faultRouterArmed,
    count: instance.faults.size,
    faults: [...instance.faults.values()].map((rule) => ({
      fault_id: rule.id,
      action: rule.action,
      url_pattern: rule.urlPattern,
      times_applied: rule.matched,
      ...(rule.matchedUrls?.length ? { matched_so_far: rule.matchedUrls } : {}),
      ...(rule.matched === 0
        ? { note: 'This rule has never fired. Check the glob with fault.test before concluding the app is at fault.' }
        : {}),
      remaining: rule.remaining ?? null,
      exhausted: rule.remaining !== undefined && rule.remaining <= 0,
      created_at: new Date(rule.createdAt).toISOString(),
    })),
  };
}

export async function remove(
  ctx: OpsContext,
  args: FaultArgs & { fault_id: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('fault.remove');
  if (!instance.faults.delete(args.fault_id)) {
    throw new NotFoundError('fault rule', args.fault_id);
  }
  return { browser_id: instance.id, fault_id: args.fault_id, removed: true, remaining_rules: instance.faults.size };
}

export async function clear(ctx: OpsContext, args: FaultArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('fault.clear');
  const cleared = instance.faults.size;
  instance.faults.clear();

  // With no rules left, take interception back down so normal traffic is not
  // routed through the daemon at all.
  if (instance.faultRouterArmed) {
    await target.session.trySend('Fetch.disable');
    instance.faultRouterArmed = false;
  }
  return { browser_id: instance.id, cleared, interception_active: false };
}
