import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import type { CallFrame, DebuggerPausedEvent, RemoteObject, ScriptParsedEvent } from '../cdp/types.js';
import { AgentBrowserError, NotFoundError, TimeoutError } from '../util/errors.js';
import { flattenStack, renderRemoteObject } from '../util/remote-object.js';
import type { OpsContext } from './context.js';

export interface DebuggerArgs {
  browser_id?: string;
  target_id?: string;
}

async function pageOf(ctx: OpsContext, args: DebuggerArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolveTarget(args.target_id);
  return { instance, target };
}

function requirePaused(instance: BrowserInstance, target: ManagedTarget): DebuggerPausedEvent {
  const paused = instance.pausedAt.get(target.handle);
  if (!paused) {
    throw new AgentBrowserError(
      'not_paused',
      `Target ${target.handle} is not paused. Set a breakpoint and trigger it, or call debugger.pause first.`,
    );
  }
  return paused;
}

/**
 * Turning on the Debugger domain is deliberately explicit: it makes Chromium
 * keep script sources alive, and pause-on-exception changes how the page
 * behaves for the human sharing the browser.
 */
export async function enable(
  ctx: OpsContext,
  args: DebuggerArgs & { max_script_cache_size?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  if (instance.debuggerEnabled.has(target.handle)) {
    return {
      target_id: target.handle,
      already_enabled: true,
      script_count: instance.parsedScripts.get(target.handle)?.size ?? 0,
    };
  }

  const scripts = new Map<string, ScriptParsedEvent>();
  instance.parsedScripts.set(target.handle, scripts);

  target.session.on('Debugger.scriptParsed', (params) => {
    const event = params as unknown as ScriptParsedEvent;
    scripts.set(event.scriptId, event);
  });
  target.session.on('Debugger.paused', (params) => {
    instance.pausedAt.set(target.handle, params as unknown as DebuggerPausedEvent);
  });
  target.session.on('Debugger.resumed', () => {
    instance.pausedAt.delete(target.handle);
  });

  await target.session.send('Debugger.enable', {
    ...(args.max_script_cache_size ? { maxScriptsCacheSize: args.max_script_cache_size } : {}),
  });
  await target.session.trySend('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
  instance.debuggerEnabled.add(target.handle);

  // scriptParsed replays for already-loaded scripts; give it a beat to arrive.
  await delay(150);

  return {
    target_id: target.handle,
    enabled: true,
    script_count: scripts.size,
    hint: 'debugger.list_scripts now includes eval\'d and inline scripts with script ids.',
  };
}

export async function disable(ctx: OpsContext, args: DebuggerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  if (!instance.debuggerEnabled.has(target.handle)) {
    return { target_id: target.handle, enabled: false, already_disabled: true };
  }
  // Never leave a page frozen behind us.
  if (instance.pausedAt.has(target.handle)) await target.session.trySend('Debugger.resume');
  await target.session.trySend('Debugger.disable');
  instance.debuggerEnabled.delete(target.handle);
  instance.parsedScripts.delete(target.handle);
  instance.pausedAt.delete(target.handle);
  for (const [id, bp] of [...instance.breakpoints]) {
    if (bp.targetHandle === target.handle) instance.breakpoints.delete(id);
  }
  return { target_id: target.handle, enabled: false };
}

function requireEnabled(instance: BrowserInstance, target: ManagedTarget): void {
  if (!instance.debuggerEnabled.has(target.handle)) {
    throw new AgentBrowserError(
      'debugger_disabled',
      `Call debugger.enable for target ${target.handle} first.`,
    );
  }
}

export async function listScripts(
  ctx: OpsContext,
  args: DebuggerArgs & { url_contains?: string; include_anonymous?: boolean },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  const scripts = [...(instance.parsedScripts.get(target.handle)?.values() ?? [])]
    .filter((s) => args.include_anonymous || s.url !== '')
    .filter((s) => !args.url_contains || s.url.includes(args.url_contains));

  return {
    target_id: target.handle,
    count: scripts.length,
    scripts: scripts.map((s) => ({
      script_id: s.scriptId,
      url: s.url || '(anonymous)',
      lines: s.endLine + 1,
      length: s.length ?? null,
      is_module: s.isModule === true,
      has_source_map: Boolean(s.sourceMapURL),
      source_map_url: s.sourceMapURL || null,
    })),
  };
}

export async function setBreakpoint(
  ctx: OpsContext,
  args: DebuggerArgs & {
    url?: string;
    url_regex?: string;
    script_id?: string;
    line: number;
    column?: number;
    condition?: string;
  },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  instance.requireControl('debugger.set_breakpoint');

  if (args.line < 1) {
    throw new AgentBrowserError('bad_line', 'Line numbers are 1-based.');
  }
  // CDP is 0-based; every user-facing line number in this daemon is 1-based.
  const lineNumber = args.line - 1;

  if (args.script_id) {
    const result = await target.session.send<{ breakpointId: string; actualLocation: { lineNumber: number; columnNumber: number } }>(
      'Debugger.setBreakpoint',
      {
        location: {
          scriptId: args.script_id,
          lineNumber,
          ...(args.column === undefined ? {} : { columnNumber: args.column - 1 }),
        },
        ...(args.condition ? { condition: args.condition } : {}),
      },
    );
    instance.breakpoints.set(result.breakpointId, {
      targetHandle: target.handle,
      lineNumber: result.actualLocation.lineNumber + 1,
      ...(args.condition ? { condition: args.condition } : {}),
    });
    return {
      target_id: target.handle,
      breakpoint_id: result.breakpointId,
      script_id: args.script_id,
      requested_line: args.line,
      actual_line: result.actualLocation.lineNumber + 1,
      condition: args.condition ?? null,
    };
  }

  if (!args.url && !args.url_regex) {
    throw new AgentBrowserError('bad_args', 'Provide url, url_regex, or script_id.');
  }

  const result = await target.session.send<{
    breakpointId: string;
    locations: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }>;
  }>('Debugger.setBreakpointByUrl', {
    lineNumber,
    ...(args.url ? { url: args.url } : {}),
    ...(args.url_regex ? { urlRegex: args.url_regex } : {}),
    ...(args.column === undefined ? {} : { columnNumber: args.column - 1 }),
    ...(args.condition ? { condition: args.condition } : {}),
  });

  instance.breakpoints.set(result.breakpointId, {
    targetHandle: target.handle,
    ...(args.url ? { url: args.url } : {}),
    lineNumber: args.line,
    ...(args.condition ? { condition: args.condition } : {}),
  });

  return {
    target_id: target.handle,
    breakpoint_id: result.breakpointId,
    url: args.url ?? args.url_regex,
    requested_line: args.line,
    resolved_locations: result.locations.map((l) => ({
      script_id: l.scriptId,
      line: l.lineNumber + 1,
      column: (l.columnNumber ?? 0) + 1,
    })),
    condition: args.condition ?? null,
    // An unresolved breakpoint is the single most common confusion here.
    warning:
      result.locations.length === 0
        ? 'Breakpoint is registered but did not bind to any loaded script. Check the URL matches exactly (see js.list_scripts), or reload the page so the script parses again.'
        : undefined,
  };
}

export async function removeBreakpoint(
  ctx: OpsContext,
  args: DebuggerArgs & { breakpoint_id: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  await target.session.send('Debugger.removeBreakpoint', { breakpointId: args.breakpoint_id });
  instance.breakpoints.delete(args.breakpoint_id);
  return { target_id: target.handle, breakpoint_id: args.breakpoint_id, removed: true };
}

export async function listBreakpoints(
  ctx: OpsContext,
  args: DebuggerArgs,
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const entries = [...instance.breakpoints.entries()].filter(
    ([, bp]) => bp.targetHandle === target.handle,
  );
  return {
    target_id: target.handle,
    count: entries.length,
    breakpoints: entries.map(([id, bp]) => ({
      breakpoint_id: id,
      url: bp.url ?? null,
      line: bp.lineNumber,
      condition: bp.condition ?? null,
    })),
  };
}

export async function setPauseOnExceptions(
  ctx: OpsContext,
  args: DebuggerArgs & { state: 'none' | 'caught' | 'uncaught' | 'all' },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  instance.requireControl('debugger.pause_on_exceptions');
  await target.session.send('Debugger.setPauseOnExceptions', { state: args.state });
  return { target_id: target.handle, pause_on_exceptions: args.state };
}

export async function pause(
  ctx: OpsContext,
  args: DebuggerArgs & { wait_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  instance.requireControl('debugger.pause');
  await target.session.send('Debugger.pause');

  // Pausing takes effect at the next statement, which may be a moment away.
  const deadline = Date.now() + Math.min(args.wait_ms ?? 2000, 30_000);
  while (Date.now() < deadline && !instance.pausedAt.has(target.handle)) await delay(25);

  const paused = instance.pausedAt.get(target.handle);
  return {
    target_id: target.handle,
    paused: paused !== undefined,
    ...(paused ? { reason: paused.reason, top_frame: describeFrame(paused.callFrames[0]) } : {}),
    note: paused ? undefined : 'Pause requested; the page has not reached a statement yet.',
  };
}

export async function resume(ctx: OpsContext, args: DebuggerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  instance.requireControl('debugger.resume');
  await target.session.send('Debugger.resume');
  instance.pausedAt.delete(target.handle);
  return { target_id: target.handle, resumed: true };
}

export async function step(
  ctx: OpsContext,
  args: DebuggerArgs & { kind: 'into' | 'over' | 'out'; wait_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  instance.requireControl('debugger.step');
  requirePaused(instance, target);

  const method =
    args.kind === 'into' ? 'Debugger.stepInto' : args.kind === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver';
  instance.pausedAt.delete(target.handle);
  await target.session.send(method);

  const deadline = Date.now() + Math.min(args.wait_ms ?? 3000, 30_000);
  while (Date.now() < deadline && !instance.pausedAt.has(target.handle)) await delay(20);

  const paused = instance.pausedAt.get(target.handle);
  if (!paused) {
    return { target_id: target.handle, stepped: args.kind, still_paused: false, note: 'Execution continued past the stepped statement without pausing again.' };
  }
  return {
    target_id: target.handle,
    stepped: args.kind,
    still_paused: true,
    reason: paused.reason,
    top_frame: describeFrame(paused.callFrames[0]),
  };
}

function describeFrame(frame: CallFrame | undefined): Record<string, unknown> | null {
  if (!frame) return null;
  return {
    call_frame_id: frame.callFrameId,
    function: frame.functionName || '(anonymous)',
    url: frame.url,
    line: frame.location.lineNumber + 1,
    column: (frame.location.columnNumber ?? 0) + 1,
    script_id: frame.location.scriptId,
  };
}

export async function callFrames(ctx: OpsContext, args: DebuggerArgs): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const paused = requirePaused(instance, target);

  return {
    target_id: target.handle,
    reason: paused.reason,
    data: paused.data ?? null,
    hit_breakpoints: paused.hitBreakpoints ?? [],
    async_stack: flattenStack(paused.asyncStackTrace),
    frames: paused.callFrames.map((frame, index) => ({
      index,
      ...describeFrame(frame),
      this: renderRemoteObject(frame.this),
      scopes: frame.scopeChain.map((scope) => ({
        type: scope.type,
        name: scope.name ?? null,
        object_id: scope.object.objectId ?? null,
        description: scope.object.description ?? scope.object.className ?? null,
      })),
    })),
    hint: 'Use debugger.evaluate with call_frame_id to read locals in a frame, or debugger.scope to expand a scope object.',
  };
}

export async function evaluateOnCallFrame(
  ctx: OpsContext,
  args: DebuggerArgs & { expression: string; call_frame_id?: string; frame_index?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const paused = requirePaused(instance, target);

  let callFrameId = args.call_frame_id;
  if (!callFrameId) {
    const frame = paused.callFrames[args.frame_index ?? 0];
    if (!frame) throw new NotFoundError('call frame', String(args.frame_index ?? 0));
    callFrameId = frame.callFrameId;
  }

  const response = await target.session.send<{
    result: RemoteObject;
    exceptionDetails?: { text: string; exception?: RemoteObject };
  }>('Debugger.evaluateOnCallFrame', {
    callFrameId,
    expression: args.expression,
    returnByValue: true,
    generatePreview: true,
  });

  if (response.exceptionDetails) {
    return {
      target_id: target.handle,
      ok: false,
      error: response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
    };
  }
  return {
    target_id: target.handle,
    ok: true,
    type: response.result.type,
    value: response.result.value,
    rendered: renderRemoteObject(response.result),
  };
}

/** Expand a scope (or any remote object) into readable properties. */
export async function inspectObject(
  ctx: OpsContext,
  args: DebuggerArgs & { object_id: string; own_properties?: boolean; max_properties?: number },
): Promise<Record<string, unknown>> {
  const { target } = await pageOf(ctx, args);
  const response = await target.session.send<{
    result: Array<{ name: string; value?: RemoteObject; writable?: boolean; get?: RemoteObject }>;
  }>('Runtime.getProperties', {
    objectId: args.object_id,
    ownProperties: args.own_properties !== false,
    generatePreview: true,
  });
  const max = Math.min(Math.max(args.max_properties ?? 100, 1), 500);
  const properties = response.result.slice(0, max).map((prop) => ({
    name: prop.name,
    type: prop.value?.type ?? (prop.get ? 'getter' : 'undefined'),
    value: prop.value?.value,
    rendered: prop.value ? renderRemoteObject(prop.value) : '(getter)',
    object_id: prop.value?.objectId ?? null,
  }));
  return {
    target_id: target.handle,
    object_id: args.object_id,
    property_count: response.result.length,
    truncated: response.result.length > max,
    properties,
  };
}

export async function waitForPause(
  ctx: OpsContext,
  args: DebuggerArgs & { timeout_ms?: number },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  requireEnabled(instance, target);
  const timeout = Math.min(args.timeout_ms ?? 30_000, 300_000);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const paused = instance.pausedAt.get(target.handle);
    if (paused) {
      return {
        target_id: target.handle,
        paused: true,
        reason: paused.reason,
        hit_breakpoints: paused.hitBreakpoints ?? [],
        top_frame: describeFrame(paused.callFrames[0]),
      };
    }
    await delay(50);
  }
  throw new TimeoutError(`wait for ${target.handle} to pause`, timeout);
}
