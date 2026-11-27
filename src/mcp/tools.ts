import { z } from 'zod';
import type { OpsContext, ToolRun } from '../ops/context.js';
import * as artifactOps from '../ops/artifact.js';
import * as appStateOps from '../ops/appstate.js';
import * as attentionOps from '../ops/attention.js';
import * as visualOps from '../ops/visual-review.js';
import * as auditOps from '../ops/audit.js';
import * as batchOps from '../ops/batch.js';
import * as browserOps from '../ops/browser.js';
import * as captureOps from '../ops/capture.js';
import * as consoleOps from '../ops/console.js';
import * as cssOps from '../ops/css.js';
import * as debuggerOps from '../ops/debugger.js';
import * as domOps from '../ops/dom.js';
import * as emulationOps from '../ops/emulation.js';
import * as faultOps from '../ops/faults.js';
import * as fileOps from '../ops/file.js';
import * as gestureOps from '../ops/gesture.js';
import * as guideOps from '../ops/guide.js';
import * as inspectorOps from '../ops/inspector.js';
import * as jsOps from '../ops/js.js';
import * as layerViewOps from '../ops/layer-view.js';
import * as locatorOps from '../ops/locator.js';
import * as networkOps from '../ops/network.js';
import * as qaOps from '../ops/qa.js';
import * as pageOps from '../ops/page.js';
import * as profilerOps from '../ops/profiler.js';
import * as sensorOps from '../ops/sensors.js';
import * as skeletonOps from '../ops/skeleton.js';
import * as storageOps from '../ops/storage.js';
import * as workflowOps from '../ops/workflow.js';
import * as credentialOps from '../ops/credentials.js';
import * as timeOps from '../ops/time.js';

/** One MCP tool: name, blurb, argument schema, and the op it calls. */
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (ctx: OpsContext, args: Record<string, unknown>, run?: ToolRun) => Promise<Record<string, unknown>>;
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
const regionName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const cssSelector = z.string().min(1).max(1000);
const attentionTargets = z.array(z.union([
  z.object({ name: regionName, selector: cssSelector }).strict(),
  z.object({ name: regionName, text: z.string().trim().min(1).max(200) }).strict(),
])).max(20).optional().describe('Named elements to score. Use a unique top-document CSS selector or exact visible control text or aria-label.');
const designOptions = z.object({
  allowed_font_sizes: z.array(z.number().positive().finite()).max(40).optional(),
  allowed_button_heights: z.array(z.number().positive().finite()).max(40).optional(),
  max_sizes_per_role: z.number().int().min(1).max(20).optional(),
  geometry: z.union([z.boolean(), z.object({
    alignment_tolerance_px: z.number().min(0).max(50).optional(),
    spacing_tolerance_px: z.number().min(0).max(50).optional(),
    scope: cssSelector.optional().describe('Compare only groups in this section.'),
    ignore: cssSelector.optional().describe('Exclude intentionally staggered components.'),
  })]).optional().describe('Check aligned edges and repeated spacing of flex/grid siblings.'),
});
const attentionModel = {
  backend: z.enum(['fast', 'deep']).optional().describe('Fast UI saliency heuristic (default) or pretrained UNISAL for image-heavy screens and second estimates. Deep dependencies and weights download automatically on first use with the default uv runner.'),
  faces: z.boolean().optional().describe('Enable the optional YuNet face-attention layer. Default false.'),
  balance: z.union([z.boolean(), z.object({
    region: z.object({
      x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
      width: z.number().int().min(4), height: z.number().int().min(4),
    }).optional().describe('Area to measure in PNG pixels. Defaults to the whole image.'),
    target_left: z.number().min(0).max(1).optional().describe('Expected fraction on the left. Default 0.5.'),
    target_top: z.number().min(0).max(1).optional().describe('Expected fraction on top. Omit to report top/bottom without warning.'),
    tolerance: z.number().min(0).max(0.5).optional().describe('Allowed difference from each target fraction. Default 0.15.'),
  })]).optional().describe('Report visual balance, half and quadrant attention shares, and an approximate visual center.'),
  use_attention_targets: z.boolean().optional().describe('Score named element bounds saved on the screenshot. Default true.'),
  regions: z.array(z.object({
    name: regionName,
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })).max(30).optional().describe('Named rectangles in actual PNG pixels, measured from the top left.'),
};
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
/** How the gesture tools (drag, long_press, pinch, pointer) move. */
const gestureMotion = {
  input: z
    .enum(['auto', 'mouse', 'touch'])
    .optional()
    .describe('Default auto: touch when touch emulation is on for the tab (device.preset), else mouse.'),
  human: z
    .boolean()
    .optional()
    .describe('Default true: curved path, slow-fast-slow speed, hand jitter, short pauses. false: straight, even, no pauses.'),
  seed: z.number().optional().describe('Seed for the human randomness, to repeat a gesture exactly. Every call reports the seed it used.'),
  jitter_px: z.number().optional().describe('Hand wobble mid-path in CSS px. Default 1.5; 0 for a steady hand. Ends are always exact.'),
  modifiers: z.array(z.string()).optional().describe('Keys held throughout, e.g. ["Shift"] or ["Alt"].'),
  verify: z.boolean().optional().describe('Watch for DOM mutations after the gesture. Default true.'),
  verify_ms: z.number().optional().describe('How long to watch. Default 300.'),
};

/**
 * A locator a durable test can contain: role and accessible name, label, text
 * or test id, optionally scoped to a landmark. Deliberately unable to express a
 * CSS selector, an XPath or a positional index, which is what keeps a compiled
 * test from encoding today's DOM shape.
 */
const semanticTarget = z.object({
  by: z.enum(['role', 'label', 'text', 'testId']),
  role: z.string().optional().describe('Required when by="role", e.g. "button", "link", "textbox".'),
  name: z.string().optional().describe('Accessible name. Required when by="role".'),
  label: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  exact: z
    .boolean()
    .optional()
    .describe('Default false: case-insensitive substring. True is case-sensitive whole-string.'),
  within: z
    .object({
      role: z.string().describe('Landmark or role to scope to: main, navigation, banner, contentinfo, region, form, or any target role.'),
      name: z.string().optional(),
    })
    .optional()
    .describe('Scopes the locator to a landmark, which is how a repeated name stays unambiguous without .first().'),
});

/** Cast a typed op into the uniform handler shape. */
export function op<A>(
  fn: (ctx: OpsContext, args: A, run?: ToolRun) => Promise<Record<string, unknown>>,
): ToolDef['handler'] {
  return (ctx, args, run) => fn(ctx, args as A, run);
}

