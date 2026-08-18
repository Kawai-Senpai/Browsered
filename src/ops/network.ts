import { toArtifactRef } from '../store/artifact-store.js';
import {
  toRequestDetail,
  toRequestView,
  type RequestFilter,
  type RequestRow,
} from '../store/network-store.js';
import { toWebSocketView, toWsMessageView } from '../store/websocket-store.js';
import { AgentBrowserError, NotFoundError } from '../util/errors.js';
import { parseSince, resolveBrowserScope, type OpsContext } from './context.js';

export interface NetworkQueryArgs {
  browser_id?: string;
  target_id?: string;
  url_contains?: string;
  url_regex?: string;
  method?: string;
  resource_type?: string;
  mime_contains?: string;
  status_min?: number;
  status_max?: number;
  state?: 'pending' | 'response' | 'finished' | 'failed';
  has_body?: boolean;
  failed_only?: boolean;
  since?: string | number;
  until?: string | number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/**
 * The recorder is already running, so a query never has to arm anything first.
 * Resolving the browser is only needed to scope the filter and to auto-launch
 * when nothing is open yet.
 */
async function scope(ctx: OpsContext, args: NetworkQueryArgs): Promise<RequestFilter> {
  // Queries read recorded history, so a browser that has since closed is still
  // a valid scope. Only live control needs a running instance.
  const { browserId } = await resolveBrowserScope(ctx, args.browser_id);
  const filter: RequestFilter = { browserId };
  if (args.target_id) filter.targetHandle = args.target_id;
  if (args.url_contains) filter.urlContains = args.url_contains;
  if (args.url_regex) filter.urlRegex = args.url_regex;
  if (args.method) filter.method = args.method.toUpperCase();
  if (args.resource_type) filter.resourceType = args.resource_type;
  if (args.mime_contains) filter.mimeContains = args.mime_contains;
  if (args.status_min !== undefined) filter.statusMin = args.status_min;
  if (args.status_max !== undefined) filter.statusMax = args.status_max;
  if (args.state) filter.state = args.state;
  if (args.has_body !== undefined) filter.hasBody = args.has_body;
  if (args.failed_only) filter.failedOnly = true;
  const since = parseSince(args.since);
  if (since !== undefined) filter.since = since;
  const until = parseSince(args.until);
  if (until !== undefined) filter.until = until;
  if (args.limit !== undefined) filter.limit = args.limit;
  if (args.offset !== undefined) filter.offset = args.offset;
  if (args.order) filter.order = args.order;
  return filter;
}

export async function listRequests(
  ctx: OpsContext,
  args: NetworkQueryArgs,
): Promise<Record<string, unknown>> {
  const filter = await scope(ctx, args);
  const rows = ctx.stores.network.list(filter);
  const total = ctx.stores.network.count(filter);
  return {
    browser_id: filter.browserId,
    total_matching: total,
    returned: rows.length,
    offset: filter.offset ?? 0,
    requests: rows.map(toRequestView),
    hint:
      'Bodies and full headers are not in this list. Call network.get_request(request_id) for one, '
      + 'network.get_body(request_id) for its payload.',
  };
}

function requireRequest(ctx: OpsContext, requestId: string): RequestRow {
  const row = ctx.stores.network.get(requestId);
  if (!row) throw new NotFoundError('request', requestId);
  return row;
}

export async function getRequest(
  ctx: OpsContext,
  args: { request_id: string; include_redirect_chain?: boolean },
): Promise<Record<string, unknown>> {
  const row = requireRequest(ctx, args.request_id);
  const detail = toRequestDetail(row);

  if (args.include_redirect_chain !== false) {
    const chain = ctx.stores.network.redirectChain(row.browser_id, row.cdp_request_id);
    if (chain.length > 1) {
      detail.redirect_chain = chain.map((hop) => ({
        hop: hop.hop,
        request_id: hop.request_handle,
        url: hop.url,
        status: hop.status,
        location: hop.request_handle === row.request_handle ? '(this request)' : undefined,
      }));
    }
  }

  detail.bodies = {
    request_body: row.post_data_blob
      ? { state: row.post_data_state, size: row.post_data_size, call: 'network.get_body(which="request")' }
      : { state: row.post_data_state ?? 'empty', size: row.post_data_size ?? 0 },
    response_body: {
      state: row.body_state,
      size: row.body_size,
      ...(row.body_state === 'stored' ? { call: 'network.get_body(which="response")' } : {}),
    },
  };
  return detail;
}

/**
 * Bodies are stored as content-addressed blobs, never inlined by default.
 * This returns a bounded window plus an artifact handle for everything else,
 * so a 200MB response never lands in a prompt.
 */
export async function getBody(
  ctx: OpsContext,
  args: {
    request_id: string;
    which?: 'response' | 'request';
    max_chars?: number;
    offset?: number;
    as_json?: boolean;
    save_path?: string;
  },
): Promise<Record<string, unknown>> {
  const row = requireRequest(ctx, args.request_id);
  const which = args.which ?? 'response';
  const blobRef = which === 'request' ? row.post_data_blob : row.body_blob;
  const state = which === 'request' ? row.post_data_state : row.body_state;

  if (!blobRef) {
    return {
      request_id: row.request_handle,
      which,
      available: false,
      state: state ?? 'empty',
      reason:
        state === 'too_large'
          ? 'Body exceeded the recorder capture limit; raise recorder.maxBodyBytes to keep it.'
          : state === 'skipped'
            ? 'MIME type is on recorder.skipBodyMimePrefixes.'
            : state === 'unavailable'
              ? 'Chromium evicted the body before it could be read (common for redirects and preflights).'
              : 'No body was sent.',
    };
  }

  const buffer = ctx.stores.blobs.get(blobRef);
  if (!buffer) {
    return {
      request_id: row.request_handle,
      which,
      available: false,
      state: state ?? 'unavailable',
      reason: 'The body was recorded but its blob is missing from disk.',
    };
  }
  const isBase64 = which === 'response' && row.body_base64 === 1;
  const artifact = ctx.stores.artifacts.put(which === 'request' ? 'request_body' : 'response_body', buffer, {
    browserId: row.browser_id,
    label: `${which}-body`,
    mime: row.mime_type ?? 'application/octet-stream',
    ...(isBase64 ? { encoding: 'base64' } : {}),
    sourceRef: row.request_handle,
    meta: { url: row.url, status: row.status, method: row.method },
  });

  const out: Record<string, unknown> = {
    request_id: row.request_handle,
    which,
    available: true,
    url: row.url,
    mime: row.mime_type,
    size: buffer.length,
    binary: isBase64,
    artifact: toArtifactRef(artifact),
  };

  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }

  if (isBase64) {
    out.hint =
      'Binary body: use artifact.read(offset, encoding="base64") or save_path rather than reading it as text.';
    return out;
  }

  const text = buffer.toString('utf8');
  const offset = Math.max(args.offset ?? 0, 0);
  const max = Math.min(Math.max(args.max_chars ?? 20_000, 200), 400_000);
  const window = text.slice(offset, offset + max);

  out.offset = offset;
  out.truncated = offset + window.length < text.length;
  out.body = window;

  if (args.as_json) {
    try {
      out.parsed = JSON.parse(text);
      delete out.body;
      delete out.truncated;
    } catch (err) {
      out.parse_error = (err as Error).message;
    }
  }
  if (out.truncated) {
    out.hint = 'Body is truncated. Use artifact.search / artifact.json_query on the artifact instead of paging.';
  }
  return out;
}

/**
 * Aggregate view over the recording: what is slow, what failed, what is
 * heaviest. Meant as the first call when the question is "what is wrong with
 * this page" rather than "show me request X".
 */
/** The filters the caller actually set, echoed back for empty results. */
function describeFilters(args: NetworkQueryArgs): string[] {
  const out: string[] = [];
  const named: Array<[keyof NetworkQueryArgs, string]> = [
    ['url_contains', 'url_contains'],
    ['url_regex', 'url_regex'],
    ['method', 'method'],
    ['resource_type', 'resource_type'],
    ['mime_contains', 'mime_contains'],
    ['status_min', 'status_min'],
    ['status_max', 'status_max'],
    ['state', 'state'],
    ['since', 'since'],
    ['until', 'until'],
    ['target_id', 'target_id'],
  ];
  for (const [key, label] of named) {
    const value = args[key];
    if (value !== undefined && value !== '') out.push(`${label}=${String(value)}`);
  }
  if (args.failed_only) out.push('failed_only=true');
  if (args.has_body !== undefined) out.push(`has_body=${args.has_body}`);
  return out;
}

