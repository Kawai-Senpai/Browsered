import { CdpConnection, ROOT_SESSION } from '../cdp/connection.js';
import { CdpSession } from '../cdp/session.js';
import type { AttachedToTargetEvent, DetachedFromTargetEvent, TargetInfo } from '../cdp/types.js';
import type { Logger } from '../util/logger.js';

/** Target types worth instrumenting. `browser` is the root and never attached this way. */
const ATTACHABLE_TYPES = new Set([
  'page',
  'iframe',
  'webview',
  'worker',
  'shared_worker',
  'service_worker',
  'worklet',
  'shared_storage_worklet',
  'background_page',
  'other',
]);

/** Types that own a DOM and respond to the Page domain. */
export const PAGE_LIKE_TYPES = new Set(['page', 'iframe', 'webview', 'background_page']);

export interface ManagedTarget {
  /** Durable handle minted by the daemon. */
  handle: string;
  cdpTargetId: string;
  session: CdpSession;
  info: TargetInfo;
  type: string;
  parentHandle: string | null;
  attachedAt: number;
}

export type AttachListener = (target: ManagedTarget) => void | Promise<void>;
export type DetachListener = (target: ManagedTarget) => void;
export type InfoListener = (target: ManagedTarget) => void;

/**
 * Discovers and attaches to every target in a browser: pages, out-of-process
 * iframes, dedicated/shared/service workers, extension contexts.
 *
 * New targets start held at `waitForDebuggerOnStart`, so listeners get to turn
 * on Network/Runtime/Log before the target executes a single line. That hold is
 * what makes "we did not miss the request" true rather than probable.
 */
export class TargetManager {
  private readonly bySession = new Map<string, ManagedTarget>();
  private readonly byCdpTargetId = new Map<string, ManagedTarget>();
  private readonly byHandle = new Map<string, ManagedTarget>();
  private readonly attachListeners = new Set<AttachListener>();
  private readonly detachListeners = new Set<DetachListener>();
  private readonly infoListeners = new Set<InfoListener>();
  /**
   * Attachments still running their instrumentation listeners.
   *
   * `Target.attachedToTarget` is an event, so handling it cannot block the
   * connection's read loop; the work is started with `void`. Anything that
   * needs a target to be *usable* (rather than merely known) must await these,
   * or it will act on a target whose Network/Runtime/Log domains are not on
   * yet and silently lose the first navigation.
   */
  private readonly pendingAttachments = new Set<Promise<void>>();
  private started = false;

  constructor(
    private readonly connection: CdpConnection,
    private readonly log: Logger,
    /** Mints (or looks up) the durable handle for a CDP target. */
    private readonly resolveHandle: (info: TargetInfo, sessionId: string, parent: string | null) => string,
  ) {}

  onAttached(listener: AttachListener): void {
    this.attachListeners.add(listener);
  }

  onDetached(listener: DetachListener): void {
    this.detachListeners.add(listener);
  }

