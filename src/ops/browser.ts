import { ROOT_SESSION } from '../cdp/connection.js';
import type { ControlMode } from '../config.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';

export async function listInstances(ctx: OpsContext): Promise<Record<string, unknown>> {
  /*
   * Sweep the discovery registry before answering. This is usually the first
   * tool an agent calls, and reporting "no browsers" while a window the human
   * opened is sitting there recording would be the worst possible first
   * impression - and would push the agent into launching a second one.
   */
  await ctx.registry.adoptDiscovered().catch(() => []);
  const running = ctx.registry.list();
  const liveIds = new Set(running.map((b) => b.id));

  /*
   * Browsers that have closed but still hold recorded history. Their network,
   * console and artifacts remain queryable; only live control is gone. Hiding
   * them would make yesterday's recording look lost when it is on disk.
   */
  const historical = ctx.stores.targets
    .listBrowsers(true)
    .filter((row) => !liveIds.has(row.browser_id))
    .slice(0, 25)
    .map((row) => ({
      browser_id: row.browser_id,
      profile: row.profile,
      status: 'closed' as const,
      live: false,
      launched_at: new Date(row.launched_at).toISOString(),
      recorded: {
        requests: ctx.stores.network.count({ browserId: row.browser_id }),
        console_entries: ctx.stores.console.countEntries({ browserId: row.browser_id }),
      },
    }))
    .filter((row) => row.recorded.requests > 0 || row.recorded.console_entries > 0);
  return {
    count: running.length,
    auto_launch: ctx.config.autoLaunch,
    browsers: running.map((instance) => ({
      browser_id: instance.id,
      profile: instance.profile,
      status: instance.status,
      control_mode: instance.controlMode,
      managed: instance.managed,
      pid: instance.pid,
      product: instance.version?.product ?? null,
      user_data_dir: instance.userDataDir,
      extensions: instance.extensions,
      tabs: instance.targets.listPages().length,
      targets: instance.targets.list().length,
      launched_at: new Date(instance.launchedAt).toISOString(),
    })),
    historical: historical.length ? historical : undefined,
    ...(historical.length
      ? {
          historical_note:
            'These browsers have closed. Their recorded network and console are still queryable by browser_id; live control is not.',
        }
      : {}),
    ...(running.length === 0
      ? {
          hint: ctx.config.autoLaunch
            ? 'None running. Any tool call will auto-launch one, or call browser.launch explicitly.'
            : 'None running and autoLaunch is off. Call browser.launch.',
        }
      : {}),
  };
}

export async function launch(
  ctx: OpsContext,
  args: {
    profile?: string;
    headless?: boolean;
    url?: string;
    extensions?: string[];
    chromium_path?: string;
    capture_netlog?: boolean;
    window_size?: { width: number; height: number };
    extra_args?: string[];
  },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.launch({
    profile: args.profile ?? ctx.config.autoLaunchProfile,
    headless: args.headless ?? ctx.config.autoLaunchHeadless,
    ...(args.extensions ? { extensions: args.extensions } : {}),
    ...(args.chromium_path ? { chromiumPath: args.chromium_path } : {}),
    ...(args.capture_netlog ? { netLog: true } : {}),
    ...(args.window_size ? { windowSize: args.window_size } : {}),
    ...(args.extra_args ? { args: args.extra_args } : {}),
    ...(args.url ? { urls: [args.url] } : {}),
  });

  return {
    browser_id: instance.id,
    profile: instance.profile,
    status: instance.status,
    control_mode: instance.controlMode,
    pid: instance.pid,
    executable: instance.executable,
    product: instance.version?.product ?? null,
    user_data_dir: instance.userDataDir,
    extensions_loaded: instance.extensions,
    netlog_path: instance.netLogPath,
    tabs: instance.targets.listPages().length,
    ...(args.url ? { navigated_to: args.url } : {}),
  };
}

/** Attach to a Chromium someone else started. Never killed by the daemon. */
export async function connect(
  ctx: OpsContext,
  args: { ws_endpoint: string; profile?: string; pid?: number },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.connect({
    wsEndpoint: args.ws_endpoint,
    ...(args.profile ? { profile: args.profile } : {}),
    ...(args.pid === undefined ? {} : { pid: args.pid }),
  });
  return {
    browser_id: instance.id,
    profile: instance.profile,
    managed: false,
    product: instance.version?.product ?? null,
    tabs: instance.targets.listPages().length,
    note: 'This browser was not launched by the daemon, so browser.close will detach rather than kill it.',
  };
}

