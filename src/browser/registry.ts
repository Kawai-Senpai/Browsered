import type { DaemonConfig } from '../config.js';
import type { Stores } from '../store/index.js';
import { NotFoundError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { discover, publish, withdraw, type BrowserRecord } from './discovery.js';
import { BrowserInstance } from './instance.js';
import type { LaunchOptions } from './launcher.js';

const log = createLogger('registry');

/**
 * Every browser the daemon owns or has attached to. One process, many
 * browsers, addressed by durable `browser_id` rather than by port.
 *
 * The map is per-process, but the *set of browsers* is not: launched browsers
 * advertise themselves on disk (see discovery.ts), so a new MCP session started
 * hours later finds the window you opened this morning and attaches to it
 * rather than spawning a second one.
 */
export class BrowserRegistry {
  private readonly browsers = new Map<string, BrowserInstance>();
  /** Serializes auto-launch so two concurrent tool calls cannot race a second window open. */
  private autoLaunchInFlight: Promise<BrowserInstance> | null = null;
  /** Serializes adoption so two concurrent tool calls cannot attach twice. */
  private adoptInFlight: Promise<BrowserInstance[]> | null = null;

  constructor(
    private readonly stores: Stores,
    private readonly config: DaemonConfig,
  ) {}

  async launch(options: LaunchOptions): Promise<BrowserInstance> {
    const instance = await BrowserInstance.launch(options, this.stores, this.config);
    this.register(instance);
    return instance;
  }

  async connect(input: {
    wsEndpoint: string;
    profile?: string;
    userDataDir?: string;
    pid?: number;
  }): Promise<BrowserInstance> {
    const existing = [...this.browsers.values()].find((b) => b.wsEndpoint === input.wsEndpoint);
    if (existing) return existing;
    const instance = await BrowserInstance.connect(input, this.stores, this.config);
    this.register(instance);
    return instance;
  }

  /**
   * Attach to every browser advertised on disk that this process does not
   * already hold.
   *
   * Called before any resolution, so a fresh MCP session sees the window you
   * opened with `browserd open` instead of an empty registry. Failures are
   * logged and skipped rather than thrown: one unreachable browser must not
   * stop the others from being usable.
   */
  async adoptDiscovered(): Promise<BrowserInstance[]> {
    if (this.adoptInFlight) return this.adoptInFlight;

    this.adoptInFlight = (async () => {
      const adopted: BrowserInstance[] = [];
      const held = new Set([...this.browsers.values()].map((b) => b.wsEndpoint));

      for (const record of discover()) {
        if (held.has(record.wsEndpoint)) continue;
        try {
          const instance = await BrowserInstance.connect(
            {
              wsEndpoint: record.wsEndpoint,
              profile: record.profile,
              userDataDir: record.userDataDir,
              pid: record.pid,
              browserId: record.browserId,
            },
            this.stores,
            this.config,
          );
          this.register(instance, { advertise: false });
          adopted.push(instance);
          log.info(`adopted ${instance.id} (profile=${record.profile}) from the discovery registry`);
        } catch (err) {
          log.warn(`could not adopt ${record.browserId} at ${record.wsEndpoint}`, err);
        }
      }
      return adopted;
    })().finally(() => {
      this.adoptInFlight = null;
    });

    return this.adoptInFlight;
  }

  private register(instance: BrowserInstance, options?: { advertise?: boolean }): void {
    this.browsers.set(instance.id, instance);

    /*
     * Only the process that owns a browser advertises it. An adopting process
     * re-publishing would race the owner's heartbeat and could resurrect a
     * record the owner just withdrew.
     */
    const advertise = options?.advertise !== false && instance.managed;
    if (advertise) {
      publish({
        browserId: instance.id,
        wsEndpoint: instance.wsEndpoint,
        profile: instance.profile,
        userDataDir: instance.userDataDir,
        pid: instance.pid ?? 0,
        ownerPid: process.pid,
        executable: instance.executable,
        extensions: instance.extensions,
        headless: false,
        startedAt: instance.launchedAt,
        heartbeatAt: Date.now(),
      });
    }

    instance.onClosed(() => {
      this.browsers.delete(instance.id);
      /*
       * Withdraw regardless of who advertised it. A browser closed through an
       * adopting process is just as gone as one closed by its owner, and
       * leaving the record behind would keep a dead endpoint in `browserd list`
       * until something else happened to reap it.
       */
      withdraw(instance.id);
      log.info(`removed ${instance.id}`);
    });
    log.info(`registered ${instance.id} (profile=${instance.profile}, managed=${instance.managed})`);
  }

  get(browserId: string): BrowserInstance {
    const instance = this.browsers.get(browserId);
    if (!instance) throw new NotFoundError('browser', browserId);
    return instance;
  }

  find(browserId: string): BrowserInstance | undefined {
    return this.browsers.get(browserId);
  }

  list(): BrowserInstance[] {
    return [...this.browsers.values()].filter((b) => b.status !== 'closed');
  }

  /**
   * Resolve the browser a tool call should act on.
   *
   * With no `browser_id`: use the only running browser, or launch one. This is
   * what lets an agent start working immediately without a human opening a
   * window first, and without having to call `browser.launch` explicitly.
   */
  async resolve(browserId?: string): Promise<BrowserInstance> {
    /*
     * Sweep the discovery registry first. A browser opened with `browserd open`
     * belongs to a different process, so without this the very first tool call
     * in a new MCP session would ignore it and launch a second window.
     */
    if (!this.browsers.has(browserId ?? '')) {
      await this.adoptDiscovered().catch((err) => {
        log.warn('discovery sweep failed', err);
        return [];
      });
    }

    if (browserId) return this.get(browserId);

    const running = this.list();
    if (running.length === 1) return running[0]!;
    if (running.length > 1) {
      // Ambiguous on purpose: silently picking one would make a multi-browser
      // debugging session act on the wrong window.
      throw new NotFoundError(
        'browser',
        `browser_id is required: ${running.length} browsers are running (${running
          .map((b) => `${b.id}=${b.profile}`)
          .join(', ')})`,
      );
    }

    if (!this.config.autoLaunch) {
      throw new NotFoundError(
        'browser',
        'no browser is running and autoLaunch is disabled; call browser.launch first',
      );
    }

    if (this.autoLaunchInFlight) return this.autoLaunchInFlight;
    log.info('no browser running; auto-launching one');
    this.autoLaunchInFlight = this.launch({
      profile: this.config.autoLaunchProfile,
      headless: this.config.autoLaunchHeadless,
    }).finally(() => {
      this.autoLaunchInFlight = null;
    });
    return this.autoLaunchInFlight;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.browsers.values()].map((b) => b.close()));
    this.browsers.clear();
  }
}
