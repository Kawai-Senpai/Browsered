import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { CdpConnection, ROOT_SESSION } from '../cdp/connection.js';
import { CdpSession } from '../cdp/session.js';
import type { DebuggerPausedEvent, ScriptParsedEvent, TargetInfo } from '../cdp/types.js';
import { controlAllowsMutation, type ControlMode, type DaemonConfig } from '../config.js';
import { ConsoleCollector } from '../collect/console.js';
import { ContextTracker } from '../collect/contexts.js';
import { NetworkCollector } from '../collect/network.js';
import { PageCollector } from '../collect/page.js';
import type { Stores } from '../store/index.js';
import { ControlDeniedError, NotFoundError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import { createLogger, type Logger } from '../util/logger.js';
import { paths } from '../util/paths.js';
import type { FaultRule } from './faults.js';
import {
  killBrowserProcess,
  launchBrowser,
  mediaPermissions,
  type LaunchOptions,
  type MediaOptions,
} from './launcher.js';
import { TargetManager, type ManagedTarget } from './target-manager.js';

export type BrowserStatus = 'starting' | 'ready' | 'closing' | 'closed';

export interface BrowserVersion {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
  jsVersion: string;
}

export interface BrowserInstanceInit {
  browserId: string;
  profile: string;
  userDataDir: string;
  wsEndpoint: string;
  executable: string | null;
  pid: number | null;
  process: ChildProcess | null;
  /** False for browsers the daemon merely attached to; those are never killed. */
  managed: boolean;
  /** null for attached browsers: the daemon did not launch them, so it cannot know. */
  headless: boolean | null;
  extensions: string[];
  netLogPath: string | null;
  /** Media capture this browser was launched with. null when none, or when attached. */
  media: MediaOptions | null;
  stores: Stores;
  config: DaemonConfig;
}

/**
 * One Chromium: its CDP connection, its target graph, its recorders, and the
 * control-mode gate that decides whether an agent may touch it.
 */
export class BrowserInstance {
  readonly id: string;
  readonly profile: string;
  readonly userDataDir: string;
  readonly wsEndpoint: string;
  readonly executable: string | null;
  readonly pid: number | null;
  readonly managed: boolean;
  /** Whether this Chromium was launched without a window. null when unknown. */
  readonly headless: boolean | null;
  readonly extensions: string[];
  readonly netLogPath: string | null;
  /** Launch-time media capture switches, fixed for the life of the process. */
  readonly media: MediaOptions | null;
  /** CDP permissions actually granted for media at launch. */
  mediaPermissionsGranted: string[] = [];
  readonly launchedAt = Date.now();

  readonly connection: CdpConnection;
  readonly targets: TargetManager;
  readonly network: NetworkCollector;
  readonly console: ConsoleCollector;
  readonly pages: PageCollector;
  readonly contexts: ContextTracker;
  /** Browser-level session: Target/Browser/Storage domains live here. */
  readonly browserSession: CdpSession;
  /** Snapshot ref -> backendNodeId, per target. Rebuilt on each page.snapshot. */
  readonly snapshotRefs = new Map<string, Map<string, number>>();

  private readonly stores: Stores;
  private readonly config: DaemonConfig;
  private readonly process: ChildProcess | null;
  private readonly log: Logger;
  private readonly closeListeners = new Set<(reason: string) => void>();

  private statusValue: BrowserStatus = 'starting';
  private controlModeValue: ControlMode;
  private versionInfo: BrowserVersion | null = null;
  /** Targets with Debugger.enable applied, keyed by target handle. */
  readonly debuggerEnabled = new Set<string>();
  /** targetHandle -> scriptId -> script metadata, from Debugger.scriptParsed. */
  readonly parsedScripts = new Map<string, Map<string, ScriptParsedEvent>>();
  /** Current pause state per target, so debugger.* calls can report call frames. */
  readonly pausedAt = new Map<string, DebuggerPausedEvent>();
  /** breakpointId -> where it was set, so it can be listed and removed. */
  readonly breakpoints = new Map<
    string,
    { targetHandle: string; url?: string; lineNumber: number; condition?: string }
  >();
  /** Targets carrying the fake-timer shim, so two clocks are never stacked. */
  readonly clockShimTargets = new Set<string>();
  /** Environment overrides currently applied, for status and reset. */
  readonly emulation = new Map<string, unknown>();
  /** Targets under touch emulation: input tools must send touch, not mouse. */
  readonly touchTargets = new Set<string>();
  /** Active fault-injection rules, keyed by daemon-minted rule id. */
  readonly faults = new Map<string, FaultRule>();
  /** True once Fetch.enable is on and the fault router is wired. */
  faultRouterArmed = false;
  /** Last element the human picked with the DevTools picker, per target. */
  readonly pickedNodes = new Map<string, { backendNodeId: number; at: number }>();
  /** Targets whose Overlay.inspectNodeRequested listener is already wired. */
  readonly pickListeners = new Set<string>();
  /** targetHandle -> when Profiler.start was issued. */
  readonly cpuProfiling = new Map<string, number>();
  /** Browser-wide trace in progress, if any. */
  tracing: { startedAt: number; preset: string; categories: string[] } | null = null;
  /** Preset-driven profile session spanning several recorders. */
  profileSession: {
    id: string;
    preset: string;
    startedAt: number;
    targetHandle: string;
    cpu: boolean;
    trace: boolean;
    heap: boolean;
    beforeArtifacts: string[];
  } | null = null;
  lastHeartbeat = Date.now();

  private constructor(init: BrowserInstanceInit) {
    this.id = init.browserId;
    this.profile = init.profile;
    this.userDataDir = init.userDataDir;
    this.wsEndpoint = init.wsEndpoint;
    this.executable = init.executable;
    this.headless = init.headless;
    this.pid = init.pid;
    this.managed = init.managed;
    this.extensions = init.extensions;
    this.netLogPath = init.netLogPath;
    this.media = init.media;
    this.stores = init.stores;
    this.config = init.config;
    this.process = init.process;
    this.controlModeValue = init.config.defaultControlMode;

    this.log = createLogger(`browser:${this.id}`);
    this.connection = new CdpConnection(init.wsEndpoint, this.log);
    this.browserSession = new CdpSession(this.connection, ROOT_SESSION, 'browser');

    this.network = new NetworkCollector(this.id, this.stores, this.config.recorder, this.log);
    this.console = new ConsoleCollector(this.id, this.stores, this.config.recorder, this.log);
    this.pages = new PageCollector(this.id, this.stores, this.log);
    this.contexts = new ContextTracker(this.log);

    this.targets = new TargetManager(this.connection, this.log, (info, sessionId, parent) =>
      this.stores.targets.upsertTarget({
        browserId: this.id,
        cdpTargetId: info.targetId,
        sessionId,
        type: info.type,
        subtype: info.subtype ?? null,
        url: info.url,
        title: info.title,
        openerTarget: info.openerId ?? null,
        browserContext: info.browserContextId ?? null,
        parentHandle: parent,
        attachedAt: Date.now(),
      }),
    );
  }

  static async launch(
    options: LaunchOptions,
    stores: Stores,
    config: DaemonConfig,
  ): Promise<BrowserInstance> {
    // A launch that names its own media replaces the configured default whole,
    // so media:{} is how one launch opts out of a default.
    const media = options.media ?? config.media ?? undefined;
    const launched = await launchBrowser({
      ...options,
      chromiumPath: options.chromiumPath ?? config.chromiumPath,
      ...(media ? { media } : {}),
    });
    const instance = new BrowserInstance({
      browserId: mintId('br'),
      profile: options.profile,
      userDataDir: launched.userDataDir,
      wsEndpoint: launched.wsEndpoint,
      executable: launched.executable,
      pid: launched.pid,
      process: launched.process,
      managed: true,
      headless: options.headless === true,
      extensions: launched.extensionsLoaded,
      netLogPath: launched.netLogPath,
      media: media ?? null,
      stores,
      config,
    });
    launched.process.once('exit', (code, signal) => {
      instance.handleGone(`chromium exited (code=${code} signal=${signal})`);
    });
    await instance.start();
    await instance.grantMediaPermissions();
    return instance;
  }

  /** Attach to a Chromium someone else launched. Never killed by the daemon. */
  static async connect(
    input: {
      wsEndpoint: string;
      profile?: string;
      userDataDir?: string;
      pid?: number;
      /**
       * Reuse an existing handle when adopting a browser from the discovery
       * registry. Minting a fresh one would give the same window a different
       * browser_id in every session, breaking any id an agent wrote down.
       */
      browserId?: string;
    },
    stores: Stores,
    config: DaemonConfig,
  ): Promise<BrowserInstance> {
    const instance = new BrowserInstance({
      browserId: input.browserId ?? mintId('br'),
      profile: input.profile ?? 'external',
      userDataDir: input.userDataDir ?? '',
      wsEndpoint: input.wsEndpoint,
      executable: null,
      pid: input.pid ?? null,
      process: null,
      managed: false,
      headless: null,
      extensions: [],
      netLogPath: null,
      media: null,
      stores,
      config,
    });
    await instance.start();
    return instance;
  }

  /**
   * Send downloads to browserd's own capsules directory.
   *
   * The bundled capture panel exports through chrome.downloads, so without this
   * a capsule lands in the human's Downloads folder where no agent thinks to
   * look. Browser.setDownloadBehavior is browser-wide and survives navigation,
   * unlike the deprecated Page-level call.
   *
   * Best-effort: a browser we merely connected to may be driven by someone else
   * who chose their own download directory, and losing the whole session over a
   * convenience path would be a bad trade.
   */
  private async routeCapsuleDownloads(): Promise<void> {
    const downloadPath = paths.capsules();
    try {
      mkdirSync(downloadPath, { recursive: true });
      await this.browserSession.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath,
        eventsEnabled: false,
      });
      this.log.debug(`capsule downloads routed to ${downloadPath}`);
    } catch (err) {
      this.log.debug('Browser.setDownloadBehavior failed; downloads use the browser default', err);
    }
  }

  /**
   * Grant camera and microphone over CDP for a media launch.
   *
   * The launch switch answers the prompt; the grant is what makes
   * navigator.permissions.query report "granted" instead of "prompt", which a
   * page may check before it ever calls getUserMedia. Best-effort, like the
   * download routing above: the switch alone still gets past the prompt, and
   * losing a running browser over the grant would be the worse outcome.
   */
  private async grantMediaPermissions(): Promise<void> {
    const permissions = mediaPermissions(this.media ?? undefined);
    if (!permissions.length) return;
    try {
      await this.browserSession.send('Browser.grantPermissions', {
        permissions,
        ...(this.media?.origin ? { origin: this.media.origin } : {}),
      });
      this.mediaPermissionsGranted = permissions;
    } catch (err) {
      this.log.warn('Browser.grantPermissions for media failed; the launch switch still answers the prompt', err);
    }
  }

  private async start(): Promise<void> {
    await this.connection.connect();
    this.connection.setDisconnectHandler((reason) => this.handleGone(reason));

    try {
      this.versionInfo = await this.browserSession.send<BrowserVersion>('Browser.getVersion');
    } catch (err) {
      this.log.debug('Browser.getVersion failed', err);
    }

    // Recorders must be wired before auto-attach arms, so the very first target
    // is instrumented while it is still held at waitForDebuggerOnStart.
    this.targets.onAttached(async (target) => {
      // Context tracking is wired first: Runtime.enable inside the console
      // collector is what makes Chromium replay existing contexts.
      this.contexts.attach(target);
      await this.network.attach(target);
      await this.console.attach(target);
      await this.pages.attach(target);
    });
    this.targets.onDetached((target) => {
      this.network.detach(target);
      this.pages.detach(target);
      this.contexts.detach(target);
      this.snapshotRefs.delete(target.handle);
      this.debuggerEnabled.delete(target.handle);
      this.parsedScripts.delete(target.handle);
      this.pausedAt.delete(target.handle);
      this.stores.targets.markDetached(target.handle, Date.now());
    });
    this.targets.onTargetInfoChanged((target) => {
      this.stores.targets.patchTarget(target.handle, {
        url: target.info.url,
        title: target.info.title,
      });
    });

    await this.routeCapsuleDownloads();

    await this.targets.start();
    await this.waitForFirstPage();
    // waitForFirstPage can return on a target whose attach listeners are still
    // running (a page created while start() was draining). Drain again so the
    // recorders are provably live before any tool can navigate.
    await this.targets.settled();

    this.statusValue = 'ready';
    this.stores.targets.upsertBrowser({
      browserId: this.id,
      profile: this.profile,
      userDataDir: this.userDataDir,
      executable: this.executable,
      pid: this.pid,
      cdpUrl: this.wsEndpoint,
      status: this.statusValue,
      controlMode: this.controlModeValue,
      managed: this.managed,
      extensions: this.extensions,
      netlogPath: this.netLogPath,
      launchedAt: this.launchedAt,
    });
    this.log.info(`ready (${this.targets.list().length} targets attached)`);
  }

  /**
   * Hold startup until the browser's first tab has attached.
   *
   * `Target.setAutoAttach` reports existing targets asynchronously, so a launch
   * can finish while the initial about:blank page is still in flight. Returning
   * then makes the very first `resolveTarget()` throw "no page targets
   * attached", and because the caller usually navigates immediately, every
   * later tool call in that session fails too. Waiting here costs a few
   * milliseconds and removes the race entirely.
   */
  private async waitForFirstPage(timeoutMs = 5_000): Promise<void> {
    if (this.targets.listPages().length > 0) return this.targets.settled();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.targets.listPages().length > 0) return this.targets.settled();
    }
    // Not fatal: a browser can legitimately have no page yet (all tabs closed,
    // or a worker-only target set). Tools will auto-open one when they need it.
    this.log.warn('no page target attached within startup window');
  }

  get status(): BrowserStatus {
    return this.statusValue;
  }

  get controlMode(): ControlMode {
    return this.controlModeValue;
  }

  get version(): BrowserVersion | null {
    return this.versionInfo;
  }

  setControlMode(mode: ControlMode): void {
    this.controlModeValue = mode;
    this.stores.targets.patchBrowser(this.id, { control_mode: mode });
    this.log.info(`control mode -> ${mode}`);
  }

  /**
   * Gate for anything that changes browser state. Reading is always allowed;
   * clicking, typing, navigating and evaluating are not, unless the human has
   * put the browser into `shared` or `agent`.
   */
  requireControl(operation: string): void {
    if (!controlAllowsMutation(this.controlModeValue)) {
      throw new ControlDeniedError(this.controlModeValue, operation);
    }
  }

  /** Resolve a target handle, or the active page when none is given. */
  resolveTarget(targetHandle?: string): ManagedTarget {
    if (targetHandle) {
      const found = this.targets.get(targetHandle);
      if (!found) throw new NotFoundError('target', targetHandle);
      return found;
    }
    const pages = this.targets.listPages();
    const first = pages[0];
    if (!first) {
      throw new NotFoundError(
        'target',
        `${this.id} (no page targets attached; every tab may have been closed - call page.new_tab)`,
      );
    }
    return first;
  }

  /**
   * Resolve a page, opening one if the browser has none. Used by tools that
   * can sensibly create their own tab (navigate, screenshot) rather than
   * failing because the human closed the last window.
   */
  async resolvePageOrOpen(targetHandle?: string): Promise<ManagedTarget> {
    if (targetHandle) return this.resolvePage(targetHandle);
    if (this.targets.listPages().length > 0) return this.resolvePage();

    await this.browserSession.send('Target.createTarget', { url: 'about:blank' });
    await this.waitForFirstPage(5_000);
    return this.resolvePage();
  }

  resolvePage(targetHandle?: string): ManagedTarget {
    const target = this.resolveTarget(targetHandle);
    if (target.type !== 'page' && target.type !== 'iframe' && target.type !== 'webview') {
      throw new NotFoundError('page target', targetHandle ?? target.handle);
    }
    return target;
  }

  onClosed(listener: (reason: string) => void): void {
    this.closeListeners.add(listener);
  }

  private handleGone(reason: string): void {
    if (this.statusValue === 'closed') return;
    this.statusValue = 'closed';
    this.log.info(`gone: ${reason}`);
    for (const target of this.targets.list()) {
      this.stores.targets.markDetached(target.handle, Date.now());
    }
    this.targets.dispose();
    this.stores.targets.patchBrowser(this.id, { status: 'closed', closed_at: Date.now() });
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch (err) {
        this.log.warn('close listener failed', err);
      }
    }
  }

  async close(): Promise<void> {
    if (this.statusValue === 'closed' || this.statusValue === 'closing') return;
    this.statusValue = 'closing';
    this.stores.targets.patchBrowser(this.id, { status: 'closing' });

    if (this.managed) {
      try {
        // Graceful: lets Chromium flush the profile, cookies and any NetLog.
        await this.browserSession.send('Browser.close', {}, 5_000);
      } catch (err) {
        this.log.debug('Browser.close failed, killing instead', err);
      }
    }
    this.connection.close();

    if (this.managed && this.process && this.pid !== null) {
      await killBrowserProcess(this.process, this.pid);
    }
    this.handleGone('closed by request');
  }
}
