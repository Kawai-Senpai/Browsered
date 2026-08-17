import type { ControlMode } from '../config.js';
import { mintId } from '../util/ids.js';
import { j, type Db } from './db.js';

export interface TargetRow {
  target_handle: string;
  browser_id: string;
  cdp_target_id: string;
  session_id: string | null;
  type: string;
  subtype: string | null;
  url: string | null;
  title: string | null;
  opener_target: string | null;
  browser_context: string | null;
  parent_handle: string | null;
  attached_at: number;
  detached_at: number | null;
}

export interface BrowserRow {
  browser_id: string;
  profile: string;
  user_data_dir: string;
  executable: string | null;
  pid: number | null;
  cdp_url: string | null;
  status: string;
  control_mode: ControlMode;
  managed: number;
  extensions: string | null;
  netlog_path: string | null;
  launched_at: number;
  closed_at: number | null;
}

/**
 * Target and browser bookkeeping. Rows outlive the live objects on purpose:
 * a request recorded against a tab that has since closed still resolves to a
 * meaningful target handle.
 */
export class TargetStore {
  constructor(private readonly db: Db) {}

  upsertBrowser(row: {
    browserId: string;
    profile: string;
    userDataDir: string;
    executable: string | null;
    pid: number | null;
    cdpUrl: string | null;
    status: string;
    controlMode: ControlMode;
    managed: boolean;
    extensions?: string[];
    netlogPath?: string | null;
    launchedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO browsers (
           browser_id, profile, user_data_dir, executable, pid, cdp_url, status,
           control_mode, managed, extensions, netlog_path, launched_at
         ) VALUES (
           @browserId, @profile, @userDataDir, @executable, @pid, @cdpUrl, @status,
           @controlMode, @managed, @extensions, @netlogPath, @launchedAt
         )
         ON CONFLICT(browser_id) DO UPDATE SET
           status = excluded.status,
           pid = excluded.pid,
           cdp_url = excluded.cdp_url,
           control_mode = excluded.control_mode,
           netlog_path = excluded.netlog_path`,
      )
      .run({
        browserId: row.browserId,
        profile: row.profile,
        userDataDir: row.userDataDir,
        executable: row.executable,
        pid: row.pid,
        cdpUrl: row.cdpUrl,
        status: row.status,
        controlMode: row.controlMode,
        managed: row.managed ? 1 : 0,
        extensions: j(row.extensions ?? []),
        netlogPath: row.netlogPath ?? null,
        launchedAt: row.launchedAt,
      });
  }

  patchBrowser(browserId: string, columns: Record<string, unknown>): void {
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE browsers SET ${assignments} WHERE browser_id = @browserId`)
      .run({ ...columns, browserId });
  }

  getBrowser(browserId: string): BrowserRow | undefined {
    return this.db.prepare(`SELECT * FROM browsers WHERE browser_id = ?`).get(browserId) as
      | BrowserRow
      | undefined;
  }

  listBrowsers(includeClosed = false): BrowserRow[] {
    const clause = includeClosed ? '' : `WHERE closed_at IS NULL`;
    return this.db
      .prepare(`SELECT * FROM browsers ${clause} ORDER BY launched_at DESC`)
      .all() as BrowserRow[];
  }

