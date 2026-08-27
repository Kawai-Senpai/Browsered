import { readFileSync } from 'node:fs';
import { toArtifactRef } from '../store/artifact-store.js';
import { toRequestDetail, type RequestRow } from '../store/network-store.js';
import { AgentBrowserError } from '../util/errors.js';
import { createZip, type ZipEntry } from '../util/zip.js';
import { exportLogs } from './console.js';
import { parseSince, resolveBrowserScope, type OpsContext } from './context.js';
import { exportHar } from './network.js';

export interface CaptureArgs {
  browser_id?: string;
  /** Window start. Relative ("10m") or absolute; defaults to the last 10 minutes. */
  since?: string | number;
  until?: string | number;
  /** Embed response and request bodies in the HAR. Default true. */
  include_bodies?: boolean;
  /** Mask credentials in headers, cookies and URLs. Default true. */
  redact?: boolean;
  /** Where to write the .zip. Defaults to the capsules directory. */
  save_path?: string;
  /** Free-text description of what the tester saw. */
  note?: string;
}

/**
 * Header names whose values are credentials rather than context. Matched as
 * whole names, not substrings: "x-content-type-options" must not match on
 * "content", and a substring rule would quietly mask half the useful headers.
 */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'api-key',
  'auth-token',
  'session-id',
]);

/** Query parameters that carry credentials in the URL itself. */
const SECRET_QUERY_PARAMS =
  /^(access_token|id_token|refresh_token|token|api_key|apikey|key|signature|sig|password)$/i;

const MASK = '[redacted]';

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? MASK : value;
  }
  return out;
}

/**
 * Mask credential-bearing query parameters while leaving the rest of the URL
 * readable: a tester filing a bug needs to see which endpoint was called.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.test(key)) {
        parsed.searchParams.set(key, MASK);
        touched = true;
      }
    }
    return touched ? parsed.toString() : url;
  } catch {
    // Not every recorded URL parses (data:, blob:, malformed redirects).
    return url;
  }
}

/**
 * Redact URLs embedded anywhere inside free text.
 *
 * Console entries are not structured the way network rows are: a browser-
 * generated "Failed to load resource" carries the offending URL whole, and a
 * page is free to log one inside a sentence. Masking only the `url` field would
 * leave the token sitting in `text` two keys over.
 */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

function redactText(value: string): string {
  // Console output carries both shapes: a logged URL with a token in the query,
  // and a logged token on its own.
  return redactBody(value.replace(URL_IN_TEXT, (match) => redactUrl(match)));
}

/*
 * Secrets that live in a payload rather than a header.
 *
 * Headers and URLs are structured, so those are masked by name. A body is just
 * text, so these go after the two shapes that actually carry credentials in
 * practice: a JWT, and a JSON field whose *name* says it is a secret. Both are
 * specific enough not to chew through ordinary HTML or minified JS - which
 * matters, because the body is usually the reason the bundle is worth reading.
 *
 * This is a net, not a guarantee. A credential under an unrecognised field name
 * still rides along, which is why the summary says bodies are included.
 */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** "access_token": "..." and friends, including single quotes and whitespace. */
