/**
 * The saved-page library.
 *
 * Reading a documentation site costs a browser launch, a navigation, a scroll
 * sweep to trigger the lazy content, and an extraction - every single time.
 * This turns that into a one-off: a page is captured once, indexed, and from
 * then on answered from disk.
 *
 * Two storage paths, deliberately:
 *   - the full text is an artifact, so the existing artifact.read_lines /
 *     artifact.search / artifact.export tools work on a saved page with no new
 *     reader code, and a 2MB API reference never has to be resident;
 *   - a copy of the text lives in an FTS5 index, which is what makes ranked
 *     cross-document search with snippets possible at all.
 * The duplication is the price of both, and it is paid in disk, not context.
 *
 * Identity is the canonical URL, not the handle: saving the same page twice
 * updates the existing document and bumps its revision rather than growing a
 * pile of near-identical copies. `#fragment` and tracking parameters are
 * stripped before comparing, because they address a position on a page rather
 * than a different page.
 */
import { AgentBrowserError, NotFoundError } from '../util/errors.js';
import { mintId } from '../util/ids.js';
import { j, unj, type Db } from './db.js';

export interface DocumentRow {
  doc_handle: string;
  url: string;
  canonical_url: string;
  site: string;
  url_path: string | null;
  title: string | null;
  collection: string | null;
  label: string | null;
  format: string;
  text_length: number;
  word_count: number;
  artifact_handle: string | null;
  crawl_handle: string | null;
  depth: number | null;
  parent_url: string | null;
  links: string | null;
  headings: string | null;
  meta: string | null;
  browser_id: string | null;
  fetched_at: number;
  updated_at: number;
  revision: number;
}

export interface CrawlRow {
  crawl_handle: string;
  start_url: string;
  site: string;
  collection: string | null;
  config: string;
  status: string;
  pages_visited: number;
  pages_saved: number;
  matches_found: number;
  errors: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface MatchRow {
  match_handle: string;
  doc_handle: string;
  crawl_handle: string | null;
  rule: string;
  kind: string;
  value: string | null;
  detail: string | null;
  ts: number;
}

export interface DocumentFilter {
  site?: string;
  collection?: string;
  url_contains?: string;
  title_contains?: string;
  crawl_handle?: string;
  since?: number;
  until?: number;
  sort?: DocumentSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export type DocumentSort = 'fetched_at' | 'updated_at' | 'title' | 'url' | 'site' | 'length' | 'words';

const SORT_COLUMNS: Record<DocumentSort, string> = {
  fetched_at: 'fetched_at',
  updated_at: 'updated_at',
  title: 'title',
  url: 'canonical_url',
  site: 'site',
  length: 'text_length',
  words: 'word_count',
};

/*
 * Query parameters that address a marketing campaign rather than a document.
 * Two URLs differing only in these are the same page and must not be crawled,
 * stored or re-fetched twice.
 */
const TRACKING_PARAMS = /^(utm_|ref$|referrer$|fbclid$|gclid$|msclkid$|mc_(cid|eid)$|_ga$|igshid$)/i;

/**
 * The identity of a page, as opposed to a position within one.
 *
 * Fragments are dropped: `/api#install` and `/api#usage` are one document, and
 * treating them as two is how a crawler turns a ten-page site into a thousand
 * fetches of the same ten pages.
 */
export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AgentBrowserError('bad_url', `Not an absolute URL: ${JSON.stringify(input)}.`);
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  // A trailing slash on a directory-style path is cosmetic; on the root it is not.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Turn a plain query into FTS5 syntax.
 *
 * FTS5's query language treats `-`, `*`, `:` and `(` as operators, so passing a
 * user's words through raw turns "next.js app-router" into a syntax error. Each
 * bare term is quoted instead, which makes it a literal, and the terms are
 * ANDed. `raw` opts into the real grammar for callers that want NEAR or OR.
 */
export function toFtsQuery(query: string, raw = false): string {
  const trimmed = query.trim();
  if (!trimmed) throw new AgentBrowserError('empty_query', 'Search needs a non-empty query.');
  if (raw) return trimmed;
  // Respect explicit phrases: "exact wording" stays one term.
  const terms = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const quoted = terms
    .map((term) => {
      const bare = term.startsWith('"') && term.endsWith('"') ? term.slice(1, -1) : term;
      return `"${bare.replace(/"/g, '""')}"`;
    })
    .filter((t) => t !== '""');
  if (quoted.length === 0) throw new AgentBrowserError('empty_query', 'Search needs a non-empty query.');
  return quoted.join(' AND ');
}

export interface SaveDocumentInput {
  url: string;
  title?: string | null;
  text: string;
  format: string;
  collection?: string | null;
  label?: string | null;
  artifactHandle?: string | null;
  crawlHandle?: string | null;
  depth?: number | null;
  parentUrl?: string | null;
  links?: unknown;
  headings?: unknown;
  meta?: unknown;
  browserId?: string | null;
}

export class DocumentStore {
  constructor(private readonly db: Db) {}

