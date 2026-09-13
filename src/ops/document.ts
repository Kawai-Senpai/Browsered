/**
 * Save a page once, read it forever - and explore a site to find the pages
 * worth saving.
 *
 * The problem this exists for: documentation. Reading one costs a navigation, a
 * scroll sweep to make the lazily-revealed sections actually render, and an
 * extraction, and none of that is cached, so the same reference page is fetched
 * again on the next question. `doc.save` makes the capture durable and
 * searchable; `doc.crawl` walks a site and does it in bulk.
 *
 * Three things are load-bearing:
 *
 * Scrolling before extracting, not after. Content behind IntersectionObserver
 * ("reveal on scroll") and infinite-scroll lists is simply not in the DOM until
 * something scrolls, so an extraction taken on arrival silently returns a third
 * of the page and looks like a complete one. autoScroll sweeps until
 * scrollHeight stops growing rather than sweeping a fixed number of times,
 * because the number of passes a list needs is a property of the list.
 *
 * Markdown over innerText for documentation. Headings, code fences, tables and
 * link targets are the parts of an API reference that carry the meaning, and
 * innerText throws all four away - a code block becomes indistinguishable from
 * prose, and "see the options table" becomes unreadable.
 *
 * The canonical URL is the identity. Re-saving updates in place, so a refresh
 * does not fork the library, and a crawl that meets the same page by two routes
 * fetches it once.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserInstance } from '../browser/instance.js';
import type { ManagedTarget } from '../browser/target-manager.js';
import { toArtifactRef } from '../store/artifact-store.js';
import {
  canonicalizeUrl,
  documentHeadings,
  siteOf,
  toDocumentRef,
  type DocumentRow,
  type DocumentSort,
} from '../store/document-store.js';
import { unj } from '../store/db.js';
import { AgentBrowserError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { evaluate } from './element.js';
import type { OpsContext } from './context.js';
import { navigate, VISIBLE_TEXT_FN } from './page.js';
import { parseSince } from './context.js';

const log = createLogger('ops:document');

/* ------------------------------- page scripts ------------------------------ */

/**
 * Sweep the page until it stops growing.
 *
 * A fixed number of passes is the obvious implementation and the wrong one: a
 * changelog with 400 entries needs far more passes than a three-section
 * reference, and hard-coding either penalises the other. Height stability over
 * two consecutive passes is the signal that there is nothing left to reveal.
 */
const AUTO_SCROLL_FN = `(async (opts) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const height = () => Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );
  const MORE = /^(load|show|see|view)\\s+(more|all|older)|^more$|^next$/i;

  const start = window.scrollY;
  let previous = height();
  let stable = 0;
  let passes = 0;
  let clicks = 0;

  for (let p = 0; p < opts.maxPasses; p++) {
    passes++;
    const step = Math.max(200, Math.round(innerHeight * 0.8));
    for (let y = 0; y < height(); y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await sleep(opts.stepMs);
    }
    window.scrollTo({ top: height(), behavior: 'instant' });
    await sleep(opts.pauseMs);

    if (opts.clickMore) {
      const buttons = document.querySelectorAll('button, a[role="button"], [role="button"]');
      for (const el of buttons) {
        const label = (el.innerText || el.textContent || '').trim();
        if (label.length > 40 || !MORE.test(label)) continue;
        if (el.offsetParent === null || el.disabled) continue;
        el.click();
        clicks++;
        await sleep(opts.pauseMs);
        break;
      }
    }

    const now = height();
    if (now <= previous) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    previous = Math.max(previous, now);
  }

  window.scrollTo({ top: start, behavior: 'instant' });
  await sleep(60);
  return { passes, clicks, height: previous, settled: stable >= 2 };
})`;

/**
 * Structure worth keeping: headings for navigation, links for the crawler,
 * and the page metadata that says what this document actually is.
 */
const PAGE_INFO_FN = `((limit, rootSelector) => {
  // Zero-width characters are what documentation generators put inside heading
  // permalinks, and they survive trim().
  const strip = (s) => s.replace(/[\\u200b-\\u200d\\ufeff]/g, '').trim();
  const absolute = (href) => {
    try {
      const u = new URL(href, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.href;
    } catch { return null; }
  };

  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const url = absolute(a.getAttribute('href'));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url: url, text: (a.textContent || '').trim().slice(0, 120) });
    if (links.length >= limit) break;
  }

  // Links come from the whole document because that is how a crawl discovers a
  // site - the nav is the site map. Headings come from the content root only,
  // because they describe this document, and a sidebar's worth of section links
  // listed ahead of the real h1 describes the template instead.
  const headingRoot = (rootSelector && document.querySelector(rootSelector)) || document.body;
  const headings = [];
  if (headingRoot) {
    for (const h of headingRoot.querySelectorAll('h1, h2, h3, h4')) {
      const text = strip(h.innerText || h.textContent || '');
      if (text) headings.push({ level: Number(h.tagName[1]), text: text.slice(0, 200) });
      if (headings.length >= 300) break;
    }
  }

  const metaContent = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.getAttribute('content') : null;
  };

  const canonical = document.querySelector('link[rel="canonical"]');
  return {
    title: document.title || null,
    description:
      metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
    lang: document.documentElement.lang || null,
    canonical: canonical ? canonical.href : null,
    robots: metaContent('meta[name="robots"]'),
    links: links,
    headings: headings,
    link_count: document.querySelectorAll('a[href]').length,
  };
})`;

