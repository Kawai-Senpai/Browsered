import type { CdpSession } from '../cdp/session.js';
import { AgentBrowserError } from '../util/errors.js';

export async function sendTouch(
  session: CdpSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: Array<Record<string, unknown>>,
  modifiers: number,
) {
  try {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints, modifiers }, 5_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentBrowserError('touch_dispatch_failed', `${type}: ${message}`);
  }
}

export async function cancelTouch(session: CdpSession, modifiers: number): Promise<void> {
  // A timed-out event may still have reached Chromium. Clear the contact
  // without turning an interrupted gesture into a tap or drop.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchCancel', touchPoints: [], modifiers,
  }, 1_000).catch(() => {});
}
