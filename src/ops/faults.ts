import type { BrowserInstance } from '../browser/instance.js';
import { ruleMatches, type FaultRule } from '../browser/faults.js';
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
  const full: FaultRule = { ...rule, id, matched: 0, createdAt: Date.now() };
  instance.faults.set(id, full);

  return {
    browser_id: instance.id,
    target_id: target.handle,
    fault_id: id,
    action: rule.action,
    url_pattern: rule.urlPattern,
    ...(rule.remaining === undefined ? {} : { applies_to_next: rule.remaining }),
    hint: 'Reproduce the behaviour, then check network.list_requests and console.query for how the page coped.',
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