/**
 * DOM to Markdown.
 *
 * Deliberately narrow: headings, paragraphs, lists, tables, code and links, and
 * nothing else. A general HTML-to-Markdown converter has to make a decision
 * about every tag on the web; this one only has to keep the structure a
 * documentation page carries, and anything it does not recognise is descended
 * into rather than dropped.
 */
const MARKDOWN_FN = `function (root, stripChrome) {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','IFRAME','CANVAS','SVG','BUTTON','SELECT']);
  const CHROME = new Set(['NAV','FOOTER','ASIDE']);

  const hidden = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    if (Math.abs(parseFloat(s.textIndent) || 0) > 9000) return true;
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  };

  const inline = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (SKIP.has(tag)) continue;
      if (tag === 'BR') { out += '\\n'; continue; }
      if (tag === 'CODE' && child.closest('pre') === null) {
        out += '\\u0060' + (child.textContent || '').trim() + '\\u0060';
        continue;
      }
      if (tag === 'A') {
        // Documentation generators put a zero-width-space anchor link inside
        // every heading. Rendered literally that is '## [\\u200b](url)' before
        // the real heading text, which is noise in the saved document and noise
        // in the search index.
        const text = inline(child).replace(/[\\u200b-\\u200d\\ufeff]/g, '').trim();
        if (!text) continue;
        const href = child.getAttribute('href') || '';
        let resolved = '';
        try { resolved = href ? new URL(href, location.href).href : ''; } catch { resolved = ''; }
        out += resolved ? '[' + text + '](' + resolved + ')' : text;
        continue;
      }
      if (tag === 'STRONG' || tag === 'B') { out += '**' + inline(child).trim() + '**'; continue; }
      if (tag === 'EM' || tag === 'I') { out += '*' + inline(child).trim() + '*'; continue; }
      if (tag === 'IMG') {
        const alt = (child.getAttribute('alt') || '').trim();
        if (alt) out += '![' + alt + ']';
        continue;
      }
      out += inline(child);
    }
    return out;
  };

  const clean = (s) => s.replace(/[ \\t]+/g, ' ').replace(/ ?\\n ?/g, '\\n').trim();
  const lines = [];

  const walk = (node, depth) => {
    for (const el of node.children) {
      const tag = el.tagName;
      if (SKIP.has(tag)) continue;
      if (stripChrome && CHROME.has(tag)) continue;
      if (hidden(el)) continue;

      if (/^H[1-6]$/.test(tag)) {
        const text = clean(inline(el));
        if (text) lines.push('', '#'.repeat(Number(tag[1])) + ' ' + text, '');
        continue;
      }
      if (tag === 'PRE') {
        const code = (el.textContent || '').replace(/\\s+$/, '');
        if (code) {
          const langAttr = el.querySelector('code');
          const cls = (langAttr && langAttr.className) || el.className || '';
          const m = /(?:language|lang)-([A-Za-z0-9+#]+)/.exec(cls);
          lines.push('', '\\u0060\\u0060\\u0060' + (m ? m[1] : ''), code, '\\u0060\\u0060\\u0060', '');
        }
        continue;
      }
      if (tag === 'P') {
        const text = clean(inline(el));
        if (text) lines.push(text, '');
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        let n = 1;
        for (const li of el.children) {
          if (li.tagName !== 'LI') continue;
          const nested = li.querySelector(':scope > ul, :scope > ol');
          const own = nested ? li.cloneNode(true) : li;
          if (nested) {
            for (const sub of own.querySelectorAll(':scope > ul, :scope > ol')) sub.remove();
          }
          const text = clean(inline(own)).split('\\n').join(' ');
          if (text) {
            lines.push('  '.repeat(depth) + (tag === 'OL' ? n++ + '. ' : '- ') + text);
          }
          if (nested) walk(li, depth + 1);
        }
        lines.push('');
        continue;
      }
      if (tag === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tr')).slice(0, 300);
        if (rows.length === 0) continue;
        const cells = (tr) =>
          Array.from(tr.children).map((td) =>
            clean(inline(td)).split('\\n').join(' ').split('|').join('\\\\|'),
          );
        const head = cells(rows[0]);
        if (head.length === 0) continue;
        lines.push('', '| ' + head.join(' | ') + ' |');
        lines.push('| ' + head.map(() => '---').join(' | ') + ' |');
        for (const tr of rows.slice(1)) {
          const row = cells(tr);
          if (row.length) lines.push('| ' + row.join(' | ') + ' |');
        }
        lines.push('');
        continue;
      }
      if (tag === 'BLOCKQUOTE') {
        const text = clean(inline(el));
        if (text) lines.push('> ' + text.split('\\n').join('\\n> '), '');
        continue;
      }
      if (tag === 'HR') { lines.push('', '---', ''); continue; }

      if (el.children.length === 0) {
        const text = clean(inline(el));
        if (text) lines.push(text, '');
        continue;
      }
      walk(el, depth);
    }
  };

  walk(root, 0);
  return lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`;

/**
 * The element holding the actual document.
 *
 * A documentation page is mostly navigation by volume - sidebar, header, table
 * of contents, footer - and capturing all of it means every saved page shares
 * 80% of its text with every other page on the site, which wrecks search
 * ranking as much as it wastes space. The usual content landmarks are tried in
 * order and only accepted if they actually hold prose.
 */
