import type { BrowserRegistry } from '../browser/registry.js';
import type { DaemonConfig } from '../config.js';
import type { Stores } from '../store/index.js';

/** Everything an operation needs. Passed explicitly so ops stay testable. */
export interface OpsContext {
  registry: BrowserRegistry;
  stores: Stores;
  config: DaemonConfig;
}

/** Common shape for tools that address a browser and optionally a target. */
export interface TargetRef {
  browser_id?: string;
  target_id?: string;
}

export function parseSince(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  // Relative windows: "5m", "90s", "2h", "1d".
  const relative = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const factor =
      unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - amount * factor;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  const asNumber = Number(trimmed);
  return Number.isNaN(asNumber) ? undefined : asNumber;
}
