(() => {
  globalThis.browseredCancelScreenshotSelection?.();

  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.popover = 'manual';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'group');
  overlay.setAttribute('aria-label', 'Screenshot selection. Drag to select an area. Press Escape to cancel.');
  overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;' +
    'display:block!important;cursor:crosshair!important;touch-action:none!important;overflow:hidden!important;';

  const shadow = overlay.attachShadow({ mode: 'closed' });
  const selection = document.createElement('div');
  const hint = document.createElement('div');
  const cancel = document.createElement('button');
  selection.style.cssText = 'position:absolute;display:none;box-sizing:border-box;' +
    'border:2px solid #fff;box-shadow:0 0 0 1px #1765e3,0 0 0 200vmax #111a2b85;pointer-events:none;';
  hint.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);' +
    'max-width:calc(100% - 28px);box-sizing:border-box;display:flex;align-items:center;gap:12px;' +
    'padding:8px 10px 8px 14px;border-radius:10px;background:#172235;color:#fff;' +
    'box-shadow:0 4px 20px #0d15265e;font:500 13px/1.4 system-ui,sans-serif;cursor:default;';
  cancel.style.cssText = 'font:inherit;color:inherit;background:#34445b;border:0;border-radius:6px;' +
    'padding:4px 8px;cursor:pointer;';
  hint.append('Drag to select an area', cancel);
  cancel.textContent = 'Cancel';
  shadow.append(selection, hint);

  let drag;
  function remove() {
    window.removeEventListener('pagehide', remove);
    window.removeEventListener('keydown', keydown, true);
    overlay.remove();
    delete globalThis.browseredCancelScreenshotSelection;
    if (previousFocus instanceof HTMLElement && document.activeElement === document.body) {
      previousFocus.focus({ preventScroll: true });
    }
  }
  function keydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    remove();
  }
  function rectangle(event) {
    const x = Math.max(0, Math.min(document.documentElement.clientWidth, event.clientX));
    const y = Math.max(0, Math.min(document.documentElement.clientHeight, event.clientY));
    return {
      x: Math.min(drag.x, x),
      y: Math.min(drag.y, y),
      width: Math.abs(x - drag.x),
      height: Math.abs(y - drag.y),
    };
  }

  cancel.addEventListener('click', remove);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || event.composedPath().includes(hint)) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    overlay.setPointerCapture(event.pointerId);
    hint.hidden = true;
    hint.style.display = 'none';
  });
  overlay.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const { x, y, width, height } = rectangle(event);
    Object.assign(selection.style, {
      display: 'block', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
    });
  });
  overlay.addEventListener('pointerup', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const rect = rectangle(event);
    drag = undefined;
    if (rect.width < 3 || rect.height < 3) {
      selection.style.display = 'none';
      hint.hidden = false;
      hint.style.display = 'flex';
      return;
    }
    const { scrollX, scrollY } = window;
    remove();
    // Let the compositor paint once with the selection controls gone.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ mode: 'region-selected', clip: rect, scrollX, scrollY }).catch(() => {});
    }));
  });
  overlay.addEventListener('pointercancel', remove);
  overlay.addEventListener('contextmenu', (event) => event.preventDefault());
  overlay.addEventListener('wheel', (event) => {
    if (drag) event.preventDefault();
  }, { passive: false });
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('pagehide', remove, { once: true });

  globalThis.browseredCancelScreenshotSelection = remove;
  document.documentElement.append(overlay);
  overlay.showPopover();
  overlay.focus({ preventScroll: true });
})();
