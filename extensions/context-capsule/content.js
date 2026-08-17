(() => {
  if (globalThis.__CONTEXT_CAPSULE__) {
    return;
  }

  globalThis.__CONTEXT_CAPSULE__ = true;

  const state = {
    active: false,
    tool: "select",
    hoverElement: null,
    selected: [],
    activeSelectionIndex: -1,
    annotations: [],
    region: null,
    drawing: null,
    editing: null,
    captureMode: false
  };

  const host = document.createElement("div");

  host.id = "context-capsule-root";

  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "pointer-events:none"
  ].join(";");

  const shadow = host.attachShadow({
    mode: "closed"
  });

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
      }

      #layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family:
          Inter,
          ui-sans-serif,
          system-ui,
          sans-serif;
      }

      #hover {
        position: fixed;
        border: 2px solid #7c3aed;
        background: rgba(124, 58, 237, 0.08);
        border-radius: 6px;
        box-sizing: border-box;
        display: none;
      }

      .selection {
        position: fixed;
        border: 2px solid #2563eb;
        background: rgba(37, 99, 235, 0.08);
        border-radius: 6px;
        box-sizing: border-box;
      }

      .label {
        position: absolute;
        left: -2px;
        top: -26px;
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        border-radius: 6px;
        display: grid;
        place-items: center;
        color: white;
        background: #2563eb;
        font: 700 12px/1 ui-sans-serif, system-ui;
        box-shadow:
          0 4px 14px rgba(0, 0, 0, 0.25);
      }

      #region {
        position: fixed;
        border: 2px dashed #f97316;
        background: rgba(249, 115, 22, 0.08);
        border-radius: 8px;
        box-sizing: border-box;
        display: none;
      }

      #svg {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
      }

      #editor {
        position: fixed;
        display: none;
        pointer-events: auto;
        min-width: 190px;
        padding: 8px 10px;
        border: 0;
        border-radius: 9px;
        outline: 2px solid #6f5cff;
        outline-offset: 1px;
        resize: none;
        color: #f7f7fb;
        background: rgba(14, 13, 23, 0.96);
        font: 600 13px/1.35 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.42);
      }

      #editor::placeholder {
        color: rgba(247, 247, 251, 0.45);
      }

      #toast {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        padding: 9px 12px;
        border-radius: 9px;
        color: white;
        background: rgba(17, 24, 39, 0.94);
        font: 600 12px/1.2 ui-sans-serif, system-ui;
        box-shadow:
          0 8px 30px rgba(0, 0, 0, 0.28);
        display: none;
      }
    </style>

    <div id="layer">
      <div id="hover"></div>
      <div id="selections"></div>
      <div id="region"></div>

      <svg
        id="svg"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon
              points="0 0, 10 3.5, 0 7"
              fill="#ef4444"
            ></polygon>
          </marker>
        </defs>

        <g id="marks"></g>
      </svg>

      <textarea
        id="editor"
        rows="2"
        placeholder="Note, then Enter"
        spellcheck="false"
      ></textarea>

      <div id="toast"></div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const hoverBox =
    shadow.querySelector("#hover");

  const selectionsLayer =
    shadow.querySelector("#selections");

  const regionBox =
    shadow.querySelector("#region");

  const marks =
    shadow.querySelector("#marks");

  const toast =
    shadow.querySelector("#toast");

  const editor =
    shadow.querySelector("#editor");

  editor.addEventListener(
    "keydown",
    (event) => {
      /*
       * The editor is inside our shadow root, but the capture-phase document
       * listeners below would still see these keys.
       */
      event.stopPropagation();

      if (event.key === "Escape") {
        event.preventDefault();
        closeTextEditor();

        return;
      }

      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        commitTextEditor();
      }
    },
    true
  );

  editor.addEventListener("blur", () => {
    if (state.editing) {
      commitTextEditor();
    }
  });

  const STYLE_KEYS = [
    "display",
    "position",
    "z-index",
    "box-sizing",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "gap",
    "row-gap",
    "column-gap",
    "grid-template-columns",
    "grid-template-rows",
    "align-items",
    "justify-content",
    "flex-direction",
    "flex-wrap",
    "overflow",
    "opacity",
    "transform",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "color",
    "background-color",
    "border",
    "border-radius",
    "box-shadow",
    "visibility",
    "pointer-events"
  ];

  const SECRET_ATTR =
    /value|token|secret|password|authorization|cookie/i;

  chrome.runtime.onMessage.addListener(
    (
      message,
      _sender,
      sendResponse
    ) => {
      if (message.type === "CC_START") {
        start();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "CC_STOP") {
        stop();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "CC_SET_TOOL") {
        state.tool = message.tool;

        showToast(
          toolHint(message.tool)
        );

        sendResponse({
          ok: true,
          tool: state.tool
        });

        return;
      }

      if (
        message.type ===
        "CC_CLEAR_MARKUP"
      ) {
        clearMarkup();
        sendResponse({ ok: true });
        return;
      }

      if (
        message.type ===
        "CC_PREPARE_CAPTURE"
      ) {
        state.captureMode = true;
        hoverBox.style.display = "none";

        if (state.editing) {
          commitTextEditor();
        }

        sendResponse(
          buildCaptureContext(
            message.intent || {}
          )
        );

        return;
      }

      if (
        message.type ===
        "CC_CAPTURE_DONE"
      ) {
        state.captureMode = false;
        sendResponse({ ok: true });
      }
    }
  );

  function start() {
    if (state.active) {
      return;
    }

    state.active = true;

    document.addEventListener(
      "mousemove",
      onMouseMove,
      true
    );

    document.addEventListener(
      "mousedown",
      onMouseDown,
      true
    );

    document.addEventListener(
      "mouseup",
      onMouseUp,
      true
    );

    document.addEventListener(
      "click",
      onClick,
      true
    );

    document.addEventListener(
      "keydown",
      onKeyDown,
      true
    );

    window.addEventListener(
      "scroll",
      redrawSelections,
      true
    );

    window.addEventListener(
      "resize",
      redrawSelections,
      true
    );

    showToast(
      "Capture armed. Click an element. Ctrl-click adds more."
    );
  }

  function stop() {
    state.active = false;

    document.removeEventListener(
      "mousemove",
      onMouseMove,
      true
    );

    document.removeEventListener(
      "mousedown",
      onMouseDown,
      true
    );

    document.removeEventListener(
      "mouseup",
      onMouseUp,
      true
    );

    document.removeEventListener(
      "click",
      onClick,
      true
    );

    document.removeEventListener(
      "keydown",
      onKeyDown,
      true
    );

    window.removeEventListener(
      "scroll",
      redrawSelections,
      true
    );

    window.removeEventListener(
      "resize",
      redrawSelections,
      true
    );

    hoverBox.style.display = "none";

    closeTextEditor();
  }

  function onMouseMove(event) {
    if (
      !state.active ||
      state.captureMode
    ) {
      return;
    }

    if (state.drawing) {
      event.preventDefault();
      event.stopPropagation();

      updateDrawing(
        event.clientX,
        event.clientY
      );

      return;
    }

    if (state.tool !== "select") {
      return;
    }

    const element = pickElement(
      event.clientX,
      event.clientY
    );

    if (
      !element ||
      element === state.hoverElement
    ) {
      return;
    }

    state.hoverElement = element;

    drawRect(
      hoverBox,
      element.getBoundingClientRect()
    );

    hoverBox.style.display = "block";
  }

  function onMouseDown(event) {
    if (
      !state.active ||
      state.captureMode ||
      state.tool === "select"
    ) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    beginDrawing(
      state.tool,
      event.clientX,
      event.clientY
    );
  }

  function onMouseUp(event) {
    if (
      !state.active ||
      !state.drawing
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    finishDrawing(
      event.clientX,
      event.clientY
    );
  }

  function onClick(event) {
    if (
      !state.active ||
      state.captureMode ||
      state.tool !== "select"
    ) {
      return;
    }

    const element = pickElement(
      event.clientX,
      event.clientY
    );

    if (!element) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    /*
     * Ctrl (Cmd on macOS) adds to the selection, matching how every file
     * manager and design tool does multi-select. Shift is deliberately not
     * used: browsers give Shift+click their own meaning on links and text,
     * and the two fought each other on real pages.
     */
    if (event.ctrlKey || event.metaKey) {
      const existing =
        state.selected.indexOf(element);

      if (existing >= 0) {
        state.selected.splice(
          existing,
          1
        );
      } else {
        state.selected.push(element);
      }
    } else {
      state.selected = [element];
    }

    state.activeSelectionIndex =
      state.selected.length - 1;

    redrawSelections();
  }

  function onKeyDown(event) {
    if (!state.active) {
      return;
    }

    if (event.key === "Escape") {
      state.tool = "select";
      state.drawing = null;

      showToast("Selection mode");

      return;
    }

    if (!state.selected.length) {
      return;
    }

    const current =
      state.selected[
        state.activeSelectionIndex
      ] || state.selected[0];

    let next = null;

    if (event.key === "ArrowUp") {
      next = current.parentElement;
    }

    if (event.key === "ArrowDown") {
      next =
        current.firstElementChild;
    }

    if (event.key === "ArrowLeft") {
      next =
        current.previousElementSibling;
    }

    if (event.key === "ArrowRight") {
      next =
        current.nextElementSibling;
    }

    if (!next || next === host) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    state.selected[
      state.activeSelectionIndex
    ] = next;

    redrawSelections();
  }

  function pickElement(x, y) {
    const element =
      document.elementFromPoint(x, y);

    if (
      !element ||
      element === host ||
      host.contains(element)
    ) {
      return null;
    }

    return element;
  }

  function redrawSelections() {
    selectionsLayer.textContent = "";

    state.selected =
      state.selected.filter(
        (element) =>
          element?.isConnected
      );

    state.selected.forEach(
      (element, index) => {
        const rect =
          element.getBoundingClientRect();

        const box =
          document.createElement("div");

        box.className = "selection";

        drawRect(box, rect);

        const label =
          document.createElement("div");

        label.className = "label";
        label.textContent =
          alphaLabel(index);

        box.appendChild(label);
        selectionsLayer.appendChild(box);
      }
    );
  }

  function drawRect(node, rect) {
    node.style.left =
      `${Math.round(rect.left)}px`;

    node.style.top =
      `${Math.round(rect.top)}px`;

    node.style.width =
      `${Math.max(
        1,
        Math.round(rect.width)
      )}px`;

    node.style.height =
      `${Math.max(
        1,
        Math.round(rect.height)
      )}px`;
  }

  function beginDrawing(tool, x, y) {
    const id = crypto.randomUUID();

    const drawing = {
      id,
      tool,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      points: [[x, y]],
      node: null
    };

    if (tool === "region") {
      state.region = {
        x,
        y,
        width: 0,
        height: 0
      };

      regionBox.style.display =
        "block";

      drawRect(regionBox, {
        left: x,
        top: y,
        width: 1,
        height: 1
      });
    } else if (tool === "box") {
      drawing.node = svgNode(
        "rect",
        {
          x,
          y,
          width: 1,
          height: 1,
          rx: 6,
          fill:
            "rgba(239,68,68,.08)",
          stroke: "#ef4444",
          "stroke-width": 3
        }
      );

      marks.appendChild(
        drawing.node
      );
    } else if (
      tool === "arrow"
    ) {
      drawing.node = svgNode(
        "line",
        {
          x1: x,
          y1: y,
          x2: x,
          y2: y,
          stroke: "#ef4444",
          "stroke-width": 4,
          "stroke-linecap": "round",
          "marker-end":
            "url(#arrowhead)"
        }
      );

      marks.appendChild(
        drawing.node
      );
    } else if (tool === "pen") {
      drawing.node = svgNode(
        "path",
        {
          d: `M ${x} ${y}`,
          fill: "none",
          stroke: "#ef4444",
          "stroke-width": 4,
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        }
      );

      marks.appendChild(
        drawing.node
      );
    } else if (
      tool === "text"
    ) {
      /*
       * An inline editor rather than window.prompt(): a native dialog steals
       * focus, cannot be styled, and on some pages is suppressed entirely.
       */
      openTextEditor(id, x, y);

      return;
    }

    state.drawing = drawing;
  }

  /*
   * Inline text annotation editor.
   *
   * Enter commits, Shift+Enter adds a line, Escape cancels. The editor lives in
   * the closed shadow root so page styles and page scripts cannot touch it.
   */
  function openTextEditor(id, x, y) {
    closeTextEditor();

    state.editing = { id, x, y };

    editor.value = "";

    editor.style.left = `${Math.min(
      x,
      window.innerWidth - 230
    )}px`;

    editor.style.top = `${Math.max(8, y - 46)}px`;

    editor.style.display = "block";

    editor.focus();
  }

  function closeTextEditor() {
    state.editing = null;

    editor.style.display = "none";
    editor.value = "";
  }

  function commitTextEditor() {
    const pending = state.editing;

    const value = editor.value.trim();

    closeTextEditor();

    if (!pending || !value) {
      return;
    }

    drawTextAnnotation(
      pending.id,
      pending.x,
      pending.y,
      value
    );

    state.annotations.push({
      id: pending.id,
      tool: "text",
      x: pending.x,
      y: pending.y,
      text: value
    });
  }

  function drawTextAnnotation(id, x, y, value) {
    const lines = value.split("\n").slice(0, 6);

    const width = Math.max(
      86,
      Math.max(...lines.map((line) => line.length)) * 7.6 + 20
    );

    const height = lines.length * 18 + 14;

    const group = svgNode("g", {
      "data-annotation-id": id
    });

    group.appendChild(
      svgNode("rect", {
        x,
        y: y - height,
        width,
        height,
        rx: 7,
        fill: "#0e0d17",
        stroke: "#6f5cff",
        "stroke-width": 1.5
      })
    );

    lines.forEach((line, index) => {
      const text = svgNode("text", {
        x: x + 10,
        y: y - height + 20 + index * 18,
        fill: "#f7f7fb",
        "font-size": 13,
        "font-family": "ui-sans-serif, system-ui",
        "font-weight": 600
      });

      text.textContent = line;

      group.appendChild(text);
    });

    marks.appendChild(group);
  }

  function updateDrawing(x, y) {
    const drawing = state.drawing;

    if (!drawing) {
      return;
    }

    drawing.endX = x;
    drawing.endY = y;
    drawing.points.push([x, y]);

    const left = Math.min(
      drawing.startX,
      x
    );

    const top = Math.min(
      drawing.startY,
      y
    );

    const width = Math.abs(
      x - drawing.startX
    );

    const height = Math.abs(
      y - drawing.startY
    );

    if (drawing.tool === "region") {
      state.region = {
        x: left,
        y: top,
        width,
        height
      };

      drawRect(regionBox, {
        left,
        top,
        width,
        height
      });
    } else if (
      drawing.tool === "box"
    ) {
      drawing.node.setAttribute(
        "x",
        String(left)
      );

      drawing.node.setAttribute(
        "y",
        String(top)
      );

      drawing.node.setAttribute(
        "width",
        String(width)
      );

      drawing.node.setAttribute(
        "height",
        String(height)
      );
    } else if (
      drawing.tool === "arrow"
    ) {
      drawing.node.setAttribute(
        "x2",
        String(x)
      );

      drawing.node.setAttribute(
        "y2",
        String(y)
      );
    } else if (
      drawing.tool === "pen"
    ) {
      drawing.node.setAttribute(
        "d",
        pointsToPath(
          drawing.points
        )
      );
    }
  }

  function finishDrawing(x, y) {
    updateDrawing(x, y);

    const drawing = state.drawing;
    state.drawing = null;

    if (!drawing) {
      return;
    }

    if (
      drawing.tool === "region"
    ) {
      state.annotations =
        state.annotations.filter(
          (annotation) =>
            annotation.tool !==
            "region"
        );

      state.annotations.push({
        id: drawing.id,
        tool: "region",
        ...state.region
      });
    } else {
      state.annotations.push({
        id: drawing.id,
        tool: drawing.tool,
        startX: drawing.startX,
        startY: drawing.startY,
        endX: drawing.endX,
        endY: drawing.endY,

        points:
          drawing.tool === "pen"
            ? drawing.points
            : undefined
      });
    }
  }

  function clearMarkup() {
    closeTextEditor();

    state.selected = [];
    state.activeSelectionIndex = -1;
    state.annotations = [];
    state.region = null;

    selectionsLayer.textContent = "";
    marks.textContent = "";

    regionBox.style.display =
      "none";
  }

  function buildCaptureContext(intent) {
    redrawSelections();

    const selections =
      state.selected.map(
        (element, index) =>
          snapshotElement(
            element,
            index
          )
      );

    const commonAncestor =
      getCommonAncestor(
        state.selected
      );

    return {
      schemaVersion: "0.1.0",
      intent,

      page: {
        url: location.href,
        title: document.title,
        referrer: document.referrer,

        language:
          document.documentElement
            .lang ||
          navigator.language,

        route:
          `${location.pathname}` +
          `${location.search}` +
          `${location.hash}`,

        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio:
            window.devicePixelRatio,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        },

        userAgent:
          navigator.userAgent
      },

      selections,

      commonAncestor:
        commonAncestor
          ? snapshotElement(
              commonAncestor,
              -1
            )
          : null,

      captureRegion:
        state.region ||
        unionRect(
          selections.map(
            (selection) =>
              selection.rect
          )
        ),

      annotations:
        structuredCloneSafe(
          state.annotations
        ),

      documentState: {
        activeElementSelector:
          document.activeElement
            instanceof Element
            ? stableSelector(
                document.activeElement
              )
            : null,

        visibilityState:
          document.visibilityState,

        readyState:
          document.readyState
      }
    };
  }

  function snapshotElement(
    element,
    index
  ) {
    const rect =
      element.getBoundingClientRect();

    const style =
      getComputedStyle(element);

    return {
      id:
        index >= 0
          ? alphaLabel(index)
          : "COMMON_ANCESTOR",

      tagName:
        element.tagName.toLowerCase(),

      selector:
        stableSelector(element),

      text: redactText(
        (
          element.innerText ||
          element.textContent ||
          ""
        ).trim()
      ).slice(0, 4000),

      outerHTML:
        sanitizedOuterHTML(element),

      attributes:
        Object.fromEntries(
          Array.from(
            element.attributes
          ).map((attribute) => [
            attribute.name,

            SECRET_ATTR.test(
              attribute.name
            )
              ? "[REDACTED]"
              : redactText(
                  attribute.value
                )
          ])
        ),

      rect: {
        x: rect.x,
        y: rect.y,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      },

      computedStyle:
        Object.fromEntries(
          STYLE_KEYS.map((key) => [
            key,
            style.getPropertyValue(key)
          ])
        ),

      accessibility: {
        role:
          element.getAttribute(
            "role"
          ),

        ariaLabel:
          element.getAttribute(
            "aria-label"
          ),

        ariaLabelledBy:
          element.getAttribute(
            "aria-labelledby"
          ),

        ariaDescribedBy:
          element.getAttribute(
            "aria-describedby"
          ),

        title:
          element.getAttribute(
            "title"
          ),

        tabIndex:
          element.getAttribute(
            "tabindex"
          )
      },

      hierarchy:
        ancestorChain(element),

      siblings:
        siblingSummary(element)
    };
  }

  function sanitizedOuterHTML(
    element
  ) {
    const clone =
      element.cloneNode(true);

    clone
      .querySelectorAll?.(
        "script,style,noscript"
      )
      .forEach((node) =>
        node.remove()
      );

    clone
      .querySelectorAll?.(
        "input,textarea"
      )
      .forEach((node) => {
        node.setAttribute(
          "value",
          "[REDACTED]"
        );

        node.textContent =
          "[REDACTED]";
      });

    clone
      .querySelectorAll?.("*")
      .forEach((node) => {
        for (
          const attribute of
          Array.from(
            node.attributes || []
          )
        ) {
          if (
            SECRET_ATTR.test(
              attribute.name
            )
          ) {
            node.setAttribute(
              attribute.name,
              "[REDACTED]"
            );
          }
        }
      });

    return redactText(
      clone.outerHTML
    ).slice(0, 120_000);
  }

  function ancestorChain(element) {
    const result = [];
    let current = element;

    for (
      let depth = 0;
      current && depth < 10;
      depth += 1
    ) {
      result.push({
        tagName:
          current.tagName
            ?.toLowerCase() || null,

        selector:
          current instanceof Element
            ? stableSelector(current)
            : null,

        id: current.id || null,

        className:
          typeof current.className ===
          "string"
            ? current.className
            : null
      });

      current =
        current.parentElement;
    }

    return result;
  }

  function siblingSummary(element) {
    return Array.from(
      element.parentElement
        ?.children || []
    )
      .slice(0, 30)
      .map((sibling, index) => ({
        index,
        selected:
          sibling === element,

        tagName:
          sibling.tagName.toLowerCase(),

        selector:
          stableSelector(sibling),

        text: redactText(
          (
            sibling.textContent || ""
          ).trim()
        ).slice(0, 160)
      }));
  }

  function stableSelector(element) {
    if (
      !(element instanceof Element)
    ) {
      return null;
    }

    if (element.id) {
      return `#${cssEscape(
        element.id
      )}`;
    }

    for (const attribute of [
      "data-testid",
      "data-test",
      "data-cy",
      "name",
      "aria-label"
    ]) {
      const value =
        element.getAttribute(
          attribute
        );

      if (
        value &&
        value.length < 100
      ) {
        return (
          `${element.tagName.toLowerCase()}` +
          `[${attribute}="${cssString(
            value
          )}"]`
        );
      }
    }

    const parts = [];
    let current = element;

    while (
      current &&
      current !==
        document.documentElement &&
      parts.length < 7
    ) {
      let part =
        current.tagName.toLowerCase();

      const classes = Array.from(
        current.classList || []
      )
        .filter((name) =>
          /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(
            name
          )
        )
        .slice(0, 2);

      if (classes.length) {
        part += classes
          .map(
            (name) =>
              `.${cssEscape(name)}`
          )
          .join("");
      }

      const siblings =
        current.parentElement
          ? Array.from(
              current.parentElement
                .children
            ).filter(
              (node) =>
                node.tagName ===
                current.tagName
            )
          : [];

      if (siblings.length > 1) {
        part +=
          `:nth-of-type(` +
          `${siblings.indexOf(
            current
          ) + 1})`;
      }

      parts.unshift(part);

      current =
        current.parentElement;
    }

    return parts.join(" > ");
  }

  function getCommonAncestor(
    elements
  ) {
    if (!elements.length) {
      return null;
    }

    let ancestor = elements[0];

    while (
      ancestor &&
      !elements.every((element) =>
        ancestor.contains(element)
      )
    ) {
      ancestor =
        ancestor.parentElement;
    }

    return ancestor;
  }

  function unionRect(rects) {
    if (!rects.length) {
      return {
        x: 0,
        y: 0,
        width: innerWidth,
        height: innerHeight
      };
    }

    const left = Math.min(
      ...rects.map(
        (rect) => rect.left
      )
    );

    const top = Math.min(
      ...rects.map(
        (rect) => rect.top
      )
    );

    const right = Math.max(
      ...rects.map(
        (rect) => rect.right
      )
    );

    const bottom = Math.max(
      ...rects.map(
        (rect) => rect.bottom
      )
    );

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function alphaLabel(index) {
    let number = index;
    let label = "";

    do {
      label =
        String.fromCharCode(
          65 + (number % 26)
        ) + label;

      number =
        Math.floor(number / 26) - 1;
    } while (number >= 0);

    return label;
  }

  function svgNode(
    name,
    attributes
  ) {
    const node =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        name
      );

    for (const [key, value] of
      Object.entries(attributes)) {
      node.setAttribute(
        key,
        String(value)
      );
    }

    return node;
  }

  function pointsToPath(points) {
    if (!points.length) {
      return "";
    }

    return points
      .map(
        ([x, y], index) =>
          `${index ? "L" : "M"} ${x} ${y}`
      )
      .join(" ");
  }

  function structuredCloneSafe(
    value
  ) {
    return JSON.parse(
      JSON.stringify(value)
    );
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape
      ? CSS.escape(value)
      : value.replace(
          /[^a-zA-Z0-9_-]/g,
          "\\$&"
        );
  }

  function cssString(value) {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function redactText(value) {
    return String(value || "")
      .replace(
        /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
        "Bearer [REDACTED]"
      )
      .replace(
        /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[REDACTED_JWT]"
      );
  }

  function toolHint(tool) {
    return {
      select:
        "Select mode. Click, ctrl-click, or use arrow keys for hierarchy.",

      region:
        "Drag a freeform capture rectangle.",

      box:
        "Drag to draw a box.",

      arrow:
        "Drag to draw an arrow.",

      pen:
        "Drag to draw freehand.",

      text:
        "Click and enter annotation text."
    }[tool] || tool;
  }

  let toastTimer;

  function showToast(message) {
    toast.textContent = message;
    toast.style.display = "block";

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toast.style.display = "none";
    }, 2200);
  }
})();
