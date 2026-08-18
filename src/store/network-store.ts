import { mintId } from '../util/ids.js';
import { b, isOpen, j, unj, type Db } from './db.js';

export type BodyState = 'pending' | 'stored' | 'empty' | 'skipped' | 'too_large' | 'unavailable';
export type RequestState = 'pending' | 'response' | 'finished' | 'failed';

export interface RequestRow {
  request_handle: string;
  browser_id: string;
  target_handle: string | null;
  cdp_request_id: string;
  hop: number;
  frame_id: string | null;
  loader_id: string | null;
  document_url: string | null;
  url: string;
  method: string;
  resource_type: string | null;
  request_headers: string | null;
  request_headers_extra: string | null;
  post_data_blob: string | null;
  post_data_size: number | null;
  post_data_state: string | null;
  status: number | null;
  status_text: string | null;
  response_headers: string | null;
  response_headers_extra: string | null;
  mime_type: string | null;
  protocol: string | null;
  remote_ip: string | null;
  remote_port: number | null;
  from_disk_cache: number | null;
  from_service_worker: number | null;
  from_prefetch_cache: number | null;
  served_from_cache: number | null;
  encoded_data_length: number | null;
  data_length: number | null;
  body_blob: string | null;
  body_size: number | null;
  body_base64: number | null;
  body_state: BodyState;
  error_text: string | null;
  blocked_reason: string | null;
  canceled: number | null;
  initiator: string | null;
  timing: string | null;
  state: RequestState;
  started_at: number;
  response_at: number | null;
  completed_at: number | null;
  wall_time: number | null;
}

export interface CreateRequestInput {
  browserId: string;
  targetHandle: string | null;
  cdpRequestId: string;
  hop: number;
  frameId?: string | null;
  loaderId?: string | null;
  documentUrl?: string | null;
  url: string;
  method: string;
  resourceType?: string | null;
  requestHeaders?: Record<string, string> | null;
  postDataBlob?: string | null;
  postDataSize?: number | null;
  postDataState?: string | null;
  initiator?: unknown;
  startedAt: number;
  wallTime?: number | null;
}

export interface RequestFilter {
  browserId?: string;
  targetHandle?: string;
  urlContains?: string;
  urlRegex?: string;
  method?: string;
  resourceType?: string;
  mimeContains?: string;
  statusMin?: number;
  statusMax?: number;
  state?: RequestState;
  hasBody?: boolean;
  failedOnly?: boolean;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/**
 * Every network event Chromium pushes lands here, whether or not anything is
 * currently asking. Queries then run against the database instead of the
 * browser, so history survives navigation, tab close and daemon restart.
 */
export class NetworkStore {
  constructor(private readonly db: Db) {}

  create(input: CreateRequestInput): string {
    const handle = mintId('req');
    if (!isOpen(this.db)) return handle;
    this.db
      .prepare(
        `INSERT INTO requests (
           request_handle, browser_id, target_handle, cdp_request_id, hop, frame_id, loader_id,
           document_url, url, method, resource_type, request_headers, post_data_blob,
           post_data_size, post_data_state, initiator, state, body_state, started_at, wall_time
         ) VALUES (
           @handle, @browserId, @targetHandle, @cdpRequestId, @hop, @frameId, @loaderId,
           @documentUrl, @url, @method, @resourceType, @requestHeaders, @postDataBlob,
           @postDataSize, @postDataState, @initiator, 'pending', 'pending', @startedAt, @wallTime
         )
         ON CONFLICT(browser_id, cdp_request_id, hop) DO NOTHING`,
      )
      .run({
        handle,
        browserId: input.browserId,
        targetHandle: input.targetHandle,
        cdpRequestId: input.cdpRequestId,
        hop: input.hop,
        frameId: input.frameId ?? null,
        loaderId: input.loaderId ?? null,
        documentUrl: input.documentUrl ?? null,
        url: input.url,
        method: input.method,
        resourceType: input.resourceType ?? null,
        requestHeaders: j(input.requestHeaders),
        postDataBlob: input.postDataBlob ?? null,
        postDataSize: input.postDataSize ?? null,
        postDataState: input.postDataState ?? null,
        initiator: j(input.initiator),
        startedAt: input.startedAt,
        wallTime: input.wallTime ?? null,
      });

    const existing = this.findByCdpId(input.browserId, input.cdpRequestId, input.hop);
    return existing?.request_handle ?? handle;
  }