  onTargetInfoChanged(listener: InfoListener): void {
    this.infoListeners.add(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.connection.onAnySession('Target.attachedToTarget', (params, sessionId) => {
      this.track(this.handleAttached(params as unknown as AttachedToTargetEvent, sessionId));
    });
    this.connection.onAnySession('Target.detachedFromTarget', (params) => {
      this.handleDetached(params as unknown as DetachedFromTargetEvent);
    });
    this.connection.onAnySession('Target.targetInfoChanged', (params) => {
      this.handleInfoChanged((params as { targetInfo: TargetInfo }).targetInfo);
    });
    this.connection.onAnySession('Target.targetDestroyed', (params) => {
      const targetId = (params as { targetId: string }).targetId;
      const target = this.byCdpTargetId.get(targetId);
      if (target) this.handleDetached({ sessionId: target.session.sessionId, targetId });
    });

    // Discovery gives visibility into targets we never attach to (the browser
    // target itself, crashed tabs) and keeps titles/urls current.
    await this.connection.send('Target.setDiscoverTargets', { discover: true });

    // Browser-level auto-attach covers pages and service workers. Each page
    // session then auto-attaches its own iframes and workers, recursively.
    await this.connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    await this.attachExistingTargets();
    // Do not report started until every attached target is instrumented.
    await this.settled();
  }

  /**
   * Auto-attach only fires for targets created after it is armed. When the
   * daemon connects to a browser that is already open, sweep up what is
   * already there.
   */
  private async attachExistingTargets(): Promise<void> {
    let result: { targetInfos?: TargetInfo[] };
    try {
      result = await this.connection.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    } catch (err) {
      this.log.warn('Target.getTargets failed', err);
      return;
    }
    for (const info of result.targetInfos ?? []) {
      if (info.type === 'browser') continue;
      if (!ATTACHABLE_TYPES.has(info.type)) continue;
      if (this.byCdpTargetId.has(info.targetId)) continue;
      try {
        await this.connection.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true,
        });
      } catch (err) {
        this.log.debug(`could not attach to existing target ${info.targetId} (${info.type})`, err);
      }
    }
  }

  /** Register an in-flight attachment so `settled()` can wait for it. */
  private track(work: Promise<void>): void {
    const entry = work.catch((err) => {
      this.log.warn('attach failed', err);
    });
    this.pendingAttachments.add(entry);
    void entry.finally(() => this.pendingAttachments.delete(entry));
  }

  /**
   * Resolve once every in-flight attachment has finished instrumenting.
   * Attachments can cascade (a page attaches its workers), so this drains
   * until the set stays empty.
   */
  async settled(): Promise<void> {
    while (this.pendingAttachments.size > 0) {
      await Promise.all([...this.pendingAttachments]);
    }
  }

  private async handleAttached(event: AttachedToTargetEvent, parentSessionId: string): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = event;
    if (this.bySession.has(sessionId)) return;

    if (!ATTACHABLE_TYPES.has(targetInfo.type)) {
      // Release the hold even on targets we decline to instrument, otherwise
      // the target stays frozen forever.
      await this.release(sessionId, waitingForDebugger);
      return;
    }

    const parent = parentSessionId === ROOT_SESSION ? null : (this.bySession.get(parentSessionId) ?? null);
    const session = new CdpSession(this.connection, sessionId, targetInfo.targetId);
    // Instrumentation below runs against a frozen renderer, which accepts
    // commands but answers none of them until it resumes. Without this the
    // enables and the resume wait on each other for a full CDP timeout each -
    // a tab opened with target="_blank" sat blank for two minutes.
    session.setPaused(waitingForDebugger);
    const handle = this.resolveHandle(targetInfo, sessionId, parent?.handle ?? null);

    const target: ManagedTarget = {
      handle,
      cdpTargetId: targetInfo.targetId,
      session,
      info: targetInfo,
      type: targetInfo.type,
      parentHandle: parent?.handle ?? null,
      attachedAt: Date.now(),
    };

    this.bySession.set(sessionId, target);
    this.byCdpTargetId.set(targetInfo.targetId, target);
    this.byHandle.set(handle, target);
    this.log.debug(`attached ${targetInfo.type} ${handle} ${targetInfo.url}`);

    try {
      // Recurse: this session's own iframes and workers.
      await session.trySend('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      for (const listener of this.attachListeners) {
        try {
          await listener(target);
        } catch (err) {
          this.log.warn(`attach listener failed for ${handle}`, err);
        }
      }
    } finally {
      // Always release, even if instrumentation partly failed: a held target
      // is a hung tab from the user's point of view.
      await this.release(sessionId, waitingForDebugger);
      // Replies are available again now that the renderer is running.
      session.setPaused(false);
    }
  }

  private async release(sessionId: string, waitingForDebugger: boolean): Promise<void> {
    if (!waitingForDebugger) return;
    try {
      await this.connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId, 10_000);
    } catch (err) {
      this.log.debug(`runIfWaitingForDebugger failed for ${sessionId}`, err);
    }
  }

  private handleDetached(event: DetachedFromTargetEvent): void {
    const target = this.bySession.get(event.sessionId);
    if (!target) return;
    this.bySession.delete(event.sessionId);
    this.byCdpTargetId.delete(target.cdpTargetId);
    this.byHandle.delete(target.handle);
    target.session.dispose();
    this.log.debug(`detached ${target.type} ${target.handle}`);
    for (const listener of this.detachListeners) {
      try {
        listener(target);
      } catch (err) {
        this.log.warn(`detach listener failed for ${target.handle}`, err);
      }
    }
  }

  private handleInfoChanged(info: TargetInfo): void {
    const target = this.byCdpTargetId.get(info.targetId);
    if (!target) return;
    target.info = info;
    for (const listener of this.infoListeners) {
      try {
        listener(target);
      } catch (err) {
        this.log.warn(`info listener failed for ${target.handle}`, err);
      }
    }
  }

  get(handle: string): ManagedTarget | undefined {
    return this.byHandle.get(handle);
  }

  getBySession(sessionId: string): ManagedTarget | undefined {
    return this.bySession.get(sessionId);
  }

  getByCdpTargetId(targetId: string): ManagedTarget | undefined {
    return this.byCdpTargetId.get(targetId);
  }

  list(): ManagedTarget[] {
    return [...this.byHandle.values()];
  }

  listPages(): ManagedTarget[] {
    return this.list().filter((t) => t.type === 'page');
  }

  dispose(): void {
    for (const target of this.byHandle.values()) target.session.dispose();
    this.bySession.clear();
    this.byCdpTargetId.clear();
    this.byHandle.clear();
    this.attachListeners.clear();
    this.detachListeners.clear();
    this.infoListeners.clear();
  }
}
