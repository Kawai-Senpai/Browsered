// A preview opens in a new tab and can read the PNG even if Chrome restarts the
// service worker between capture and display. Consume the record on first read.
function openCaptures() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('browsered-screenshots', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('captures');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function changeCaptures(change) {
  const db = await openCaptures();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('captures', 'readwrite');
      const request = change(transaction.objectStore('captures'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not open the screenshot.'));
    });
  } finally {
    db.close();
  }
}

export async function storeCapture(capture) {
  const now = Date.now();
  const id = `${now}-${crypto.randomUUID()}`;
  await changeCaptures((store) => {
    store.delete(IDBKeyRange.upperBound(String(now - 10 * 60_000)));
    return store.put(capture, id);
  });
  return id;
}

export function takeCapture(id) {
  return changeCaptures((store) => {
    const request = store.get(id);
    store.delete(id);
    return request;
  });
}