const MAIN_ROOT_FN = `((mainOnly) => {
  if (!mainOnly || !document.body) return null;
  const candidates = ['main', '[role="main"]', 'article', '.markdown-body', '.prose', '#content', '#main-content', '#docs-content'];
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (el && (el.innerText || '').trim().length > 200) return selector;
  }
  return null;
})`;

/* -------------------------------- capture --------------------------------- */

export interface CaptureOptions {
  format?: 'markdown' | 'text';
  main_only?: boolean;
  selector?: string;
  scroll?: boolean;
  scroll_passes?: number;
  scroll_pause_ms?: number;
  click_more?: boolean;
  settle_ms?: number;
  max_links?: number;
}

interface Captured {
  url: string;
  title: string | null;
  text: string;
  format: string;
  root_selector: string | null;
  links: Array<{ url: string; text: string }>;
  headings: Array<{ level: number; text: string }>;
  meta: Record<string, unknown>;
  scroll: Record<string, unknown> | null;
}

/** Everything a saved document is made of, read from one page in one pass. */
async function capture(
  instance: BrowserInstance,
  target: ManagedTarget,
  options: CaptureOptions,
): Promise<Captured> {
  const format = options.format ?? 'markdown';

  let scroll: Record<string, unknown> | null = null;
  if (options.scroll !== false) {
    const opts = {
      maxPasses: Math.min(Math.max(options.scroll_passes ?? 12, 1), 60),
      stepMs: 40,
      pauseMs: Math.min(Math.max(options.scroll_pause_ms ?? 250, 50), 5000),
      clickMore: options.click_more === true,
    };
    try {
      const { result } = await evaluate(instance, target, {
        expression: `(${AUTO_SCROLL_FN})(${JSON.stringify(opts)})`,
        returnByValue: true,
        awaitPromise: true,
      });
      scroll = (result.value as Record<string, unknown>) ?? null;
    } catch (err) {
      // A page that refuses to be scrolled still has text worth capturing.
      log.debug(`auto-scroll failed on ${target.handle}: ${(err as Error).message}`);
      scroll = { error: (err as Error).message };
    }
  }

  if (options.settle_ms) await delay(Math.min(options.settle_ms, 30_000));

  let rootSelector = options.selector ?? null;
  if (!rootSelector) {
    const { result } = await evaluate(instance, target, {
      expression: `(${MAIN_ROOT_FN})(${options.main_only !== false})`,
      returnByValue: true,
    });
    rootSelector = (result.value as string | null) ?? null;
  }

  const rootExpression = rootSelector
    ? `document.querySelector(${JSON.stringify(rootSelector)})`
    : 'document.body';
  const stripChrome = options.main_only !== false;
  const textExpression =
    format === 'markdown'
      ? `(function () { const r = ${rootExpression}; return r ? (${MARKDOWN_FN})(r, ${stripChrome}) : ''; })()`
      : `(function () { const r = ${rootExpression}; return r ? (${VISIBLE_TEXT_FN})(r) : ''; })()`;

  const { result: textResult } = await evaluate(instance, target, {
    expression: textExpression,
    returnByValue: true,
  });
  const text = String(textResult.value ?? '');

  const { result: infoResult } = await evaluate(instance, target, {
    expression: `(${PAGE_INFO_FN})(${Math.min(Math.max(options.max_links ?? 500, 0), 3000)}, ${JSON.stringify(rootSelector)})`,
    returnByValue: true,
  });
  const info = (infoResult.value ?? {}) as Record<string, unknown>;

  const { result: urlResult } = await evaluate(instance, target, {
    expression: 'location.href',
    returnByValue: true,
  });

  return {
    url: String(urlResult.value ?? target.info.url ?? ''),
    title: (info.title as string | null) ?? null,
    text,
    format,
    root_selector: rootSelector,
    links: (info.links as Array<{ url: string; text: string }>) ?? [],
    headings: (info.headings as Array<{ level: number; text: string }>) ?? [],
    meta: {
      description: info.description ?? null,
      lang: info.lang ?? null,
      canonical: info.canonical ?? null,
      robots: info.robots ?? null,
      link_count: info.link_count ?? 0,
      root_selector: rootSelector,
      ...(scroll ? { scroll } : {}),
    },
    scroll,
  };
}

/** Persist a capture: text to an artifact, metadata and index to SQLite. */
function persist(
  ctx: OpsContext,
  captured: Captured,
  extra: {
    browserId: string;
    collection?: string | undefined;
    label?: string | undefined;
    crawlHandle?: string | null;
    depth?: number | null;
    parentUrl?: string | null;
    httpStatus?: number | null;
  },
): { row: DocumentRow; created: boolean; artifactId: string } {
  const artifact = ctx.stores.artifacts.put('page_document', Buffer.from(captured.text, 'utf8'), {
    browserId: extra.browserId,
    label: extra.label ?? `doc-${siteOf(captured.url)}`,
    mime: captured.format === 'markdown' ? 'text/plain' : 'text/plain',
    sourceRef: captured.url,
    meta: { url: captured.url, title: captured.title, format: captured.format },
  });

  const { row, created } = ctx.stores.documents.save({
    url: captured.url,
    title: captured.title,
    text: captured.text,
    format: captured.format,
    collection: extra.collection ?? null,
    label: extra.label ?? null,
    artifactHandle: artifact.artifact_handle,
    crawlHandle: extra.crawlHandle ?? null,
    depth: extra.depth ?? null,
    parentUrl: extra.parentUrl ?? null,
    links: captured.links.map((l) => l.url),
    headings: captured.headings,
    meta: {
      ...captured.meta,
      ...(extra.httpStatus === undefined || extra.httpStatus === null
        ? {}
        : { http_status: extra.httpStatus }),
      link_texts: captured.links.slice(0, 200),
    },
    browserId: extra.browserId,
  });

  return { row, created, artifactId: artifact.artifact_handle };
}

