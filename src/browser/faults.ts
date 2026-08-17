/**
 * Fault-injection rules, applied by the Fetch interception router.
 *
 * Kept in its own module so `BrowserInstance` can hold the rule map without
 * importing the ops layer (which imports the instance).
 */
export type FaultAction = 'abort' | 'delay' | 'replace_response' | 'drop' | 'modify_headers';

export interface FaultRule {
  id: string;
  /** Glob against the request URL: `*` matches any run of characters. */
  urlPattern: string;
  action: FaultAction;
  /** abort/drop: the Chromium network error to report. */
  errorReason?: string;
  /** delay: milliseconds to stall before letting the request through. */
  delayMs?: number;
  /** replace_response */
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** modify_headers: merged into the outgoing request. */
  requestHeaders?: Record<string, string>;
  /** Stop applying after this many matches. Undefined means unlimited. */
  remaining?: number;
  /** Only intercept these CDP resource types (Document, XHR, Fetch, ...). */
  resourceTypes?: string[];
  matched: number;
  createdAt: number;
}

/**
 * Glob matching for URL patterns, anchored end to end.
 *
 * `*` and `**` both match any run of characters. `?` in a pattern is treated as
 * a literal question mark rather than a single-character wildcard, because URL
 * patterns overwhelmingly contain query strings: reading `?` as a wildcard made
 * `**\/api?x` mean something nobody intends.
 *
 * A pattern with no trailing wildcard still matches a URL that carries a query
 * string or fragment, so `**\/api/payment` matches `/api/payment?retry=1`. That
 * is what a caller writing a fault rule means; requiring `**` at both ends is a
 * trap that silently produces a rule which never fires.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*+/g, '.*');
  return new RegExp(`^${escaped}(?:[?#].*)?$`);
}

export function ruleMatches(rule: FaultRule, url: string, resourceType?: string): boolean {
  if (rule.remaining !== undefined && rule.remaining <= 0) return false;
  if (rule.resourceTypes?.length && resourceType && !rule.resourceTypes.includes(resourceType)) return false;
  return globToRegExp(rule.urlPattern).test(url);
}
