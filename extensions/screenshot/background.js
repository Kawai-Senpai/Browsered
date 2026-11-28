import { storeCapture, takeCapture } from './captures.js';

const title = 'Browsered Screenshot';
const modes = {
  region: 'Select an area',
  visible: 'Capture visible area',
  full: 'Capture full page',
};
const capturing = new Set();
let nextViewportCapture = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'browsered-screenshot',
      title,
      contexts: ['all'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    for (const [id, label] of Object.entries(modes)) {
      chrome.contextMenus.create({
        id, title: label, parentId: 'browsered-screenshot', contexts: ['all'],
      });
    }
  });
});

function requireActivePage(tab) {
  if (!tab?.id || !tab.active || !/^https?:\/\//.test(tab.url ?? '')) {
    throw new Error('Open an active web page to take a screenshot.');
  }
}

async function setError(tabId, message) {
  if (tabId === undefined) return;
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: message ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#b42318' }),
    chrome.action.setTitle({ tabId, title: message ? `${title} · ${message}` : title }),
  ]);
}

async function showCapture(image, filename, tab) {
  const id = await storeCapture({ image, filename });
  try {
    await chrome.tabs.create({
      url: `${chrome.runtime.getURL('preview.html')}#${id}`,
      windowId: tab.windowId,
      index: tab.index + 1,
      active: true,
    });
  } catch (error) {
    await takeCapture(id).catch(() => {});
    throw error;
  }
}

async function currentPage(tab) {
  const current = await chrome.tabs.get(tab.id);
  requireActivePage(current);
  if (current.url !== tab.url) throw new Error('The page changed. Try capturing again.');
  return current;
}

async function captureViewport(tab) {
  // Chromium allows two calls per second across the extension.
  const now = Date.now();
  const scheduled = Math.max(now, nextViewportCapture);
  nextViewportCapture = scheduled + 550;
  if (scheduled > now) await new Promise((resolve) => setTimeout(resolve, scheduled - now));
  const current = await currentPage(tab);
  const url = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
  await currentPage(tab);
  return fetch(url).then((response) => response.blob());
}

async function settleScroll(tabId, documentId, x, y) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    args: [x, y],
    func: (x, y) => new Promise((resolve) => {
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      const read = () => resolve({ x: window.scrollX, y: window.scrollY,
        width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
      const timer = setTimeout(read, 500);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        read();
      }));
    }),
  });
  return result;
}

function tileStarts(pageSize, viewportSize) {
  const last = Math.max(0, pageSize - viewportSize);
  return Array.from({ length: Math.ceil(last / viewportSize) + 1 },
    (_, index) => Math.min(index * viewportSize, last));
}

async function captureFullPage(tab, documentId, view) {
  const { width, height, pageWidth, pageHeight, scale } = view;
  if (!width || !height || view.pinched) throw new Error('Reset pinch zoom and try capturing the full page again.');
  if (Math.ceil(pageWidth / width) * Math.ceil(pageHeight / height) > 100) {
    throw new Error('This page is too large for one screenshot. Capture a smaller area.');
  }
  const columns = tileStarts(pageWidth, width);
  const rows = tileStarts(pageHeight, height);
  const ratio = Math.min(scale, 16_000 / Math.max(pageWidth, pageHeight),
    Math.sqrt(16_000_000 / (pageWidth * pageHeight)));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(pageWidth * ratio)), Math.max(1, Math.round(pageHeight * ratio)));
  const context = canvas.getContext('2d');
  try {
    for (const [row, top] of rows.entries()) {
      const skipY = row === 0 ? 0 : rows[row - 1] + height - top;
      for (const [column, left] of columns.entries()) {
        const skipX = column === 0 ? 0 : columns[column - 1] + width - left;
        const scrollX = left + view.minX;
        await currentPage(tab);
        const position = await settleScroll(tab.id, documentId, scrollX, top);
        if (Math.abs(position.x - scrollX) > 1 || Math.abs(position.y - top) > 1 ||
          position.width !== width || position.height !== height) {
          throw new Error('The page changed size or could not scroll to the next section.');
        }
        const bitmap = await createImageBitmap(await captureViewport(tab));
        try {
          const x = Math.round((left + skipX) * ratio);
          const y = Math.round((top + skipY) * ratio);
          const right = Math.round((left + width) * ratio);
          const bottom = Math.round((top + height) * ratio);
          context.drawImage(bitmap, skipX * scale, skipY * scale,
            Math.min(bitmap.width - skipX * scale, (width - skipX) * scale),
            Math.min(bitmap.height - skipY * scale, (height - skipY) * scale),
            x, y, right - x, bottom - y);
        } finally {
          bitmap.close();
        }
      }
    }
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    await settleScroll(tab.id, documentId, view.x, view.y).catch(() => {});
  }
}