export async function summarize(
  ctx: OpsContext,
  args: NetworkQueryArgs & { group_by?: 'domain' | 'resource_type' | 'status' },
): Promise<Record<string, unknown>> {
  const filter = await scope(ctx, args);
  // Summaries must see the whole window, not the default page size.
  const rows = ctx.stores.network.list({ ...filter, limit: 5000, offset: 0 });

  /*
   * "0 requests" is ambiguous between "nothing was recorded" and "your filter
   * matched nothing", and reading it the wrong way sends you hunting for a
   * recorder bug that is not there. Say which one it is.
   */
  if (rows.length === 0) {
    const applied = describeFilters(args);
    const recorded = ctx.stores.network.count({ browserId: filter.browserId });
    return {
      browser_id: filter.browserId,
      request_count: 0,
      recorded_in_scope: recorded,
      filters_applied: applied,
      explanation: applied.length
        ? `0 of ${recorded} recorded requests matched ${applied.join(', ')}.`
        : `Nothing has been recorded for this browser yet (${recorded} requests in scope).`,
      hint: applied.length
        ? 'The recorder has data; these filters excluded it. Widen or drop a filter, or check the URL the app really calls with network.summarize(group_by:"domain").'
        : 'Load a page first, or pass a browser_id that has recorded history (browser.list shows them).',
    };
  }

  const groupBy = args.group_by ?? 'resource_type';
  const keyOf = (row: RequestRow): string => {
    if (groupBy === 'domain') {
      try {
        return new URL(row.url).host;
      } catch {
        return '(unparseable)';
      }
    }
    if (groupBy === 'status') return row.status === null ? (row.error_text ? 'failed' : 'pending') : String(row.status);
    return row.resource_type ?? 'Other';
  };

  const groups = new Map<string, { count: number; bytes: number; totalMs: number; timed: number; failed: number }>();
  const slowest: RequestRow[] = [];
  const failures: RequestRow[] = [];
  let totalBytes = 0;

  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key) ?? { count: 0, bytes: 0, totalMs: 0, timed: 0, failed: 0 };
    bucket.count++;
    bucket.bytes += row.encoded_data_length ?? 0;
    totalBytes += row.encoded_data_length ?? 0;
    if (row.completed_at !== null) {
      bucket.totalMs += row.completed_at - row.started_at;
      bucket.timed++;
    }
    if (row.error_text || (row.status !== null && row.status >= 400)) {
      bucket.failed++;
      if (failures.length < 25) failures.push(row);
    }
    groups.set(key, bucket);
    slowest.push(row);
  }

  slowest.sort((a, b) => {
    const da = a.completed_at === null ? -1 : a.completed_at - a.started_at;
    const db = b.completed_at === null ? -1 : b.completed_at - b.started_at;
    return db - da;
  });

  return {
    browser_id: filter.browserId,
    request_count: rows.length,
    total_transferred_bytes: totalBytes,
    grouped_by: groupBy,
    groups: [...groups.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        transferred_bytes: v.bytes,
        avg_duration_ms: v.timed ? Math.round(v.totalMs / v.timed) : null,
        failed: v.failed,
      }))
      .sort((a, b) => b.count - a.count),
    slowest: slowest.slice(0, 10).map((r) => ({
      request_id: r.request_handle,
      url: r.url,
      method: r.method,
      status: r.status,
      duration_ms: r.completed_at === null ? null : r.completed_at - r.started_at,
      transferred_bytes: r.encoded_data_length,
    })),
    failures: failures.map((r) => ({
      request_id: r.request_handle,
      url: r.url,
      method: r.method,
      status: r.status,
      error: r.error_text,
      blocked_reason: r.blocked_reason,
    })),
    hint: 'Drill into any request_id with network.get_request or network.get_body.',
  };
}