  /**
   * Insert, or update the document already holding this canonical URL.
   *
   * The handle is stable across re-saves so anything that referenced the
   * document - a crawl result, a note an agent wrote down - still resolves
   * after a refresh.
   */
  save(input: SaveDocumentInput): { row: DocumentRow; created: boolean } {
    const canonical = canonicalizeUrl(input.url);
    const existing = this.getByUrl(canonical);
    const now = Date.now();
    const common = {
      url: input.url,
      canonical,
      site: siteOf(canonical),
      urlPath: pathOf(canonical),
      title: input.title ?? null,
      collection: input.collection ?? null,
      label: input.label ?? null,
      format: input.format,
      textLength: input.text.length,
      wordCount: wordCount(input.text),
      artifactHandle: input.artifactHandle ?? null,
      crawlHandle: input.crawlHandle ?? null,
      depth: input.depth ?? null,
      parentUrl: input.parentUrl ?? null,
      links: j(input.links),
      headings: j(input.headings),
      meta: j(input.meta),
      browserId: input.browserId ?? null,
    };

    const write = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE documents SET
               url = @url, site = @site, url_path = @urlPath, title = @title,
               collection = COALESCE(@collection, collection),
               label = COALESCE(@label, label),
               format = @format, text_length = @textLength, word_count = @wordCount,
               artifact_handle = @artifactHandle, crawl_handle = COALESCE(@crawlHandle, crawl_handle),
               depth = COALESCE(@depth, depth), parent_url = COALESCE(@parentUrl, parent_url),
               links = @links, headings = @headings, meta = @meta, browser_id = @browserId,
               updated_at = @now, revision = revision + 1
             WHERE doc_handle = @handle`,
          )
          .run({ ...common, now, handle: existing.doc_handle });
        const rowid = this.rowidOf(existing.doc_handle);
        this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(rowid);
        this.indexText(rowid, common.title, canonical, input.text);
        return { handle: existing.doc_handle, created: false };
      }

      const handle = mintId('doc');
      const info = this.db
        .prepare(
          `INSERT INTO documents (
             doc_handle, url, canonical_url, site, url_path, title, collection, label, format,
             text_length, word_count, artifact_handle, crawl_handle, depth, parent_url,
             links, headings, meta, browser_id, fetched_at, updated_at, revision
           ) VALUES (
             @handle, @url, @canonical, @site, @urlPath, @title, @collection, @label, @format,
             @textLength, @wordCount, @artifactHandle, @crawlHandle, @depth, @parentUrl,
             @links, @headings, @meta, @browserId, @now, @now, 1
           )`,
        )
        .run({ ...common, handle, now });
      this.indexText(Number(info.lastInsertRowid), common.title, canonical, input.text);
      return { handle, created: true };
    });

    const { handle, created } = write();
    return { row: this.require(handle), created };
  }

  private indexText(rowid: number, title: string | null, url: string, body: string): void {
    this.db
      .prepare(`INSERT INTO documents_fts (rowid, title, url, body) VALUES (?, ?, ?, ?)`)
      .run(rowid, title ?? '', url, body);
  }

  private rowidOf(handle: string): number {
    const row = this.db.prepare(`SELECT rowid AS id FROM documents WHERE doc_handle = ?`).get(handle) as
      | { id: number }
      | undefined;
    if (!row) throw new NotFoundError('document', handle);
    return row.id;
  }

  get(handle: string): DocumentRow | undefined {
    return this.db.prepare(`SELECT * FROM documents WHERE doc_handle = ?`).get(handle) as
      | DocumentRow
      | undefined;
  }

  require(handle: string): DocumentRow {
    const row = this.get(handle);
    if (!row) throw new NotFoundError('document', handle);
    return row;
  }

  /** Look up by URL in any form; the canonical key is derived here. */
  getByUrl(url: string): DocumentRow | undefined {
    const canonical = canonicalizeUrl(url);
    return this.db.prepare(`SELECT * FROM documents WHERE canonical_url = ?`).get(canonical) as
      | DocumentRow
      | undefined;
  }

  private whereFor(filter: DocumentFilter): { clause: string; params: Record<string, unknown> } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.site) {
      where.push("site LIKE '%' || @site || '%'");
      params.site = filter.site;
    }
    if (filter.collection) {
      where.push('collection = @collection');
      params.collection = filter.collection;
    }
    if (filter.url_contains) {
      where.push("canonical_url LIKE '%' || @urlContains || '%'");
      params.urlContains = filter.url_contains;
    }
    if (filter.title_contains) {
      where.push("title LIKE '%' || @titleContains || '%'");
      params.titleContains = filter.title_contains;
    }
    if (filter.crawl_handle) {
      where.push('crawl_handle = @crawlHandle');
      params.crawlHandle = filter.crawl_handle;
    }
    if (filter.since !== undefined) {
      where.push('fetched_at >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push('fetched_at <= @until');
      params.until = filter.until;
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(filter: DocumentFilter): { rows: DocumentRow[]; total: number } {
    const { clause, params } = this.whereFor(filter);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM documents ${clause}`).get(params) as { n: number }
    ).n;
    const column = SORT_COLUMNS[filter.sort ?? 'fetched_at'];
    const direction = (filter.order ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM documents ${clause} ORDER BY ${column} ${direction} LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...params,
        limit: Math.min(Math.max(filter.limit ?? 50, 1), 500),
        offset: Math.max(filter.offset ?? 0, 0),
      }) as DocumentRow[];
    return { rows, total };
  }

  /** "Which sites do I already have saved?" - the cheapest answer, one row each. */
  bySite(filter: DocumentFilter): Array<Record<string, unknown>> {
    const { clause, params } = this.whereFor(filter);
    return this.db
      .prepare(
        `SELECT site,
                COUNT(*)              AS documents,
                SUM(word_count)       AS words,
                MAX(fetched_at)       AS last_fetched,
                MIN(fetched_at)       AS first_fetched,
                GROUP_CONCAT(DISTINCT collection) AS collections
         FROM documents ${clause}
         GROUP BY site
         ORDER BY documents DESC, last_fetched DESC`,
      )
      .all(params) as Array<Record<string, unknown>>;
  }

  collections(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT collection, COUNT(*) AS documents, MAX(fetched_at) AS last_fetched
         FROM documents WHERE collection IS NOT NULL
         GROUP BY collection ORDER BY last_fetched DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  /**
   * Ranked full-text search over every saved page.
   *
   * bm25 is negative and ascending-better, which is why the score is negated on
   * the way out: a caller comparing two hits should not have to know that.
   */
  search(options: {
    query: string;
    raw?: boolean;
    site?: string;
    collection?: string;
    limit?: number;
    snippet_tokens?: number;
  }): Array<Record<string, unknown>> {
    const match = toFtsQuery(options.query, options.raw);
    const where = ['documents_fts MATCH @match'];
    const params: Record<string, unknown> = {
      match,
      limit: Math.min(Math.max(options.limit ?? 20, 1), 200),
    };
    if (options.site) {
      where.push("d.site LIKE '%' || @site || '%'");
      params.site = options.site;
    }
    if (options.collection) {
      where.push('d.collection = @collection');
      params.collection = options.collection;
    }
    const tokens = Math.min(Math.max(options.snippet_tokens ?? 16, 4), 64);

    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare(
          `SELECT d.*,
                  bm25(documents_fts) AS rank,
                  snippet(documents_fts, 2, '<<', '>>', ' … ', ${tokens}) AS snippet
           FROM documents_fts
           JOIN documents d ON d.rowid = documents_fts.rowid
           WHERE ${where.join(' AND ')}
           ORDER BY rank
           LIMIT @limit`,
        )
        .all(params) as Array<Record<string, unknown>>;
    } catch (err) {
      throw new AgentBrowserError(
        'bad_query',
        `FTS query rejected: ${(err as Error).message}. Terms are quoted automatically; pass raw:true only if you mean FTS5 operators such as OR / NEAR.`,
      );
    }
    return rows.map((row) => ({ ...row, rank: -(row.rank as number) }));
  }

  delete(handles: string[]): number {
    const remove = this.db.transaction((ids: string[]) => {
      let n = 0;
      for (const id of ids) {
        const row = this.db.prepare(`SELECT rowid AS id FROM documents WHERE doc_handle = ?`).get(id) as
          | { id: number }
          | undefined;
        if (!row) continue;
        this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(row.id);
        this.db.prepare(`DELETE FROM document_matches WHERE doc_handle = ?`).run(id);
        this.db.prepare(`DELETE FROM documents WHERE doc_handle = ?`).run(id);
        n++;
      }
      return n;
    });
    return remove(handles);
  }

  /* -------------------------------- matches ------------------------------- */

  recordMatches(
    docHandle: string,
    crawlHandle: string | null,
    matches: Array<{ rule: string; kind: string; value?: string | null; detail?: unknown }>,
  ): number {
    if (matches.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT INTO document_matches (match_handle, doc_handle, crawl_handle, rule, kind, value, detail, ts)
       VALUES (@handle, @docHandle, @crawlHandle, @rule, @kind, @value, @detail, @ts)`,
    );
    const write = this.db.transaction(() => {
      const now = Date.now();
      for (const m of matches) {
        insert.run({
          handle: mintId('dmx'),
          docHandle,
          crawlHandle,
          rule: m.rule,
          kind: m.kind,
          value: m.value ?? null,
          detail: j(m.detail),
          ts: now,
        });
      }
    });
    write();
    return matches.length;
  }

  /**
   * Mark an already-saved document as covered by this crawl.
   *
   * A crawl that meets a page it saved last week skips the fetch, which is the
   * point - but the run still visited it, and doc.list(crawl_id:) has to return
   * everything the crawl covered rather than only what it happened to re-fetch.
   */
  touchCrawl(docHandle: string, crawlHandle: string): void {
    this.db
      .prepare(`UPDATE documents SET crawl_handle = @crawl WHERE doc_handle = @handle`)
      .run({ crawl: crawlHandle, handle: docHandle });
  }

  matchesFor(docHandle: string, limit = 100): MatchRow[] {
    return this.db
      .prepare(`SELECT * FROM document_matches WHERE doc_handle = ? ORDER BY ts LIMIT ?`)
      .all(docHandle, Math.min(Math.max(limit, 1), 1000)) as MatchRow[];
  }

  matchesForCrawl(crawlHandle: string, rule?: string, limit = 200): MatchRow[] {
    const clause = rule ? 'AND rule = @rule' : '';
    return this.db
      .prepare(
        `SELECT * FROM document_matches WHERE crawl_handle = @crawl ${clause} ORDER BY ts LIMIT @limit`,
      )
      .all({ crawl: crawlHandle, rule, limit: Math.min(Math.max(limit, 1), 1000) }) as MatchRow[];
  }

  /* --------------------------------- crawls -------------------------------- */

  createCrawl(input: {
    startUrl: string;
    collection?: string | null;
    config: unknown;
  }): CrawlRow {
    const handle = mintId('crl');
    this.db
      .prepare(
        `INSERT INTO crawls (
           crawl_handle, start_url, site, collection, config, status,
           pages_visited, pages_saved, matches_found, started_at
         ) VALUES (@handle, @startUrl, @site, @collection, @config, 'running', 0, 0, 0, @now)`,
      )
      .run({
        handle,
        startUrl: input.startUrl,
        site: siteOf(input.startUrl),
        collection: input.collection ?? null,
        config: j(input.config) ?? '{}',
        now: Date.now(),
      });
    return this.requireCrawl(handle);
  }

  updateCrawl(
    handle: string,
    patch: {
      status?: string;
      pagesVisited?: number;
      pagesSaved?: number;
      matchesFound?: number;
      errors?: unknown;
      finished?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { handle };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params.status = patch.status;
    }
    if (patch.pagesVisited !== undefined) {
      sets.push('pages_visited = @pagesVisited');
      params.pagesVisited = patch.pagesVisited;
    }
    if (patch.pagesSaved !== undefined) {
      sets.push('pages_saved = @pagesSaved');
      params.pagesSaved = patch.pagesSaved;
    }
    if (patch.matchesFound !== undefined) {
      sets.push('matches_found = @matchesFound');
      params.matchesFound = patch.matchesFound;
    }
    if (patch.errors !== undefined) {
      sets.push('errors = @errors');
      params.errors = j(patch.errors);
    }
    if (patch.finished) {
      sets.push('finished_at = @finishedAt');
      params.finishedAt = Date.now();
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE crawls SET ${sets.join(', ')} WHERE crawl_handle = @handle`).run(params);
  }

  getCrawl(handle: string): CrawlRow | undefined {
    return this.db.prepare(`SELECT * FROM crawls WHERE crawl_handle = ?`).get(handle) as
      | CrawlRow
      | undefined;
  }

  requireCrawl(handle: string): CrawlRow {
    const row = this.getCrawl(handle);
    if (!row) throw new NotFoundError('crawl', handle);
    return row;
  }

  listCrawls(filter: { site?: string; limit?: number }): CrawlRow[] {
    const clause = filter.site ? "WHERE site LIKE '%' || @site || '%'" : '';
    return this.db
      .prepare(`SELECT * FROM crawls ${clause} ORDER BY started_at DESC LIMIT @limit`)
      .all({ site: filter.site, limit: Math.min(Math.max(filter.limit ?? 20, 1), 200) }) as CrawlRow[];
  }
}

/** Compact shape for listings: everything a caller needs to pick a document. */
export function toDocumentRef(row: DocumentRow): Record<string, unknown> {
  return {
    doc_id: row.doc_handle,
    url: row.canonical_url,
    site: row.site,
    title: row.title,
    collection: row.collection,
    format: row.format,
    words: row.word_count,
    chars: row.text_length,
    revision: row.revision,
    fetched_at: new Date(row.fetched_at).toISOString(),
    ...(row.updated_at !== row.fetched_at
      ? { updated_at: new Date(row.updated_at).toISOString() }
      : {}),
    ...(row.artifact_handle ? { artifact_id: row.artifact_handle } : {}),
    ...(row.crawl_handle ? { crawl_id: row.crawl_handle } : {}),
    ...(row.depth === null ? {} : { depth: row.depth }),
  };
}

export function documentHeadings(row: DocumentRow): unknown {
  return unj(row.headings) ?? [];
}

export function documentLinks(row: DocumentRow): string[] {
  return (unj<string[]>(row.links) ?? []) as string[];
}