  findByCdpId(browserId: string, cdpRequestId: string, hop: number): RequestRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM requests WHERE browser_id = ? AND cdp_request_id = ? AND hop = ?`,
      )
      .get(browserId, cdpRequestId, hop) as RequestRow | undefined;
  }

  get(handle: string): RequestRow | undefined {
    // Read from a collector callback (SSE), so it can outlive the handle too.
    if (!isOpen(this.db)) return undefined;
    return this.db.prepare(`SELECT * FROM requests WHERE request_handle = ?`).get(handle) as
      | RequestRow
      | undefined;
  }

  /** Generic column patch, keyed by handle. Column names are internal, never caller-supplied. */
  patch(handle: string, columns: Record<string, unknown>): void {
    if (!isOpen(this.db)) return;
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE requests SET ${assignments} WHERE request_handle = @handle`)
      .run({ ...columns, handle });
  }

  private buildWhere(filter: RequestFilter): { clause: string; params: Record<string, unknown> } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.browserId) {
      where.push('browser_id = @browserId');
      params.browserId = filter.browserId;
    }
    if (filter.targetHandle) {
      where.push('target_handle = @targetHandle');
      params.targetHandle = filter.targetHandle;
    }
    if (filter.urlContains) {
      where.push('url LIKE @urlContains');
      params.urlContains = `%${filter.urlContains}%`;
    }
    if (filter.urlRegex) {
      where.push('regexp(@urlRegex, url) = 1');
      params.urlRegex = filter.urlRegex;
    }
    if (filter.method) {
      where.push('method = @method');
      params.method = filter.method.toUpperCase();
    }
    if (filter.resourceType) {
      where.push('resource_type = @resourceType');
      params.resourceType = filter.resourceType;
    }
    if (filter.mimeContains) {
      where.push('mime_type LIKE @mimeContains');
      params.mimeContains = `%${filter.mimeContains}%`;
    }
    if (filter.statusMin !== undefined) {
      where.push('status >= @statusMin');
      params.statusMin = filter.statusMin;
    }
    if (filter.statusMax !== undefined) {
      where.push('status <= @statusMax');
      params.statusMax = filter.statusMax;
    }
    if (filter.state) {
      where.push('state = @state');
      params.state = filter.state;
    }
    if (filter.failedOnly) {
      where.push("(state = 'failed' OR status >= 400)");
    }
    if (filter.hasBody !== undefined) {
      where.push(filter.hasBody ? "body_state = 'stored'" : "body_state != 'stored'");
    }
    if (filter.since !== undefined) {
      where.push('started_at >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push('started_at <= @until');
      params.until = filter.until;
    }

    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(filter: RequestFilter): RequestRow[] {
    const { clause, params } = this.buildWhere(filter);
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    params.limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
    params.offset = Math.max(filter.offset ?? 0, 0);

    return this.db
      .prepare(
        `SELECT * FROM requests ${clause} ORDER BY started_at ${order}, rowid ${order} LIMIT @limit OFFSET @offset`,
      )
      .all(params) as RequestRow[];
  }

  /** Total matches ignoring limit/offset, so callers can page honestly. */
  count(filter: RequestFilter): number {
    const { clause, params } = this.buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM requests ${clause}`).get(params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /** All hops of a redirect chain, oldest first. */
  redirectChain(browserId: string, cdpRequestId: string): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests WHERE browser_id = ? AND cdp_request_id = ? ORDER BY hop ASC`,
      )
      .all(browserId, cdpRequestId) as RequestRow[];
  }

  deleteForBrowser(browserId: string): void {
    this.db.prepare(`DELETE FROM requests WHERE browser_id = ?`).run(browserId);
  }
}

export interface NetworkRequestView {
  request_id: string;
  browser_id: string;
  target_id: string | null;
  url: string;
  method: string;
  resource_type: string | null;
  status: number | null;
  status_text: string | null;
  mime_type: string | null;
  protocol: string | null;
  remote_address: string | null;
  state: RequestState;
  body_state: BodyState;
  body_size: number | null;
  request_body_size: number | null;
  encoded_data_length: number | null;
  error: string | null;
  blocked_reason: string | null;
  from_cache: boolean;
  from_service_worker: boolean;
  started_at: string;
  duration_ms: number | null;
  redirect_hop: number;
}

export function toRequestView(row: RequestRow): NetworkRequestView {
  return {
    request_id: row.request_handle,
    browser_id: row.browser_id,
    target_id: row.target_handle,
    url: row.url,
    method: row.method,
    resource_type: row.resource_type,
    status: row.status,
    status_text: row.status_text,
    mime_type: row.mime_type,
    protocol: row.protocol,
    remote_address:
      row.remote_ip === null ? null : row.remote_port ? `${row.remote_ip}:${row.remote_port}` : row.remote_ip,
    state: row.state,
    body_state: row.body_state,
    body_size: row.body_size,
    request_body_size: row.post_data_size,
    encoded_data_length: row.encoded_data_length,
    error: row.error_text,
    blocked_reason: row.blocked_reason,
    from_cache: b(row.from_disk_cache) || b(row.served_from_cache),
    from_service_worker: b(row.from_service_worker),
    started_at: new Date(row.started_at).toISOString(),
    duration_ms: row.completed_at === null ? null : row.completed_at - row.started_at,
    redirect_hop: row.hop,
  };
}

export function toRequestDetail(row: RequestRow): Record<string, unknown> {
  return {
    ...toRequestView(row),
    frame_id: row.frame_id,
    loader_id: row.loader_id,
    document_url: row.document_url,
    request_headers: unj<Record<string, string>>(row.request_headers) ?? {},
    /** Headers as actually put on the wire, from *ExtraInfo. */
    request_headers_wire: unj<Record<string, string>>(row.request_headers_extra),
    response_headers: unj<Record<string, string>>(row.response_headers) ?? {},
    response_headers_wire: unj<Record<string, string>>(row.response_headers_extra),
    initiator: unj(row.initiator),
    timing: unj(row.timing),
    data_length: row.data_length,
    canceled: b(row.canceled),
    wall_time: row.wall_time === null ? null : new Date(row.wall_time * 1000).toISOString(),
    completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}