export async function status(
  ctx: OpsContext,
  args: { browser_id?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const targets = instance.targets.list();
  const byType: Record<string, number> = {};
  for (const target of targets) byType[target.type] = (byType[target.type] ?? 0) + 1;

  return {
    browser_id: instance.id,
    profile: instance.profile,
    status: instance.status,
    control_mode: instance.controlMode,
    managed: instance.managed,
    pid: instance.pid,
    executable: instance.executable,
    ws_endpoint: instance.wsEndpoint,
    user_data_dir: instance.userDataDir,
    version: instance.version,
    extensions: instance.extensions,
    netlog_path: instance.netLogPath,
    uptime_ms: Date.now() - instance.launchedAt,
    targets_by_type: byType,
    recording: {
      requests: ctx.stores.network.count({ browserId: instance.id }),
      console_entries: ctx.stores.console.countEntries({ browserId: instance.id }),
      websockets: ctx.stores.websockets.list({ browserId: instance.id, limit: 500 }).length,
    },
    active_overrides: Object.fromEntries(instance.emulation),
    fault_rules: instance.faults.size,
    debugger_enabled_on: [...instance.debuggerEnabled],
    profiling: instance.profileSession !== null,
  };
}

export async function listTargets(
  ctx: OpsContext,
  args: { browser_id?: string; type?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const targets = instance.targets.list().filter((t) => !args.type || t.type === args.type);
  return {
    browser_id: instance.id,
    count: targets.length,
    targets: targets.map((target) => ({
      target_id: target.handle,
      type: target.type,
      url: target.info.url,
      title: target.info.title,
      cdp_target_id: target.info.targetId,
      parent: target.parentHandle ?? null,
    })),
    hint: 'Workers, service workers and out-of-process iframes are all here; page tools take any of these ids.',
  };
}

/**
 * Arbitrate human and AI control. `observe` is read-only, `paused` freezes the
 * agent entirely, `shared` and `agent` permit mutation.
 */
export async function setControlMode(
  ctx: OpsContext,
  args: { browser_id?: string; mode: ControlMode },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const valid: ControlMode[] = ['observe', 'shared', 'agent', 'paused'];
  if (!valid.includes(args.mode)) {
    throw new AgentBrowserError('bad_mode', `Unknown control mode "${args.mode}". Use one of: ${valid.join(', ')}.`);
  }
  const previous = instance.controlMode;
  instance.setControlMode(args.mode);
  return {
    browser_id: instance.id,
    previous_mode: previous,
    control_mode: args.mode,
    can_mutate: args.mode === 'agent' || args.mode === 'shared',
    meaning: {
      observe: 'Read everything, change nothing.',
      shared: 'Human and agent both drive the browser.',
      agent: 'Agent owns input.',
      paused: 'Agent is frozen; reads still work.',
    }[args.mode],
  };
}

export async function close(
  ctx: OpsContext,
  args: { browser_id?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const managed = instance.managed;
  await instance.close();
  return {
    browser_id: instance.id,
    closed: true,
    note: managed ? 'Chromium was shut down.' : 'Detached from an externally launched browser; it is still running.',
  };
}

/**
 * The escape hatch. Any CDP method, on the browser session or a target session,
 * for capabilities the typed tools do not cover yet.
 */
export async function cdpSend(
  ctx: OpsContext,
  args: {
    browser_id?: string;
    target_id?: string;
    method: string;
    params?: Record<string, unknown>;
    timeout_ms?: number;
  },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  // Raw CDP can do anything a mutating tool can, so it takes the same gate.
  instance.requireControl(`cdp.send(${args.method})`);

  const session = args.target_id ? instance.resolveTarget(args.target_id).session : instance.browserSession;
  const result = await session.send<Record<string, unknown>>(
    args.method,
    args.params ?? {},
    args.timeout_ms ?? 30_000,
  );

  const serialized = JSON.stringify(result);
  if (serialized.length > 100_000) {
    const artifact = ctx.stores.artifacts.put('other', Buffer.from(serialized, 'utf8'), {
      browserId: instance.id,
      label: args.method.replace('.', '-'),
      mime: 'application/json',
    });
    return {
      browser_id: instance.id,
      session: args.target_id ?? ROOT_SESSION,
      method: args.method,
      result_size: serialized.length,
      truncated: true,
      artifact: { artifact_id: artifact.artifact_handle, size: artifact.size },
      hint: 'Result was too large to inline. Query it with artifact.json_query.',
    };
  }

  return {
    browser_id: instance.id,
    session: args.target_id ?? ROOT_SESSION,
    method: args.method,
    result,
  };
}