export const TOOLS: ToolDef[] = [
  {
    name: 'visual.review',
    description: 'Start here for visual QA after a UI change. Review the current page at phone and desktop widths with annotated screenshots, contrast, clipping, typography, alignment, spacing, predicted attention and optional baseline diffs.',
    schema: {
      ...scope,
      widths: z.array(z.number().int().min(200).max(2400)).min(1).max(5).optional().describe('CSS viewport widths. Defaults to the approved baseline, or 320, 414 and 1280.'),
      height: z.number().int().min(200).max(1800).optional().describe('CSS viewport height. Defaults to the approved baseline, or 800.'),
      design: designOptions.optional(),
      attention: z.union([z.boolean(), z.object({ backend: attentionModel.backend, balance: attentionModel.balance, faces: attentionModel.faces })]).optional().describe('Generate a heatmap and visual balance. Default runs on stable captures; set false for layout only.'),
      attention_targets: attentionTargets,
      mask_selectors: z.array(cssSelector).max(20).optional().describe('Exclude changing regions like timestamps from pixel diffs and stability checks. Omit to reuse baseline masks.'),
      baseline: z.string().trim().min(1).max(120).optional().describe('Name of an approved baseline for this page and state.'),
      threshold: z.number().min(0).max(1).optional().describe('Pixel difference threshold, default 0.1.'),
      return_image: z.boolean().optional().describe('Include the first viewport PNG inline. The annotated HTML always includes every viewport.'),
    },
    handler: op(visualOps.review),
  },
  {
    name: 'visual.approve_baseline',
    description: 'Save a reviewed, stable visual.review result under a project and page-state name. Replace an existing baseline only by supplying its current report ID.',
    schema: {
      name: z.string().trim().min(1).max(120), report_id: z.string(), replace_report_id: z.string().optional(),
    },
    handler: op(visualOps.approveBaseline),
  },
  {
    name: 'visual.list_baselines',
    description: 'Find approved visual review baselines and their report IDs.',
    schema: { limit: z.number().int().min(1).max(500).optional() },
    handler: op(visualOps.listBaselines),
    readOnly: true,
  },
  {
    name: 'visual.inspect_target',
    description: 'Diagnose a visible control you cannot click. Pass its CSS selector or viewport CSS point to see the nearby stacking contexts and which elements receive the hit.',
    schema: {
      ...scope, selector: cssSelector.optional(), point: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).optional(),
    },
    handler: op(visualOps.inspectTarget),
    readOnly: true,
  },
  {
    name: 'attention.analyze',
    description: 'Use for visual hierarchy, visual balance, CTA prominence, or clutter reviews. Predict attention on a clean PNG screenshot. Set balance:true for left/right weight, quadrants, and the estimated visual center.',
    schema: {
      screenshot_id: z.string().describe('PNG artifact ID from page.screenshot. Use mode:viewport for a first-glance review.'),
      ...attentionModel,
      overlay: z.boolean().optional().describe('Generate and store the PNG overlay. Default true.'),
      return_image: z.boolean().optional().describe('Include the overlay as an MCP image. Default true when overlay is enabled.'),
    },
    handler: op(attentionOps.analyze),
    readOnly: true,
  },
  {
    name: 'attention.compare',
    description: 'Compare predicted attention on two same-sized PNG screenshot artifacts. Named element targets are read from each capture, while manual regions use the same pixel coordinates in both.',
    schema: {
      baseline_id: z.string(),
      candidate_id: z.string(),
      ...attentionModel,
    },
    handler: op(attentionOps.compare),
    readOnly: true,
  },
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
      'Launch a new Chromium with a persistent profile. Not usually needed: any tool auto-launches a browser when none is running. Needed for camera, microphone or screen capture: pass media (e.g. {camera:true, microphone:true, fake_devices:true, screen:true}) so getUserMedia/getDisplayMedia prompts and the screen picker are answered automatically. When url is given, the result reports what actually committed (landed.url, landed.title, landed.http_status) rather than echoing the request.',
    schema: {
      profile: z.string().optional().describe('Named persistent profile. Reused across runs.'),
      launch_engine: z.enum(['native', 'patchright']).optional().describe('Choose Patchright when the task requests it. Use a fresh profile and keep the returned browser_id for later tools. Defaults to the configured engine, normally native.'),
      headless: z.boolean().optional().describe('Default false: a visible window a human can also use.'),
      url: z
        .string()
        .optional()
        .describe('Open this URL at startup. Launch-time navigation is racy; check landed in the result, or just use page.navigate.'),
      extensions: z.array(z.string()).optional().describe('Absolute paths to unpacked extension directories.'),
      chromium_path: z.string().optional(),
      capture_netlog: z.boolean().optional().describe('Also record Chromium NetLog (DNS, sockets, TLS).'),
      window_size: z.object({ width: z.number(), height: z.number() }).optional(),
      stealth: z
        .boolean()
        .optional()
        .describe(
          'Hide automation signals (navigator.webdriver, Chrome for Testing banner, empty plugins) so bot detectors like Cloudflare Turnstile treat the browser as a normal user session.',
        ),
      extra_args: z.array(z.string()).optional(),
      media: z
        .object({
          camera: z.boolean().optional().describe('Accept getUserMedia camera requests with no prompt, and grant the camera permission.'),
          microphone: z.boolean().optional().describe('Accept getUserMedia microphone requests with no prompt, and grant the microphone permission.'),
          screen: z.boolean().optional().describe('getDisplayMedia auto-picks a screen instead of showing the picker. Which screen is not controllable.'),
          screen_source: z
            .string()
            .optional()
            .describe('Auto-pick the capture source whose title contains this text, e.g. "Entire screen" (English UI). Implies screen.'),
          fake_devices: z
            .boolean()
            .optional()
            .describe('Replace real hardware with Chromium\'s synthetic camera and microphone. Repeatable, and needs no OS permission.'),
          video_file: z.string().optional().describe('Absolute path to a .y4m or .mjpeg file played as the camera. Implies fake_devices.'),
          image_file: z
            .string()
            .optional()
            .describe('Absolute path to a .jpg/.jpeg shown by the camera as a still image, e.g. a photo of a QR code for a scanner to read. Implies fake_devices; not with video_file.'),
          audio_file: z.string().optional().describe('Absolute path to a .wav file played (looping) as the microphone. Implies fake_devices.'),
          origin: z.string().optional().describe('Scope the camera/microphone grant to this origin. Default: every origin.'),
        })
        .optional()
        .describe(
          'Camera, microphone and screen capture without prompts, for testing getUserMedia/getDisplayMedia flows. Fixed at process start: to change it, close and relaunch. Replaces the daemon\'s configured media default; media:{} launches without any. The page must be a secure context (https, or http://localhost).',
        ),
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
    name: 'browser.reveal',
    description:
      'Put a headless session on screen for the human, in one call. Chromium fixes headless at process start, so this closes the browser and relaunches the same profile with a window, carrying the open tabs over. Cookies, localStorage and logins survive because they live in the profile; live page state (unsaved input, in-memory JS, agent DOM edits) does not, and the result says so. Returns a NEW browser_id.',
    schema: {
      ...browserId,
      url: z.string().optional().describe('Open this instead of the tabs that were open.'),
      control_mode: z
        .enum(['observe', 'shared', 'agent', 'paused'])
        .optional()
        .describe('Set on the new window, e.g. "observe" to hand it to the human and stop touching it.'),
      window_size: z.object({ width: z.number(), height: z.number() }).optional(),
    },
    handler: op(browserOps.reveal),
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
    name: 'page.reset_target',
    description:
      'Unstick one tab without closing Chromium. Use when a tab stops answering (evaluate or navigate hangs until timeout). Fails the tab\'s in-flight commands, terminates its running script, stops loading and parks it on about:blank (or url). mode "auto" (default) escalates to replacing the tab with a fresh one if the renderer still does not answer; the result then carries a NEW target_id.',
    schema: {
      ...scope,
      mode: z.enum(['auto', 'soft', 'recreate']).optional(),
      url: z.string().optional().describe('Where to park the tab afterwards. Default about:blank.'),
    },
    handler: op(pageOps.resetTarget),
  },
  {
    name: 'page.navigate',
    description:
      'Navigate to a URL and wait for the load state. Reports the committed URL, the document title and its HTTP status, and flags HTTP errors. Set verify_ms for pages that navigate again shortly after loading.',
    schema: {
      ...scope,
      url: z.string(),
      wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional(),
      timeout_ms: z.number().optional(),
      verify_ms: z.number().int().min(0).max(5000).optional().describe('Observe follow-up navigation for up to this many ms before reporting the displayed document. Counts toward timeout_ms. Default 0.'),
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
  },  {
    name: 'page.visit_batch',
    description:
      'Visit many URLs and extract from each, with a separate status per page (ok / error / timeout) so one bad page never stalls the rest. Runs in background tabs (concurrency, default 2) with a hard per-page deadline; a page that misses it has its tab reset and the batch moves on. The run lives in the daemon: this call waits up to wait_ms, returns every finished page, and the rest keeps going - poll page.batch_status, so a client timeout never loses results. Sends MCP progress notifications per page when the client asks for them. extract: "text" (innerText, default), "visible_text", "markdown" (doc capture; save:true also stores each as a document), or "none"; expression runs your own JS per page and returns its value.',
    schema: {
      ...browserId,
      urls: z.array(z.string()).describe('Absolute URLs, at most 500.'),
      extract: z.enum(['text', 'visible_text', 'markdown', 'none']).optional(),
      selector: z.string().optional().describe('Extract from this element instead of the whole page.'),
      expression: z.string().optional().describe('JS evaluated on each page after load; its JSON value is returned as value.'),
      max_chars: z.number().optional().describe('Text kept per page (default 4000, max 200000). text_length gives the full size.'),
      concurrency: z.number().optional().describe('Parallel tabs, 1-6. Default 2.'),
      page_timeout_ms: z.number().optional().describe('Hard deadline per page, navigation and extraction together. Default 45000.'),
      wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).optional(),
      settle_ms: z.number().optional().describe('Extra wait after load, before extracting.'),
      delay_ms: z.number().optional().describe('Pause between pages per tab. Use it on someone else\'s server.'),
      wait_ms: z.number().optional().describe('How long this call waits before returning what is done (default 60000, 0 returns at once).'),
      save: z.boolean().optional().describe('With extract:"markdown", also store each page in the doc library.'),
      collection: z.string().optional(),
      label: z.string().optional(),
    },
    handler: op(batchOps.visitBatch),
  },
  {
    name: 'page.batch_status',
    description:
      'Results so far of a page.visit_batch run, finished or not. wait_ms waits for more progress first; cancel:true stops the run and keeps everything already visited. Omit batch_id to list recent runs.',
    schema: {
      batch_id: z.string().optional().describe('Batch handle (bat_*).'),
      cancel: z.boolean().optional(),
      wait_ms: z.number().optional(),
      include_text: z.boolean().optional().describe('Default true. False returns statuses and values only.'),
      offset: z.number().optional(),
      limit: z.number().optional(),
    },
    handler: op(batchOps.batchStatus),
  },

  {
    name: 'page.screenshot',
    description:
      'See the rendered page. Returns the image for visual inspection plus a stored artifact. mode: viewport, full_page, element (with a locator), or sheet: the whole page cut into side-by-side columns that fit one screen, so a long page stays readable. Prefer sheet for reviewing a whole page; add width:320 for a phone or width:1280 for a desktop without touching the viewport.',
    schema: {
      ...scope,
      ...locator,
      attention_targets: attentionTargets,
      mode: z.enum(['viewport', 'full_page', 'element', 'sheet']).optional(),
      grid: z.object({
        spacing: z.number().int().min(16).max(1000).optional().describe('Distance between grid lines in viewport CSS pixels. Default 80. Smaller numbers make a denser grid.'),
      }).optional().describe('Viewport only. Draw numbered x/y coordinates for page.click, page.drag, or page.pointer. Pass {} for default spacing.'),
      columns: z.number().optional().describe('mode:sheet. Columns to cut the page into, up to 12. Default: whatever fits aspect.'),
      aspect: z.union([z.string(), z.number()]).optional().describe('mode:sheet. Shape to fit, like "16:10" or "4:3". Default 16:10.'),
      width: z.number().optional().describe('mode:sheet. Lay the page out at this CSS width for the capture, then put the viewport back. Under 600 emulates a phone.'),
      height: z.number().optional().describe('mode:sheet. Viewport height to go with width. Default 800 for a phone, 900 otherwise.'),
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
        .describe('Downscale the capture to at most this many CSS pixels wide. Cuts payload on wide or full-page shots. With mode:sheet it caps the whole sheet, default 2000.'),
    },
    handler: op(pageOps.screenshot),
    readOnly: true,
  },
  {
    name: 'page.filmstrip',
    description:
      'SEE MOTION. Records the page briefly and returns the frames tiled into ONE labelled contact sheet, so entrance ' +
      'animations, hovers, reveals and scroll effects can actually be judged. A screenshot is a single instant and ' +
      'repeated screenshots are unrelated instants; this samples evenly across a real recording. Drive the motion with ' +
      'reload, hover or scroll_by so there is something to film.',
    schema: {
      ...scope,
      duration_ms: z.number().optional().describe('How long to record. Default 2000, max 15000.'),
      frames: z.number().optional().describe('Frames in the sheet, sampled evenly across the recording. Default 8, max 24.'),
      columns: z.number().optional().describe('Columns in the contact sheet. Default 4.'),
      frame_width: z.number().optional().describe('Width of each frame in the sheet. Default 320.'),
      quality: z.number().optional().describe('JPEG quality 1-100. Default 72.'),
      reload: z.boolean().optional().describe('Reload as recording starts, to film an entrance animation.'),
      hover: z.string().optional().describe('CSS selector to hover once recording starts, to film a hover response.'),
      scroll_by: z
        .number()
        .optional()
        .describe('Scroll this many pixels across the recording, stepped, to film a scroll-driven effect.'),
      label: z.string().optional().describe('Tag for this capture. Filter later with artifact.list(label:).'),
      save_path: z.string().optional(),
      return_image: z.boolean().optional().describe('Default true. Set false to store only.'),
    },
    handler: op(pageOps.filmstrip),
    readOnly: true,
  },
  {
    name: 'page.snapshot',
    description:
      'Accessibility-tree snapshot of the interactive elements, each with a stable ref (eNN) usable by page.click and friends. Cheaper and more reliable than screenshots for deciding what to click. format:"aria" instead emits Playwright\'s aria-snapshot dialect for a toMatchAriaSnapshot assertion - refless, and it leaves existing refs alone.',
    schema: {
      ...scope,
      interactive_only: z.boolean().optional(),
      max_nodes: z.number().optional(),
      root_selector: z
        .string()
        .optional()
        .describe('Scope the walk to this subtree, e.g. "main". Keeps a large hidden SEO block from eating the whole node budget.'),
      format: z
        .enum(['refs', 'aria'])
        .optional()
        .describe('Default "refs". "aria" is a draft for a toMatchAriaSnapshot assertion and must be run once before it is trusted.'),
    },
    handler: op(pageOps.snapshot),
    readOnly: true,
  },
  {
    name: 'page.click',
    description:
      'Click or tap viewport coordinates (x and y in CSS pixels), or use a locator to reveal and click an element. By default watches for a DOM reaction and reports observed_change, so "the input was dispatched" is not mistaken for "the app handled it".',
    schema: {
      ...scope,
      ...locator,
      button: z.enum(['left', 'right', 'middle']).optional(),
      click_count: z.number().optional(),
      input: gestureMotion.input,
      modifiers: z.array(z.string()).optional().describe('e.g. ["Control", "Shift"].'),
      verify: z.boolean().optional().describe('Watch for DOM mutations after the click. Default true.'),
      verify_ms: z.number().optional().describe('How long to watch. Default 300.'),
      retry_if_unchanged: z
        .boolean()
        .optional()
        .describe('If nothing changed, retry through the element own .click(), which reaches framework handlers synthetic input can miss.'),
      x: z.number().optional().describe('With y and no locator: click this viewport point in CSS px (the `at.css` units every click reports). For controls no locator can reach.'),
      y: z.number().optional().describe('With x: viewport point in CSS px.'),
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
    name: 'page.drag',
    description:
      'Press, travel and release like a hand: drag-and-drop, slide a slider or "slide to unlock", reorder a list, pan a map, draw a stroke, or swipe (direction + distance, with touch input on a phone). ' +
      'The pointer approaches the source, presses, holds briefly, moves along a curved slow-fast-slow path with slight wobble, pauses, then releases. ' +
      'Native HTML5 draggable elements are detected and finished with real dragenter/dragover/drop. release:false leaves the press down for page.pointer or another page.drag.',
    schema: {
      ...scope,
      ...locator,
      x: z.number().optional().describe('With y and no locator: start at this viewport point (CSS px).'),
      y: z.number().optional(),
      to_selector: z.string().optional().describe('Drop on this element (its centre).'),
      to_xpath: z.string().optional(),
      to_text: z.string().optional(),
      to_ref: z.string().optional().describe('Snapshot ref of the drop target.'),
      to_backend_node_id: z.number().optional(),
      to_nth: z.number().optional(),
      to_x: z.number().optional().describe('With to_y: end at this viewport point.'),
      to_y: z.number().optional(),
      by_x: z.number().optional().describe('End this many px right of the start (negative: left). The usual way to move a slider.'),
      by_y: z.number().optional().describe('End this many px below the start (negative: above).'),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('Swipe: the way the finger/pointer moves. Without a start locator it starts at the viewport centre.'),
      distance: z.number().optional().describe('With direction. Default half the viewport.'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      duration_ms: z.number().optional().describe('Travel time. Default from distance and target size (Fitts), roughly 250-900ms; a direction swipe defaults to a 150-500ms flick released without a pause.'),
      steps: z.number().optional().describe('Intermediate moves. Default one per ~16ms of travel.'),
      hold_ms: z.number().optional().describe('Hold still after pressing, before moving. Default 70-180ms human; raise it (500+) for "press and hold to drag" lists.'),
      settle_ms: z.number().optional().describe('Hold still at the end before releasing. Default 60-160ms human.'),
      html5: z.boolean().optional().describe('Default true: detect native draggable and finish with drag events. false: only pointer events.'),
      release: z.boolean().optional().describe('Default true. false: keep the button/finger down at the end.'),
      ...gestureMotion,
    },
    handler: op(gestureOps.drag),
  },
  {
    name: 'page.long_press',
    description:
      'Press and hold on an element or point: long-press menus, "press and hold" buttons, hold-to-confirm, hold-to-record. ' +
      'Holds for duration_ms, or until until_selector/until_text appears (or disappears with until_gone) and then lets go. ' +
      'Mouse holds creep by a pixel now and then as a resting hand does. release:false keeps holding so page.drag or page.pointer can continue.',
    schema: {
      ...scope,
      ...locator,
      x: z.number().optional().describe('With y and no locator: press this viewport point (CSS px).'),
      y: z.number().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      duration_ms: z.number().optional().describe('How long to hold. Default 800; with until_* it is the most it will wait (default 15000, max 120000).'),
      until_selector: z.string().optional().describe('Release as soon as this CSS selector matches.'),
      until_text: z.string().optional().describe('Release as soon as this text is on the page.'),
      until_gone: z.boolean().optional().describe('Invert until_*: release once it is gone.'),
      release: z.boolean().optional().describe('Default true. false: keep holding after duration_ms.'),
      ...gestureMotion,
    },
    handler: op(gestureOps.longPress),
  },
  {
    name: 'page.pinch',
    description:
      'Two-finger touch gesture: pinch to zoom (scale over 1 spreads the fingers, under 1 pinches them together) and/or twist (rotate_deg). ' +
      'For maps, image viewers, canvases and anything reading multi-touch. Turn on touch emulation first (device.preset) so the page treats it as a touch device.',
    schema: {
      ...scope,
      ...locator,
      x: z.number().optional().describe('With y: centre of the gesture. Default the element centre, else the viewport centre.'),
      y: z.number().optional(),
      scale: z.number().optional().describe('Final finger spread / starting spread. 2 = zoom in, 0.5 = zoom out.'),
      rotate_deg: z.number().optional().describe('Twist the fingers by this many degrees, clockwise positive.'),
      start_distance: z.number().optional().describe('Starting gap between the fingers in CSS px. Default 120.'),
      angle_deg: z.number().optional().describe('Starting angle of the line between the fingers. Default 0 (side by side).'),
      duration_ms: z.number().optional().describe('Default 450.'),
      ...gestureMotion,
    },
    handler: op(gestureOps.pinch),
  },
  {
    name: 'page.pointer',
    description:
      'Raw pointer script for anything the other tools do not cover: draw a shape, hover-then-press, drag with a wheel scroll in the middle, a press in one call and the release in a later one. ' +
      'actions run in order; each move travels the human path from wherever the pointer is. The held button and position persist per tab between calls. ' +
      'Example: [{action:"move",selector:"canvas"},{action:"down"},{action:"move",x:300,y:200},{action:"move",x:350,y:260},{action:"up"}].',
    schema: {
      ...scope,
      actions: z
        .array(
          z.object({
            action: z.enum(['move', 'down', 'up', 'click', 'pause', 'wheel']),
            selector: z.string().optional(),
            xpath: z.string().optional(),
            text: z.string().optional(),
            ref: z.string().optional(),
            backend_node_id: z.number().optional(),
            frame_id: z.string().optional(),
            nth: z.number().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            button: z.enum(['left', 'right', 'middle']).optional().describe('down/click. Default left.'),
            duration_ms: z.number().optional().describe('move: travel time. pause: how long. Default 200 for pause.'),
            delta_x: z.number().optional().describe('wheel.'),
            delta_y: z.number().optional().describe('wheel. Positive scrolls down.'),
          }),
        )
        .describe('Steps. A locator or x/y on down/up/click/wheel moves there first.'),
      html5: z.boolean().optional().describe('Default true: a held left button that starts a native HTML5 drag finishes with drag events.'),
      ...gestureMotion,
    },
    handler: op(gestureOps.pointerSequence),
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
      'Audit mobile overflow, clipped text or controls, and small touch targets across widths. Use design:true for invisible text or same-color contrast, too many font sizes, inconsistent button heights, and repeated decorative gradients. Projects can supply allowed font sizes and button heights.',
    schema: {
      ...scope,
      widths: z.array(z.number()).optional().describe('CSS widths to test. Default [320, 414, 768, 1280].'),
      height: z.number().optional().describe('Viewport height for every width. Default 800.'),
      urls: z.array(z.string()).optional().describe('Audit these URLs in turn. Omit to audit the current page.'),
      min_touch_target: z.number().optional().describe('Smallest acceptable interactive dimension in CSS px. Default 24.'),
      design: z.union([z.boolean(), designOptions]).optional().describe('Enable design checks or pass project-specific typography, control sizes, and peer geometry rules.'),
      device_scale_factor: z.number().optional(),
    },
    handler: op((ctx, args: Parameters<typeof auditOps.auditLayout>[1]) => auditOps.auditLayout(ctx, args)),
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

  /* -------------------------------- locator ------------------------------- */
  {
    name: 'locator.candidates',
    description:
      'Given any element (ref, selector, xpath, text), the locators a durable test could use for it - role plus accessible name, label, text, test id - each with how many elements it actually matches right now. When a locator is ambiguous it computes the landmark scope that makes it unique, which is the honest alternative to .first(). Use this before writing a Playwright test or a scenario, not after it fails.',
    schema: {
      ...scope,
      ...locator,
      test_id_attribute: z.string().optional().describe('Default "data-testid".'),
    },
    handler: op(locatorOps.candidates),
    readOnly: true,
  },
  {
    name: 'locator.check',
    description:
      'Resolve a semantic locator against the live page and report how many elements it hits. A locator matching zero or several is far cheaper to find here than after compiling the test, running it three times and reading a strict-mode failure.',
    schema: {
      ...scope,
      target: semanticTarget,
      test_id_attribute: z.string().optional().describe('Default "data-testid".'),
    },
    handler: op(locatorOps.check),
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
  /* ------------------------------ app state ------------------------------ */
  {
    name: 'app.error_state',
    description:
      'Errors the application is holding that never reached the console. Frameworks (TanStack Query, SWR, Redux) catch what their own code paths throw and park it in state, so a handler can throw, roll its optimistic update back, and leave console.exceptions empty. Start here when a control does nothing and the console looks clean. Also reports whether this origin is a secure context, since crypto.randomUUID, clipboard and service workers are undefined on plain http:// but present on localhost.',
    schema: {
      ...scope,
      frame_id: z.string().optional(),
      include_capabilities: z.boolean().optional().describe('Secure-context and gated-API report. Default true.'),
    },
    handler: op(appStateOps.appErrorState),
    readOnly: true,
  },
  {
    name: 'app.diagnose_interaction',
    description:
      'Click a control and report what the application actually did: whether a handler was attached, whether it threw, whether any request was initiated, whether the app consumed the input, and any error the framework caught. Use instead of page.click when a control appears to do nothing - page.click reports DOM mutations, which unrelated re-renders also produce.',
    schema: {
      ...scope,
      selector: z.string().optional().describe('CSS selector for the control.'),
      text: z.string().optional().describe('Visible text of the control, when no selector is handy.'),
      frame_id: z.string().optional(),
      settle_ms: z.number().optional().describe('How long to watch after the click. Default 1500.'),
    },
    handler: op(appStateOps.diagnoseInteraction),
  },

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
      'Restore storage and cookies, the counterpart to storage.export. Pass a whole export payload as `state` to put a logged-in session back without replaying the login form, or `items`/`cookies` to set state piecemeal.',
    schema: {
      ...scope,
      kind: z.enum(['local', 'session']).optional(),
      items: z.record(z.string()).optional().describe('Key/value pairs to write into one store.'),
      cookies: z
        .array(z.record(z.any()))
        .optional()
        .describe('Cookies to restore, as returned by storage.list_cookies or storage.export.'),
      state: z
        .record(z.any())
        .optional()
        .describe('A whole storage.export payload: localStorage, sessionStorage and cookies restored together.'),
      clear_first: z.boolean().optional().describe('Clear the store first so the result is exact rather than merged.'),
    },
    handler: op(storageOps.importStorage),
  },
  {
    name: 'credentials.save',
    description:
      'Save a login the agent can USE but never READ. The password is encrypted at rest and no tool ever returns it, so a prompt-injected agent cannot exfiltrate it. Bound to an exact origin. Intended for development and test accounts.',
    schema: {
      site: z.string().describe('Short name to refer to it by, e.g. "staging".'),
      origin: z.string().describe('Exact origin it may be used on, e.g. "https://staging.example.com".'),
      username: z.string(),
      password: z.string().describe('Stored encrypted. Never returned by any tool.'),
      login_url: z.string().optional().describe('Where the login form lives, if not the origin root.'),
      fields: z.record(z.string()).optional().describe('Extra form fields by name attribute, e.g. an org or tenant.'),
      selectors: z
        .object({ username: z.string().optional(), password: z.string().optional(), submit: z.string().optional() })
        .optional()
        .describe('Override the auto-detected form selectors.'),
      note: z.string().optional(),
    },
    handler: op(credentialOps.saveCredential),
  },
  {
    name: 'credentials.login',
    description:
      'Sign in on the current page using a saved credential. The password goes straight from the vault into the field and is never exposed. Refuses if the page origin does not match the one the credential was saved for. Filling is not proof of login: confirm with page.expect.',
    schema: {
      ...scope,
      site: z.string(),
      username_selector: z.string().optional(),
      password_selector: z.string().optional(),
      submit_selector: z.string().optional(),
      submit: z.boolean().optional().describe('Default true. false fills without submitting.'),
    },
    handler: op(credentialOps.login),
  },
  {
    name: 'credentials.list',
    description: 'Saved credentials as metadata only: site, origin, username, when saved and last used. Never includes passwords.',
    schema: {},
    handler: op(credentialOps.listCredentials),
    readOnly: true,
  },
  {
    name: 'credentials.delete',
    description: 'Delete a saved credential.',
    schema: { site: z.string() },
    handler: op(credentialOps.deleteCredential),
  },
  {
    name: 'workflow.save',
    description:
      'Save a named, parameterised sequence of tool calls for replay. Use {{var}} anywhere in a step argument. Snapshot refs are refused: they are only valid for the snapshot that produced them, so save a selector, xpath or text locator instead.',
    schema: {
      name: z.string().describe('Name to replay it by.'),
      description: z.string().optional(),
      vars: z.array(z.string()).optional().describe('Variable names; any {{placeholder}} found in the steps is added automatically.'),
      steps: z
        .array(
          z.object({
            tool: z.string().describe('Tool name, e.g. "page.click".'),
            args: z.record(z.any()).optional(),
            expect: z.boolean().optional().describe('false to skip the built-in outcome assertion for this step.'),
          }),
        )
        .describe('Steps in order.'),
    },
    handler: op(workflowOps.saveWorkflow),
  },
  {
    name: 'workflow.run',
    description:
      'Replay a saved workflow, substituting variables. Each step is checked against what browserd observed (landed_characters, observed_change), so a run that did nothing is reported as a failure rather than success. Unsupplied vars fall back to WORKFLOW_VAR_<NAME> in the environment, which keeps credentials out of the saved file.',
    schema: {
      name: z.string(),
      vars: z.record(z.any()).optional().describe('Values for the workflow placeholders.'),
      continue_on_error: z.boolean().optional().describe('Keep going after a failed step instead of stopping.'),
      dry_run: z.boolean().optional().describe('Return the substituted steps without driving the browser.'),
    },
    handler: op(workflowOps.runWorkflow),
  },
  {
    name: 'workflow.list',
    description: 'Saved workflows, with their step counts and variables.',
    schema: {},
    handler: op(workflowOps.listWorkflows),
    readOnly: true,
  },
  {
    name: 'workflow.show',
    description: 'The full saved definition of one workflow.',
    schema: { name: z.string() },
    handler: op(workflowOps.showWorkflow),
    readOnly: true,
  },
  {
    name: 'workflow.delete',
    description: 'Delete a saved workflow.',
    schema: { name: z.string() },
    handler: op(workflowOps.deleteWorkflow),
  },
  {
    name: 'guide.search',
    description:
      'Search browserd\'s own documentation when you know the problem but not the tool. Ranks over tool names, summaries, argument descriptions, hand-written notes and long-form topics. Filter by family or by whether a tool mutates the page, sort by relevance, name or family, and pass full:true to expand every hit into its complete write-up.',
    schema: {
      query: z.string().describe('What you are trying to do, in plain words.'),
      family: z.string().optional().describe('Restrict to one tool family, e.g. "network".'),
      mutating: z.boolean().optional().describe('true for tools that change the page, false for read-only ones.'),
      kind: z.enum(['tools', 'topics', 'all']).optional().describe('Default "all".'),
      sort: z.enum(['relevance', 'name', 'family']).optional().describe('Default "relevance".'),
      limit: z.number().optional().describe('Max results. Default 15.'),
      full: z.boolean().optional().describe('Expand each hit into the full guide.tool write-up.'),
    },
    handler: op(guideOps.guideSearch),
    readOnly: true,
  },
  {
    name: 'guide.tool',
    description:
      'The long guide to one tool: what it is for, how it works underneath, every argument with its type and meaning read from the live registration, the caveats that cost a session, worked examples and related tools. Accurate by construction, because the arguments come from the same schema the server validates against.',
    schema: { name: z.string().describe('Tool name, e.g. "page.click". A near miss is resolved where it is unambiguous.') },
    handler: op(guideOps.guideTool),
    readOnly: true,
  },
  {
    name: 'guide.topic',
    description:
      'Long-form background on the system rather than on one tool: start, architecture (how it works under the hood), install (where this daemon lives and how to update it, with live paths), recording, artifacts, control, traps, repeat.',
    schema: { name: z.string().describe('Topic name. guide.list shows them all.') },
    handler: op(guideOps.guideTopic),
    readOnly: true,
  },
  {
    name: 'guide.orient',
    description:
      'START HERE if you have not used this server before. One call: what browserd is, every tool family and what each is for, which tool to reach for in the situations that come up most, and the techniques sessions habitually skip (reading component state off the React fiber, patching the running page to confirm a fix before editing a file). Cheaper than discovering the surface by trial.',
    schema: {
      verbose: z.boolean().optional().describe('Reserved; the default already includes every family.'),
    },
    handler: op(guideOps.guideOrient),
    readOnly: true,
  },
  {
    name: 'guide.list',
    description:
      'The index: every tool family with its size, how many of its tools mutate, and its family-wide notes, plus every documentation topic. Pass family to list that family\'s tools instead.',
    schema: {
      family: z.string().optional().describe('List the tools in this family instead of the family index.'),
      kind: z.enum(['tools', 'topics', 'all']).optional().describe('Default "all".'),
    },
    handler: op(guideOps.guideList),
    readOnly: true,
  },
  {
    name: 'skeleton.capture',
    description:
      'Measure the real UI at several widths and save a skeleton (bones) file: the exact boxes a loading placeholder should draw. Elements carrying the marker attribute (default data-skeleton) are used when present; otherwise the layout under `selector` is decomposed automatically - wrapped text into one bone per visual line, media and controls into their own boxes, and any container that paints a background or a rounded border into a lighter surface bone drawn underneath its children. Circles, pills and asymmetric corners are preserved as such. Bones are matched across widths by DOM position, so an element that only exists on desktop is recorded as absent on mobile rather than shifting the rest. Viewport emulation is always cleared afterwards.',
    schema: {
      ...scope,
      name: z.string().describe('Name to save the skeleton under; also its filename.'),
      url: z.string().optional().describe('Navigate here first. Omit to measure the current page.'),
      selector: z.string().optional().describe('Root to measure. Default body. Narrow this to skeleton one component.'),
      marker: z.string().optional().describe('Attribute marking elements to measure. Default "data-skeleton".'),
      widths: z.array(z.number()).optional().describe('CSS widths to capture. Default [375, 768, 1280].'),
      height: z.number().optional().describe('Viewport height for every width. Default 900.'),
      min_size: z.number().optional().describe('Ignore boxes smaller than this in CSS px. Default 1, which keeps hairline dividers.'),
      max_bones: z.number().optional().describe('Cap on bones per capture. Default 400.'),
      max_lines: z.number().optional().describe('Cap on line bones per text run. Default 12.'),
      containers: z
        .boolean()
        .optional()
        .describe(
          'Emit a lighter surface bone for containers that paint a background, image or rounded border, drawn underneath their children so a card reads as a card. Default true.',
        ),
      capture_rounded_borders: z
        .boolean()
        .optional()
        .describe('Treat a rounded element with a visible border as a surface even when its background is white or transparent. Default true.'),
      leaf_tags: z
        .array(z.string())
        .optional()
        .describe('Extra tags to capture as a bone when they have no children. Added to p, h1-h6, li, td, th.'),
      exclude_tags: z.array(z.string()).optional().describe('Tags to skip entirely, with their whole subtree, e.g. ["nav","footer"].'),
      exclude_selectors: z
        .array(z.string())
        .optional()
        .describe('CSS selectors to skip entirely, with their subtrees, e.g. [".icon","[data-no-skeleton]"]. An invalid selector is ignored rather than failing the capture.'),
      default_radius: z.number().optional().describe('Corner radius in px for bones whose element has none. Default 8.'),
      replace: z
        .boolean()
        .optional()
        .describe('Discard widths from an earlier capture of this name instead of merging them. By default re-capturing at one width keeps the others.'),
      device_scale_factor: z.number().optional(),
      mobile: z
        .boolean()
        .optional()
        .describe(
          'Emulate a mobile device as well as the width. Off by default: on a page without a <meta name="viewport"> it forces a 980px layout viewport, so the media queries evaluate at the wrong width and the capture describes the desktop layout.',
        ),
      save_path: z.string().optional().describe('Also write the .bones.json here.'),
      include_bones: z.boolean().optional().describe('Return every bone inline. Off by default: the summary is usually enough.'),
    },
    handler: op(skeletonOps.captureSkeleton),
  },
  {
    name: 'skeleton.emit',
    description:
      'Turn a captured skeleton into ready-to-paste source: html, css, react, vue, svelte, or the raw json. Output is mobile-first CSS - the narrowest captured width is the base rule and wider ones are min-width overrides - with horizontal geometry in percentages so it stretches between breakpoints. Honours prefers-reduced-motion.',
    schema: {
      name: z.string(),
      format: z.enum(['html', 'css', 'react', 'vue', 'svelte', 'json']).optional().describe('Default "html".'),
      animation: z.enum(['pulse', 'shimmer', 'solid']).optional().describe('Default "shimmer".'),
      color: z.string().optional().describe('Bone fill. Default a theme-neutral translucent grey.'),
      highlight: z.string().optional().describe('Shimmer sweep colour.'),
      container_color: z.string().optional().describe('Surface fill for container bones. Defaults to the bone colour at lower opacity.'),
      class_prefix: z.string().optional().describe('CSS class prefix. Default skeleton-<name>.'),
      component: z.string().optional().describe('Component name for react/vue/svelte output.'),
      breakpoints: z
        .enum(['container', 'media'])
        .optional()
        .describe(
          'What the breakpoints ask about. "container" (default) uses @container queries keyed on the width of the skeleton itself, which is what its geometry is relative to. "media" uses viewport @media queries: only correct when the skeleton fills the viewport, but needed for browsers older than Chrome 105 / Safari 16 / Firefox 110.',
        ),
      save_path: z.string().optional().describe('Also write the generated source here.'),
    },
    handler: op(skeletonOps.emitSkeleton),
    readOnly: true,
  },
  {
    name: 'skeleton.preview',
    description:
      'Draw a captured skeleton over the live page, anchored to the element it was measured from, so you can screenshot it and see whether the placeholder actually matches. The overlay lives in a shadow root outside the app tree, so page CSS cannot restyle it and it cannot restyle the page. Call with remove:true to take it down.',
    schema: {
      ...scope,
      name: z.string(),
      selector: z.string().optional().describe('Anchor element. Defaults to the selector the skeleton was captured from.'),
      animation: z.enum(['pulse', 'shimmer', 'solid']).optional(),
      color: z.string().optional(),
      highlight: z.string().optional(),
      container_color: z.string().optional(),
      breakpoints: z.enum(['container', 'media']).optional().describe('Default "container". See skeleton.emit.'),
      remove: z.boolean().optional().describe('Remove the overlay instead of drawing one.'),
    },
    handler: op(skeletonOps.previewSkeleton),
  },
  {
    name: 'skeleton.list',
    description: 'Captured skeletons, with their widths and bone counts.',
    schema: {},
    handler: op(skeletonOps.listSkeletons),
    readOnly: true,
  },
  {
    name: 'skeleton.show',
    description:
      'The bones of one skeleton. Pass width to get flat rectangles for the nearest captured width instead of the per-width map.',
    schema: {
      name: z.string(),
      width: z.number().optional().describe('Return rectangles for the captured width nearest this one.'),
      limit: z.number().optional().describe('Max bones returned. Default 100.'),
    },
    handler: op(skeletonOps.showSkeleton),
    readOnly: true,
  },
  {
    name: 'skeleton.delete',
    description: 'Delete a captured skeleton.',
    schema: { name: z.string() },
    handler: op(skeletonOps.deleteSkeleton),
  },
  {
    name: 'storage.clear',
    description: 'Clear all of localStorage or sessionStorage for the origin.',
    schema: { ...scope, kind: z.enum(['local', 'session']).optional() },
    handler: op(storageOps.clear),
  },
  {
    name: 'storage.export',
    description:
      'Dump localStorage, sessionStorage and cookies to a JSON artifact. format:"playwright" instead emits a real Playwright storageState file, which is what a test loads to start authenticated without replaying the login form.',
    schema: {
      ...scope,
      save_path: z.string().optional(),
      format: z
        .enum(['browserd', 'playwright'])
        .optional()
        .describe('Default "browserd" (diagnostic dump). "playwright" emits a loadable storageState; note it has no sessionStorage field.'),
    },
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
    name: 'inspector.layer_view',
    description: 'Use when a visible button is blocked, a menu is behind a header, or overlays overlap. The z_index view shows Chromium paint order and a front-to-back hit test at a point. Returns a numbered exploded PNG and optional HTML viewer. Use dom for nesting and composited for Chromium render layers and paint replays.',
    schema: {
      ...scope,
      mode: z.enum(['dom', 'z_index', 'composited']).optional().describe('Default z_index. Choose which kind of depth to visualize.'),
      selector: z.string().optional().describe('CSS selector for the element to focus.'),
      backend_node_id: z.number().int().positive().optional().describe('Highlight a node from inspector.element, inspector.picked, or another layer view.'),
      point: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).optional().describe('Viewport CSS point to mark. Returns the browser hit-test stack from front to back.'),
      radius: z.number().min(24).max(2000).optional().describe('Crop to this many CSS pixels around the point or focused element center.'),
      angle: z.number().min(-180).max(180).optional().describe('Camera rotation in degrees. Default -24.'),
      tilt: z.number().min(15).max(85).optional().describe('Camera elevation in degrees. Default 35.'),
      explode: z.number().min(0).max(200).optional().describe('Gap between depth levels. Default 64. Set 0 to collapse.'),
      max_layers: z.number().int().min(1).max(100).optional().describe('Max visible layers to draw and return. Default 16. Larger layers and the focus area are prioritized.'),
      detail: z.enum(['overview', 'all']).optional().describe('Overview (default) reduces tiny decorations and redundant DOM wrappers. All keeps them eligible for display.'),
      isolate: z.boolean().optional().describe('Draw only the layer matching selector or backend_node_id, above the original viewport.'),
      paint: z.boolean().optional().describe('Composited mode only. Replay paint for up to eight drawable layers. Default true.'),
      return_image: z.boolean().optional().describe('Return the PNG as an MCP image. Default true.'),
      interactive: z.boolean().optional().describe('Store a standalone HTML viewer with rotate, tilt, explode, focus and animation controls. Default true.'),
      save_path: z.string().optional().describe('Export the PNG to this path.'),
    },
    handler: op(layerViewOps.layerView),
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
    description: 'Rotate the emulated screen between portrait and landscape. This is the screen, not the gyroscope: for the tilt angles a page reads from deviceorientation, use sensor.orientation.',
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
    description:
      'Grant browser permissions, e.g. ["geolocation", "notifications", "camera", "microphone"], optionally scoped to one origin. Web names are mapped to CDP types (camera -> videoCapture, microphone -> audioCapture); CDP names pass through. Granting camera/microphone lets getUserMedia resolve with no prompt, but supplies no device; the getDisplayMedia screen picker cannot be granted away at all. For both, launch with browser.launch{media}.',
    schema: {
      ...browserId,
      permissions: z.array(z.string()).describe('Web permission names or CDP Browser.PermissionType names.'),
      origin: z.string().optional(),
    },
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

  /* --------------------------------- sensors ------------------------------ */
  {
    name: 'sensor.orientation',
    description:
      'Set how the device is held, so deviceorientation fires on a desktop: alpha (compass turn), beta (front-back tilt) and gamma (left-right tilt) in degrees, or a named pose (flat-face-up, portrait-upright, landscape-left, landscape-right). Angles given alongside a pose override it. For VR, aim the head instead: yaw/pitch/roll turn the head from the pose (default landscape-left, a phone in a headset), e.g. pitch:-30 to look down at a menu. This is the gyroscope a VR viewer, compass or tilt control reads.',
    schema: {
      ...scope,
      alpha: z.number().optional().describe('Rotation about the vertical axis, 0-360.'),
      beta: z.number().optional().describe('Front-back tilt, -180 to 180. 90 is upright in portrait (use 89: exactly 90 reads as null).'),
      gamma: z.number().optional().describe('Left-right tilt, -90 to 90. -90 is upright in landscape with the top to the left.'),
      pose: z.string().optional().describe('flat-face-up, portrait-upright, landscape-left (a phone in a VR headset) or landscape-right.'),
      yaw: z.number().optional().describe('Head turn left (+) / right (-) in degrees, about the vertical.'),
      pitch: z.number().optional().describe('Head tilt up (+) / down (-) in degrees.'),
      roll: z.number().optional().describe('Head roll toward the right ear (+) in degrees.'),
      absolute: z.boolean().optional().describe('Also drive deviceorientationabsolute / AbsoluteOrientationSensor.'),
    },
    handler: op(sensorOps.setOrientation),
  },
  {
    name: 'sensor.motion',
    description:
      'Feed devicemotion: acceleration (m/s^2, gravity removed), acceleration_including_gravity (m/s^2) and rotation_rate (rad/s), each as {x,y,z}. For shake detection, step counters and anything reading the accelerometer or gyroscope rate.',
    schema: {
      ...scope,
      acceleration: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      acceleration_including_gravity: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      rotation_rate: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    },
    handler: op(sensorOps.setMotion),
  },
  {
    name: 'sensor.path',
    description:
      'Play a head movement in real time, interpolated smoothly at up to 120 Hz, and return when it finishes: a preset (look-around, nod, spin, hold) relative to a base pose, or keyframes (head yaw/pitch/roll from the pose, or absolute angles). The only way to test smoothing, recentring and gaze-dwell logic, which a single static reading cannot exercise. For a realistic phone add jitter_deg / drift_deg_per_min (Chrome drops deviceorientation changes under 0.1 deg, so a perfectly still virtual phone looks dead) and motion:true to stream matching devicemotion. At most 60 seconds.',
    schema: {
      ...scope,
      preset: z.string().optional().describe('look-around (yaw sweep), nod (pitch), spin (full turn), or hold (stay on the pose; pair with jitter/drift).'),
      keyframes: z
        .array(
          z.object({
            at_ms: z.number(),
            yaw: z.number().optional(),
            pitch: z.number().optional(),
            roll: z.number().optional(),
            alpha: z.number().optional(),
            beta: z.number().optional(),
            gamma: z.number().optional(),
          }),
        )
        .optional()
        .describe('Poses at times from the start: a head turn (yaw/pitch/roll, degrees from the base pose; pitch -30 looks down) or absolute angles (a missing one keeps the base pose value). Not both in one frame. Repeat a pose at two times to hold it, e.g. to dwell on a gaze target.'),
      pose: z.string().optional().describe('Base pose. Default landscape-left, a phone in a headset.'),
      amplitude: z.number().optional().describe('Degrees of swing for a preset. Default 45.'),
      duration_ms: z.number().optional().describe('Length of a preset. Default 4000.'),
      hz: z.number().optional().describe('Samples per second, 1-120. Default 60.'),
      jitter_deg: z.number().optional().describe('RMS sensor shake added to every sample, 0-5 degrees. Real phones: about 0.02-0.3.'),
      drift_deg_per_min: z.number().optional().describe('Slow yaw creep, as an uncorrected gyro has. Real phones: about 0.1-10.'),
      motion: z.boolean().optional().describe('Also stream devicemotion consistent with the path: gravity in device axes and the rotation rate. Default false.'),
      seed: z.number().optional().describe('Noise seed, so a noisy run replays identically. Default 1.'),
      absolute: z.boolean().optional(),
    },
    handler: op(sensorOps.playPath),
  },
  {
    name: 'sensor.set',
    description:
      'Set one raw sensor reading: accelerometer, linear-acceleration, gravity, gyroscope or magnetometer take x/y/z; absolute-orientation and relative-orientation take a quaternion x/y/z/w; ambient-light takes value in lux. available:false makes the page see the sensor as missing, which is how to test the "no gyroscope" fallback.',
    schema: {
      ...scope,
      type: z.string().describe('accelerometer, linear-acceleration, gravity, gyroscope, magnetometer, absolute-orientation, relative-orientation, ambient-light.'),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      w: z.number().optional(),
      value: z.number().optional().describe('For ambient-light, in lux.'),
      available: z.boolean().optional().describe('false reports the sensor as absent on this device.'),
    },
    handler: op(sensorOps.setSensor),
  },
  {
    name: 'sensor.status',
    description: 'Which sensors are overridden on this page, plus the available sensor types, poses and path presets, and what cannot be emulated (proximity; the camera is a browser.launch option).',
    schema: { ...scope },
    handler: op(sensorOps.status),
    readOnly: true,
  },
  {
    name: 'sensor.reset',
    description: 'Stop overriding one sensor type, or all of them, and return the page to the real sensors.',
    schema: { ...scope, type: z.string().optional() },
    handler: op(sensorOps.reset),
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
  {
    name: 'file.write',
    description:
      'Write a file on the daemon host in one call, instead of echoing content through a shell in chunks. Source is exactly one of content (text, or base64 with encoding), json (pretty-printed), artifact_id, or batch_id (a page.visit_batch run\'s results, partial if still running). The file name is sanitized for every OS (illegal characters, reserved names like CON, trailing dots, length); the directory must be absolute and is created. on_conflict: "rename" (default, writes "name (2).ext"), "error", or "overwrite" (atomic replace).',
    schema: {
      path: z.string().optional().describe('Absolute path. Only the file name part is sanitized.'),
      dir: z.string().optional().describe('Absolute directory; use with filename.'),
      filename: z.string().optional().describe('File name, sanitized before use. Handy when it comes from a page title.'),
      content: z.string().optional(),
      encoding: z.enum(['utf8', 'base64']).optional(),
      json: z.unknown().optional(),
      artifact_id: z.string().optional(),
      batch_id: z.string().optional(),
      on_conflict: z.enum(['error', 'rename', 'overwrite']).optional(),
    },
    handler: op(fileOps.write),
  },

  /* ----------------------------------- QA --------------------------------- */
  {
    name: 'qa.record_start',
    description:
      'Start recording the flow you are about to drive, as steps a test harness can compile. Every mutating page action is captured with its semantic locator resolved before the action runs, which is the only moment that answer is reliable. Network and console were already being recorded and are unaffected.',
    schema: {
      ...scope,
      flow: z.string().describe('What is being exercised, e.g. "create a todo".'),
    },
    handler: op(qaOps.recordStart),
  },
  {
    name: 'qa.record_stop',
    description: 'Stop recording. The steps survive, so qa.steps and qa.scenario_draft still work afterwards.',
    schema: {},
    handler: op(qaOps.recordStop),
  },
  {
    name: 'qa.record_status',
    description: 'Whether a recording is active, and how much it has captured.',
    schema: {},
    handler: op(qaOps.recordStatus),
    readOnly: true,
  },
  {
    name: 'qa.steps',
    description:
      'The recorded flow as scenario steps, each with its semantic target and, where one exists, the reason it cannot be compiled as recorded. A step whose locator matches several elements is reported rather than quietly narrowed.',
    schema: { include_problems: z.boolean().optional() },
    handler: op(qaOps.steps),
    readOnly: true,
  },
  {
    name: 'qa.evidence',
    description:
      'What browserd observed during a window, shaped as things a scenario could assert: first-party XHR/fetch calls as requestSeen candidates, the navigation path, console errors, exceptions and HTTP failures. Because recording is always on, the window is chosen after the flow, once you know the question. Every candidate carries a null oracle: it says what happened, never what should have happened.',
    schema: {
      ...scope,
      ...timeWindow,
      origin: z.string().optional().describe('First-party origin. Inferred from the document request when omitted.'),
    },
    handler: op(qaOps.evidence),
    readOnly: true,
  },
  {
    name: 'qa.scenario_draft',
    description:
      'The recorded flow as a draft scenario. It is deliberately not compilable: assertions are empty and requirementSource is null, because those are the two things an agent must not invent. Candidate assertions are listed separately for a human or an agent to promote against a real requirement.',
    schema: {
      ...scope,
      id: z.string().describe('Lowercase letters, numbers and hyphens, e.g. "todo-create".'),
      name: z.string(),
      requirement_source: z.string().optional().describe('The requirement document this flow is tested against.'),
      start_path: z.string().optional(),
      role: z.string().optional().describe('Auth role whose stored state the test should load.'),
      viewport: z.string().optional(),
    },
    handler: op(qaOps.scenarioDraft),
    readOnly: true,
  },
  {
    name: 'qa.session_events',
    description:
      'The recording as an exploration event log a QA harness can ingest (Auto-QA: feed each to qa_record_event). Returned rather than written, so the harness keeps control of its own evidence directory.',
    schema: { ...scope, ...timeWindow },
    handler: op(qaOps.sessionEvents),
    readOnly: true,
  },
];