/* ------------------------------- match rules ------------------------------ */

export interface FindRule {
  name?: string;
  regex?: string;
  text?: string;
  selector?: string;
  attribute?: string;
  flags?: string;
  max?: number;
}

interface Match {
  rule: string;
  kind: string;
  value: string | null;
  detail?: unknown;
}

function ruleName(rule: FindRule, index: number): string {
  return rule.name ?? rule.regex ?? rule.text ?? rule.selector ?? `rule_${index}`;
}

/** Text and regex rules run over the captured document, not the live DOM. */
function matchInText(text: string, rules: FindRule[]): Match[] {
  const out: Match[] = [];
  rules.forEach((rule, index) => {
    const name = ruleName(rule, index);
    const cap = Math.min(Math.max(rule.max ?? 20, 1), 500);

    if (rule.regex) {
      let re: RegExp;
      try {
        re = new RegExp(rule.regex, rule.flags?.includes('g') ? rule.flags : `${rule.flags ?? ''}g`);
      } catch (err) {
        throw new AgentBrowserError('bad_regex', `Rule ${name}: invalid regex - ${(err as Error).message}`);
      }
      let hit: RegExpExecArray | null;
      let n = 0;
      while ((hit = re.exec(text)) !== null && n < cap) {
        n++;
        out.push({
          rule: name,
          kind: 'regex',
          value: hit[0].slice(0, 500),
          detail: {
            index: hit.index,
            ...(hit.length > 1 ? { groups: hit.slice(1).map((g) => g?.slice(0, 200) ?? null) } : {}),
            context: text.slice(Math.max(0, hit.index - 80), hit.index + hit[0].length + 80),
          },
        });
        // A zero-width match would spin here forever.
        if (hit[0].length === 0) re.lastIndex++;
      }
    }

    if (rule.text) {
      const needle = rule.text.toLowerCase();
      const haystack = text.toLowerCase();
      let from = 0;
      let n = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1 || n >= cap) break;
        n++;
        out.push({
          rule: name,
          kind: 'text',
          value: text.slice(at, at + rule.text.length),
          detail: { index: at, context: text.slice(Math.max(0, at - 80), at + rule.text.length + 80) },
        });
        from = at + rule.text.length;
      }
    }
  });
  return out;
}

const SELECTOR_MATCH_FN = `((rules) => {
  const out = [];
  for (const rule of rules) {
    let nodes;
    try { nodes = document.querySelectorAll(rule.selector); }
    catch (err) { out.push({ rule: rule.name, kind: 'selector', value: null, detail: { error: String(err && err.message) } }); continue; }
    let n = 0;
    for (const el of nodes) {
      if (n >= rule.max) break;
      n++;
      const value = rule.attribute
        ? el.getAttribute(rule.attribute)
        : (el.innerText || el.textContent || '').trim();
      out.push({
        rule: rule.name,
        kind: 'selector',
        value: value === null ? null : String(value).slice(0, 500),
        detail: {
          tag: el.tagName.toLowerCase(),
          total: nodes.length,
          ...(rule.attribute ? { attribute: rule.attribute } : {}),
          id: el.id || null,
        },
      });
    }
  }
  return out;
})`;

/** Selector rules need the live DOM, so they run in the page. */
async function matchInDom(
  instance: BrowserInstance,
  target: ManagedTarget,
  rules: FindRule[],
): Promise<Match[]> {
  const selectorRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => typeof rule.selector === 'string' && rule.selector.length > 0)
    .map(({ rule, index }) => ({
      name: ruleName(rule, index),
      selector: rule.selector,
      attribute: rule.attribute ?? null,
      max: Math.min(Math.max(rule.max ?? 20, 1), 500),
    }));
  if (selectorRules.length === 0) return [];

  const { result } = await evaluate(instance, target, {
    expression: `(${SELECTOR_MATCH_FN})(${JSON.stringify(selectorRules)})`,
    returnByValue: true,
  });
  return ((result.value as Match[]) ?? []).map((m) => ({ ...m, kind: 'selector' }));
}

/* ---------------------------------- ops ----------------------------------- */

