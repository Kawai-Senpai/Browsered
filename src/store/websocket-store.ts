import { mintId } from '../util/ids.js';
import { j, unj, type Db } from './db.js';

export interface WebSocketRow {
  ws_handle: string;
  browser_id: string;
  target_handle: string | null;
  cdp_request_id: string;
  url: string;
  initiator: string | null;
  handshake_status: number | null;
  handshake_headers: string | null;
  error_text: string | null;
  created_at: number;
  closed_at: number | null;
}

export interface WsMessageRow {
  message_handle: string;
  ws_handle: string;
  browser_id: string;
  direction: 'sent' | 'received';
  opcode: number | null;
  payload: string | null;
  payload_size: number | null;
  truncated: number;
  ts: number;
}

/** WebSocket connections and their frames, recorded continuously. */
export class WebSocketStore {
  constructor(private readonly db: Db) {}

  create(input: {
    browserId: string;
    targetHandle: string | null;
    cdpRequestId: string;
    url: string;
    initiator?: unknown;
    createdAt: number;
  }): string {
    const handle = mintId('ws');
    this.db
      .prepare(
        `INSERT INTO websockets (ws_handle, browser_id, target_handle, cdp_request_id, url, initiator, created_at)
         VALUES (@handle, @browserId, @targetHandle, @cdpRequestId, @url, @initiator, @createdAt)
         ON CONFLICT(browser_id, cdp_request_id) DO NOTHING`,
      )
      .run({
        handle,
        browserId: input.browserId,
        targetHandle: input.targetHandle,
        cdpRequestId: input.cdpRequestId,
        url: input.url,
        initiator: j(input.initiator),
        createdAt: input.createdAt,
      });
    return this.findByCdpId(input.browserId, input.cdpRequestId)?.ws_handle ?? handle;
  }

  findByCdpId(browserId: string, cdpRequestId: string): WebSocketRow | undefined {
    return this.db
      .prepare(`SELECT * FROM websockets WHERE browser_id = ? AND cdp_request_id = ?`)
      .get(browserId, cdpRequestId) as WebSocketRow | undefined;
  }

  get(handle: string): WebSocketRow | undefined {
    return this.db.prepare(`SELECT * FROM websockets WHERE ws_handle = ?`).get(handle) as
      | WebSocketRow
      | undefined;
  }

  patch(handle: string, columns: Record<string, unknown>): void {
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE websockets SET ${assignments} WHERE ws_handle = @handle`)
      .run({ ...columns, handle });
  }

  addMessage(input: {
    wsHandle: string;
    browserId: string;
    direction: 'sent' | 'received';
    opcode: number | null;
    payload: string | null;
    payloadSize: number;
    truncated: boolean;
    ts: number;
  }): string {
    const handle = mintId('wsm');
    this.db
      .prepare(
        `INSERT INTO ws_messages (message_handle, ws_handle, browser_id, direction, opcode, payload, payload_size, truncated, ts)
         VALUES (@handle, @wsHandle, @browserId, @direction, @opcode, @payload, @payloadSize, @truncated, @ts)`,
      )
      .run({
        handle,
        wsHandle: input.wsHandle,
        browserId: input.browserId,
        direction: input.direction,
        opcode: input.opcode,
        payload: input.payload,
        payloadSize: input.payloadSize,
        truncated: input.truncated ? 1 : 0,
        ts: input.ts,
      });
    return handle;
  }

  list(filter: {
    browserId?: string;
    targetHandle?: string;
    urlContains?: string;
    openOnly?: boolean;
    limit?: number;
  }): WebSocketRow[] {
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
    if (filter.openOnly) where.push('closed_at IS NULL');
    params.limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM websockets ${clause} ORDER BY created_at DESC LIMIT @limit`)
      .all(params) as WebSocketRow[];
  }

  messages(filter: {
    wsHandle: string;
    direction?: 'sent' | 'received';
    search?: string;
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
  }): WsMessageRow[] {
    const where = ['ws_handle = @wsHandle'];
    const params: Record<string, unknown> = { wsHandle: filter.wsHandle };
    if (filter.direction) {
      where.push('direction = @direction');
      params.direction = filter.direction;
    }
    if (filter.search) {
      where.push('payload LIKE @search');
      params.search = `%${filter.search}%`;
    }
    params.limit = Math.min(Math.max(filter.limit ?? 100, 1), 2000);
    params.offset = Math.max(filter.offset ?? 0, 0);
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    return this.db
      .prepare(
        `SELECT * FROM ws_messages WHERE ${where.join(' AND ')} ORDER BY ts ${order}, rowid ${order} LIMIT @limit OFFSET @offset`,
      )
      .all(params) as WsMessageRow[];
  }

  messageCount(wsHandle: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ws_messages WHERE ws_handle = ?`)
      .get(wsHandle) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

export function toWebSocketView(row: WebSocketRow, messageCount?: number): Record<string, unknown> {
  return {
    websocket_id: row.ws_handle,
    target_id: row.target_handle,
    url: row.url,
    handshake_status: row.handshake_status,
    handshake_headers: unj(row.handshake_headers),
    error: row.error_text,
    open: row.closed_at === null,
    created_at: new Date(row.created_at).toISOString(),
    closed_at: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
    ...(messageCount === undefined ? {} : { message_count: messageCount }),
  };
}

export function toWsMessageView(row: WsMessageRow): Record<string, unknown> {
  return {
    message_id: row.message_handle,
    direction: row.direction,
    opcode: row.opcode,
    size: row.payload_size,
    truncated: row.truncated === 1,
    payload: row.payload,
    at: new Date(row.ts).toISOString(),
  };
}
