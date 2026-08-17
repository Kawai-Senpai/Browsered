/*
 * Service worker: capture orchestration.
 *
 * Design rule for this file: hold no capture state in module scope. Chrome may
 * terminate this worker between any two events, so every read goes through the
 * durable session store and every mutation is followed by a touch or a flush.
 * The only module-level state permitted is derived, cheap to rebuild, and
 * harmless to lose (the CDP clock offsets below).
 */

import {
  createSession,
  loadSession,
  putSession,
  deleteSession,
  touch,
  flush,
  flushAll,
  listSessions,
  pushEvent,
  pushNavigation,
  entryGet,
  entrySet,
  entryValues,
  windowedEvidence,
  LIMITS
} from "./session-store.js";

import {
  BODY_MIME,
  redactHeaders,
  redactText,
  sanitizeValue,
  stringifySafe
} from "./redact.js";

const MAX_BODY_BYTES = 1_000_000;

const CDP_DOMAINS = [
  [
    "Network.enable",
    {
      maxTotalBufferSize: 20_000_000,
      maxResourceBufferSize: 2_000_000,
      maxPostDataSize: 1_000_000
    }
  ],
  ["Runtime.enable", undefined],
  ["Log.enable", undefined],
  ["Page.enable", undefined],
  ["DOM.enable", undefined],
  ["CSS.enable", undefined],
  ["Accessibility.enable", undefined],
  ["Performance.enable", undefined]
];

const SNAPSHOT_STYLES = [
  "display",
  "position",
  "z-index",
  "width",
  "height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border-radius",
  "overflow",
  "opacity",
  "transform"
];

/*
 * Derived, disposable: maps a tab's CDP monotonic clock onto wall time. Lost on
 * worker restart, which only costs a slightly less precise offset.
 */
const clockOffsets = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onSuspend?.addListener(() => {
  void flushAll();
});

/*
 * Panel liveness. The overlay swallows clicks on the page, so leaving a tab
 * armed after the panel is gone makes the page feel broken with no visible
 * cause and no control left to switch it off. Closing the panel is therefore
 * treated as "disarm everything"; the port is the only signal Chrome gives us
 * that a side panel went away.
 */
const panelPorts = new Set();

function panelOpen() {
  return panelPorts.size > 0;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "context-capsule-panel") {
    return;
  }

  panelPorts.add(port);

  port.onMessage.addListener((message) => {
    void handlePanelMessage(message, port);
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);

    if (!panelOpen()) {
      void disarmAll();
    }
  });
});

/**
 * Tear down every armed tab: stop the overlay, detach the debugger, drop the
 * session. Best effort per tab — one dead tab must not strand the others.
 */
async function disarmAll() {
  /* Flush first so a session still only in the write-behind cache is seen. */
  await flushAll().catch(() => {});

  const sessions = (await listSessions().catch(() => [])).filter(
    (session) => session?.armed
  );

  await Promise.all(
    sessions.map(async (session) => {
      const tabId = session.tabId;

      try {
        await chrome.tabs.sendMessage(tabId, { type: "CC_STOP" });
      } catch {
        /* The tab or content script may already be gone. */
      }

      if (session.attached) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          /* Already detached. */
        }
      }

      clockOffsets.delete(tabId);

      await deleteSession(tabId).catch(() => {});
    })
  );
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) {
    return;
  }

  void handleDebuggerEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) {
    return;
  }

  void (async () => {
    const session = await loadSession(source.tabId);

    if (!session) {
      return;
    }

    session.attached = false;
    session.detachReason = reason;

    /*
     * Detach is exactly the moment a naive implementation loses everything, so
     * this flush is awaited rather than debounced.
     */
    await flush(source.tabId);

    broadcastStatus(source.tabId);
  })();
});

/*
 * Navigation resilience. A single-page-app route change keeps the content
 * script alive; a real document load does not. Re-inject and re-arm so the
 * overlay does not silently disappear mid-capture.
 */
