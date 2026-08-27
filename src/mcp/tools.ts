import { z } from 'zod';
import type { OpsContext } from '../ops/context.js';
import * as artifactOps from '../ops/artifact.js';
import * as auditOps from '../ops/audit.js';
import * as browserOps from '../ops/browser.js';
import * as captureOps from '../ops/capture.js';
import * as consoleOps from '../ops/console.js';
import * as cssOps from '../ops/css.js';
import * as debuggerOps from '../ops/debugger.js';
import * as domOps from '../ops/dom.js';
import * as emulationOps from '../ops/emulation.js';
import * as faultOps from '../ops/faults.js';
import * as inspectorOps from '../ops/inspector.js';
import * as jsOps from '../ops/js.js';
import * as networkOps from '../ops/network.js';
import * as pageOps from '../ops/page.js';
import * as profilerOps from '../ops/profiler.js';
import * as storageOps from '../ops/storage.js';
import * as timeOps from '../ops/time.js';

/** One MCP tool: name, blurb, argument schema, and the op it calls. */
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (ctx: OpsContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Tools that only read are safe under every control mode. */
  readOnly?: boolean;
}

/* Argument fragments shared by most tools. */
const browserId = {
  browser_id: z.string().optional().describe('Browser handle (br_*). Omit to use the only running browser, or auto-launch one.'),
};
const targetId = {
  target_id: z.string().optional().describe('Target handle (tgt_*). Omit for the active page.'),
};
const scope = { ...browserId, ...targetId };
const locator = {
  selector: z.string().optional().describe('CSS selector; pierces shadow DOM.'),
  xpath: z.string().optional().describe('XPath expression.'),
  text: z.string().optional().describe('Visible text of the element.'),
  ref: z.string().optional().describe('Snapshot ref (eNN) from page.snapshot.'),
  backend_node_id: z.number().optional().describe('CDP backendNodeId, e.g. from inspector.pick.'),
  frame_id: z.string().optional().describe('Frame to search within; see page.list_frames.'),
  nth: z.number().optional().describe('Zero-based index when the locator matches several elements.'),
};
const timeWindow = {
  since: z.union([z.string(), z.number()]).optional().describe('Relative ("5m", "90s") or absolute ISO timestamp.'),
  until: z.union([z.string(), z.number()]).optional().describe('Upper bound of the time window.'),
};
/** Response-shaping shared by the console readers, to keep payloads small. */
const consoleShape = {
  fields: z
    .array(z.string())
    .optional()
    .describe('Return only these fields, e.g. ["level","text","at"]. Cuts payload dramatically.'),
  stack: z
    .enum(['none', 'top', 'full'])
    .optional()
    .describe('Stack detail per entry. Default "top" (one frame) for console.query, "full" for console.exceptions.'),
};

/** One branch of a page.wait_for race. */
const waitCondition = z.object({
  selector: z.string().optional(),
  text: z.string().optional(),
  gone: z.boolean().optional(),
});
const paging = {
  limit: z.number().optional(),
  offset: z.number().optional(),
  order: z.enum(['asc', 'desc']).optional(),
};

/** Cast a typed op into the uniform handler shape. */
function op<A>(fn: (ctx: OpsContext, args: A) => Promise<Record<string, unknown>>): ToolDef['handler'] {
  return (ctx, args) => fn(ctx, args as A);
}