/**
 * Search inside recorded bodies. This is what makes "which response contained
 * this token" answerable without downloading every payload.
 */
export async function searchBodies(
  ctx: OpsContext,
  args: NetworkQueryArgs & {
    query: string;
    is_regex?: boolean;
    ignore_case?: boolean;
    which?: 'response' | 'request' | 'both';
    max_files?: number;
    max_matches_per_body?: number;
  },
): Promise<Record<string, unknown>> {
  const filter = await scope(ctx, args);
  const rows = ctx.stores.network.list({ ...filter, limit: Math.min(Math.max(args.max_files ?? 100, 1), 1000) });
  const which = args.which ?? 'response';
  const perBody = Math.min(Math.max(args.max_matches_per_body ?? 3, 1), 25);

  let test: (text: string) => number[];
  if (args.is_regex) {
    let re: RegExp;
    try {
      re = new RegExp(args.query, `g${args.ignore_case ? 'i' : ''}`);
    } catch (err) {
      throw new AgentBrowserError('bad_regex', `Invalid regex: ${(err as Error).message}`);
    }
    test = (text) => {
      const out: number[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null && out.length < perBody) {
        out.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return out;
    };
  } else {
    const needle = args.ignore_case ? args.query.toLowerCase() : args.query;
    test = (text) => {
      const haystack = args.ignore_case ? text.toLowerCase() : text;
      const out: number[] = [];
      let at = haystack.indexOf(needle);
      while (at >= 0 && out.length < perBody) {
        out.push(at);
        at = haystack.indexOf(needle, at + needle.length);
      }
      return out;
    };
  }

  const results: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (const row of rows) {
    const candidates: Array<{ kind: 'request' | 'response'; blob: string | null; base64: boolean }> = [];
    if (which === 'response' || which === 'both') {
      candidates.push({ kind: 'response', blob: row.body_blob, base64: row.body_base64 === 1 });
    }
    if (which === 'request' || which === 'both') {
      candidates.push({ kind: 'request', blob: row.post_data_blob, base64: false });
    }

    for (const candidate of candidates) {
      // Binary blobs are skipped: substring matching on base64 is meaningless.
      if (!candidate.blob || candidate.base64) continue;
      const blob = ctx.stores.blobs.get(candidate.blob);
      if (!blob) continue;
      const text = blob.toString('utf8');
      scanned++;
      const positions = test(text);
      if (!positions.length) continue;
      results.push({
        request_id: row.request_handle,
        which: candidate.kind,
        url: row.url,
        status: row.status,
        mime: row.mime_type,
        body_size: text.length,
        match_count: positions.length,
        excerpts: positions.map((at) => {
          const from = Math.max(0, at - 120);
          const to = Math.min(text.length, at + args.query.length + 120);
          return {
            offset: at,
            text: `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`,
          };
        }),
      });
    }
  }

  return {
    browser_id: filter.browserId,
    query: args.query,
    bodies_scanned: scanned,
    bodies_with_matches: results.length,
    results,
    hint: 'Call network.get_body(request_id, offset=<match offset>) to read around a hit.',
  };
}

export async function listWebSockets(
  ctx: OpsContext,
  args: { browser_id?: string; target_id?: string; url_contains?: string; open_only?: boolean; limit?: number },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const rows = ctx.stores.websockets.list({
    browserId: instance.id,
    ...(args.target_id ? { targetHandle: args.target_id } : {}),
    ...(args.url_contains ? { urlContains: args.url_contains } : {}),
    ...(args.open_only ? { openOnly: true } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  return {
    browser_id: instance.id,
    count: rows.length,
    websockets: rows.map((row) => toWebSocketView(row, ctx.stores.websockets.messageCount(row.ws_handle))),
    hint: 'Read frames with network.ws_messages(websocket_id). Server-sent events are recorded here too.',
  };
}

export async function wsMessages(
  ctx: OpsContext,
  args: {
    websocket_id: string;
    direction?: 'sent' | 'received';
    search?: string;
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
  },
): Promise<Record<string, unknown>> {
  const connection = ctx.stores.websockets.get(args.websocket_id);
  if (!connection) throw new NotFoundError('websocket', args.websocket_id);
  const rows = ctx.stores.websockets.messages({
    wsHandle: args.websocket_id,
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.search ? { search: args.search } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.order ? { order: args.order } : {}),
  });
  return {
    websocket_id: args.websocket_id,
    url: connection.url,
    total_messages: ctx.stores.websockets.messageCount(args.websocket_id),
    returned: rows.length,
    messages: rows.map(toWsMessageView),
  };
}

/** Dump the current filter's requests to a HAR-shaped artifact. */
export async function exportHar(
  ctx: OpsContext,
  args: NetworkQueryArgs & { save_path?: string; include_bodies?: boolean },
): Promise<Record<string, unknown>> {
  const filter = await scope(ctx, args);
  const rows = ctx.stores.network.list({ ...filter, limit: 5000, offset: 0, order: 'asc' });
  const includeBodies = args.include_bodies !== false;

  const headerList = (headers: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
    Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));

  const entries = rows.map((row) => {
    const detail = toRequestDetail(row) as Record<string, unknown>;
    let responseText: string | undefined;
    if (includeBodies && row.body_blob && row.body_base64 !== 1) {
      responseText = ctx.stores.blobs.get(row.body_blob)?.toString('utf8');
    }
    let postText: string | undefined;
    if (includeBodies && row.post_data_blob) {
      postText = ctx.stores.blobs.get(row.post_data_blob)?.toString('utf8');
    }
    return {
      startedDateTime: new Date(row.started_at).toISOString(),
      time: row.completed_at === null ? -1 : row.completed_at - row.started_at,
      _requestId: row.request_handle,
      request: {
        method: row.method,
        url: row.url,
        httpVersion: row.protocol ?? '',
        headers: headerList(detail.request_headers as Record<string, string>),
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: row.post_data_size ?? 0,
        ...(postText === undefined
          ? {}
          : { postData: { mimeType: 'application/octet-stream', text: postText } }),
      },
      response: {
        status: row.status ?? 0,
        statusText: row.status_text ?? '',
        httpVersion: row.protocol ?? '',
        headers: headerList(detail.response_headers as Record<string, string>),
        cookies: [],
        content: {
          size: row.body_size ?? 0,
          mimeType: row.mime_type ?? '',
          ...(responseText === undefined ? {} : { text: responseText }),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: row.encoded_data_length ?? -1,
        _error: row.error_text,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
    };
  });

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'browserd', version: '0.1.0' },
      entries,
    },
  };

  const artifact = ctx.stores.artifacts.put('har', Buffer.from(JSON.stringify(har, null, 2), 'utf8'), {
    browserId: filter.browserId ?? null,
    label: 'network',
    mime: 'application/json',
    meta: { entry_count: entries.length, include_bodies: includeBodies },
  });

  const out: Record<string, unknown> = {
    browser_id: filter.browserId,
    entry_count: entries.length,
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

export async function clear(
  ctx: OpsContext,
  args: { browser_id?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const before = ctx.stores.network.count({ browserId: instance.id });
  ctx.stores.network.deleteForBrowser(instance.id);
  return { browser_id: instance.id, deleted: before };
}