export async function save(
  ctx: OpsContext,
  args: CaptureOptions & {
    browser_id?: string;
    target_id?: string;
    url?: string;
    collection?: string;
    label?: string;
    refresh?: boolean;
    find?: FindRule[];
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'none';
    timeout_ms?: number;
    preview_chars?: number;
  },
): Promise<Record<string, unknown>> {
  // Cheapest possible answer to "do I already have this?": no browser needed.
  if (args.url && args.refresh !== true) {
    const existing = ctx.stores.documents.getByUrl(args.url);
    if (existing) {
      return {
        saved: false,
        already_saved: true,
        document: toDocumentRef(existing),
        headings: documentHeadings(existing),
        hint: 'Already in the library. Read it with doc.get or doc.search; pass refresh:true to re-capture the live page.',
      };
    }
  }

  const instance = await ctx.registry.resolve(args.browser_id);
  const target = await instance.resolvePageOrOpen(args.target_id);

  let httpStatus: number | null = null;
  if (args.url) {
    const nav = (await navigate(ctx, {
      browser_id: instance.id,
      target_id: target.handle,
      url: args.url,
      wait_until: args.wait_until ?? 'load',
      ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }),
    })) as Record<string, unknown>;
    if (nav.committed === false) {
      throw new AgentBrowserError(
        'navigation_failed',
        `Could not load ${args.url}: ${String(nav.error ?? 'no document committed')}.`,
      );
    }
    httpStatus = (nav.http_status as number | undefined) ?? null;
  }

  // Scrolling and "load more" clicking mutate the page, so they answer to the
  // control mode like any other action a human might be fighting with.
  if (args.scroll !== false || args.click_more) instance.requireControl('doc.save');

  const captured = await capture(instance, target, args);
  if (captured.text.trim().length === 0) {
    throw new AgentBrowserError(
      'empty_document',
      `${captured.url} yielded no text. The page may still be loading (page.wait_for), the content may be in an iframe (page.list_frames), or main_only:true may have picked an empty landmark - retry with main_only:false.`,
      { url: captured.url, root_selector: captured.root_selector },
    );
  }

  const { row, created, artifactId } = persist(ctx, captured, {
    browserId: instance.id,
    collection: args.collection,
    label: args.label,
    httpStatus,
  });

  const rules = args.find ?? [];
  let matches: Match[] = [];
  if (rules.length > 0) {
    matches = [...matchInText(captured.text, rules), ...(await matchInDom(instance, target, rules))];
    ctx.stores.documents.recordMatches(row.doc_handle, null, matches);
  }

  const preview = Math.min(Math.max(args.preview_chars ?? 600, 0), 20_000);
  return {
    saved: true,
    created,
    updated: !created,
    document: toDocumentRef(row),
    artifact: toArtifactRef(ctx.stores.artifacts.require(artifactId)),
    root_selector: captured.root_selector,
    headings: captured.headings.slice(0, 60),
    links_found: captured.links.length,
    ...(captured.scroll ? { scroll: captured.scroll } : {}),
    ...(matches.length ? { matches: matches.slice(0, 50), match_count: matches.length } : {}),
    ...(preview ? { preview: captured.text.slice(0, preview) } : {}),
    hint: `Full text: artifact.read_lines(artifact_id:"${artifactId}") or doc.get(doc_id:"${row.doc_handle}"). Search everything saved with doc.search.`,
  };
}