/*
 * Switching tabs used to leave the panel describing the tab you left, with no
 * way to notice except that capture silently did nothing. The panel always
 * describes the active tab, so every change of active tab is a status change.
 */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    await autoArm(tabId);

    broadcastStatus(tabId);
  })();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  void (async () => {
    const tab = await getActiveTab().catch(() => null);

    if (tab) {
      await autoArm(tab.id);

      broadcastStatus(tab.id);
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void (async () => {
    const session = await loadSession(tabId);

    if (!session?.armed) {
      /*
       * Not armed, but the page still changed under the panel — refresh it so
       * the header never describes a page that is no longer there, and pick up
       * a newly loaded page if auto-arm is on.
       */
      if (changeInfo.status === "complete") {
        await autoArm(tabId);

        broadcastStatus(tabId);
      }

      return;
    }

    if (changeInfo.status === "loading" && changeInfo.url) {
      pushNavigation(session, {
        url: redactText(changeInfo.url),
        timeMs: Date.now(),
        timestamp: new Date().toISOString(),
        kind: "document-load"
      });

      await flush(tabId);

      return;
    }

    if (changeInfo.status !== "complete") {
      return;
    }

    /*
     * Armed, but the panel is gone — a session that outlived its panel, e.g.
     * because the worker restarted. Re-injecting here would resurrect the
     * overlay on a page with no way to switch it off.
     */
    if (!panelOpen()) {
      await disarmAll();

      broadcastStatus(tabId);

      return;
    }

    try {
      await injectContentScript(tabId);

      await chrome.tabs.sendMessage(tabId, { type: "CC_START" });
    } catch (error) {
      pushEvent(session, {
        category: "extension",
        level: "warning",
        timeMs: Date.now(),
        timestamp: new Date().toISOString(),
        text:
          "Could not re-arm the overlay after navigation: " +
          toErrorMessage(error)
      });
    }

    await flush(tabId);

    broadcastStatus(tabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clockOffsets.delete(tabId);

  void deleteSession(tabId);
});

async function handlePanelMessage(message, port) {
  const requestId = message.requestId;

  try {
    let result;

    switch (message.type) {
      case "GET_STATUS":
        result = await getStatus();
        break;

      case "ARM":
        result = await armActiveTab();
        break;

      case "STOP":
        result = await stopActiveTab();
        break;

      case "SET_AUTO_ARM": {
        await chrome.storage.local.set({
          [AUTO_ARM_KEY]: Boolean(message.enabled)
        });

        if (message.enabled) {
          const tab = await getActiveTab();

          await autoArm(tab.id);
        }

        result = await getStatus();
        break;
      }

      case "SET_TOOL":
        result = await sendToActiveTab({
          type: "CC_SET_TOOL",
          tool: message.tool
        });
        break;

      case "CLEAR_MARKUP":
        result = await sendToActiveTab({
          type: "CC_CLEAR_MARKUP"
        });
        break;

      case "CAPTURE_FRAME":
        result = await captureFrame(
          message.intent || {},
          message.options || {}
        );
        break;

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }

    port.postMessage({ requestId, ok: true, result });
  } catch (error) {
    port.postMessage({
      requestId,
      ok: false,
      error: toErrorMessage(error)
    });
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active browser tab found.");
  }

  return tab;
}

async function getStatus() {
  const tab = await getActiveTab();
  const session = await loadSession(tab.id);

  return {
    tabId: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    armed: Boolean(session?.armed),
    attached: Boolean(session?.attached),

    autoArm: await autoArmEnabled(),

    /*
     * Stated explicitly so the panel can explain an inactive step instead of
     * leaving the user to guess why nothing happens on a chrome:// page.
     */
    capturable: isCapturable(tab.url),

    armedAt: session?.startedAt
      ? new Date(session.startedAt).toISOString()
      : null,

    eventCount: session?.events.length || 0,
    requestCount: session?.requests.length || 0,
    bodyCount: session?.responseBodies.length || 0,
    navigationCount: session?.navigations.length || 0,

    limits: LIMITS,
    detachReason: session?.detachReason || null,

    lastFlushedAt: session?.lastFlushedAt
      ? new Date(session.lastFlushedAt).toISOString()
      : null
  };
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function armActiveTab() {
  const tab = await getActiveTab();

  return armTab(tab.id);
}

/*
 * Pages no extension may touch. Attempting them throws a raw Chrome error that
 * reads like a bug in this tool, so auto-arm skips them and the panel says why.
 */
const UNCAPTURABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/;

export function isCapturable(url) {
  return Boolean(url) && !UNCAPTURABLE.test(url);
}

const AUTO_ARM_KEY = "cc.autoArm";

async function autoArmEnabled() {
  const stored = await chrome.storage.local.get(AUTO_ARM_KEY);

  /* On by default: arming manually every time was the top confusion report. */
  return stored?.[AUTO_ARM_KEY] !== false;
}

/**
 * Arm a tab without being asked, when the panel is open and the tab can
 * actually be captured. Failures are deliberately silent — an automatic action
 * the user did not request must never interrupt them with an error.
 */
async function autoArm(tabId) {
  try {
    /*
     * No panel, no arming. Otherwise switching tabs with the panel closed
     * silently arms the overlay on a page the user never pointed the tool at.
     */
    if (!panelOpen()) {
      return;
    }

    if (!(await autoArmEnabled())) {
      return;
    }

    const session = await loadSession(tabId);

    if (session?.armed) {
      return;
    }

    const tab = await chrome.tabs.get(tabId);

    if (!isCapturable(tab.url)) {
      return;
    }

    await armTab(tabId);
  } catch {
    /* Auto-arm is best effort; the manual button reports real errors. */
  }
}

async function armTab(tabId) {
  let session = await loadSession(tabId);

  if (!session) {
    session = createSession(tabId);
  }

  session.armed = true;
  session.detachReason = null;

  if (!session.attached) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      const text = toErrorMessage(error);

      /*
       * Attaching twice is harmless; DevTools already owning the tab is not,
       * and the user needs to be told which of the two happened.
       */
      if (!/already attached/i.test(text)) {
        throw new Error(
          `Could not attach the debugger: ${text}. ` +
            "Close DevTools on this tab and try again."
        );
      }
    }

    session.attached = true;

    for (const [method, params] of CDP_DOMAINS) {
      try {
        await cdp(tabId, method, params);
      } catch (error) {
        pushEvent(session, {
          category: "extension",
          level: "warning",
          timeMs: Date.now(),
          timestamp: new Date().toISOString(),
          text: `${method} failed: ${toErrorMessage(error)}`
        });
      }
    }

    /*
     * Flat auto-attach so out-of-process iframes and workers arrive as child
     * sessions instead of vanishing. Their events are recorded with the
     * originating sessionId; enabling domains inside each child target is the
     * next implementation pass.
     */
    try {
      await cdp(tabId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
    } catch (error) {
      pushEvent(session, {
        category: "extension",
        level: "warning",
        timeMs: Date.now(),
        timestamp: new Date().toISOString(),
        text:
          "Target.setAutoAttach failed; child frames and workers " +
          "will not be captured: " +
          toErrorMessage(error)
      });
    }
  }

  await injectContentScript(tabId);

  await chrome.tabs.sendMessage(tabId, { type: "CC_START" });

  await putSession(session);

  broadcastStatus(tabId);

  return getStatus();
}

async function stopActiveTab() {
  const tab = await getActiveTab();
  const session = await loadSession(tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CC_STOP" });
  } catch {
    /* The content script may be gone after a navigation. */
  }

  if (session?.attached) {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch {
      /* Already detached. */
    }
  }

  clockOffsets.delete(tab.id);

  await deleteSession(tab.id);

  return getStatus();
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();

  return chrome.tabs.sendMessage(tab.id, message);
}

async function captureFrame(intent, options) {
  const tab = await getActiveTab();
  const session = await loadSession(tab.id);

  if (!session?.armed) {
    throw new Error("Arm capture before adding a frame.");
  }

  if (!session.attached) {
    throw new Error(
      "The debugger detached" +
        (session.detachReason ? ` (${session.detachReason})` : "") +
        ". Re-arm capture before adding a frame."
    );
  }

  let pageContext;

  try {
    pageContext = await chrome.tabs.sendMessage(tab.id, {
      type: "CC_PREPARE_CAPTURE",
      intent
    });
  } catch {
    /*
     * The overlay died with the previous document. Bring it back and tell the
     * user plainly rather than exporting an empty frame.
     */
    await injectContentScript(tab.id).catch(() => {});

    await chrome.tabs
      .sendMessage(tab.id, { type: "CC_START" })
      .catch(() => {});

    throw new Error(
      "The page navigated and the selection was lost. " +
        "Re-select the element, then add the frame again."
    );
  }

  if (
    !pageContext?.selections?.length &&
    !pageContext?.captureRegion
  ) {
    throw new Error(
      "Select an element or drag a region before adding a frame."
    );
  }

  let screenshotDataUrl;

  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format: "png" }
    );
  } finally {
    await chrome.tabs
      .sendMessage(tab.id, { type: "CC_CAPTURE_DONE" })
      .catch(() => {});
  }

  const cdpContext = await captureCdpContext(
    tab.id,
    pageContext,
    options
  );

  const appContext = await captureAppBridge(tab.id, pageContext);

  const now = Date.now();

  const runtime = windowedEvidence(session, now);

  /* Capture is a visible checkpoint: never leave it unflushed. */
  await flush(tab.id);

  return {
    capturedAt: new Date(now).toISOString(),
    screenshotDataUrl,
    pageContext,
    cdpContext,
    appContext,
    runtime
  };
}

async function captureAppBridge(tabId, pageContext) {
  try {
    const selectors = (pageContext?.selections || []).map(
      (selection) => selection.selector
    );

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",

      func: async (selectedSelectors) => {
        const bridge = globalThis.__CONTEXT_CAPSULE_BRIDGE__;

        if (!bridge || typeof bridge.snapshot !== "function") {
          return {
            available: false,
            reason: "No application bridge registered."
          };
        }

        try {
          const value = await bridge.snapshot({
            selectors: selectedSelectors
          });

          return {
            available: true,
            bridgeVersion: bridge.version || null,
            value
          };
        } catch (error) {
          return {
            available: true,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          };
        }
      },

      args: [selectors]
    });

    return sanitizeValue(result?.result || { available: false });
  } catch (error) {
    return {
      available: false,
      error: toErrorMessage(error)
    };
  }
}

