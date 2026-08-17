import { randomBytes } from 'node:crypto';

/**
 * Durable, daemon-minted handles.
 *
 * CDP identifiers (targetId, sessionId, requestId) belong to a browser
 * execution and churn on navigation/restart. Everything that crosses the MCP
 * boundary uses one of these instead, so the model never has to carry a
 * Chrome-internal identifier around.
 */
export type Prefix =
  | 'br' // browser instance
  | 'tgt' // target (page / iframe / worker / service worker)
  | 'req' // network request
  | 'ws' // websocket connection
  | 'wsm' // websocket message
  | 'log' // console entry
  | 'exc' // exception
  | 'nav' // navigation
  | 'bp' // breakpoint
  | 'snap' // dom snapshot
  | 'trace' // trace recording
  | 'art' // exported artifact on disk
  | 'flt' // fault-injection rule
  | 'prof' // profiling session
  | 'blob'; // stored payload

const counters = new Map<Prefix, number>();

/**
 * Short, sortable-ish, collision-resistant handle. The counter keeps ids
 * emitted in the same millisecond distinct and readable; the random suffix
 * keeps them unique across daemon restarts sharing one database.
 */
export function mintId(prefix: Prefix): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${prefix}_${n.toString(36)}${randomBytes(3).toString('hex')}`;
}

/** Seed the per-prefix counter so ids continue past a restart. */
export function seedCounter(prefix: Prefix, value: number): void {
  if (value > (counters.get(prefix) ?? 0)) counters.set(prefix, value);
}

export function isHandle(value: string, prefix: Prefix): boolean {
  return value.startsWith(`${prefix}_`);
}

/**
 * Composite key for a CDP network request. Chrome reuses a requestId across a
 * redirect chain, so the hop index is part of the identity.
 */
export function networkKey(browserId: string, cdpRequestId: string, hop: number): string {
  return `${browserId}:${cdpRequestId}:${hop}`;
}