export async function list(
  ctx: OpsContext,
  args: {
    site?: string;
    collection?: string;
    url_contains?: string;
    title_contains?: string;
    crawl_id?: string;
    since?: string | number;
    until?: string | number;
    sort?: DocumentSort;
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    group_by?: 'site' | 'collection';
  },
): Promise<Record<string, unknown>> {
  const filter = {
    ...(args.site ? { site: args.site } : {}),
    ...(args.collection ? { collection: args.collection } : {}),
    ...(args.url_contains ? { url_contains: args.url_contains } : {}),
    ...(args.title_contains ? { title_contains: args.title_contains } : {}),
    ...(args.crawl_id ? { crawl_handle: args.crawl_id } : {}),
    ...(parseSince(args.since) === undefined ? {} : { since: parseSince(args.since)! }),
    ...(parseSince(args.until) === undefined ? {} : { until: parseSince(args.until)! }),
    ...(args.sort ? { sort: args.sort } : {}),
    ...(args.order ? { order: args.order } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
  };

  if (args.group_by === 'site') {
    const sites = ctx.stores.documents.bySite(filter).map((row) => ({
      site: row.site,
      documents: row.documents,
      words: row.words,
      collections: row.collections ? String(row.collections).split(',') : [],
      last_fetched: new Date(Number(row.last_fetched)).toISOString(),
    }));
    return { grouped_by: 'site', site_count: sites.length, sites };
  }
  if (args.group_by === 'collection') {
    const collections = ctx.stores.documents.collections().map((row) => ({
      collection: row.collection,
      documents: row.documents,
      last_fetched: new Date(Number(row.last_fetched)).toISOString(),
    }));
    return { grouped_by: 'collection', collection_count: collections.length, collections };
  }

  const { rows, total } = ctx.stores.documents.list(filter);
  return {
    count: rows.length,
    total,
    documents: rows.map(toDocumentRef),
    ...(total > rows.length
      ? { hint: `${total} match; pass offset to page, or group_by:"site" for a rollup.` }
      : {}),
  };
}

export async function get(
  ctx: OpsContext,
  args: {
    doc_id?: string;
    url?: string;
    start_line?: number;
    end_line?: number;
    include_text?: boolean;
    include_links?: boolean;
  },
): Promise<Record<string, unknown>> {
  const row = resolveDocument(ctx, args);
  const out: Record<string, unknown> = {
    document: toDocumentRef(row),
    headings: documentHeadings(row),
    meta: unj(row.meta) ?? {},
    matches: ctx.stores.documents.matchesFor(row.doc_handle, 50).map((m) => ({
      rule: m.rule,
      kind: m.kind,
      value: m.value,
      detail: unj(m.detail),
    })),
  };
  if (args.include_links) out.links = unj(row.links) ?? [];

  if (args.include_text !== false && row.artifact_handle) {
    // Reuse the artifact reader rather than growing a second one: it streams,
    // so a 2MB reference costs one line window instead of the whole file.
    out.text = await ctx.stores.artifacts.readLines(
      row.artifact_handle,
      args.start_line ?? 1,
      args.end_line ?? 200,
    );
    out.hint = `More: doc.get(start_line:, end_line:) or artifact.search(artifact_id:"${row.artifact_handle}", query:).`;
  }
  return out;
}

export async function search(
  ctx: OpsContext,
  args: {
    query: string;
    mode?: 'fts' | 'regex';
    raw?: boolean;
    site?: string;
    collection?: string;
    doc_id?: string;
    limit?: number;
    snippet_tokens?: number;
    ignore_case?: boolean;
    context_lines?: number;
  },
): Promise<Record<string, unknown>> {
  if (args.mode === 'regex') return regexSearch(ctx, args);

  const hits = ctx.stores.documents.search({
    query: args.query,
    ...(args.raw === undefined ? {} : { raw: args.raw }),
    ...(args.site ? { site: args.site } : {}),
    ...(args.collection ? { collection: args.collection } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.snippet_tokens === undefined ? {} : { snippet_tokens: args.snippet_tokens }),
  });

  return {
    query: args.query,
    mode: 'fts',
    count: hits.length,
    results: hits.map((hit) => ({
      ...toDocumentRef(hit as unknown as DocumentRow),
      // toPrecision, not toFixed: when a term appears in nearly every saved
      // page its IDF collapses and bm25 lands around 1e-6, which a fixed
      // 4-decimal rendering reports as a flat 0 for every hit.
      score: Number((hit.rank as number).toPrecision(4)),
      snippet: hit.snippet,
    })),
    ...(hits.length === 0
      ? {
          hint: 'No saved page matches. doc.list(group_by:"site") shows what is in the library; doc.save or doc.crawl to add more. Terms are ANDed - try fewer of them, or mode:"regex" for a pattern.',
        }
      : {}),
  };
}

/**
 * Regex search across saved pages.
 *
 * FTS5 tokenises, so it cannot answer "which page mentions a version number
 * like 5\\.\\d+". That question is answered by streaming the artifacts, which
 * the artifact store already does line by line - no document is ever fully
 * resident.
 */
async function regexSearch(
  ctx: OpsContext,
  args: {
    query: string;
    site?: string;
    collection?: string;
    doc_id?: string;
    limit?: number;
    ignore_case?: boolean;
    context_lines?: number;
  },
): Promise<Record<string, unknown>> {
  try {
    new RegExp(args.query);
  } catch (err) {
    throw new AgentBrowserError('bad_regex', `Invalid regex: ${(err as Error).message}`);
  }

  const candidates = args.doc_id
    ? [ctx.stores.documents.require(args.doc_id)]
    : ctx.stores.documents.list({
        ...(args.site ? { site: args.site } : {}),
        ...(args.collection ? { collection: args.collection } : {}),
        limit: 500,
      }).rows;

  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const results: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (const row of candidates) {
    if (results.length >= limit) break;
    if (!row.artifact_handle) continue;
    scanned++;
    let hit: Record<string, unknown>;
    try {
      hit = await ctx.stores.artifacts.search(row.artifact_handle, {
        query: args.query,
        isRegex: true,
        ...(args.ignore_case === undefined ? {} : { ignoreCase: args.ignore_case }),
        ...(args.context_lines === undefined ? {} : { contextLines: args.context_lines }),
        maxMatches: 10,
      });
    } catch (err) {
      // A document whose artifact was cleaned up should not sink the search.
      log.debug(`regex search skipped ${row.doc_handle}: ${(err as Error).message}`);
      continue;
    }
    const matches = (hit.matches as unknown[]) ?? [];
    if (matches.length === 0) continue;
    results.push({
      ...toDocumentRef(row),
      match_count: hit.matches_found_so_far,
      matches,
    });
  }

  return {
    query: args.query,
    mode: 'regex',
    documents_scanned: scanned,
    count: results.length,
    results,
    ...(results.length === 0 ? { hint: 'No saved page matches that pattern.' } : {}),
  };
}

export async function remove(
  ctx: OpsContext,
  args: { doc_id?: string; url?: string; site?: string; collection?: string; crawl_id?: string; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (args.doc_id || args.url) {
    const row = resolveDocument(ctx, args);
    ctx.stores.documents.delete([row.doc_handle]);
    return { deleted: 1, documents: [toDocumentRef(row)] };
  }

  if (!args.site && !args.collection && !args.crawl_id) {
    throw new AgentBrowserError(
      'no_selection',
      'doc.delete needs doc_id, url, site, collection or crawl_id. It will not delete the whole library.',
    );
  }
  const { rows } = ctx.stores.documents.list({
    ...(args.site ? { site: args.site } : {}),
    ...(args.collection ? { collection: args.collection } : {}),
    ...(args.crawl_id ? { crawl_handle: args.crawl_id } : {}),
    limit: 500,
  });
  // Bulk deletion is not reversible, so the caller sees the list first.
  if (args.confirm !== true) {
    return {
      deleted: 0,
      would_delete: rows.length,
      documents: rows.slice(0, 50).map(toDocumentRef),
      hint: 'Pass confirm:true to delete these.',
    };
  }
  const deleted = ctx.stores.documents.delete(rows.map((r) => r.doc_handle));
  return { deleted, documents: rows.slice(0, 50).map(toDocumentRef) };
}

function resolveDocument(ctx: OpsContext, args: { doc_id?: string; url?: string }): DocumentRow {
  if (args.doc_id) return ctx.stores.documents.require(args.doc_id);
  if (args.url) {
    const row = ctx.stores.documents.getByUrl(args.url);
    if (!row) {
      throw new AgentBrowserError(
        'not_saved',
        `No saved document for ${args.url}. Capture it with doc.save(url:) first.`,
      );
    }
    return row;
  }
  throw new AgentBrowserError('no_document', 'Pass doc_id or url.');
}

/* --------------------------------- crawl ---------------------------------- */

export type CrawlScope = 'same-origin' | 'same-host' | 'path-prefix' | 'any';

/**
 * Should the crawler follow this link?
 *
 * Scope is checked before include/exclude so a permissive include pattern
 * cannot accidentally send the crawler off onto the whole web - the cost of
 * that mistake is paid in real page loads, not in a wrong answer.
 */
function inScope(
  candidate: string,
  start: URL,
  scope: CrawlScope,
  include: RegExp[],
  exclude: RegExp[],
): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (scope === 'same-origin' && url.origin !== start.origin) return false;
  if (scope === 'same-host' && url.hostname !== start.hostname) return false;
  if (scope === 'path-prefix') {
    const prefix = start.pathname.endsWith('/') ? start.pathname : `${start.pathname.replace(/\/[^/]*$/, '')}/`;
    if (url.origin !== start.origin || !url.pathname.startsWith(prefix)) return false;
  }
  if (exclude.some((re) => re.test(candidate))) return false;
  if (include.length > 0 && !include.some((re) => re.test(candidate))) return false;
  return true;
}

function compile(patterns: string[] | undefined, what: string): RegExp[] {
  return (patterns ?? []).map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch (err) {
      throw new AgentBrowserError('bad_regex', `Invalid ${what} pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
    }
  });
}

export async function crawl(
  ctx: OpsContext,
  args: CaptureOptions & {
    browser_id?: string;
    target_id?: string;
    url: string;
    max_depth?: number;
    max_pages?: number;
    scope?: CrawlScope;
    include?: string[];
    exclude?: string[];
    save?: boolean;
    refresh?: boolean;
    collection?: string;
    find?: FindRule[];
    delay_ms?: number;
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'none';
    timeout_ms?: number;
    stop_after_matches?: number;
  },
): Promise<Record<string, unknown>> {
  const start = (() => {
    try {
      return new URL(args.url);
    } catch {
      throw new AgentBrowserError('bad_url', `Not an absolute URL: ${JSON.stringify(args.url)}.`);
    }
  })();

  const maxDepth = Math.min(Math.max(args.max_depth ?? 1, 0), 10);
  const maxPages = Math.min(Math.max(args.max_pages ?? 25, 1), 500);
  const scope = args.scope ?? 'same-origin';
  const include = compile(args.include, 'include');
  const exclude = compile(args.exclude, 'exclude');
  const rules = args.find ?? [];
  const shouldSave = args.save !== false;
  const pauseMs = Math.min(Math.max(args.delay_ms ?? 0, 0), 10_000);

  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('doc.crawl');
  const target = await instance.resolvePageOrOpen(args.target_id);

  const crawlRow = ctx.stores.documents.createCrawl({
    startUrl: args.url,
    collection: args.collection ?? null,
    config: {
      max_depth: maxDepth,
      max_pages: maxPages,
      scope,
      include: args.include ?? [],
      exclude: args.exclude ?? [],
      save: shouldSave,
      format: args.format ?? 'markdown',
      find: rules,
    },
  });

  const queue: Array<{ url: string; depth: number; parent: string | null }> = [
    { url: canonicalizeUrl(args.url), depth: 0, parent: null },
  ];
  const seen = new Set<string>([canonicalizeUrl(args.url)]);
  const pages: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const allMatches: Array<Record<string, unknown>> = [];
  let saved = 0;
  let stopped: string | null = null;

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;

      let httpStatus: number | null = null;
      try {
        const nav = (await navigate(ctx, {
          browser_id: instance.id,
          target_id: target.handle,
          url: item.url,
          wait_until: args.wait_until ?? 'load',
          ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }),
        })) as Record<string, unknown>;
        if (nav.committed === false) throw new Error(String(nav.error ?? 'no document committed'));
        httpStatus = (nav.http_status as number | undefined) ?? null;
      } catch (err) {
        errors.push({ url: item.url, depth: item.depth, error: (err as Error).message });
        continue;
      }

      let captured: Captured;
      try {
        captured = await capture(instance, target, args);
      } catch (err) {
        errors.push({ url: item.url, depth: item.depth, error: (err as Error).message });
        continue;
      }

      // A page that redirected is recorded under where it landed, and its
      // destination is marked seen so the redirect is not chased twice.
      const landed = canonicalizeUrl(captured.url);
      seen.add(landed);

      const matches =
        rules.length > 0
          ? [...matchInText(captured.text, rules), ...(await matchInDom(instance, target, rules))]
          : [];

      let docRef: Record<string, unknown> | null = null;
      let docHandle: string | null = null;
      if (shouldSave && captured.text.trim().length > 0) {
        const existing = args.refresh === true ? undefined : ctx.stores.documents.getByUrl(landed);
        if (existing) {
          // Already in the library: skip the re-capture, but record that this
          // run covered the page so the crawl's document set is complete.
          ctx.stores.documents.touchCrawl(existing.doc_handle, crawlRow.crawl_handle);
          docHandle = existing.doc_handle;
          docRef = { ...toDocumentRef(existing), reused: true };
        } else {
          const { row } = persist(ctx, captured, {
            browserId: instance.id,
            ...(args.collection === undefined ? {} : { collection: args.collection }),
            crawlHandle: crawlRow.crawl_handle,
            depth: item.depth,
            parentUrl: item.parent,
            httpStatus,
          });
          docHandle = row.doc_handle;
          docRef = toDocumentRef(row);
          saved++;
        }
      }
      // Match hits belong to the run, not to whether the page needed fetching.
      if (docHandle && matches.length > 0) {
        ctx.stores.documents.recordMatches(docHandle, crawlRow.crawl_handle, matches);
      }

      for (const match of matches) {
        allMatches.push({ url: landed, ...match });
      }

      pages.push({
        url: landed,
        depth: item.depth,
        title: captured.title,
        words: captured.text.trim() ? captured.text.trim().split(/\s+/).length : 0,
        links: captured.links.length,
        ...(httpStatus === null ? {} : { http_status: httpStatus }),
        ...(matches.length ? { matches: matches.length } : {}),
        ...(docRef ? { document: docRef } : { saved: false }),
      });

      ctx.stores.documents.updateCrawl(crawlRow.crawl_handle, {
        pagesVisited: pages.length,
        pagesSaved: saved,
        matchesFound: allMatches.length,
      });

      if (args.stop_after_matches && allMatches.length >= args.stop_after_matches) {
        stopped = `stop_after_matches (${args.stop_after_matches}) reached`;
        break;
      }

      if (item.depth < maxDepth) {
        for (const link of captured.links) {
          let canonical: string;
          try {
            canonical = canonicalizeUrl(link.url);
          } catch {
            continue;
          }
          if (seen.has(canonical)) continue;
          if (!inScope(canonical, start, scope, include, exclude)) continue;
          seen.add(canonical);
          queue.push({ url: canonical, depth: item.depth + 1, parent: landed });
        }
      }

      if (pauseMs > 0 && queue.length > 0) await delay(pauseMs);
    }
  } finally {
    ctx.stores.documents.updateCrawl(crawlRow.crawl_handle, {
      status: stopped ? 'stopped' : 'done',
      pagesVisited: pages.length,
      pagesSaved: saved,
      matchesFound: allMatches.length,
      errors: errors.length ? errors : null,
      finished: true,
    });
  }

  const hitPageCap = pages.length >= maxPages && queue.length > 0;
  return {
    crawl_id: crawlRow.crawl_handle,
    start_url: args.url,
    scope,
    max_depth: maxDepth,
    pages_visited: pages.length,
    pages_saved: saved,
    queue_remaining: queue.length,
    ...(stopped ? { stopped_because: stopped } : {}),
    ...(hitPageCap
      ? { truncated: `Stopped at max_pages=${maxPages} with ${queue.length} URLs still queued. Raise max_pages or narrow include/exclude.` }
      : {}),
    pages,
    ...(allMatches.length
      ? { match_count: allMatches.length, matches: allMatches.slice(0, 100) }
      : {}),
    ...(errors.length ? { errors } : {}),
    hint: `Saved pages are searchable now: doc.search(query:, collection:${JSON.stringify(args.collection ?? null)}) or doc.list(crawl_id:"${crawlRow.crawl_handle}").`,
  };
}

export async function crawls(
  ctx: OpsContext,
  args: { crawl_id?: string; site?: string; limit?: number; rule?: string },
): Promise<Record<string, unknown>> {
  if (args.crawl_id) {
    const row = ctx.stores.documents.requireCrawl(args.crawl_id);
    const { rows } = ctx.stores.documents.list({ crawl_handle: args.crawl_id, limit: 500 });
    const matches = ctx.stores.documents.matchesForCrawl(
      args.crawl_id,
      args.rule,
      200,
    );
    return {
      crawl: describeCrawl(row),
      documents: rows.map(toDocumentRef),
      matches: matches.map((m) => ({
        rule: m.rule,
        kind: m.kind,
        value: m.value,
        detail: unj(m.detail),
        doc_id: m.doc_handle,
      })),
    };
  }
  const rows = ctx.stores.documents.listCrawls({
    ...(args.site ? { site: args.site } : {}),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  return { count: rows.length, crawls: rows.map(describeCrawl) };
}

function describeCrawl(row: {
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
}): Record<string, unknown> {
  return {
    crawl_id: row.crawl_handle,
    start_url: row.start_url,
    site: row.site,
    collection: row.collection,
    status: row.status,
    pages_visited: row.pages_visited,
    pages_saved: row.pages_saved,
    matches_found: row.matches_found,
    config: unj(row.config),
    ...(row.errors ? { errors: unj(row.errors) } : {}),
    started_at: new Date(row.started_at).toISOString(),
    ...(row.finished_at ? { finished_at: new Date(row.finished_at).toISOString() } : {}),
  };
}