export const TOOLS: ToolDef[] = [
  /* ------------------------------- browser ------------------------------- */
  {
    name: 'browser.list',
    description:
      'List every browser the daemon owns or is attached to, with tab counts and control mode. Start here when unsure what exists. Closed browsers whose recordings are still queryable are counted as historical_available; pass include_historical:true to list them.',
    schema: {
      include_historical: z
        .boolean()
        .optional()
        .describe('Default false: only running browsers. Set true to also list closed browsers that still hold recordings.'),
      limit: z.number().optional().describe('Maximum closed browsers to include. Default 10.'),
    },
    handler: op(browserOps.listInstances),
    readOnly: true,
  },
  {
    name: 'browser.launch',
    description:
      'Launch a new Chromium with a persistent profile. Not usually needed: any tool auto-launches a browser when none is running. When url is given, the result reports what actually committed (landed.url, landed.title, landed.http_status) rather than echoing the request.',
    schema: {
      profile: z.string().optional().describe('Named persistent profile. Reused across runs.'),
      headless: z.boolean().optional().describe('Default false: a visible window a human can also use.'),
      url: z
        .string()
        .optional()
        .describe('Open this URL at startup. Launch-time navigation is racy; check landed in the result, or just use page.navigate.'),
      extensions: z.array(z.string()).optional().describe('Absolute paths to unpacked extension directories.'),
      chromium_path: z.string().optional(),
      capture_netlog: z.boolean().optional().describe('Also record Chromium NetLog (DNS, sockets, TLS).'),
      window_size: z.object({ width: z.number(), height: z.number() }).optional(),
      extra_args: z.array(z.string()).optional(),
    },
    handler: op(browserOps.launch),
  },
  {
    name: 'browser.connect',
    description: 'Attach to a Chromium started elsewhere, via its CDP WebSocket endpoint. The daemon will never kill it.',
    schema: {
      ws_endpoint: z.string().describe('ws://127.0.0.1:PORT/devtools/browser/...'),
      profile: z.string().optional(),
      pid: z.number().optional(),
    },
    handler: op(browserOps.connect),
  },
  {
    name: 'browser.status',
    description:
      'Full state of one browser: every page target with its committed URL, title, load state and HTTP status, plus version, how much has been recorded, active environment overrides and fault rules. The cheapest way to answer "what is actually on screen right now".',
    schema: { ...browserId },
    handler: op(browserOps.status),
    readOnly: true,
  },
  {
    name: 'browser.list_targets',
    description:
      'Every attached target: pages, out-of-process iframes, dedicated/shared/service workers, extension contexts. Page tools accept any of these ids.',
    schema: { ...browserId, type: z.string().optional().describe('Filter, e.g. "page", "service_worker", "worker".') },
    handler: op(browserOps.listTargets),
    readOnly: true,
  },
  {
    name: 'browser.set_control_mode',
    description:
      'Arbitrate human and AI control. observe = read only; shared = both drive; agent = AI owns input; paused = AI frozen. Mutating tools refuse under observe and paused.',
    schema: { ...browserId, mode: z.enum(['observe', 'shared', 'agent', 'paused']) },
    handler: op(browserOps.setControlMode),
  },
  {
    name: 'recording.reset',
    description:
      'Clear recorded console and network in one call, starting a fresh window. Use before a repro instead of hand-filtering with since:. Defaults to both; name one to clear only that.',
    schema: {
      ...browserId,
      console: z.boolean().optional(),
      network: z.boolean().optional(),
    },
    handler: op(browserOps.resetRecording),
  },
  {
    name: 'browser.close',
    description: 'Shut down a managed browser, or detach from an externally launched one.',
    schema: { ...browserId },
    handler: op(browserOps.close),
  },
  {
    name: 'cdp.send',
    description:
      'Escape hatch: send any raw Chrome DevTools Protocol command. Use when no typed tool covers the capability. Large results are stored as an artifact instead of being inlined.',
    schema: {
      ...scope,
      method: z.string().describe('CDP method, e.g. "Page.getNavigationHistory".'),
      params: z.record(z.unknown()).optional(),
      timeout_ms: z.number().optional(),
    },
    handler: op(browserOps.cdpSend),
  },

  /* --------------------------------- page -------------------------------- */
  {
    name: 'page.list_tabs',
    description: 'List open tabs with their URLs, titles and target ids.',
    schema: { ...browserId },
    handler: op(pageOps.listTabs),
    readOnly: true,
  },
  {
    name: 'page.new_tab',
    description: 'Open a new tab, optionally at a URL.',
    schema: { ...browserId, url: z.string().optional(), activate: z.boolean().optional() },
    handler: op(pageOps.newTab),
  },
  {
    name: 'page.activate_tab',
    description: 'Bring a tab to the front, as clicking its tab strip entry would.',
    schema: { ...scope },
    handler: op(pageOps.activateTab),
  },
  {
    name: 'page.close_tab',
    description: 'Close a tab.',
    schema: { ...scope },
    handler: op(pageOps.closeTab),
  },
  {
    name: 'page.navigate',
    description:
      'Navigate to a URL and wait for the load state. Reports the committed URL, the document title and its HTTP status, so a dev server serving a different project on the expected port is visible immediately.',
    schema: {
      ...scope,
      url: z.string(),
      wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional(),
      timeout_ms: z.number().optional(),
    },
    handler: op(pageOps.navigate),
  },
  {
    name: 'page.reload',
    description:
      'Reload the page, optionally bypassing the cache. Note: this fires pagehide/beforeunload, so an app that persists state in those handlers will not come back in the same state - page.navigate to the same URL skips them, which matters for repeatable test loops.',
    schema: { ...scope, ignore_cache: z.boolean().optional(), wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional() },
    handler: op(pageOps.reload),
  },
  {
    name: 'page.go_back',
    description: 'Go back in session history.',
    schema: { ...scope },
    handler: op(pageOps.goBack),
  },
  {
    name: 'page.go_forward',
    description: 'Go forward in session history.',
    schema: { ...scope },
    handler: op(pageOps.goForward),
  },
  {
    name: 'page.history',
    description: 'Recorded navigation history for this browser, including same-document navigations.',
    schema: { ...scope, limit: z.number().optional() },
    handler: op(pageOps.history),
    readOnly: true,
  },
  {
    name: 'page.screenshot',
    description:
      'See the rendered page. Returns the image for visual inspection plus a stored artifact. mode: viewport, full_page, or element (with a locator).',
    schema: {
      ...scope,
      ...locator,
      mode: z.enum(['viewport', 'full_page', 'element']).optional(),
      format: z.enum(['png', 'jpeg', 'webp']).optional(),
      quality: z.number().optional().describe('1-100, for jpeg/webp.'),
      save_path: z.string().optional(),
      return_image: z.boolean().optional().describe('Default true. Set false to store only.'),
      highlight: z
        .string()
        .optional()
        .describe('CSS selector to box in the image. One-shot: the overlay is cleared after capture, unlike page.highlight.'),
      label: z
        .string()
        .optional()
        .describe('Tag for this capture, e.g. "onboarding-repro". Filter later with artifact.list(label:).'),
      timeout_ms: z
        .number()
        .optional()
        .describe('Give up after this long. Default 15000; a hung capture reports what the target was doing rather than stalling.'),
      settle: z
        .boolean()
        .optional()
        .describe('Wait for running CSS animations and transitions to finish first, so entrance animations are not captured mid-flight.'),
      settle_timeout_ms: z.number().optional().describe('Cap on the settle wait. Default 2000.'),
      trigger_lazy_content: z
        .boolean()
        .optional()
        .describe('Scroll the full page once before a full_page capture, so IntersectionObserver-driven content has rendered.'),
      max_width: z
        .number()
        .optional()
        .describe('Downscale the capture to at most this many CSS pixels wide. Cuts payload on wide or full-page shots.'),
    },
    handler: op(pageOps.screenshot),
    readOnly: true,
  },
  {
    name: 'page.snapshot',
    description:
      'Accessibility-tree snapshot of the interactive elements, each with a stable ref (eNN) usable by page.click and friends. Cheaper and more reliable than screenshots for deciding what to click.',
    schema: {
      ...scope,
      interactive_only: z.boolean().optional(),
      max_nodes: z.number().optional(),
      root_selector: z
        .string()
        .optional()
        .describe('Scope the walk to this subtree, e.g. "main". Keeps a large hidden SEO block from eating the whole node budget.'),
    },
    handler: op(pageOps.snapshot),
    readOnly: true,
  },
  {
    name: 'page.click',
    description:
      'Click an element, scrolling it into view first. By default watches for a DOM reaction and reports observed_change, so "the input was dispatched" is not mistaken for "the app handled it".',
    schema: {
      ...scope,
      ...locator,
      button: z.enum(['left', 'right', 'middle']).optional(),
      click_count: z.number().optional(),
      modifiers: z.array(z.string()).optional().describe('e.g. ["Control", "Shift"].'),
      verify: z.boolean().optional().describe('Watch for DOM mutations after the click. Default true.'),
      verify_ms: z.number().optional().describe('How long to watch. Default 300.'),
      retry_if_unchanged: z
        .boolean()
        .optional()
        .describe('If nothing changed, retry through the element own .click(), which reaches framework handlers synthetic input can miss.'),
    },
    handler: op(pageOps.click),
  },
  {
    name: 'page.hover',
    description: 'Move the mouse over an element, triggering hover styles and menus.',
    schema: { ...scope, ...locator },
    handler: op(pageOps.hover),
  },
  {
    name: 'page.type',
    description:
      'Type text into an element, with real key events so the page sees each keystroke. Newlines become Enter in textareas and contenteditables; on a single-line input they are reported as dropped rather than silently flattened. Reads the field back so landed_characters is measured, not assumed.',
    schema: {
      ...scope,
      ...locator,
      text: z.string(),
      clear: z.boolean().optional().describe('Clear the field first.'),
      delay_ms: z.number().optional(),
      insert_text: z
        .boolean()
        .optional()
        .describe('Paste in one Input.insertText instead of per-key events. Much faster and newline-safe, but the page sees no keydown/keyup.'),
      press_enter: z.boolean().optional(),
    },
    handler: op(pageOps.typeText),
  },
  {
    name: 'page.press',
    description: 'Press a key or chord, e.g. "Enter", "Escape", "Control+Shift+K".',
    schema: { ...scope, ...locator, key: z.string() },
    handler: op(pageOps.press),
  },
  {
    name: 'page.scroll',
    description:
      'Scroll the page or a specific scrollable element. If wheel dispatch stalls on a busy compositor it falls back to a programmatic scroll and says so via `via`.',
    schema: {
      ...scope,
      ...locator,
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      to: z.enum(['top', 'bottom', 'element']).optional(),
    },
    handler: op(pageOps.scroll),
  },
  {
    name: 'page.select_option',
    description: 'Choose one or more options in a <select>.',
    schema: { ...scope, ...locator, values: z.array(z.string()).optional(), labels: z.array(z.string()).optional() },
    handler: op(pageOps.selectOption),
  },
  {
    name: 'page.upload_files',
    description: 'Set files on a file input.',
    schema: { ...scope, ...locator, files: z.array(z.string()).describe('Absolute paths on the daemon host.') },
    handler: op(pageOps.uploadFiles),
  },
  {
    name: 'page.highlight',
    description:
      'Draw the DevTools highlight over an element so a human can see what the AI is looking at. Follow with page.screenshot to verify the right element was found.',
    schema: { ...scope, ...locator, duration_ms: z.number().optional(), scroll_into_view: z.boolean().optional() },
    handler: op(pageOps.highlight),
  },
  {
    name: 'page.unhighlight',
    description: 'Clear any highlight overlay.',
    schema: { ...scope },
    handler: op(pageOps.unhighlight),
  },
  {
    name: 'page.extract_text',
    description:
      'Readable text of the page, or of one element when given a locator. Pass selector/ref to read a single panel instead of the whole page.',
    schema: {
      ...scope,
      ...locator,
      max_chars: z.number().optional(),
      include_hidden: z.boolean().optional(),
      visible_only: z
        .boolean()
        .optional()
        .describe('Skip visually-hidden (sr-only, clipped, off-screen) text that innerText still reports. Use on marketing pages whose first 1500 characters are an invisible SEO block.'),
    },
    handler: op(pageOps.extractText),
    readOnly: true,
  },
  {
    name: 'page.wait_for',
    description:
      'Wait until an element appears or disappears, or until text shows up. Use any_of to race several outcomes (success UI vs error UI) instead of guessing one and eating a full timeout; all_of waits for every condition. On timeout the error reports which conditions were unmet and the closest thing on the page.',
    schema: {
      ...scope,
      selector: z.string().optional(),
      text: z.string().optional(),
      gone: z.boolean().optional().describe('Wait for absence instead of presence.'),
      any_of: z
        .array(waitCondition)
        .optional()
        .describe('Return as soon as any one of these is met; the response says which (matched, index).'),
      all_of: z.array(waitCondition).optional().describe('Return once every one of these is met.'),
      normalize: z
        .boolean()
        .optional()
        .describe('Case- and whitespace-insensitive text matching. Use when the DOM may differ in casing or line breaks.'),
      timeout_ms: z.number().optional(),
      poll_ms: z.number().optional(),
    },
    handler: op(pageOps.waitFor),
    readOnly: true,
  },
  {
    name: 'page.expect',
    description:
      'Assert the state of one element and get pass/fail plus what was actually observed. Replaces the evaluate-then-eyeball-the-JSON loop. Give timeout_ms to retry until it holds instead of failing on a race.',
    schema: {
      ...scope,
      ...locator,
      visible: z.boolean().optional(),
      enabled: z.boolean().optional(),
      checked: z.boolean().optional(),
      focused: z.boolean().optional(),
      in_viewport: z.boolean().optional(),
      text_contains: z.string().optional(),
      value: z.string().optional(),
      timeout_ms: z.number().optional().describe('Retry until the expectations hold. Default 0: check once.'),
      poll_ms: z.number().optional(),
    },
    handler: op(pageOps.expect),
    readOnly: true,
  },
  {
    name: 'page.observe',
    description:
      'Sample expressions on an interval and return the timeline plus the transitions between values. Use to measure how long a UI sat locked or when a step actually appeared, instead of hand-rolling a polling loop in js.evaluate.',
    schema: {
      ...scope,
      sample: z
        .record(z.string())
        .optional()
        .describe('Named JS expressions to evaluate each tick, e.g. {"locked": "!!document.querySelector(\'.overlay\')"}.'),
      selector: z
        .string()
        .optional()
        .describe('Shorthand for the common case: watch this element text change over time. Use instead of sample.'),
      every_ms: z.number().optional().describe('Sampling interval. Default 250.'),
      for_ms: z.number().optional().describe('Total duration. Default 10000.'),
      stop_when: z.string().optional().describe('JS expression; sampling stops early once it is truthy.'),
    },
    handler: op(pageOps.observe),
    readOnly: true,
  },
  {
    name: 'page.audit_layout',
    description:
      'Measure a page at several viewport widths and report what is actually broken: horizontal overflow (outermost offender only), touch targets under the minimum size, and clipped text. Answers responsive questions that a screenshot leaves to guesswork. Viewport emulation is always cleared afterwards.',
    schema: {
      ...scope,
      widths: z.array(z.number()).optional().describe('CSS widths to test. Default [320, 414, 768, 1280].'),
      height: z.number().optional().describe('Viewport height for every width. Default 800.'),
      urls: z.array(z.string()).optional().describe('Audit these URLs in turn. Omit to audit the current page.'),
      min_touch_target: z.number().optional().describe('Smallest acceptable interactive dimension in CSS px. Default 24.'),
      device_scale_factor: z.number().optional(),
    },
    handler: op(auditOps.auditLayout),
  },
  {
    name: 'page.list_dialogs',
    description: 'JavaScript dialogs (alert/confirm/prompt/beforeunload) currently blocking the page.',
    schema: { ...scope },
    handler: op(pageOps.listDialogs),
    readOnly: true,
  },
  {
    name: 'page.handle_dialog',
    description: 'Accept or dismiss an open JavaScript dialog.',
    schema: { ...scope, accept: z.boolean(), prompt_text: z.string().optional() },
    handler: op(pageOps.handleDialog),
  },
  {
    name: 'page.set_viewport',
    description: 'Resize the emulated viewport. See device.preset for realistic device profiles.',
    schema: {
      ...scope,
      width: z.number().optional(),
      height: z.number().optional(),
      device_scale_factor: z.number().optional(),
      mobile: z.boolean().optional(),
      reset: z.boolean().optional(),
    },
    handler: op(pageOps.setViewport),
  },
  {
    name: 'page.list_frames',
    description: 'Frame tree with origins and execution-context ids, so JS can be run inside a specific iframe.',
    schema: { ...scope },
    handler: op(pageOps.listFrames),
    readOnly: true,
  },

  /* ---------------------------------- DOM -------------------------------- */
  {
    name: 'dom.summary',
    description:
      'Structural outline of the document rather than its markup. Read this first; pull HTML only for the branch that matters.',
    schema: { ...scope, selector: z.string().optional(), max_depth: z.number().optional(), max_nodes: z.number().optional() },
    handler: op(domOps.summary),
    readOnly: true,
  },
  {
    name: 'dom.query',
    description: 'Find elements by CSS selector, with text, attributes, box and visibility for each match.',
    schema: { ...scope, selector: z.string(), limit: z.number().optional(), frame_id: z.string().optional() },
    handler: op(domOps.query),
    readOnly: true,
  },
  {
    name: 'dom.inspect',
    description: 'Everything about one element: attributes, computed box, visibility, a stable selector path and its markup.',
    schema: { ...scope, ...locator },
    handler: op(domOps.inspect),
    readOnly: true,
  },
  {
    name: 'dom.get_html',
    description:
      'Markup of one element or of the whole document. Always stored as an artifact; only a bounded window is returned inline.',
    schema: { ...scope, ...locator, max_chars: z.number().optional(), whole_document: z.boolean().optional(), save_path: z.string().optional() },
    handler: op(domOps.getHtml),
    readOnly: true,
  },
  {
    name: 'dom.set_html',
    description: 'Replace an element and its subtree with new markup.',
    schema: { ...scope, ...locator, html: z.string() },
    handler: op(domOps.setHtml),
  },
  {
    name: 'dom.set_attribute',
    description: 'Set or remove an attribute on an element.',
    schema: { ...scope, ...locator, name: z.string(), value: z.string().optional(), remove: z.boolean().optional() },
    handler: op(domOps.setAttribute),
  },
  {
    name: 'dom.remove',
    description: 'Remove an element from the document.',
    schema: { ...scope, ...locator },
    handler: op(domOps.removeElement),
  },
  {
    name: 'dom.export',
    description: 'Dump the entire DOM tree, including shadow roots and iframe documents, to an artifact.',
    schema: { ...scope, include_shadow_dom: z.boolean().optional(), save_path: z.string().optional() },
    handler: op(domOps.exportDom),
    readOnly: true,
  },

  /* ---------------------------------- CSS -------------------------------- */
  {
    name: 'css.computed',
    description: 'Computed style of an element. Defaults to the properties that usually matter; pass all:true for everything.',
    schema: { ...scope, ...locator, properties: z.array(z.string()).optional(), all: z.boolean().optional() },
    handler: op(cssOps.computed),
    readOnly: true,
  },
  {
    name: 'css.matched_rules',
    description:
      'The cascade as DevTools shows it: which rule in which stylesheet at which line set each property, strongest first, plus inherited rules.',
    schema: { ...scope, ...locator, property: z.string().optional().describe('Narrow to one property.') },
    handler: op(cssOps.matchedRules),
    readOnly: true,
  },
  {
    name: 'css.set_style',
    description: 'Set inline style properties on an element, as editing element.style in DevTools would.',
    schema: { ...scope, ...locator, properties: z.record(z.string()) },
    handler: op(cssOps.setStyle),
  },
  {
    name: 'css.list_stylesheets',
    description: 'Stylesheets loaded by the document, with rule counts and cross-origin status.',
    schema: { ...scope },
    handler: op(cssOps.listStyleSheets),
    readOnly: true,
  },
  {
    name: 'css.get_stylesheet_text',
    description: 'Source text of one stylesheet, stored as an artifact.',
    schema: { ...scope, style_sheet_id: z.string(), save_path: z.string().optional() },
    handler: op(cssOps.getStyleSheetText),
    readOnly: true,
  },
  {
    name: 'css.explain_visibility',
    description:
      'Answers "why can I not see this?" by checking the element and every ancestor for display, visibility, opacity, zero size, clipping and occluders, and naming the culprit.',
    schema: { ...scope, ...locator },
    handler: op(cssOps.explainVisibility),
    readOnly: true,
  },

  /* ---------------------------------- JS --------------------------------- */
  {
    name: 'js.evaluate',
    description:
      'Run an expression exactly as typing it into the DevTools console would, command-line helpers ($, $$, $x) included. Awaits promises by default.',
    schema: {
      ...scope,
      expression: z.string().optional().describe('The code to run. Omit when using file.'),
      file: z
        .string()
        .optional()
        .describe('Read the code from this path on the daemon host instead. Use for long probes, where escaping into JSON is error-prone.'),
      bypass_module_cache: z
        .boolean()
        .optional()
        .describe('Cache-bust dynamic import() calls. Without this the page can return a module it loaded earlier, so a probe silently reports stale values.'),
      frame_id: z.string().optional(),
      await_promise: z.boolean().optional(),
      return_by_value: z.boolean().optional(),
      command_line_api: z.boolean().optional(),
      timeout_ms: z.number().optional(),
      max_chars: z.number().optional(),
    },
    handler: op(jsOps.evaluateExpression),
  },
  {
    name: 'js.list_scripts',
    description: 'Scripts, documents and stylesheets loaded by the page, plus eval\'d scripts when the debugger is enabled.',
    schema: { ...scope, types: z.array(z.string()).optional(), url_contains: z.string().optional() },
    handler: op(jsOps.listScripts),
    readOnly: true,
  },
  {
    name: 'js.get_source',
    description: 'Source of one script or resource. Returns a line window inline and the whole file as an artifact.',
    schema: {
      ...scope,
      url: z.string().optional(),
      script_id: z.string().optional(),
      line_start: z.number().optional(),
      line_end: z.number().optional(),
      save_path: z.string().optional(),
    },
    handler: op(jsOps.getSource),
    readOnly: true,
  },
  {
    name: 'js.search_source',
    description:
      'Grep every loaded script in the browser and return file:line hits with excerpts. Use this instead of pulling bundles into context.',
    schema: {
      ...scope,
      query: z.string(),
      is_regex: z.boolean().optional(),
      ignore_case: z.boolean().optional(),
      types: z.array(z.string()).optional(),
      url_contains: z.string().optional(),
      context_lines: z.number().optional(),
      max_files: z.number().optional(),
      max_matches_per_file: z.number().optional(),
    },
    handler: op(jsOps.searchSource),
    readOnly: true,
  },

  /* -------------------------------- console ------------------------------ */
  {
    name: 'console.query',
    description:
      'Console output and uncaught exceptions, recorded continuously and kept across navigations. Filter by level, text, regex and time window rather than dumping everything. Narrow the response with fields (e.g. ["level","text","at"]) and stack:"none" when you only need to see what was logged.',
    schema: {
      ...scope,
      ...timeWindow,
      ...paging,
      level: z.union([z.string(), z.array(z.string())]).optional().describe('e.g. "error" or ["error","warning"].'),
      source: z.string().optional(),
      search: z.string().optional(),
      regex: z.string().optional(),
      include_exceptions: z.boolean().optional(),
      ...consoleShape,
    },
    handler: op(consoleOps.query),
    readOnly: true,
  },
  {
    name: 'console.exceptions',
    description: 'Uncaught exceptions only, with stack traces.',
    schema: { ...scope, ...timeWindow, ...paging, search: z.string().optional(), ...consoleShape },
    handler: op(consoleOps.exceptions),
    readOnly: true,
  },
  {
    name: 'console.export',
    description: 'Write a time slice of the console to an NDJSON artifact. The answer to "50,000 log lines".',
    schema: {
      ...scope,
      ...timeWindow,
      level: z.union([z.string(), z.array(z.string())]).optional(),
      search: z.string().optional(),
      include_exceptions: z.boolean().optional(),
      save_path: z.string().optional(),
    },
    handler: op(consoleOps.exportLogs),
    readOnly: true,
  },
  {
    name: 'console.clear',
    description: 'Delete recorded console entries for a browser or one target.',
    schema: { ...scope },
    handler: op(consoleOps.clear),
  },

  /* -------------------------------- network ------------------------------ */
  {
    name: 'network.list_requests',
    description:
      'Recorded HTTP requests with status, type, size and timing. Recording runs continuously, so this covers traffic from before the AI was asked anything. Filter hard; fetch bodies separately.',
    schema: {
      ...scope,
      ...timeWindow,
      ...paging,
      url_contains: z.string().optional(),
      url_regex: z.string().optional(),
      method: z.string().optional(),
      resource_type: z.string().optional().describe('Document, XHR, Fetch, Script, Stylesheet, Image, ...'),
      mime_contains: z.string().optional(),
      status_min: z.number().optional(),
      status_max: z.number().optional(),
      state: z.enum(['pending', 'response', 'finished', 'failed']).optional(),
      has_body: z.boolean().optional(),
      failed_only: z.boolean().optional(),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe('Drop these hosts from the result, e.g. ["analytics.google.com"].'),
      include_aborted: z
        .boolean()
        .optional()
        .describe('Include requests the browser abandoned at navigation (net::ERR_ABORTED). Default false when failed_only is set.'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Return only these fields, e.g. ["url","status","started_at"]. Entries carry ~20 fields otherwise.'),
    },
    handler: op(networkOps.listRequests),
    readOnly: true,
  },
  {
    name: 'network.get_request',
    description:
      'Everything about one request: all request and response headers (including the ones actually put on the wire), initiator, timing, redirect chain and body availability.',
    schema: { request_id: z.string(), include_redirect_chain: z.boolean().optional() },
    handler: op(networkOps.getRequest),
    readOnly: true,
  },
  {
    name: 'network.get_body',
    description:
      'Request payload or response body for one request. Returns a bounded window plus an artifact handle, so a huge response never floods the context. as_json parses it for you.',
    schema: {
      request_id: z.string(),
      which: z.enum(['response', 'request']).optional(),
      max_chars: z.number().optional(),
      offset: z.number().optional(),
      as_json: z.boolean().optional(),
      save_path: z.string().optional(),
    },
    handler: op(networkOps.getBody),
    readOnly: true,
  },
  {
    name: 'network.summarize',
    description:
      'Aggregate view: what is slow, what failed, what is heaviest, grouped by domain, resource type or status. Start here for "what is wrong with this page".',
    schema: {
      ...scope,
      ...timeWindow,
      url_contains: z.string().optional(),
      resource_type: z.string().optional(),
      failed_only: z.boolean().optional(),
      group_by: z
        .enum(['domain', 'resource_type', 'status', 'error'])
        .optional()
        .describe('"error" groups by failure classification - refused vs timed out vs blocked need different answers.'),
      sort: z.enum(['duration', 'time']).optional().describe('Order the detail lists. Default "duration".'),
      exclude_domains: z.array(z.string()).optional().describe('Drop these hosts entirely, e.g. analytics.'),
      include_aborted: z
        .boolean()
        .optional()
        .describe('Count requests the browser abandoned at navigation (net::ERR_ABORTED). Default false: they are benign on every SPA route change.'),
    },
    handler: op(networkOps.summarize),
    readOnly: true,
  },
  {
    name: 'network.probe',
    description:
      'Issue a request from inside the page and report what the page sees. Unlike curl this respects CORS, service workers, proxies and the page origin, so it faithfully answers "can this app reach its API".',
    schema: {
      ...scope,
      url: z.string(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      timeout_ms: z.number().optional().describe('Default 10000.'),
    },
    handler: op(networkOps.probe),
    readOnly: true,
  },
  {
    name: 'network.search_bodies',
    description:
      'Search inside recorded request and response bodies. Answers "which response contained this token" without downloading every payload.',
    schema: {
      ...scope,
      ...timeWindow,
      query: z.string(),
      is_regex: z.boolean().optional(),
      ignore_case: z.boolean().optional(),
      which: z.enum(['response', 'request', 'both']).optional(),
      url_contains: z.string().optional(),
      max_files: z.number().optional(),
      max_matches_per_body: z.number().optional(),
    },
    handler: op(networkOps.searchBodies),
    readOnly: true,
  },
  {
    name: 'network.list_websockets',
    description: 'Recorded WebSocket connections, with handshake details and frame counts. Server-sent event streams appear here too.',
    schema: { ...scope, url_contains: z.string().optional(), open_only: z.boolean().optional(), limit: z.number().optional() },
    handler: op(networkOps.listWebSockets),
    readOnly: true,
  },
  {
    name: 'network.ws_messages',
    description: 'Frames on one WebSocket, filterable by direction and payload text.',
    schema: {
      websocket_id: z.string(),
      direction: z.enum(['sent', 'received']).optional(),
      search: z.string().optional(),
      ...paging,
    },
    handler: op(networkOps.wsMessages),
    readOnly: true,
  },
  {
    name: 'network.export_har',
    description: 'Export the matching requests as a HAR artifact, optionally with bodies embedded.',
    schema: {
      ...scope,
      ...timeWindow,
      url_contains: z.string().optional(),
      resource_type: z.string().optional(),
      include_bodies: z.boolean().optional(),
      save_path: z.string().optional(),
    },
    handler: op(networkOps.exportHar),
    readOnly: true,
  },
  {
    name: 'network.clear',
    description: 'Delete recorded requests for a browser.',
    schema: { ...browserId },
    handler: op(networkOps.clear),
  },

  /* -------------------------------- storage ------------------------------ */
  {
    name: 'storage.list',
    description: 'List localStorage or sessionStorage entries for the page origin.',
    schema: { ...scope, kind: z.enum(['local', 'session']).optional(), max_value_chars: z.number().optional() },
    handler: op(storageOps.list),
    readOnly: true,
  },
  {
    name: 'storage.get',
    description: 'Read storage keys in full, optionally parsed as JSON. Pass keys to read several in one round trip.',
    schema: {
      ...scope,
      kind: z.enum(['local', 'session']).optional(),
      key: z.string().optional().describe('A single key.'),
      keys: z.array(z.string()).optional().describe('Several keys at once; the response is an items array.'),
      as_json: z.boolean().optional(),
    },
    handler: op(storageOps.get),
    readOnly: true,
  },
  {
    name: 'storage.set',
    description: 'Write a localStorage or sessionStorage value.',
    schema: { ...scope, kind: z.enum(['local', 'session']).optional(), key: z.string(), value: z.string() },
    handler: op(storageOps.set),
  },
  {
    name: 'storage.remove',
    description: 'Delete storage keys. Pass keys to clear several in one call.',
    schema: {
      ...scope,
      kind: z.enum(['local', 'session']).optional(),
      key: z.string().optional(),
      keys: z.array(z.string()).optional(),
    },
    handler: op(storageOps.remove),
  },
  {
    name: 'storage.snapshot',
    description:
      'Local and session storage inline, optionally narrowed to a key prefix. Use for app-scoped state (feature flags, tour progress); pair with storage.import to restore it.',
    schema: {
      ...scope,
      kind: z.enum(['local', 'session', 'both']).optional().describe('Default both.'),
      prefix: z.string().optional().describe('Only keys starting with this, e.g. "myapp_".'),
      max_value_chars: z.number().optional(),
    },
    handler: op(storageOps.snapshot),
    readOnly: true,
  },
  {
    name: 'storage.import',
    description:
      'Write many storage keys at once, the counterpart to storage.snapshot/export. Sets up a scenario state in one call.',
    schema: {
      ...scope,
      kind: z.enum(['local', 'session']).optional(),
      items: z.record(z.string()).describe('Key/value pairs to write.'),
      clear_first: z.boolean().optional().describe('Clear the store first so the result is exact rather than merged.'),
    },
    handler: op(storageOps.importStorage),
  },
  {
    name: 'storage.clear',
    description: 'Clear all of localStorage or sessionStorage for the origin.',
    schema: { ...scope, kind: z.enum(['local', 'session']).optional() },
    handler: op(storageOps.clear),
  },
  {
    name: 'storage.export',
    description: 'Dump localStorage, sessionStorage and cookies to a JSON artifact.',
    schema: { ...scope, save_path: z.string().optional() },
    handler: op(storageOps.exportStorage),
    readOnly: true,
  },
  {
    name: 'storage.list_cookies',
    description: 'All browser cookies, filterable by domain or name.',
    schema: { ...browserId, domain_contains: z.string().optional(), name: z.string().optional() },
    handler: op(storageOps.listCookies),
    readOnly: true,
  },
  {
    name: 'storage.set_cookie',
    description: 'Set a cookie. Provide url or domain so Chromium knows where it belongs.',
    schema: {
      ...browserId,
      name: z.string(),
      value: z.string(),
      url: z.string().optional(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      http_only: z.boolean().optional(),
      same_site: z.enum(['Strict', 'Lax', 'None']).optional(),
      expires: z.number().optional().describe('Unix seconds.'),
    },
    handler: op(storageOps.setCookie),
  },
  {
    name: 'storage.delete_cookies',
    description: 'Delete cookies by name, optionally scoped to a domain, path or URL.',
    schema: { ...browserId, name: z.string(), domain: z.string().optional(), path: z.string().optional(), url: z.string().optional() },
    handler: op(storageOps.deleteCookies),
  },
  {
    name: 'storage.clear_cookies',
    description: 'Delete every cookie in the browser.',
    schema: { ...browserId },
    handler: op(storageOps.clearCookies),
  },
  {
    name: 'storage.indexeddb.databases',
    description: 'IndexedDB database names for the page origin.',
    schema: { ...scope },
    handler: op(storageOps.listDatabases),
    readOnly: true,
  },
  {
    name: 'storage.indexeddb.describe',
    description: 'Object stores, key paths and indexes of one IndexedDB database.',
    schema: { ...scope, database: z.string() },
    handler: op(storageOps.describeDatabase),
    readOnly: true,
  },
  {
    name: 'storage.indexeddb.query',
    description: 'Page through records in an IndexedDB object store.',
    schema: { ...scope, database: z.string(), object_store: z.string(), index: z.string().optional(), skip: z.number().optional(), limit: z.number().optional() },
    handler: op(storageOps.queryDatabase),
    readOnly: true,
  },
  {
    name: 'storage.indexeddb.put',
    description: 'Write a record into an IndexedDB object store (executed through the page\'s own IndexedDB API).',
    schema: { ...scope, database: z.string(), object_store: z.string(), value: z.unknown(), key: z.unknown().optional() },
    handler: op(storageOps.putRecord),
  },
  {
    name: 'storage.indexeddb.clear',
    description: 'Empty an IndexedDB object store.',
    schema: { ...scope, database: z.string(), object_store: z.string() },
    handler: op(storageOps.clearObjectStore),
  },
  {
    name: 'storage.indexeddb.delete_database',
    description: 'Delete an entire IndexedDB database.',
    schema: { ...scope, database: z.string() },
    handler: op(storageOps.deleteDatabase),
  },
  {
    name: 'storage.list_caches',
    description: 'Cache Storage buckets for the origin.',
    schema: { ...scope },
    handler: op(storageOps.listCaches),
    readOnly: true,
  },
  {
    name: 'storage.list_cache_entries',
    description: 'Entries inside one Cache Storage bucket.',
    schema: { ...scope, cache_id: z.string(), skip: z.number().optional(), limit: z.number().optional(), path_filter: z.string().optional() },
    handler: op(storageOps.listCacheEntries),
    readOnly: true,
  },
  {
    name: 'storage.usage',
    description: 'Storage usage and quota for the origin, broken down by storage type.',
    schema: { ...scope },
    handler: op(storageOps.usage),
    readOnly: true,
  },
  {
    name: 'storage.clear_origin',
    description: 'Wipe selected storage types for the page origin.',
    schema: { ...scope, types: z.array(z.string()).optional().describe('Default ["all"].') },
    handler: op(storageOps.clearOrigin),
  },

  /* ------------------------------- debugger ------------------------------ */
  {
    name: 'debugger.enable',
    description: 'Turn on the JavaScript debugger for a target and list the scripts it knows about.',
    schema: { ...scope },
    handler: op(debuggerOps.enable),
  },
  {
    name: 'debugger.disable',
    description: 'Turn the debugger off and drop its breakpoints.',
    schema: { ...scope },
    handler: op(debuggerOps.disable),
  },
  {
    name: 'debugger.list_scripts',
    description: 'Scripts the debugger has parsed, including inline and eval\'d code, with script ids.',
    schema: { ...scope, url_contains: z.string().optional(), include_anonymous: z.boolean().optional() },
    handler: op(debuggerOps.listScripts),
    readOnly: true,
  },
  {
    name: 'debugger.set_breakpoint',
    description: 'Set a breakpoint by URL, URL regex or script id, with an optional condition expression.',
    schema: {
      ...scope,
      url: z.string().optional(),
      url_regex: z.string().optional(),
      script_id: z.string().optional(),
      line: z.number().describe('1-based line number.'),
      column: z.number().optional(),
      condition: z.string().optional().describe('Only pause when this expression is truthy.'),
    },
    handler: op(debuggerOps.setBreakpoint),
  },
  {
    name: 'debugger.remove_breakpoint',
    description: 'Remove one breakpoint.',
    schema: { ...scope, breakpoint_id: z.string() },
    handler: op(debuggerOps.removeBreakpoint),
  },
  {
    name: 'debugger.list_breakpoints',
    description: 'Breakpoints currently set.',
    schema: { ...scope },
    handler: op(debuggerOps.listBreakpoints),
    readOnly: true,
  },
  {
    name: 'debugger.pause_on_exceptions',
    description: 'Pause on no exceptions, only uncaught ones, or all of them.',
    schema: { ...scope, state: z.enum(['none', 'uncaught', 'all']) },
    handler: op(debuggerOps.setPauseOnExceptions),
  },
  {
    name: 'debugger.pause',
    description: 'Pause JavaScript execution at the next statement.',
    schema: { ...scope, wait_ms: z.number().optional() },
    handler: op(debuggerOps.pause),
  },
  {
    name: 'debugger.resume',
    description: 'Resume execution.',
    schema: { ...scope },
    handler: op(debuggerOps.resume),
  },
  {
    name: 'debugger.step',
    description: 'Step into, over, or out of the current call while paused.',
    schema: { ...scope, kind: z.enum(['into', 'over', 'out']) },
    handler: op(debuggerOps.step),
  },
  {
    name: 'debugger.call_frames',
    description: 'The call stack while paused: functions, locations, scope chain and `this` for each frame.',
    schema: { ...scope },
    handler: op(debuggerOps.callFrames),
    readOnly: true,
  },
  {
    name: 'debugger.evaluate_on_frame',
    description: 'Evaluate an expression in the scope of a paused call frame: this is how you read local variables.',
    schema: { ...scope, expression: z.string(), call_frame_id: z.string().optional(), frame_index: z.number().optional() },
    handler: op(debuggerOps.evaluateOnCallFrame),
  },
  {
    name: 'debugger.inspect_object',
    description: 'Expand a remote object or scope handle into its properties.',
    schema: { ...scope, object_id: z.string(), own_properties_only: z.boolean().optional() },
    handler: op(debuggerOps.inspectObject),
    readOnly: true,
  },
  {
    name: 'debugger.wait_for_pause',
    description: 'Block until execution pauses (breakpoint hit or exception), then report where.',
    schema: { ...scope, timeout_ms: z.number().optional() },
    handler: op(debuggerOps.waitForPause),
    readOnly: true,
  },

  /* ------------------------------- inspector ----------------------------- */
  {
    name: 'inspector.pick',
    description:
      'Arm the DevTools element picker so the human can click the element they mean. Then read the result with inspector.picked.',
    schema: { ...scope, mode: z.enum(['searchForNode', 'searchForUAShadowDOM', 'none']).optional(), timeout_ms: z.number().optional() },
    handler: op(inspectorOps.pick),
  },
  {
    name: 'inspector.picked',
    description: 'The element the human last picked, as a backend_node_id usable by every element-taking tool.',
    schema: { ...scope },
    handler: op(inspectorOps.picked),
    readOnly: true,
  },
  {
    name: 'inspector.element',
    description: 'DevTools Elements panel for one node: box model, key computed styles, event listeners and accessibility role/name.',
    schema: { ...scope, ...locator, include_listeners: z.boolean().optional(), include_accessibility: z.boolean().optional() },
    handler: op(inspectorOps.element),
    readOnly: true,
  },
  {
    name: 'inspector.parents',
    description: 'Ancestor chain of an element with the layout properties that create stacking and clipping.',
    schema: { ...scope, ...locator },
    handler: op(inspectorOps.parent),
    readOnly: true,
  },
  {
    name: 'inspector.children',
    description: 'Direct children of an element with sizes and text.',
    schema: { ...scope, ...locator, limit: z.number().optional() },
    handler: op(inspectorOps.children),
    readOnly: true,
  },
  {
    name: 'inspector.snapshot',
    description:
      'DOMSnapshot: structure, layout and selected computed styles in one pass, flattened across shadow roots and iframes. Written to an artifact.',
    schema: { ...scope, computed_styles: z.array(z.string()).optional(), save_path: z.string().optional() },
    handler: op(inspectorOps.snapshot),
    readOnly: true,
  },
  {
    name: 'inspector.accessibility_tree',
    description: 'Full accessibility tree, as a screen reader would traverse it.',
    schema: { ...scope, max_nodes: z.number().optional(), save_path: z.string().optional() },
    handler: op(inspectorOps.accessibilityTree),
    readOnly: true,
  },
  {
    name: 'devtools.open',
    description:
      'Open a real DevTools window for the human, at a chosen panel. Experimental; keep using the CDP-backed tools for machine work.',
    schema: { ...scope, panel: z.string().optional().describe('elements, console, network, sources, timeline, heap-profiler, ...') },
    handler: op(inspectorOps.openDevTools),
  },

  /* -------------------------------- profiler ----------------------------- */
  {
    name: 'profile.start',
    description:
      'Preset-driven profiling. One call arms every recorder that matters: cpu, slow-page, hang, memory-leak, full. Reproduce the problem, then call profile.stop.',
    schema: { ...scope, preset: z.enum(['cpu', 'slow-page', 'hang', 'memory-leak', 'full']).optional() },
    handler: op(profilerOps.startProfile),
  },
  {
    name: 'profile.stop',
    description:
      'End the profile session and return one summary: top functions, longest tasks, heap growth, network failures and console errors, plus artifacts for each.',
    schema: { ...browserId, save_path: z.string().optional() },
    handler: op(profilerOps.stopProfile),
  },
  {
    name: 'profile.status',
    description: 'What is currently recording.',
    schema: { ...browserId },
    handler: op(profilerOps.profileStatus),
    readOnly: true,
  },
  {
    name: 'profiler.cpu.start',
    description: 'Start the sampling CPU profiler on a target.',
    schema: { ...scope, sampling_interval_us: z.number().optional() },
    handler: op(profilerOps.startCpu),
  },
  {
    name: 'profiler.cpu.stop',
    description: 'Stop the CPU profiler and return self-time per function, with the full .cpuprofile as an artifact.',
    schema: { ...scope, save_path: z.string().optional(), top: z.number().optional() },
    handler: op(profilerOps.stopCpu),
  },
  {
    name: 'profiler.cpu.analyze',
    description: 'Re-analyze a stored .cpuprofile artifact, with a different depth if wanted.',
    schema: { artifact_id: z.string(), top: z.number().optional() },
    handler: op(profilerOps.analyzeCpuProfile),
    readOnly: true,
  },
  {
    name: 'profiler.coverage.start',
    description: 'Start precise JavaScript coverage recording.',
    schema: { ...scope, detailed: z.boolean().optional() },
    handler: op(profilerOps.startCoverage),
  },
  {
    name: 'profiler.coverage.stop',
    description: 'Stop coverage and report unused bytes per script.',
    schema: { ...scope, save_path: z.string().optional() },
    handler: op(profilerOps.stopCoverage),
  },
  {
    name: 'profiler.trace.start',
    description: 'Start a Chromium trace. Presets: web-performance, minimal, javascript, rendering. Keep traces short.',
    schema: { ...browserId, preset: z.string().optional(), categories: z.array(z.string()).optional() },
    handler: op(profilerOps.startTrace),
  },
  {
    name: 'profiler.trace.stop',
    description: 'Stop tracing and stream the result to an artifact, without loading it into memory.',
    schema: { ...browserId, save_path: z.string().optional() },
    handler: op(profilerOps.stopTrace),
  },
  {
    name: 'profiler.trace.long_tasks',
    description:
      'Pull the long main-thread tasks out of a recorded trace. Answers "what hung the page" without the trace ever entering the context.',
    schema: { artifact_id: z.string(), min_duration_ms: z.number().optional(), limit: z.number().optional() },
    handler: op(profilerOps.longTasks),
    readOnly: true,
  },
  {
    name: 'memory.heap.snapshot',
    description: 'Take a heap snapshot, streamed straight to an artifact. Label it so you can diff two of them later.',
    schema: { ...scope, label: z.string().optional(), collect_garbage: z.boolean().optional(), save_path: z.string().optional() },
    handler: op(profilerOps.heapSnapshot),
  },
  {
    name: 'memory.heap.compare',
    description:
      'Diff two heap snapshots by constructor: what grew, what shrank, and how many detached DOM nodes accumulated. This is how leaks get found.',
    schema: { before_artifact_id: z.string(), after_artifact_id: z.string(), top: z.number().optional() },
    handler: op(profilerOps.compareHeap),
    readOnly: true,
  },
  {
    name: 'memory.gc',
    description: 'Force a garbage collection, so a following snapshot only shows genuinely retained objects.',
    schema: { ...scope },
    handler: op(profilerOps.collectGarbage),
  },
  {
    name: 'memory.usage',
    description: 'Current JS heap usage and DOM counters.',
    schema: { ...scope },
    handler: op(profilerOps.heapUsage),
    readOnly: true,
  },
  {
    name: 'performance.metrics',
    description: 'Runtime performance counters: heap, nodes, listeners, layout and script durations.',
    schema: { ...scope },
    handler: op(profilerOps.metrics),
    readOnly: true,
  },
  {
    name: 'performance.processes',
    description: 'Chromium processes with types, PIDs and cumulative CPU time. Useful when something hangs.',
    schema: { ...browserId },
    handler: op(profilerOps.processInfo),
    readOnly: true,
  },

  /* ---------------------------------- time -------------------------------- */
  {
    name: 'time.status',
    description: 'Whether a controlled clock is installed, how far it is skewed from real time, and how many timers are pending.',
    schema: { ...scope },
    handler: op(timeOps.status),
    readOnly: true,
  },
  {
    name: 'time.install',
    description:
      'Install a controlled clock over Date, setTimeout, setInterval, requestAnimationFrame and performance.now, optionally starting at a given time. Survives navigation.',
    schema: { ...scope, time: z.union([z.string(), z.number()]).optional().describe('ISO timestamp to start from.') },
    handler: op(timeOps.install),
  },
  {
    name: 'time.freeze',
    description: 'Pin the clock at an instant and stop timer progression until time.run, time.jump or time.resume.',
    schema: { ...scope, at: z.union([z.string(), z.number()]).optional() },
    handler: op(timeOps.freeze),
  },
  {
    name: 'time.run',
    description:
      'Advance the clock and fire every timer that comes due, in order. Use this to exercise intervals and timeouts without waiting: time.run("30m") on a 60s interval fires it 30 times.',
    schema: { ...scope, duration: z.union([z.string(), z.number()]).describe('e.g. "5m", "90s", "1500ms".') },
    handler: op(timeOps.run),
  },
  {
    name: 'time.jump',
    description:
      'Leap forward, firing each due timer at most once: the "closed the laptop for three hours" case. Different bug class from time.run.',
    schema: { ...scope, duration: z.union([z.string(), z.number()]) },
    handler: op(timeOps.jump),
  },
  {
    name: 'time.resume',
    description: 'Let the controlled clock run in real time again.',
    schema: { ...scope },
    handler: op(timeOps.resume),
  },
  {
    name: 'time.set_fixed_date',
    description:
      'Make Date.now() and new Date() always return one instant, while timers, animations and polling keep running normally.',
    schema: { ...scope, time: z.union([z.string(), z.number()]) },
    handler: op(timeOps.setFixedDate),
  },
  {
    name: 'time.clear_fixed_date',
    description: 'Stop pinning Date.',
    schema: { ...scope },
    handler: op(timeOps.clearFixedDate),
  },
  {
    name: 'time.set_wall_clock',
    description: 'Move perceived wall time to an instant without firing the timers in between.',
    schema: { ...scope, time: z.union([z.string(), z.number()]) },
    handler: op(timeOps.setWallClock),
  },
  {
    name: 'time.uninstall',
    description: 'Remove the controlled clock and restore the real timer functions.',
    schema: { ...scope },
    handler: op(timeOps.uninstall),
  },
  {
    name: 'time.virtual',
    description:
      'Chromium native virtual time, which also governs loading and rendering. Stronger but experimental; cannot be combined with the controlled clock.',
    schema: {
      ...scope,
      policy: z.enum(['advance', 'pause', 'pauseIfNetworkFetchesPending']).optional(),
      budget_ms: z.number().optional(),
      initial_time: z.union([z.string(), z.number()]).optional(),
    },
    handler: op(timeOps.virtualTime),
  },

  /* ------------------------------ environment ----------------------------- */
  {
    name: 'environment.status',
    description: 'Every override currently changing how the page behaves: device, network, CPU, clock, faults.',
    schema: { ...scope },
    handler: op(emulationOps.status),
    readOnly: true,
  },
  {
    name: 'environment.reset',
    description: 'Put every environment override back to browser defaults. Clock and fault rules are cleared separately.',
    schema: { ...scope },
    handler: op(emulationOps.resetAll),
  },
  {
    name: 'device.preset',
    description: 'Emulate a device: desktop, desktop-hidpi, laptop, iphone (390), iphone-se (375, the modern SE), phone-small (320, the original SE and the width most layouts break at), pixel, tablet, ipad. Sets viewport, DPR, touch and user agent.',
    schema: { ...scope, preset: z.string(), orientation: z.enum(['portrait', 'landscape']).optional() },
    handler: op(emulationOps.devicePreset),
  },
  {
    name: 'device.viewport',
    description: 'Set an exact viewport, device pixel ratio, mobile flag and touch emulation.',
    schema: {
      ...scope,
      width: z.number(),
      height: z.number(),
      device_scale_factor: z.number().optional(),
      mobile: z.boolean().optional(),
      touch: z.boolean().optional(),
      user_agent: z.string().optional(),
      orientation: z.enum(['portrait', 'landscape']).optional(),
    },
    handler: op(emulationOps.setViewport),
  },
  {
    name: 'device.orientation',
    description: 'Rotate the emulated screen.',
    schema: { ...scope, orientation: z.enum(['portrait', 'landscape']) },
    handler: op(emulationOps.setOrientation),
  },
  {
    name: 'device.reset',
    description: 'Drop device emulation and go back to the real window size.',
    schema: { ...scope },
    handler: op(emulationOps.resetDevice),
  },
  {
    name: 'cpu.throttle',
    description: 'Slow the renderer down by a factor: 1 is normal, 4 is a mid-range phone, 6 is a slow one.',
    schema: { ...scope, rate: z.number() },
    handler: op(emulationOps.throttleCpu),
  },
  {
    name: 'cpu.reset',
    description: 'Remove CPU throttling.',
    schema: { ...scope },
    handler: op(emulationOps.resetCpu),
  },
  {
    name: 'network.simulate',
    description:
      'Damage the network on purpose. Presets: slow-3g, fast-3g, 4g, bad-wifi, offline, none. Or set latency, download and upload directly.',
    schema: {
      ...scope,
      preset: z.string().optional(),
      offline: z.boolean().optional(),
      latency: z.union([z.string(), z.number()]).optional().describe('e.g. "400ms".'),
      download: z.union([z.string(), z.number()]).optional().describe('e.g. "750kbps".'),
      upload: z.union([z.string(), z.number()]).optional(),
    },
    handler: op(emulationOps.setNetworkConditions),
  },
  {
    name: 'network.simulate_reset',
    description: 'Restore normal network conditions.',
    schema: { ...scope },
    handler: op(emulationOps.resetNetworkConditions),
  },
  {
    name: 'cache.set_disabled',
    description: 'Disable or re-enable the HTTP cache, to test whether a bug is a caching artifact.',
    schema: { ...scope, disabled: z.boolean() },
    handler: op(emulationOps.setCacheDisabled),
  },
  {
    name: 'service_worker.bypass',
    description: 'Bypass service workers so requests go to the network.',
    schema: { ...scope, bypass: z.boolean() },
    handler: op(emulationOps.bypassServiceWorker),
  },
  {
    name: 'environment.timezone',
    description: 'Override the browser timezone with an IANA id, e.g. "America/New_York". Good for DST and midnight-rollover bugs.',
    schema: { ...scope, timezone: z.string() },
    handler: op(emulationOps.setTimezone),
  },
  {
    name: 'environment.locale',
    description: 'Override the browser locale, e.g. "de-DE".',
    schema: { ...scope, locale: z.string() },
    handler: op(emulationOps.setLocale),
  },
  {
    name: 'location.set',
    description: 'Override geolocation by coordinates or preset (mumbai, new-york, london, tokyo, sydney, san-francisco), or make it unavailable.',
    schema: {
      ...scope,
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      accuracy: z.number().optional(),
      preset: z.string().optional(),
      unavailable: z.boolean().optional(),
    },
    handler: op(emulationOps.setGeolocation),
  },
  {
    name: 'environment.color_scheme',
    description: 'Force prefers-color-scheme to dark, light or no-preference.',
    schema: { ...scope, scheme: z.enum(['dark', 'light', 'no-preference']) },
    handler: op(emulationOps.setColorScheme),
  },
  {
    name: 'environment.reduced_motion',
    description: 'Toggle prefers-reduced-motion.',
    schema: { ...scope, reduced: z.boolean() },
    handler: op(emulationOps.setReducedMotion),
  },
  {
    name: 'environment.media_features',
    description: 'Set arbitrary emulated media features, merged with what is already overridden.',
    schema: { ...scope, features: z.record(z.string()), media: z.string().optional() },
    handler: op(emulationOps.setMediaFeatures),
  },
  {
    name: 'environment.vision',
    description:
      'Simulate a vision deficiency: none, achromatopsia, blurredVision, deuteranopia, protanopia, tritanopia, reducedContrast. Screenshot afterwards to see the effect.',
    schema: { ...scope, deficiency: z.string() },
    handler: op(emulationOps.setVisionDeficiency),
  },
  {
    name: 'user_state.set',
    description: 'Emulate an idle user or a locked screen, for apps that change behaviour when nobody is there.',
    schema: { ...scope, user_active: z.boolean().optional(), screen_unlocked: z.boolean().optional(), reset: z.boolean().optional() },
    handler: op(emulationOps.setIdleState),
  },
  {
    name: 'permissions.grant',
    description: 'Grant browser permissions, e.g. ["geolocation", "notifications"], optionally scoped to one origin.',
    schema: { ...browserId, permissions: z.array(z.string()), origin: z.string().optional() },
    handler: op(emulationOps.grantPermissions),
  },
  {
    name: 'permissions.reset',
    description: 'Reset all permission overrides.',
    schema: { ...browserId },
    handler: op(emulationOps.resetPermissions),
  },
  {
    name: 'scenario.apply',
    description:
      'Apply a bundle of conditions at once: slow-mobile, terrible-network, offline, cold-load, low-end-desktop. Beats setting fifteen switches by hand.',
    schema: { ...scope, scenario: z.string() },
    handler: op(emulationOps.applyScenario),
  },
  {
    name: 'scenario.list',
    description: 'Available scenarios, device presets, network presets and vision deficiencies.',
    schema: {},
    handler: () => emulationOps.listScenarios(),
    readOnly: true,
  },

  /* --------------------------------- faults ------------------------------- */
  {
    name: 'fault.abort',
    description: 'Make matching requests fail. URL patterns use * wildcards, e.g. "**/analytics/**".',
    schema: {
      ...scope,
      url: z.string(),
      error_reason: z.string().optional().describe('Chromium error, e.g. Failed, ConnectionRefused, TimedOut.'),
      count: z.number().optional().describe('Apply to only the next N matches.'),
      resource_types: z.array(z.string()).optional(),
    },
    handler: op(faultOps.abort),
  },
  {
    name: 'fault.delay',
    description: 'Stall matching requests. Answers "what does the UI do if Save takes 20 seconds?".',
    schema: { ...scope, url: z.string(), delay: z.union([z.string(), z.number()]), count: z.number().optional(), resource_types: z.array(z.string()).optional() },
    handler: op(faultOps.delay),
  },
  {
    name: 'fault.replace_response',
    description: 'Return a synthetic response for matching requests, e.g. a 500 with an error body.',
    schema: {
      ...scope,
      url: z.string(),
      status: z.number().optional(),
      body: z.union([z.string(), z.record(z.unknown())]).optional(),
      headers: z.record(z.string()).optional(),
      count: z.number().optional(),
    },
    handler: op(faultOps.replaceResponse),
  },
  {
    name: 'fault.drop_next',
    description: 'Drop the next N matching requests, as a connection loss would.',
    schema: { ...scope, url: z.string(), count: z.number().optional() },
    handler: op(faultOps.dropNext),
  },
  {
    name: 'fault.modify_headers',
    description: 'Rewrite request headers on matching requests.',
    schema: { ...scope, url: z.string(), headers: z.record(z.string()), count: z.number().optional() },
    handler: op(faultOps.modifyHeaders),
  },
  {
    name: 'fault.list',
    description:
      'Active fault rules, how many times each has fired, and the URLs they actually matched. A rule showing times_applied:0 is the usual reason "the app ignored my outage" - the glob never fired.',
    schema: { ...browserId },
    handler: op(faultOps.list),
    readOnly: true,
  },
  {
    name: 'fault.test',
    description:
      'Dry-run a URL glob against the traffic already recorded, without creating a rule. Returns sample matches and non-matches, and warns when the pattern would also take out the document of the page you are driving. Use before fault.abort when the pattern is not obviously right.',
    schema: {
      ...scope,
      url: z.string().describe('The glob to test, e.g. "http://localhost:5000/**".'),
      resource_types: z.array(z.string()).optional().describe('Restrict to these CDP resource types.'),
      limit: z.number().optional().describe('Samples per bucket. Default 10.'),
    },
    handler: op(faultOps.test),
    readOnly: true,
  },
  {
    name: 'fault.remove',
    description: 'Remove one fault rule.',
    schema: { ...browserId, fault_id: z.string() },
    handler: op(faultOps.remove),
  },
  {
    name: 'fault.clear',
    description: 'Remove every fault rule and take request interception back down.',
    schema: { ...scope },
    handler: op(faultOps.clear),
  },

  /* -------------------------------- artifacts ----------------------------- */
  {
    name: 'artifact.list',
    description: 'Stored artifacts: bodies, screenshots, traces, heap snapshots, exports.',
    schema: {
      ...browserId,
      kind: z.string().optional(),
      label: z.string().optional().describe('Substring match on the label, to pull back one investigation\'s captures.'),
      limit: z.number().optional(),
    },
    handler: op(artifactOps.list),
    readOnly: true,
  },
  {
    name: 'artifact.stat',
    description: 'Size, mime, checksum and origin of one artifact.',
    schema: { artifact_id: z.string() },
    handler: op(artifactOps.stat),
    readOnly: true,
  },
  {
    name: 'artifact.read',
    description: 'Bounded byte-range read. Use encoding "base64" for binary artifacts.',
    schema: {
      artifact_id: z.string(),
      offset: z.number().optional(),
      length: z.number().optional(),
      encoding: z.enum(['utf8', 'base64']).optional(),
    },
    handler: op(artifactOps.read),
    readOnly: true,
  },
  {
    name: 'artifact.read_lines',
    description: 'Read a line window from a text artifact, 1-indexed and inclusive.',
    schema: { artifact_id: z.string(), start: z.number().optional(), end: z.number().optional() },
    handler: op(artifactOps.readLines),
    readOnly: true,
  },
  {
    name: 'artifact.search',
    description:
      'Streamed search inside an artifact, so a multi-hundred-megabyte body is searchable without ever being fully loaded.',
    schema: {
      artifact_id: z.string(),
      query: z.string(),
      is_regex: z.boolean().optional(),
      ignore_case: z.boolean().optional(),
      context_lines: z.number().optional(),
      max_matches: z.number().optional(),
    },
    handler: op(artifactOps.search),
    readOnly: true,
  },
  {
    name: 'artifact.json_query',
    description:
      'JSONPath query against a JSON artifact: $.data.users[?(@.status == \'disabled\')], $.a[1:5], $..name. Beats scanning a huge response by hand.',
    schema: { artifact_id: z.string(), path: z.string(), limit: z.number().optional() },
    handler: op(artifactOps.jsonQuery),
    readOnly: true,
  },
  {
    name: 'capture.bundle',
    description:
      'Bundle a time slice of the recording into a single zip: network HAR with bodies, console NDJSON, runnable curls, navigations and a summary.md. The window is chosen after the bug, so "capture the last 10 minutes" works without arming anything first. Credentials are masked unless redact:false.',
    schema: {
      ...browserId,
      ...timeWindow,
      include_bodies: z.boolean().optional(),
      redact: z.boolean().optional().describe('Mask credentials in headers, cookies and URLs. Default true.'),
      note: z.string().optional().describe('What the tester saw. Goes in summary.md.'),
      save_path: z.string().optional(),
    },
    handler: op(captureOps.bundle),
    readOnly: true,
  },
  {
    name: 'artifact.export',
    description: 'Copy an artifact to a path on the daemon host, for tooling outside this session.',
    schema: { artifact_id: z.string(), path: z.string() },
    handler: op(artifactOps.exportTo),
    readOnly: true,
  },
];