  /** Returns the durable handle for a CDP target, creating one on first sight. */
  upsertTarget(row: {
    browserId: string;
    cdpTargetId: string;
    sessionId: string | null;
    type: string;
    subtype?: string | null;
    url?: string | null;
    title?: string | null;
    openerTarget?: string | null;
    browserContext?: string | null;
    parentHandle?: string | null;
    attachedAt: number;
  }): string {
    const existing = this.findTargetByCdpId(row.browserId, row.cdpTargetId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE targets SET session_id = @sessionId, url = @url, title = @title,
             type = @type, subtype = @subtype, parent_handle = COALESCE(@parentHandle, parent_handle),
             detached_at = NULL
           WHERE target_handle = @handle`,
        )
        .run({
          handle: existing.target_handle,
          sessionId: row.sessionId,
          url: row.url ?? existing.url,
          title: row.title ?? existing.title,
          type: row.type,
          subtype: row.subtype ?? null,
          parentHandle: row.parentHandle ?? null,
        });
      return existing.target_handle;
    }
    const handle = mintId('tgt');
    this.db
      .prepare(
        `INSERT INTO targets (
           target_handle, browser_id, cdp_target_id, session_id, type, subtype, url, title,
           opener_target, browser_context, parent_handle, attached_at
         ) VALUES (
           @handle, @browserId, @cdpTargetId, @sessionId, @type, @subtype, @url, @title,
           @openerTarget, @browserContext, @parentHandle, @attachedAt
         )`,
      )
      .run({
        handle,
        browserId: row.browserId,
        cdpTargetId: row.cdpTargetId,
        sessionId: row.sessionId,
        type: row.type,
        subtype: row.subtype ?? null,
        url: row.url ?? null,
        title: row.title ?? null,
        openerTarget: row.openerTarget ?? null,
        browserContext: row.browserContext ?? null,
        parentHandle: row.parentHandle ?? null,
        attachedAt: row.attachedAt,
      });
    return handle;
  }

  findTargetByCdpId(browserId: string, cdpTargetId: string): TargetRow | undefined {
    return this.db
      .prepare(`SELECT * FROM targets WHERE browser_id = ? AND cdp_target_id = ?`)
      .get(browserId, cdpTargetId) as TargetRow | undefined;
  }

  getTarget(handle: string): TargetRow | undefined {
    return this.db.prepare(`SELECT * FROM targets WHERE target_handle = ?`).get(handle) as
      | TargetRow
      | undefined;
  }

  patchTarget(handle: string, columns: Record<string, unknown>): void {
    const keys = Object.keys(columns);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE targets SET ${assignments} WHERE target_handle = @handle`)
      .run({ ...columns, handle });
  }

  markDetached(handle: string, ts: number): void {
    this.db
      .prepare(`UPDATE targets SET detached_at = ?, session_id = NULL WHERE target_handle = ?`)
      .run(ts, handle);
  }

  listTargets(browserId: string, includeDetached = false): TargetRow[] {
    const clause = includeDetached ? '' : 'AND detached_at IS NULL';
    return this.db
      .prepare(`SELECT * FROM targets WHERE browser_id = ? ${clause} ORDER BY attached_at ASC`)
      .all(browserId) as TargetRow[];
  }

  addNavigation(row: {
    browserId: string;
    targetHandle: string | null;
    frameId: string | null;
    url: string;
    kind: string;
    ts: number;
  }): string {
    const handle = mintId('nav');
    this.db
      .prepare(
        `INSERT INTO navigations (nav_handle, browser_id, target_handle, frame_id, url, kind, ts)
         VALUES (@handle, @browserId, @targetHandle, @frameId, @url, @kind, @ts)`,
      )
      .run({
        handle,
        browserId: row.browserId,
        targetHandle: row.targetHandle,
        frameId: row.frameId,
        url: row.url,
        kind: row.kind,
        ts: row.ts,
      });
    return handle;
  }

  listNavigations(filter: {
    browserId: string;
    targetHandle?: string;
    limit?: number;
  }): Array<{ nav_handle: string; target_handle: string | null; url: string; kind: string; ts: number }> {
    const where = ['browser_id = @browserId'];
    const params: Record<string, unknown> = { browserId: filter.browserId };
    if (filter.targetHandle) {
      where.push('target_handle = @targetHandle');
      params.targetHandle = filter.targetHandle;
    }
    params.limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    return this.db
      .prepare(
        `SELECT nav_handle, target_handle, url, kind, ts FROM navigations
         WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT @limit`,
      )
      .all(params) as Array<{
      nav_handle: string;
      target_handle: string | null;
      url: string;
      kind: string;
      ts: number;
    }>;
  }
}
