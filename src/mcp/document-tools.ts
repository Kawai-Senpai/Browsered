/**
 * doc.* - the saved-page library and the site explorer.
 *
 * Kept in its own module rather than appended to tools.ts because that file is
 * already 2000+ lines of live-browser control, and this family is about
 * durable content: it is the one group of tools that mostly answers without
 * touching a browser at all.
 */
import { z } from 'zod';
import * as documentOps from '../ops/document.js';
import { op, type ToolDef } from './tools.js';

const browserId = {
  browser_id: z.string().optional().describe('Browser handle (br_*). Omit to use the only running browser, or auto-launch one.'),
};
const targetId = {
  target_id: z.string().optional().describe('Target handle (tgt_*). Omit for the active page.'),
};
const scope = { ...browserId, ...targetId };

/** Capture shaping, shared by doc.save and doc.crawl. */
const capture = {
  format: z
    .enum(['markdown', 'text'])
    .optional()
    .describe('Default "markdown": keeps headings, code fences, tables and link targets, which is what makes a saved API reference still readable. "text" is flat visible text.'),
  main_only: z
    .boolean()
    .optional()
    .describe('Default true: capture the <main>/<article> content and drop nav, sidebar and footer. Set false if the page has no content landmark and comes back short.'),
  selector: z.string().optional().describe('Capture only this element instead of letting main_only pick one.'),
  scroll: z
    .boolean()
    .optional()
    .describe('Default true: sweep the page until scrollHeight stops growing, so lazy-loaded and reveal-on-scroll sections are actually in the DOM before extraction. Turn off only for a page you know renders in full immediately.'),
  scroll_passes: z.number().optional().describe('Cap on sweeps (default 12, max 60). Raise for a long infinite-scroll list.'),
  scroll_pause_ms: z.number().optional().describe('Wait after each sweep for content to load (default 250).'),
  click_more: z
    .boolean()
    .optional()
    .describe('Also click "Load more" / "Show all" buttons between sweeps. Off by default because it is a real interaction, not just a scroll.'),
  settle_ms: z.number().optional().describe('Extra wait after scrolling, before extracting.'),
  max_links: z.number().optional().describe('Cap on links collected per page (default 500).'),
};

const findRule = z.object({
  name: z.string().optional().describe('Label for this rule in the results.'),
  regex: z.string().optional().describe('JavaScript regex run over the captured text. Groups are returned.'),
  text: z.string().optional().describe('Case-insensitive substring of the captured text.'),
  selector: z.string().optional().describe('CSS selector run against the live DOM.'),
  attribute: z.string().optional().describe('With selector: return this attribute instead of the element text.'),
  flags: z.string().optional().describe('Regex flags, e.g. "i". "g" is always applied.'),
  max: z.number().optional().describe('Cap on hits per page for this rule (default 20).'),
});