async function captureCdpContext(tabId, pageContext, options) {
  const result = {
    layoutMetrics: null,
    selectedNodes: [],
    domSnapshot: null,

    /*
     * Full-page snapshots run into megabytes on real applications, so they are
     * opt-in. Selected nodes plus ancestors are the default evidence.
     */
    domSnapshotSkipped: null,
    errors: []
  };

  try {
    result.layoutMetrics = await cdp(
      tabId,
      "Page.getLayoutMetrics"
    );
  } catch (error) {
    result.errors.push(
      `Page.getLayoutMetrics: ${toErrorMessage(error)}`
    );
  }

  /*
   * Every selection, not just the first one. Group selection was the entire
   * point of the interaction model.
   */
  for (const selection of pageContext?.selections || []) {
    result.selectedNodes.push(
      await captureNode(tabId, selection, result.errors)
    );
  }

  if (options?.fullDomSnapshot) {
    try {
      result.domSnapshot = await cdp(
        tabId,
        "DOMSnapshot.captureSnapshot",
        {
          computedStyles: SNAPSHOT_STYLES,
          includePaintOrder: true,
          includeDOMRects: true,
          includeBlendedBackgroundColors: true,
          includeTextColorOpacities: true
        }
      );
    } catch (error) {
      result.errors.push(
        `DOMSnapshot.captureSnapshot: ${toErrorMessage(error)}`
      );
    }
  } else {
    result.domSnapshotSkipped =
      "Full-page DOM snapshot not requested. Enable it in the side " +
      "panel when whole-document layout is needed.";
  }

  return result;
}

