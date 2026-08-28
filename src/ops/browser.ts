import { ROOT_SESSION } from '../cdp/connection.js';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { evaluate } from './element.js';
import type { ControlMode } from '../config.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';

/**
 * Clear the continuous recordings in one call, so a fresh window of console and
 * network starts now. Clearing them separately left `since:` filters doing this
 * job by hand.
 */
export async function resetRecording(
  ctx: OpsContext,
  args: { browser_id?: string; console?: boolean; network?: boolean },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  // Default is both; naming one narrows it to that one.
  const named = args.console !== undefined || args.network !== undefined;
  const doConsole = named ? args.console === true : true;
  const doNetwork = named ? args.network === true : true;

  const out: Record<string, unknown> = { browser_id: instance.id, reset_at: new Date().toISOString() };
  if (doConsole) {
    out.console_entries_deleted = ctx.stores.console.clear(instance.id);
  }
  if (doNetwork) {
    const before = ctx.stores.network.count({ browserId: instance.id });
    ctx.stores.network.deleteForBrowser(instance.id);
    out.requests_deleted = before;
  }
  return out;
}

export async function listInstances(
  ctx: OpsContext,
  args: { include_historical?: boolean; limit?: number } = {},
): Promise<Record<string, unknown>> {
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
  const historicalLimit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const allClosed = ctx.stores.targets.listBrowsers(true).filter((row) => !liveIds.has(row.browser_id));

  const withRecordings = allClosed
    .map((row) => ({
      browser_id: row.browser_id,
      profile: row.profile,
      status: 'closed' as const,
      live: false,
      // The last URL is what makes a past session recognisable.
      last_url: ctx.stores.targets.lastPageUrl(row.browser_id),
      launched_at: new Date(row.launched_at).toISOString(),
      recorded: {
        requests: ctx.stores.network.count({ browserId: row.browser_id }),
        console_entries: ctx.stores.console.countEntries({ browserId: row.browser_id }),
      },
    }))
    .filter((row) => row.recorded.requests > 0 || row.recorded.console_entries > 0);

  /*
   * Historical browsers are off by default. The first call of a session is
   * almost always "which browser is live so I can attach to it", and answering
   * it with ten closed sessions whose last_url is chrome://newtab buries the
   * one useful fact. The capability stays discoverable via historical_available.
   */
  const historical = args.include_historical === true ? withRecordings.slice(0, historicalLimit) : [];
  const hiddenHistorical = args.include_historical === true ? withRecordings.length - historical.length : 0;
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
    ...(args.include_historical === true || withRecordings.length === 0
      ? {}
      : {
          historical_available: withRecordings.length,
          historical_note: `${withRecordings.length} closed browser(s) still hold queryable recordings. Pass include_historical:true to list them.`,
        }),
    ...(historical.length
      ? {
          historical_note:
            'These browsers have closed. Their recorded network and console are still queryable by browser_id; live control is not.' +
            (hiddenHistorical > 0
              ? ` ${hiddenHistorical} older one(s) not shown; raise limit to see them, or pass include_historical:false to hide all.`
              : ''),
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

  /*
   * `navigated_to: args.url` echoed the request as though it were an outcome.
   * When launch-time navigation did not happen, an agent read that as
   * confirmation and moved on to a wait that timed out for an unrelated-looking
   * reason. Report what actually committed, or report that nothing did.
   */
  const landed = args.url ? await landedPage(ctx, instance) : null;

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
    ...(args.url
      ? landed
        ? { requested_url: args.url, landed }
        : {
            requested_url: args.url,
            landed: null,
            navigation_error:
              'No document committed for the requested URL at launch. The window is still blank. Call page.navigate to load it.',
          }
      : {}),
    ...(ctx.registry.list().length > 1
      ? {
          note:
            `${ctx.registry.list().length} browsers are now running, so browser_id is required on every subsequent call. ` +
            `Pass browser_id:"${instance.id}" to keep driving this one.`,
        }
      : {}),
  };
}

/**
 * The committed URL, title and HTTP status of a browser's active page.
 *
 * The title is the cheapest identity check available, and the one that catches
 * a dev-server port collision between sibling projects - seeing a title for a
 * different app is instant, where "HTTP 200 and it looks like a Vite app" is
 * not.
 */
async function landedPage(
  ctx: OpsContext,
  instance: BrowserInstance,
  target?: ManagedTarget,
): Promise<Record<string, unknown> | null> {
  let page = target;
  if (!page) {
    /*
     * Launch-time navigation is racy: the target can exist before its document
     * does. Give it a short window rather than declaring failure on a page that
     * was one tick away.
     */
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      page = instance.targets.listPages().find((t) => t.info.url && t.info.url !== 'about:blank');
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!page) return null;
  }
  if (!page.info.url || page.info.url === 'about:blank') return null;

  let url = page.info.url;
  let title: string | null = page.info.title ?? null;
  try {
    const { result } = await evaluate(instance, page, {
      expression: '[location.href, document.title, document.readyState]',
      returnByValue: true,
      awaitPromise: false,
    });
    const [href, docTitle, readyState] = (result.value ?? []) as [string?, string?, string?];
    if (href) url = href;
    if (docTitle !== undefined) title = docTitle;
    return { url, title, load_state: readyState ?? null, ...documentStatus(ctx, instance.id, page.handle, url) };
  } catch {
    return { url, title, load_state: null, ...documentStatus(ctx, instance.id, page.handle, url) };
  }
}

