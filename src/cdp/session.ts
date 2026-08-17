import type { CdpConnection, EventHandler } from './connection.js';

/**
 * A CDP session bound to one target. Thin by design: it exists so collectors
 * and ops never have to thread a sessionId through every call.
 */
export class CdpSession {
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  send<T = Record<string, unknown>>(
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