async function captureNode(tabId, selection, errors) {
  const rect = selection?.rect;

  const node = {
    id: selection?.id || null,
    selector: selection?.selector || null,
    describeNode: null,
    computedStyle: null,
    matchedStyles: null,
    accessibility: null,
    eventListeners: null
  };

  if (!rect || !rect.width || !rect.height) {
    errors.push(`Selection ${node.id}: no layout box to probe.`);

    return node;
  }

  const x = Math.max(0, Math.round(rect.x + rect.width / 2));
  const y = Math.max(0, Math.round(rect.y + rect.height / 2));

  try {
    const located = await cdp(tabId, "DOM.getNodeForLocation", {
      x,
      y,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true
    });

    let nodeId = located.nodeId;

    if (!nodeId && located.backendNodeId) {
      const pushed = await cdp(
        tabId,
        "DOM.pushNodesByBackendIdsToFrontend",
        { backendNodeIds: [located.backendNodeId] }
      );

      nodeId = pushed.nodeIds?.[0];
    }

    if (!nodeId) {
      errors.push(
        `Selection ${node.id}: node not resolvable at (${x}, ${y}).`
      );

      return node;
    }

    node.describeNode = await cdp(tabId, "DOM.describeNode", {
      nodeId,
      depth: 4,
      pierce: true
    });

    node.computedStyle = await cdp(
      tabId,
      "CSS.getComputedStyleForNode",
      { nodeId }
    );

    /* Matched rules carry stylesheet origin — where to actually edit. */
    try {
      node.matchedStyles = await cdp(
        tabId,
        "CSS.getMatchedStylesForNode",
        { nodeId }
      );
    } catch (error) {
      errors.push(
        `Selection ${node.id} matched styles: ${toErrorMessage(error)}`
      );
    }

    node.accessibility = await cdp(
      tabId,
      "Accessibility.getPartialAXTree",
      { nodeId, fetchRelatives: true }
    );

    try {
      const resolved = await cdp(tabId, "DOM.resolveNode", {
        nodeId
      });

      if (resolved?.object?.objectId) {
        node.eventListeners = await cdp(
          tabId,
          "DOMDebugger.getEventListeners",
          { objectId: resolved.object.objectId }
        );
      }
    } catch (error) {
      errors.push(
        `Selection ${node.id} listeners: ${toErrorMessage(error)}`
      );
    }
  } catch (error) {
    errors.push(`Selection ${node.id}: ${toErrorMessage(error)}`);
  }

  return node;
}

