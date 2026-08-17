import { PAGE_LIKE_TYPES, type ManagedTarget } from '../browser/target-manager.js';
import type { Stores } from '../store/index.js';
import type { Logger } from '../util/logger.js';

export interface PendingDialog {
  targetHandle: string;
  type: string;
  message: string;
  defaultPrompt?: string;
  url: string;
  openedAt: number;
}

/**
 * Navigation history and JavaScript dialogs.
 *
 * Dialogs are recorded, not auto-dismissed. This browser is meant to stay
 * usable by a human, and silently accepting their confirm() would change what
 * the page does behind their back. `page.handle_dialog` is the explicit route.
 */
export class PageCollector {
  private readonly dialogs = new Map<string, PendingDialog>();

  constructor(
    private readonly browserId: string,
    private readonly stores: Stores,
    private readonly log: Logger,
  ) {}

  async attach(target: ManagedTarget): Promise<void> {
    if (!PAGE_LIKE_TYPES.has(target.type)) return;
    const { session } = target;
    // Subscribe before enabling: Page.enable makes Chromium emit at once, and
    // the first frameNavigated of a fresh tab arrives in that window.
    session.on('Page.frameNavigated', (params) => {
      const frame = (params as { frame: { id: string; url: string; parentId?: string } }).frame;
      // Only main-frame navigations are history; subframe churn would drown it.
      if (frame.parentId) return;
      this.stores.targets.addNavigation({
        browserId: this.browserId,
        targetHandle: target.handle,
        frameId: frame.id,
        url: frame.url,
        kind: 'navigate',
        ts: Date.now(),
      });
      this.stores.targets.patchTarget(target.handle, { url: frame.url });
    });

    session.on('Page.navigatedWithinDocument', (params) => {
      const p = params as { frameId: string; url: string };
      this.stores.targets.addNavigation({
        browserId: this.browserId,
        targetHandle: target.handle,
        frameId: p.frameId,
        url: p.url,
        kind: 'same-document',
        ts: Date.now(),
      });
    });

    session.on('Page.javascriptDialogOpening', (params) => {
      const p = params as {
        url: string;
        message: string;
        type: string;
        defaultPrompt?: string;
      };
      const dialog: PendingDialog = {
        targetHandle: target.handle,
        type: p.type,
        message: p.message,
        url: p.url,
        openedAt: Date.now(),
      };
      if (p.defaultPrompt !== undefined) dialog.defaultPrompt = p.defaultPrompt;
      this.dialogs.set(target.handle, dialog);
      this.stores.console.addEntry({
        browserId: this.browserId,
        targetHandle: target.handle,
        source: 'dialog',
        level: 'info',
        text: `${p.type}: ${p.message}`,
        url: p.url,
        ts: Date.now(),
      });
    });

    session.on('Page.javascriptDialogClosed', () => {
      this.dialogs.delete(target.handle);
    });

    session.on('Page.frameDetached', () => {
      /* frame trees are queried live; nothing to persist */
    });

    const ok = await session.trySend('Page.enable');
    if (!ok) {
      this.log.debug(`Page.enable unsupported on ${target.type} ${target.handle}`);
      return;
    }
    // Lifecycle events give load/DOMContentLoaded/firstPaint without polling.
    await session.trySend('Page.setLifecycleEventsEnabled', { enabled: true });
  }

  getDialog(targetHandle: string): PendingDialog | undefined {
    return this.dialogs.get(targetHandle);
  }

  listDialogs(): PendingDialog[] {
    return [...this.dialogs.values()];
  }

  clearDialog(targetHandle: string): void {
    this.dialogs.delete(targetHandle);
  }

  detach(target: ManagedTarget): void {
    this.dialogs.delete(target.handle);
  }
}
