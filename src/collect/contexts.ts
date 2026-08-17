import type { ManagedTarget } from '../browser/target-manager.js';
import type { Logger } from '../util/logger.js';

interface ExecutionContext {
  id: number;
  origin: string;
  name: string;
  frameId: string | null;
  isDefault: boolean;
}

/**
 * Tracks JavaScript execution contexts per target.
 *
 * Same-process iframes are not separate CDP targets, so the only way to run
 * code inside one is to address its execution context directly. Chromium
 * announces contexts as they are created; remembering them is what makes
 * `frame_id` a usable argument on evaluate and query operations.
 */
export class ContextTracker {
  /** targetHandle -> contextId -> context */
  private readonly byTarget = new Map<string, Map<number, ExecutionContext>>();

  constructor(private readonly log: Logger) {}

  attach(target: ManagedTarget): void {
    const { session } = target;
    const contexts = new Map<number, ExecutionContext>();
    this.byTarget.set(target.handle, contexts);

    session.on('Runtime.executionContextCreated', (params) => {
      const ctx = (params as {
        context: {
          id: number;
          origin: string;
          name: string;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
      }).context;
      contexts.set(ctx.id, {
        id: ctx.id,
        origin: ctx.origin,
        name: ctx.name,
        frameId: ctx.auxData?.frameId ?? null,
        isDefault: ctx.auxData?.isDefault === true,
      });
    });

    session.on('Runtime.executionContextDestroyed', (params) => {
      contexts.delete((params as { executionContextId: number }).executionContextId);
    });

    session.on('Runtime.executionContextsCleared', () => {
      contexts.clear();
    });
  }

  detach(target: ManagedTarget): void {
    this.byTarget.delete(target.handle);
  }

  list(targetHandle: string): ExecutionContext[] {
    return [...(this.byTarget.get(targetHandle)?.values() ?? [])];
  }

  /** Default (main-world) context for a frame, or undefined if not seen yet. */
  forFrame(targetHandle: string, frameId: string): ExecutionContext | undefined {
    const contexts = this.byTarget.get(targetHandle);
    if (!contexts) return undefined;
    for (const ctx of contexts.values()) {
      if (ctx.frameId === frameId && ctx.isDefault) return ctx;
    }
    for (const ctx of contexts.values()) {
      if (ctx.frameId === frameId) return ctx;
    }
    this.log.trace(`no execution context recorded for frame ${frameId}`);
    return undefined;
  }
}
