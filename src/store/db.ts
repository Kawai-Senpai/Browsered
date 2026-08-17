import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../util/logger.js';

const log = createLogger('store:db');

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS browsers (
  browser_id        TEXT PRIMARY KEY,
  profile           TEXT NOT NULL,
  user_data_dir     TEXT NOT NULL,
  executable        TEXT,
  pid               INTEGER,
  cdp_url           TEXT,
  status            TEXT NOT NULL,
  control_mode      TEXT NOT NULL,
  managed           INTEGER NOT NULL DEFAULT 1,
  extensions        TEXT,
  netlog_path       TEXT,
  launched_at       INTEGER NOT NULL,
  closed_at         INTEGER
);

CREATE TABLE IF NOT EXISTS targets (
  target_handle     TEXT PRIMARY KEY,
  browser_id        TEXT NOT NULL,
  cdp_target_id     TEXT NOT NULL,
  session_id        TEXT,
  type              TEXT NOT NULL,
  subtype           TEXT,
  url               TEXT,
  title             TEXT,
  opener_target     TEXT,
  browser_context   TEXT,
  parent_handle     TEXT,
  attached_at       INTEGER NOT NULL,
  detached_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_targets_browser ON targets(browser_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_cdp ON targets(browser_id, cdp_target_id);

CREATE TABLE IF NOT EXISTS requests (
  request_handle        TEXT PRIMARY KEY,
  browser_id            TEXT NOT NULL,
  target_handle         TEXT,
  cdp_request_id        TEXT NOT NULL,
  hop                   INTEGER NOT NULL DEFAULT 0,
  frame_id              TEXT,
  loader_id             TEXT,
  document_url          TEXT,
  url                   TEXT NOT NULL,
  method                TEXT NOT NULL,
  resource_type         TEXT,
  request_headers       TEXT,
  request_headers_extra TEXT,
  post_data_blob        TEXT,
  post_data_size        INTEGER,
  post_data_state       TEXT,
  status                INTEGER,
  status_text           TEXT,
  response_headers      TEXT,
  response_headers_extra TEXT,
  mime_type             TEXT,
  protocol              TEXT,
  remote_ip             TEXT,
  remote_port           INTEGER,
  from_disk_cache       INTEGER,
  from_service_worker   INTEGER,
  from_prefetch_cache   INTEGER,
  served_from_cache     INTEGER,
  encoded_data_length   INTEGER,
  data_length           INTEGER,
  body_blob             TEXT,
  body_size             INTEGER,
  body_base64           INTEGER,
  body_state            TEXT NOT NULL DEFAULT 'pending',
  error_text            TEXT,
  blocked_reason        TEXT,
  canceled              INTEGER,
  initiator             TEXT,
  timing                TEXT,
  state                 TEXT NOT NULL DEFAULT 'pending',
  started_at            INTEGER NOT NULL,
  response_at           INTEGER,
  completed_at          INTEGER,
  wall_time             REAL
);
CREATE INDEX IF NOT EXISTS idx_requests_browser_started ON requests(browser_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_handle);
CREATE INDEX IF NOT EXISTS idx_requests_url ON requests(url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_cdp ON requests(browser_id, cdp_request_id, hop);

CREATE TABLE IF NOT EXISTS websockets (
  ws_handle         TEXT PRIMARY KEY,
  browser_id        TEXT NOT NULL,
  target_handle     TEXT,
  cdp_request_id    TEXT NOT NULL,
  url               TEXT NOT NULL,
  initiator         TEXT,
  handshake_status  INTEGER,
  handshake_headers TEXT,
  error_text        TEXT,
  created_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ws_browser ON websockets(browser_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_cdp ON websockets(browser_id, cdp_request_id);

CREATE TABLE IF NOT EXISTS ws_messages (
  message_handle    TEXT PRIMARY KEY,
  ws_handle         TEXT NOT NULL,
  browser_id        TEXT NOT NULL,
  direction         TEXT NOT NULL,
  opcode            INTEGER,
  payload           TEXT,
  payload_size      INTEGER,
  truncated         INTEGER NOT NULL DEFAULT 0,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wsmsg_ws ON ws_messages(ws_handle, ts);

CREATE TABLE IF NOT EXISTS console_entries (
  log_handle        TEXT PRIMARY KEY,
  browser_id        TEXT NOT NULL,
  target_handle     TEXT,
  source            TEXT NOT NULL,
  level             TEXT NOT NULL,
  text              TEXT,
  args              TEXT,
  url               TEXT,
  line_number       INTEGER,
  column_number     INTEGER,
  stack             TEXT,
  network_request   TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_console_browser ON console_entries(browser_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_console_level ON console_entries(browser_id, level);

CREATE TABLE IF NOT EXISTS exceptions (
  exception_handle  TEXT PRIMARY KEY,
  browser_id        TEXT NOT NULL,
  target_handle     TEXT,
  text              TEXT NOT NULL,
  description       TEXT,
  url               TEXT,
  line_number       INTEGER,
  column_number     INTEGER,
  stack             TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exceptions_browser ON exceptions(browser_id, ts DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_handle   TEXT PRIMARY KEY,
  browser_id        TEXT,
  kind              TEXT NOT NULL,
  label             TEXT,
  path              TEXT NOT NULL,
  mime              TEXT,
  size              INTEGER NOT NULL,
  sha256            TEXT,
  encoding          TEXT,
  source_ref        TEXT,
  meta              TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_browser ON artifacts(browser_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS navigations (
  nav_handle        TEXT PRIMARY KEY,
  browser_id        TEXT NOT NULL,
  target_handle     TEXT,
  frame_id          TEXT,
  url               TEXT NOT NULL,
  kind              TEXT NOT NULL,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nav_browser ON navigations(browser_id, ts DESC);
`;

export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL keeps the recorder writing while the MCP layer reads.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // SQLite ships no REGEXP implementation; register one so URL/text filters can
  // use real regexes instead of pulling rows into JS to post-filter.
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (typeof pattern !== 'string' || typeof value !== 'string') return 0;
    try {
      return new RegExp(pattern).test(value) ? 1 : 0;
    } catch {
      return 0;
    }
  });

  const row = db.pragma('user_version', { simple: true }) as number;
  if (row === 0) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (row > SCHEMA_VERSION) {
    throw new Error(
      `Database ${file} was written by a newer agent-browser (schema v${row} > v${SCHEMA_VERSION}).`,
    );
  }
  log.debug(`opened ${file} (schema v${SCHEMA_VERSION})`);
  return db;
}

/** JSON column helper: null-safe stringify. */
export function j(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** JSON column helper: null-safe parse. */
export function unj<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** SQLite has no boolean type; normalize on the way out. */
export function b(value: unknown): boolean {
  return value === 1 || value === true;
}