/** HTTP status of the main-frame document request, from the recorder. */
function documentStatus(
  ctx: OpsContext,
  browserId: string,
  targetHandle: string,
  url: string,
): Record<string, unknown> {
  try {
    const rows = ctx.stores.network.list({
      browserId,
      targetHandle,
      resourceType: 'Document',
      limit: 10,
      order: 'desc',
    });
    const match = rows.find((row) => row.url === url) ?? rows[0];
    return match?.status === null || match?.status === undefined ? {} : { http_status: match.status };
  } catch {
    return {};
  }
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
  let activeHandle: string | null = null;
  try {
    activeHandle = instance.resolvePage().handle;
  } catch {
    /* No page open; every entry is simply reported as inactive. */
  }
  const byType: Record<string, number> = {};
  for (const target of targets) byType[target.type] = (byType[target.type] ?? 0) + 1;

  return {
    browser_id: instance.id,
    profile: instance.profile,
    status: instance.status,
    control_mode: instance.controlMode,
    managed: instance.managed,
    headless: instance.headless,
    pid: instance.pid,
    executable: instance.executable,
    ws_endpoint: instance.wsEndpoint,
    user_data_dir: instance.userDataDir,
    version: instance.version,
    extensions: instance.extensions,
    netlog_path: instance.netLogPath,
    uptime_ms: Date.now() - instance.launchedAt,
    targets_by_type: byType,
    /*
     * A count of page targets does not answer "what is on screen right now",
     * which is the question that made a blank window survive a whole session
     * undetected. List them with their URL and title.
     */
    pages: await Promise.all(
      instance.targets.listPages().map(async (page) => ({
        target_id: page.handle,
        active: page.handle === activeHandle,
        url: page.info.url,
        title: page.info.title,
        ...((await landedPage(ctx, instance, page)) ?? {}),
      })),
    ),
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

/**
 * Hand a headless session to the human.
 *
 * Chromium decides headless at process start (`--headless=new`), so there is no
 * runtime switch: the only way to produce a window is to relaunch. The profile
 * directory is what carries the session across, which means cookies, localStorage
 * and logins survive but the live page does not. That distinction is reported
 * rather than glossed over, because "your login is still there" and "the DOM you
 * were looking at is still there" are different promises and only the first holds.
 */
export async function reveal(
  ctx: OpsContext,
  args: {
    browser_id?: string;
    url?: string;
    control_mode?: 'observe' | 'shared' | 'agent' | 'paused';
    window_size?: { width: number; height: number };
  },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);

  if (!instance.managed) {
    throw new AgentBrowserError(
      'not_managed',
      'This browser was started elsewhere and is only attached to, so the daemon cannot relaunch it. ' +
        'Reveal it from wherever it was launched.',
    );
  }

  // Carry the open tabs over. Internal pages would come back as dead tabs in the
  // new window, so only real navigable URLs are restored.
  const openUrls = instance.targets
    .listPages()
    .map((p) => p.info.url)
    .filter((u) => typeof u === 'string' && /^https?:/i.test(u));
  const urls = args.url ? [args.url] : openUrls;

  const wasHeadless = instance.headless;
  const profile = instance.profile;
  const extensions = instance.extensions;

  // headless === false means a window is already on screen; relaunching would
  // throw away the live page for nothing. null (attached) never reaches here.
  if (wasHeadless === false) {
    if (args.control_mode) instance.setControlMode(args.control_mode);
    return {
      browser_id: instance.id,
      revealed: false,
      already_headed: true,
      profile,
      control_mode: instance.controlMode,
      tabs: instance.targets.listPages().length,
      note: 'This browser already has a window; nothing was relaunched.',
    };
  }

  await instance.close();

  /*
   * close() resolves once the kill has been *signalled*, not once Chromium has
   * finished unwinding, and the profile's SingletonLock outlives the signal by a
   * short and load-dependent margin. Relaunching straight away therefore fails
   * intermittently with "another browser is already using this profile" - the
   * kind of race that passes in isolation and breaks under a full test run. Retry
   * briefly rather than surfacing a collision with the process we just killed.
   */
  const launchOptions = {
    profile,
    headless: false,
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(args.window_size ? { windowSize: args.window_size } : {}),
    ...(urls.length > 0 ? { urls } : {}),
  };

  let relaunched;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      relaunched = await ctx.registry.launch(launchOptions);
      break;
    } catch (err) {
      lastError = err;
      // Only the profile-lock collision is transient; anything else is a real
      // failure and retrying it would just delay the report.
      if (!/already using this profile/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!relaunched) {
    throw new AgentBrowserError(
      'reveal_failed',
      `The headless browser was closed, but the headed relaunch could not take the profile: ` +
        `${(lastError as Error)?.message ?? 'unknown error'}. ` +
        `Launch it yourself with browser.launch{profile:"${profile}"}.`,
    );
  }

  if (args.control_mode) relaunched.setControlMode(args.control_mode);

  const landed = urls.length > 0 ? await landedPage(ctx, relaunched) : null;

  return {
    browser_id: relaunched.id,
    previous_browser_id: instance.id,
    revealed: true,
    profile,
    control_mode: relaunched.controlMode,
    pid: relaunched.pid,
    user_data_dir: relaunched.userDataDir,
    tabs: relaunched.targets.listPages().length,
    restored_urls: urls,
    ...(landed ? { landed } : {}),
    carried_over: 'cookies, localStorage, sessionStorage and logins (everything held in the profile)',
    lost: 'live page state: unsaved form input, in-memory JS state, and any DOM the agent modified',
    note:
      `The browser was relaunched as a new instance, so use browser_id:"${relaunched.id}" from now on. ` +
      'Recordings from the headless session stay queryable under the previous id.',
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