async function handleDebuggerEvent(source, method, params) {
  const tabId = source.tabId;

  const session = await loadSession(tabId);

  if (!session?.armed) {
    return;
  }

  const timeMs = wallTimeFor(tabId, params?.timestamp);

  const origin = {
    sessionId: source.sessionId || null,
    frameId: params?.frameId || null
  };

  switch (method) {
    case "Network.requestWillBeSent": {
      const existing = entryGet(session.requests, params.requestId);

      /*
       * A redirect reuses the request ID. Keep the chain instead of silently
       * overwriting the original request.
       */
      if (existing && params.redirectResponse) {
        existing.redirectChain.push(
          describeResponse(params.redirectResponse)
        );

        existing.request.url = redactText(params.request?.url || "");

        touch(tabId);

        return;
      }

      entrySet(
        session.requests,
        params.requestId,
        {
          requestId: params.requestId,
          timeMs,
          timestamp: new Date(timeMs).toISOString(),
          origin,
          type: params.type || null,
          documentURL: redactText(params.documentURL || null),
          initiator: sanitizeValue(params.initiator),

          request: {
            url: redactText(params.request?.url || ""),
            method: params.request?.method || "GET",
            headers: redactHeaders(params.request?.headers || {}),
            postData: redactText(params.request?.postData || null)
          },

          redirectChain: [],
          encodedDataLength: null,
          response: null,
          failure: null
        },
        LIMITS.requests
      );

      touch(tabId);

      return;
    }

    case "Network.responseReceived": {
      const request = entryGet(session.requests, params.requestId);

      if (request) {
        request.response = describeResponse(params.response);

        touch(tabId);
      }

      return;
    }

    case "Network.loadingFinished": {
      const request = entryGet(session.requests, params.requestId);

      if (request) {
        request.encodedDataLength =
          params.encodedDataLength ?? null;
      }

      await maybeCaptureBody(tabId, session, params, request);

      touch(tabId);

      return;
    }

    case "Network.loadingFailed": {
      const request = entryGet(session.requests, params.requestId);

      if (request) {
        request.failure = {
          errorText: params.errorText,
          canceled: params.canceled,
          blockedReason: params.blockedReason,
          corsErrorStatus: params.corsErrorStatus
        };

        touch(tabId);
      }

      return;
    }

    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived":
      pushEvent(session, {
        category: "websocket",
        level: "info",
        timeMs,
        timestamp: new Date(timeMs).toISOString(),
        origin,

        direction:
          method === "Network.webSocketFrameSent"
            ? "sent"
            : "received",

        text: redactText(
          String(params.response?.payloadData || "").slice(0, 4000)
        )
      });

      touch(tabId);

      return;

    case "Runtime.consoleAPICalled":
      pushEvent(session, {
        category: "console",
        level: params.type,
        timeMs,
        timestamp: new Date(timeMs).toISOString(),
        origin,

        text: (params.args || [])
          .map(serializeRemoteObject)
          .join(" "),

        stackTrace: sanitizeValue(params.stackTrace || null)
      });

      touch(tabId);

      return;

    case "Runtime.exceptionThrown":
      pushEvent(session, {
        category: "exception",
        level: "error",
        timeMs,
        timestamp: new Date(timeMs).toISOString(),
        origin,

        text: redactText(
          params.exceptionDetails?.text || "Unhandled exception"
        ),

        detail: sanitizeValue(params.exceptionDetails || null)
      });

      /* Exceptions are the evidence most worth not losing. */
      await flush(tabId);

      return;

    case "Log.entryAdded":
      pushEvent(session, {
        category: "log",
        level: params.entry?.level || "info",
        timeMs,
        timestamp: new Date(timeMs).toISOString(),
        origin,
        text: redactText(params.entry?.text || ""),
        detail: sanitizeValue(params.entry || null)
      });

      touch(tabId);

      return;

    case "Page.frameNavigated":
      pushNavigation(session, {
        url: redactText(params.frame?.url || ""),
        frameId: params.frame?.id || null,
        parentFrameId: params.frame?.parentId || null,
        timeMs,
        timestamp: new Date(timeMs).toISOString(),
        kind: "frame-navigated"
      });

      await flush(tabId);

      return;

    case "Target.attachedToTarget":
      entrySet(
        session.targets,
        params.sessionId,
        {
          sessionId: params.sessionId,
          type: params.targetInfo?.type || null,
          url: redactText(params.targetInfo?.url || ""),
          attachedAt: new Date(timeMs).toISOString()
        },
        50
      );

      touch(tabId);

      return;

    default:
      return;
  }
}