const SECRET_JSON_FIELD =
  /(["']?(?:access_token|refresh_token|id_token|client_secret|api_?key|apiSecret|auth_?token|session_?token|password|passwd|secret|credential)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/gi;

function redactBody(text: string): string {
  return text
    .replace(JWT, MASK)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${MASK}`)
    .replace(SECRET_JSON_FIELD, (_m, head: string, quote: string) => `${head}${quote}${MASK}${quote}`);
}

/** Apply the text redaction to every string in a decoded JSON value. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(inner);
    }
    return out;
  }
  return value;
}

/** Redact an NDJSON export line by line, leaving unparseable lines masked as text. */
function redactNdjson(ndjson: string): string {
  return ndjson
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactDeep(JSON.parse(line)));
      } catch {
        return redactText(line);
      }
    })
    .join('\n');
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/**
 * Rebuild each request as a runnable curl command.
 *
 * This is the artifact a developer actually reruns, so it reflects what the
 * browser put on the wire: the *ExtraInfo headers where we have them, falling
 * back to the pre-flight set where we do not.
 */
function buildCurls(ctx: OpsContext, rows: RequestRow[], redact: boolean): string {
  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# Requests replayed from a browserd capture.',
    '#',
    ...(redact
      ? [
          '# Credentials are masked as [redacted]. Fill them in before running,',
          '# or recapture with --no-redact if you need them verbatim.',
        ]
      : ['# WARNING: these commands carry live credentials. Do not paste them anywhere public.']),
    '',
  ];

  for (const row of rows) {
    const detail = toRequestDetail(row) as Record<string, unknown>;
    const wire = detail.request_headers_wire as Record<string, string> | null;
    const headers = wire ?? (detail.request_headers as Record<string, string>);
    const safeHeaders = redact ? redactHeaders(headers) : headers;
    const url = redact ? redactUrl(row.url) : row.url;

    const parts = ['curl -i -X ' + row.method + ' ' + shellQuote(url)];
    for (const [name, value] of Object.entries(safeHeaders)) {
      // Pseudo-headers are an HTTP/2 framing detail; curl rejects them.
      if (name.startsWith(':')) continue;
      parts.push('  -H ' + shellQuote(name + ': ' + value));
    }
    if (row.post_data_blob) {
      const body = ctx.stores.blobs.get(row.post_data_blob);
      if (body) {
        const text = body.toString('utf8');
        parts.push('  --data-raw ' + shellQuote(redact ? redactBody(text) : text));
      }
    }

    const status = row.status === null ? (row.error_text ?? 'pending') : String(row.status);
    lines.push('# ' + new Date(row.started_at).toISOString() + '  ->  ' + status);
    lines.push(parts.join(' \\\n'));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Redact inside an already-built HAR, so HAR construction stays one
 * implementation rather than gaining a redacting twin.
 */
function redactHar(har: Record<string, unknown>): void {
  const log = har.log as { entries?: Array<Record<string, unknown>> } | undefined;
  const maskList = (headers: unknown): unknown =>
    Array.isArray(headers)
      ? headers.map((h: { name: string; value: string }) =>
          SECRET_HEADERS.has(h.name.toLowerCase()) ? { ...h, value: MASK } : h,
        )
      : headers;

  for (const entry of log?.entries ?? []) {
    const request = entry.request as Record<string, unknown> | undefined;
    const response = entry.response as Record<string, unknown> | undefined;
    if (request) {
      request.url = redactUrl(String(request.url));
      request.headers = maskList(request.headers);
      const post = request.postData as { text?: string } | undefined;
      if (typeof post?.text === 'string') post.text = redactBody(post.text);
    }
    if (response) {
      response.headers = maskList(response.headers);
      const content = response.content as { text?: string } | undefined;
      if (typeof content?.text === 'string') content.text = redactBody(content.text);
    }
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Bundle a time slice of the recording into a single zip a tester can attach
 * to a bug report.
 *
 * Everything here is read back out of SQLite, so the window is chosen *after*
 * the bug happened rather than armed before it. That is the whole point: a
 * tester cannot predict which click will break, but the recorders were on the
 * entire time.
 */
export async function bundle(ctx: OpsContext, args: CaptureArgs): Promise<Record<string, unknown>> {
  const { browserId } = await resolveBrowserScope(ctx, args.browser_id);
  const redact = args.redact !== false;
  const includeBodies = args.include_bodies !== false;
  /*
   * An unparseable window must not fall through to "no lower bound". Silently
   * bundling the entire recording because someone typed "10min" would produce
   * a huge zip that looks like it worked.
   */
  const requestedSince = args.since ?? '10m';
  const since = parseSince(requestedSince);
  if (since === undefined) {
    throw new AgentBrowserError(
      'bad_time_window',
      `Could not read "${requestedSince}" as a time window. Use a relative window like 10m, 90s or 1h, or an ISO timestamp.`,
    );
  }
  const until = parseSince(args.until);
  const capturedAt = new Date();

  const window = { since, ...(until === undefined ? {} : { until }) };

  // Reuse the shipped exporters rather than rebuilding HAR and NDJSON here.
  const harResult = await exportHar(ctx, {
    browser_id: browserId,
    ...window,
    include_bodies: includeBodies,
  });
  const harRef = harResult.artifact as Record<string, unknown>;
  const har = JSON.parse(readFileSync(String(harRef.path), 'utf8')) as Record<string, unknown>;
  if (redact) redactHar(har);

  const consoleResult = await exportLogs(ctx, {
    browser_id: browserId,
    ...window,
    include_exceptions: true,
  });
  const consoleRef = consoleResult.artifact as Record<string, unknown>;
  const consoleRaw = readFileSync(String(consoleRef.path), 'utf8');
  const consoleNdjson = redact ? redactNdjson(consoleRaw) : consoleRaw;

  const requests = ctx.stores.network.list({
    browserId,
    ...window,
    limit: 5000,
    offset: 0,
    order: 'asc',
  });
  const failures = requests.filter((r) => r.error_text || (r.status !== null && r.status >= 400));
  const errors = ctx.stores.console.listEntries({ browserId, ...window, level: 'error', limit: 1000 });
  const exceptions = ctx.stores.console.listExceptions({ browserId, ...window, limit: 500 });

  // listNavigations has no time filter of its own; slice the recent page.
  const navigations = ctx.stores.targets
    .listNavigations({ browserId, limit: 500 })
    .filter((n) => n.ts >= since && (until === undefined || n.ts <= until))
    .sort((a, b) => a.ts - b.ts);

  const windowEnd = until ?? capturedAt.getTime();
  const manifest = {
    tool: 'browserd capture',
    browser_id: browserId,
    captured_at: capturedAt.toISOString(),
    window: {
      from: new Date(since).toISOString(),
      to: new Date(windowEnd).toISOString(),
      duration: formatDuration(windowEnd - since),
    },
    note: args.note ?? null,
    redacted: redact,
    bodies_included: includeBodies,
    counts: {
      requests: requests.length,
      failed_requests: failures.length,
      console_errors: errors.length,
      exceptions: exceptions.length,
      navigations: navigations.length,
    },
  };

  const summary = [
    '# Capture bundle',
    '',
    args.note ? `**What happened:** ${args.note}` : '_No note recorded._',
    '',
    `- Window: ${manifest.window.from} to ${manifest.window.to} (${manifest.window.duration})`,
    `- Browser: ${browserId}`,
    `- Credentials: ${
      redact
        ? 'headers, URLs and console text masked as [redacted]; bodies scanned for JWTs and secret-named fields, but a credential under an unusual field name can still be in here'
        : 'NOT masked - treat this bundle as a secret'
    }`,
    '',
    '## What is in here',
    '',
    `- \`network.har\` - ${requests.length} requests${includeBodies ? ' with bodies' : ' (metadata only)'}. Import it in DevTools > Network.`,
    '- `curls.sh` - the same requests as runnable curl commands.',
    '- `console.ndjson` - console output and uncaught exceptions, one JSON object per line.',
    '- `navigations.json` - pages visited during the window.',
    '- `manifest.json` - machine-readable version of this summary.',
    '',
    '## Failed requests',
    '',
    failures.length
      ? failures
          .slice(0, 50)
          .map((r) => {
            const url = redact ? redactUrl(r.url) : r.url;
            const why = r.error_text ? ` (${r.error_text})` : '';
            return `- ${r.status ?? 'ERR'} ${r.method} ${url}${why}`;
          })
          .join('\n')
      : '_None._',
    '',
    '## Uncaught exceptions',
    '',
    exceptions.length
      ? exceptions
          .slice(0, 50)
          .map((e) => {
            // `text` is usually the bare word "Uncaught"; the message a reader
            // needs is on `description`. Prefer it, and keep it to one line.
            const message = (e.description ?? e.text).split('\n')[0]!;
            const where = e.url ? ` (${e.url}${e.line_number === null ? '' : `:${e.line_number}`})` : '';
            return `- ${redact ? redactText(message + where) : message + where}`;
          })
          .join('\n')
      : '_None._',
    '',
    `_${errors.length} console error(s) in this window; see console.ndjson for the rest._`,
    '',
  ].join('\n');

  const entries: ZipEntry[] = [
    { name: 'summary.md', data: summary },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'network.har', data: JSON.stringify(har, null, 2) },
    { name: 'curls.sh', data: buildCurls(ctx, requests, redact) },
    { name: 'console.ndjson', data: consoleNdjson },
    {
      name: 'navigations.json',
      data: JSON.stringify(
        navigations.map((n) => ({ ...n, at: new Date(n.ts).toISOString() })),
        null,
        2,
      ),
    },
  ];

  const stamp = capturedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zip = createZip(entries, capturedAt);
  const artifact = ctx.stores.artifacts.put('debug_bundle', zip, {
    browserId,
    label: `capture-${stamp}`,
    mime: 'application/zip',
    meta: manifest,
  });

  const out: Record<string, unknown> = {
    browser_id: browserId,
    window: manifest.window,
    counts: manifest.counts,
    redacted: redact,
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}