export const DOCUMENT_TOOLS: ToolDef[] = [
  {
    name: 'doc.save',
    description:
      'Capture a page as a saved document: scroll it until the lazy content has actually loaded, extract it as Markdown, store the full text as an artifact and index it for search. This is the tool for "read these docs" - save once, then answer from doc.search instead of re-fetching. Passing url navigates there first and returns immediately if that URL is already saved (refresh:true re-captures).',
    schema: {
      ...scope,
      ...capture,
      url: z.string().optional().describe('Navigate here first. Omit to capture the page already open.'),
      collection: z
        .string()
        .optional()
        .describe('Group this with related pages, e.g. "nextjs-docs". Filter and search by it later.'),
      label: z.string().optional().describe('Free-text tag for this capture.'),
      refresh: z.boolean().optional().describe('Re-capture even if this URL is already saved. Updates in place, keeping the same doc_id.'),
      find: z.array(findRule).optional().describe('Record regex / text / selector hits against this page.'),
      wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional(),
      timeout_ms: z.number().optional(),
      preview_chars: z.number().optional().describe('How much of the text to echo back (default 600, 0 for none).'),
    },
    handler: op(documentOps.save),
  },
  {
    name: 'doc.list',
    description:
      'What is in the library. Filter by site, collection, URL or title, sort by date, title, url, site, length or word count. group_by:"site" answers "which pages do I already have saved" in one row per site; group_by:"collection" does the same for collections. Reads the database only - no browser needed.',
    schema: {
      site: z.string().optional().describe('Hostname substring, e.g. "nextjs.org".'),
      collection: z.string().optional(),
      url_contains: z.string().optional(),
      title_contains: z.string().optional(),
      crawl_id: z.string().optional().describe('Only documents saved by this crawl (crl_*).'),
      since: z.union([z.string(), z.number()]).optional().describe('Relative ("7d") or ISO timestamp.'),
      until: z.union([z.string(), z.number()]).optional(),
      sort: z.enum(['fetched_at', 'updated_at', 'title', 'url', 'site', 'length', 'words']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      group_by: z.enum(['site', 'collection']).optional(),
    },
    handler: op(documentOps.list),
  },
  {
    name: 'doc.get',
    description:
      'One saved document: metadata, headings, recorded matches, and a line window of the text. Address it by doc_id or by url. The full text is an artifact, so artifact.search and artifact.read_lines work on it too.',
    schema: {
      doc_id: z.string().optional().describe('Document handle (doc_*).'),
      url: z.string().optional().describe('Any form of the saved URL; fragments and tracking parameters are ignored.'),
      start_line: z.number().optional().describe('First line of text to return (default 1).'),
      end_line: z.number().optional().describe('Last line (default 200).'),
      include_text: z.boolean().optional().describe('Set false for metadata only.'),
      include_links: z.boolean().optional().describe('Include the outbound links recorded at capture time.'),
    },
    handler: op(documentOps.get),
    readOnly: true,
  },
  {
    name: 'doc.search',
    description:
      'Search every saved page at once. Default mode is ranked full-text with snippets showing the match in context; terms are quoted and ANDed for you, so punctuation in a query is safe. mode:"regex" streams the stored text instead, for patterns full-text search cannot express (version numbers, identifiers, anything with wildcards). Scope with site or collection.',
    schema: {
      query: z.string().describe('Words to find, or a regex when mode is "regex".'),
      mode: z.enum(['fts', 'regex']).optional().describe('Default "fts" (ranked, with snippets).'),
      raw: z.boolean().optional().describe('fts mode: pass the query through as FTS5 syntax, for OR / NEAR / prefix*.'),
      site: z.string().optional(),
      collection: z.string().optional(),
      doc_id: z.string().optional().describe('regex mode: search inside one document.'),
      limit: z.number().optional(),
      snippet_tokens: z.number().optional().describe('fts mode: snippet width in tokens (default 16).'),
      ignore_case: z.boolean().optional().describe('regex mode.'),
      context_lines: z.number().optional().describe('regex mode: lines of context around each hit.'),
    },
    handler: op(documentOps.search),
    readOnly: true,
  },
  {
    name: 'doc.crawl',
    description:
      'Point at a starting page and explore outward, saving each page as a searchable document. Follows links breadth-first to max_depth, staying inside scope (same-origin by default) and honouring include/exclude regexes. find rules match regex, text or CSS selectors on every page and are stored with the results, so this doubles as "search a whole site for X". Every page is scrolled before extraction. Pages already saved are reused rather than re-fetched unless refresh:true. Each saved page is stored as it is visited, so a run cut short (client timeout or cancel) keeps everything it reached - doc.crawls shows it; progress notifications are sent per page when the client asks.',
    schema: {
      ...scope,
      ...capture,
      url: z.string().describe('Where to start. Must be absolute.'),
      max_depth: z.number().optional().describe('Link hops from the start page. 0 is that page alone; default 1, max 10.'),
      max_pages: z.number().optional().describe('Hard cap on pages visited (default 25, max 500). The crawl reports what was still queued.'),
      scope: z
        .enum(['same-origin', 'same-host', 'path-prefix', 'any'])
        .optional()
        .describe('Default "same-origin". "path-prefix" keeps to the starting URL\'s directory, which is how you crawl /docs without the marketing site. "any" leaves the site - pair it with include.'),
      include: z.array(z.string()).optional().describe('Only follow URLs matching one of these regexes.'),
      exclude: z.array(z.string()).optional().describe('Never follow URLs matching these. Checked before include.'),
      save: z.boolean().optional().describe('Default true. Set false to explore and match without storing documents.'),
      refresh: z.boolean().optional().describe('Re-capture pages already in the library instead of reusing them.'),
      collection: z.string().optional().describe('Name for this batch, e.g. "react-docs". Makes doc.search scoping easy afterwards.'),
      find: z.array(findRule).optional().describe('Regex / text / selector rules to run on every page.'),
      delay_ms: z.number().optional().describe('Pause between pages. Use it on someone else\'s server.'),
      stop_after_matches: z.number().optional().describe('Stop the crawl once this many find-hits have accumulated.'),
      page_timeout_ms: z
        .number()
        .optional()
        .describe('Hard deadline per page (default 60000). A page that misses it is recorded as an error, its tab is reset, and the crawl moves on.'),
      wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional(),
      timeout_ms: z.number().optional(),
    },
    handler: op(documentOps.crawl),
  },
  {
    name: 'doc.crawls',
    description:
      'Past crawl runs: what was explored, how far it got, what it saved and what it matched. Pass crawl_id for that run\'s documents and match hits.',
    schema: {
      crawl_id: z.string().optional().describe('Crawl handle (crl_*).'),
      site: z.string().optional(),
      limit: z.number().optional(),
      rule: z.string().optional().describe('With crawl_id: only hits from this find rule.'),
    },
    handler: op(documentOps.crawls),
    readOnly: true,
  },
  {
    name: 'doc.delete',
    description:
      'Remove saved documents. By doc_id or url it deletes one; by site, collection or crawl_id it lists what would go and needs confirm:true to actually do it. The text artifacts are left on disk for artifact tooling to reclaim.',
    schema: {
      doc_id: z.string().optional(),
      url: z.string().optional(),
      site: z.string().optional(),
      collection: z.string().optional(),
      crawl_id: z.string().optional(),
      confirm: z.boolean().optional().describe('Required for bulk deletion by site, collection or crawl_id.'),
    },
    handler: op(documentOps.remove),
  },
];
