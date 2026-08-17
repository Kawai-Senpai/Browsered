import type { DaemonConfig } from '../config.js';
import type { Stores } from '../store/index.js';
import { NotFoundError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { BrowserInstance } from './instance.js';
import type { LaunchOptions } from './launcher.js';

const log = createLogger('registry');

/**
 * Every browser the daemon owns or has attached to. One process, many
 * browsers, addressed by durable `browser_id` rather than by port.
 */
export class BrowserRegistry {
  private readonly browsers = new Map<string, BrowserInstance>();
  /** Serializes auto-launch so two concurrent tool calls cannot race a second window open. */
  private autoLaunchInFlight: Promise<BrowserInstance> | null = null;

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

  private register(instance: BrowserInstance): void {
    this.browsers.set(instance.id, instance);
    instance.onClosed(() => {
      this.browsers.delete(instance.id);
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
