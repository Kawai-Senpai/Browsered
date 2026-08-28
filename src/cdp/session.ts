import type { CdpConnection, EventHandler } from './connection.js';

/**
 * Commands that may be sent without waiting for a reply while a target is held
 * at `waitForDebuggerOnStart`.
 *
 * Deliberately an allowlist rather than a rule. Every entry returns an empty
 * result, so skipping the wait loses nothing; anything not listed keeps its
 * real reply, because handing a caller a fabricated `{}` would be a silent
 * wrong answer rather than a slow one.
 */
const PAUSE_SAFE_METHODS = new Set([
  'Network.enable',
  'Runtime.enable',
  'Log.enable',
  'Page.enable',
  'Page.setLifecycleEventsEnabled',
  'Target.setAutoAttach',
]);

/**
 * A CDP session bound to one target. Thin by design: it exists so collectors
 * and ops never have to thread a sessionId through every call.
 */
export class CdpSession {
  private readonly disposers: Array<() => void> = [];
  private disposed = false;
  /** True while the target is held at `waitForDebuggerOnStart`. See `setPaused`. */
  private paused = false;

  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  /**
   * Mark the session as talking to a target that is frozen before its first
   * line of script.
   *
   * A paused renderer accepts commands but does not answer them, so awaiting a
   * reply blocks until the CDP timeout - and the resume that would unblock it
   * is queued behind that same await. While paused, commands are written and
   * not waited on: ordering on the wire still guarantees the domain is enabled
   * before the renderer runs, which is the property that matters.
   *
   * Callers that must read a result while paused should use `sendAwaited`.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (this.paused && PAUSE_SAFE_METHODS.has(method)) {
      this.connection.fire(method, params, this.sessionId);
      // These return an empty result even when awaited, so nothing is lost by
      // not waiting. Any other command still gets a real reply - a caller that
      // needs data must not be handed a fabricated empty object.
      return Promise.resolve({} as T);
    }
    return this.connection.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /** Await a reply even while paused. Will block until the target resumes. */
  sendAwaited<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /**
   * Send a command whose failure is not worth propagating (best-effort domain
   * enabling on targets that may vanish mid-handshake).
   */
  async trySend(method: string, params: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await this.send(method, params);
      return true;
    } catch {
      return false;
    }
  }

  on(method: string, handler: EventHandler): () => void {
    const off = this.connection.on(method, handler, this.sessionId);
    this.disposers.push(off);
    return off;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.disposers.splice(0)) off();
    this.connection.clearSession(this.sessionId);
  }
}