async function crop(image, clip, view) {
  const bitmap = await createImageBitmap(image);
  try {
    const left = Math.max(0, Math.floor((clip.x - view.offsetX) * view.scale));
    const top = Math.max(0, Math.floor((clip.y - view.offsetY) * view.scale));
    const right = Math.min(bitmap.width, Math.ceil((clip.x + clip.width - view.offsetX) * view.scale));
    const bottom = Math.min(bitmap.height, Math.ceil((clip.y + clip.height - view.offsetY) * view.scale));
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) throw new Error('The selection moved offscreen. Select it again.');
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

async function capture(tab, mode, selection) {
  requireActivePage(tab);
  const tabId = tab.id;
  if (capturing.has(tabId)) throw new Error('A screenshot is already in progress.');
  capturing.add(tabId);
  try {
    const current = await currentPage(tab);
    const [{ result: view, documentId }] = await chrome.scripting.executeScript({
      target: selection ? { tabId, documentIds: [selection.documentId] } : { tabId },
      func: () => {
        globalThis.browseredCancelScreenshotSelection?.();
        const root = document.documentElement;
        const scroller = document.scrollingElement ?? root;
        const width = root.clientWidth;
        const pageWidth = Math.max(width, scroller.scrollWidth);
        const pinch = window.visualViewport?.scale ?? 1;
        return {
          x: window.scrollX,
          y: window.scrollY,
          offsetX: window.visualViewport?.offsetLeft ?? 0,
          offsetY: window.visualViewport?.offsetTop ?? 0,
          scale: window.devicePixelRatio * pinch,
          pinched: Math.abs(pinch - 1) > 0.01,
          width,
          height: root.clientHeight,
          pageWidth,
          pageHeight: Math.max(root.clientHeight, scroller.scrollHeight),
          minX: getComputedStyle(scroller).direction === 'rtl' ? width - pageWidth : 0,
        };
      },
    });
    if (selection && (selection.scrollX !== view.x || selection.scrollY !== view.y)) {
      throw new Error('The page scrolled. Select the area again.');
    }
    let image;
    if (mode === 'full') {
      image = await captureFullPage(current, documentId, view);
    } else {
      image = await captureViewport(current);
      if (selection) image = await crop(image, selection.clip, view);
    }
    await currentPage(tab);
    const host = new URL(tab.url).hostname.replace(/[^a-z0-9.-]/gi, '-');
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    await showCapture(image, `screenshot-${host}-${mode}-${date}.png`, current);
  } finally {
    capturing.delete(tabId);
  }
}

async function run(tab, mode, selection) {
  try {
    requireActivePage(tab);
    await setError(tab.id);
    if (mode === 'region' && !selection) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selection.js'] });
    } else {
      await capture(tab, mode, selection);
    }
    return { ok: true };
  } catch (error) {
    const message = error.message || 'Screenshot failed. Try again.';
    await setError(tab?.id, message);
    return { ok: false, message };
  }
}

chrome.contextMenus.onClicked.addListener(({ menuItemId }, tab) => {
  if (Object.hasOwn(modes, menuItemId)) void run(tab, menuItemId);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url === chrome.runtime.getURL('popup.html') && Object.hasOwn(modes, message?.mode)) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => run(tab, message.mode), error => ({ ok: false, message: error.message }))
      .then(respond);
    return true;
  }
  if (message?.mode === 'region-selected' && sender.tab && sender.frameId === 0 && sender.documentId) {
    const { x, y, width, height } = message.clip ?? {};
    const { scrollX, scrollY } = message;
    if (![x, y, width, height, scrollX, scrollY].every(Number.isFinite) || width < 1 || height < 1) return;
    run(sender.tab, 'region', { documentId: sender.documentId, clip: { x, y, width, height }, scrollX, scrollY })
      .then(respond);
    return true;
  }
});