function describeResponse(response) {
  return {
    url: redactText(response?.url || ""),
    status: response?.status,
    statusText: response?.statusText,
    mimeType: response?.mimeType,
    headers: redactHeaders(response?.headers || {}),
    protocol: response?.protocol,
    remoteIPAddress: response?.remoteIPAddress,
    fromDiskCache: response?.fromDiskCache,
    fromServiceWorker: response?.fromServiceWorker,
    timing: sanitizeValue(response?.timing || null)
  };
}

async function maybeCaptureBody(tabId, session, params, request) {
  if (!request) {
    return;
  }

  const mimeType = request.response?.mimeType || "";

  if (!BODY_MIME.test(mimeType)) {
    return;
  }

  const size = Number(params.encodedDataLength || 0);

  if (size > MAX_BODY_BYTES) {
    entrySet(
      session.responseBodies,
      params.requestId,
      {
        skipped: true,
        reason:
          `Body of ${size} bytes exceeds the ` +
          `${MAX_BODY_BYTES} byte capture limit.`
      },
      LIMITS.responseBodies
    );

    return;
  }

  try {
    const body = await cdp(tabId, "Network.getResponseBody", {
      requestId: params.requestId
    });

    entrySet(
      session.responseBodies,
      params.requestId,
      {
        base64Encoded: Boolean(body.base64Encoded),

        body: body.base64Encoded
          ? "[BINARY BODY OMITTED]"
          : redactText(body.body)
      },
      LIMITS.responseBodies
    );
  } catch {
    /* Chrome evicts bodies aggressively; nothing to recover. */
  }
}

function cdp(tabId, method, params = undefined) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * CDP timestamps are monotonic seconds, not epoch milliseconds. Anchor the
 * first one seen per tab against wall time and derive the rest from it, so
 * event ordering stays truthful instead of collapsing to arrival time.
 */
export function wallTimeFor(tabId, timestamp, now = Date.now()) {
  if (
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return now;
  }

  const monotonicMs = timestamp * 1000;

  let offset = clockOffsets.get(tabId);

  if (offset === undefined) {
    offset = now - monotonicMs;

    clockOffsets.set(tabId, offset);
  }

  const wall = monotonicMs + offset;

  /*
   * Guard against a clock base we misread: never report the future, and never
   * report something implausibly old.
   */
  if (wall > now + 1000 || wall < now - 3_600_000) {
    return now;
  }

  return Math.round(wall);
}

function serializeRemoteObject(object) {
  if (Object.prototype.hasOwnProperty.call(object || {}, "value")) {
    return redactText(stringifySafe(object.value));
  }

  return redactText(
    object?.description || object?.type || "unknown"
  );
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function broadcastStatus(tabId) {
  chrome.runtime
    .sendMessage({ type: "CC_STATUS_CHANGED", tabId })
    .catch(() => {});
}

/* Exported for the test suite; unused by the worker itself. */
export { describeResponse, entryValues };
