import { toArtifactRef } from '../store/artifact-store.js';
import { AgentBrowserError } from '../util/errors.js';
import type { OpsContext } from './context.js';
import { evaluate } from './element.js';

export interface StorageArgs {
  browser_id?: string;
  target_id?: string;
}

type Kind = 'local' | 'session';

async function pageOf(ctx: OpsContext, args: StorageArgs) {
  const instance = await ctx.registry.resolve(args.browser_id);
  const target = instance.resolvePage(args.target_id);
  return { instance, target };
}

/**
 * DOMStorage is addressed by security origin, not by target, so the origin has
 * to be read out of the page before any storage call can be made.
 */
async function storageIdFor(
  ctx: OpsContext,
  args: StorageArgs,
  kind: Kind,
): Promise<{ instance: Awaited<ReturnType<typeof pageOf>>['instance']; target: Awaited<ReturnType<typeof pageOf>>['target']; storageId: { securityOrigin: string; isLocalStorage: boolean }; origin: string }> {
  const { instance, target } = await pageOf(ctx, args);
  await target.session.trySend('DOMStorage.enable');
  const { result } = await evaluate(instance, target, {
    expression: 'location.origin',
    returnByValue: true,
  });
  const origin = String(result.value ?? '');
  if (!origin || origin === 'null') {
    throw new AgentBrowserError(
      'no_origin',
      'This target has an opaque origin (about:blank, sandboxed frame); it has no accessible storage.',
    );
  }
  return {
    instance,
    target,
    origin,
    storageId: { securityOrigin: origin, isLocalStorage: kind === 'local' },
  };
}

export async function list(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind; max_value_chars?: number },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const { target, storageId, origin } = await storageIdFor(ctx, args, kind);
  const { entries } = await target.session.send<{ entries: string[][] }>('DOMStorage.getDOMStorageItems', {
    storageId,
  });

  const max = Math.min(Math.max(args.max_value_chars ?? 2000, 50), 100_000);
  let totalBytes = 0;
  const items = entries.map(([key = '', value = '']) => {
    totalBytes += key.length + value.length;
    return {
      key,
      size: value.length,
      value: value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value,
      truncated: value.length > max,
    };
  });

  return {
    target_id: target.handle,
    kind,
    origin,
    count: items.length,
    total_bytes: totalBytes,
    items,
    hint: 'Use storage.get(key) for a single full value, or storage.export for everything.',
  };
}

/** Parse a stored value as JSON, reporting the failure rather than throwing. */
function withParsed(out: Record<string, unknown>, value: string): Record<string, unknown> {
  try {
    out.parsed = JSON.parse(value);
  } catch (err) {
    out.parse_error = (err as Error).message;
  }
  return out;
}

export async function get(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind; key?: string; keys?: string[]; as_json?: boolean },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const wanted = args.keys ?? (args.key !== undefined ? [args.key] : []);
  if (wanted.length === 0) {
    throw new AgentBrowserError('no_key', 'Provide key or keys.');
  }
  const { target, storageId, origin } = await storageIdFor(ctx, args, kind);
  const { entries } = await target.session.send<{ entries: string[][] }>('DOMStorage.getDOMStorageItems', {
    storageId,
  });
  const byKey = new Map(entries.map(([k = '', v = '']) => [k, v]));

  // Several keys in one round trip: reading three keys used to cost three calls.
  if (args.keys) {
    const items = wanted.map((key) => {
      const value = byKey.get(key);
      if (value === undefined) return { key, found: false };
      const item: Record<string, unknown> = { key, found: true, size: value.length, value };
      return args.as_json ? withParsed(item, value) : item;
    });
    return {
      target_id: target.handle,
      kind,
      origin,
      count: items.length,
      found_count: items.filter((i) => i.found).length,
      items,
    };
  }

  const key = wanted[0]!;
  const value = byKey.get(key);
  if (value === undefined) {
    return { target_id: target.handle, kind, origin, key, found: false };
  }
  const out: Record<string, unknown> = {
    target_id: target.handle,
    kind,
    origin,
    key,
    found: true,
    size: value.length,
    value,
  };
  return args.as_json ? withParsed(out, value) : out;
}

export async function set(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind; key: string; value: string },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const { instance, target, storageId, origin } = await storageIdFor(ctx, args, kind);
  instance.requireControl(`storage.${kind}.set`);
  await target.session.send('DOMStorage.setDOMStorageItem', {
    storageId,
    key: args.key,
    value: args.value,
  });
  return { target_id: target.handle, kind, origin, key: args.key, set: true, size: args.value.length };
}

export async function remove(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind; key?: string; keys?: string[] },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const wanted = args.keys ?? (args.key !== undefined ? [args.key] : []);
  if (wanted.length === 0) {
    throw new AgentBrowserError('no_key', 'Provide key or keys.');
  }
  const { instance, target, storageId, origin } = await storageIdFor(ctx, args, kind);
  instance.requireControl(`storage.${kind}.remove`);
  for (const key of wanted) {
    await target.session.send('DOMStorage.removeDOMStorageItem', { storageId, key });
  }
  if (args.keys) {
    return { target_id: target.handle, kind, origin, removed: wanted, count: wanted.length };
  }
  return { target_id: target.handle, kind, origin, key: wanted[0], removed: true };
}

export async function clear(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const { instance, target, storageId, origin } = await storageIdFor(ctx, args, kind);
  instance.requireControl(`storage.${kind}.clear`);
  await target.session.send('DOMStorage.clear', { storageId });
  return { target_id: target.handle, kind, origin, cleared: true };
}

/**
 * Inline snapshot of local and session storage, optionally narrowed to a key
 * prefix. Scenario setup ("user has seen tour A but not B") is app-scoped keys,
 * which is a prefix filter, not a full dump to an artifact.
 */
export async function snapshot(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind | 'both'; prefix?: string; max_value_chars?: number },
): Promise<Record<string, unknown>> {
  const which: Kind[] = args.kind === undefined || args.kind === 'both' ? ['local', 'session'] : [args.kind];
  const max = Math.min(Math.max(args.max_value_chars ?? 2000, 50), 100_000);
  const out: Record<string, unknown> = {};
  let origin = '';
  let targetHandle = '';

  for (const kind of which) {
    const { target, storageId, origin: seen } = await storageIdFor(ctx, args, kind);
    origin = seen;
    targetHandle = target.handle;
    const { entries } = await target.session.send<{ entries: string[][] }>('DOMStorage.getDOMStorageItems', {
      storageId,
    });
    const items: Record<string, string> = {};
    let skipped = 0;
    for (const [key = '', value = ''] of entries) {
      if (args.prefix && !key.startsWith(args.prefix)) {
        skipped++;
        continue;
      }
      items[key] = value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value;
    }
    out[`${kind}Storage`] = { count: Object.keys(items).length, ...(skipped ? { skipped_by_prefix: skipped } : {}), items };
  }

  return {
    target_id: targetHandle,
    origin,
    ...(args.prefix ? { prefix: args.prefix } : {}),
    ...out,
    hint: 'Feed these items straight back to storage.import to restore this state later.',
  };
}

/**
 * Restore a set of keys in one call, the counterpart to snapshot/export.
 * `clear_first` makes the resulting state exact rather than a merge.
 */
/** Shape written by exportStorage, accepted back by importStorage. */
interface StorageExport {
  localStorage?: { origin?: string; items?: Record<string, string> };
  sessionStorage?: { origin?: string; items?: Record<string, string> };
  cookies?: unknown;
}

/**
 * A cookie needs somewhere to belong. Exported cookies carry domain/path, but a
 * domain-only cookie from a `localhost` export is rejected by Chromium unless a
 * URL is reconstructed for it, so synthesise one from the domain and the secure
 * flag when the export did not carry a usable url.
 */
function cookieUrlFor(c: Record<string, unknown>): string | undefined {
  const domain = typeof c.domain === 'string' ? c.domain.replace(/^\./, '') : '';
  if (!domain) return undefined;
  const scheme = c.secure === true ? 'https' : 'http';
  const path = typeof c.path === 'string' ? c.path : '/';
  return `${scheme}://${domain}${path}`;
}

export async function importStorage(
  ctx: OpsContext,
  args: StorageArgs & {
    kind?: Kind;
    items?: Record<string, string>;
    state?: StorageExport;
    cookies?: Array<Record<string, unknown>>;
    clear_first?: boolean;
  },
): Promise<Record<string, unknown>> {
  const hasItems = args.items && typeof args.items === 'object';
  const hasState = args.state && typeof args.state === 'object';
  const hasCookies = Array.isArray(args.cookies);
  if (!hasItems && !hasState && !hasCookies) {
    throw new AgentBrowserError(
      'no_items',
      'Provide `items` (key/value pairs), `cookies`, or `state` (a storage.export payload).',
    );
  }

  const out: Record<string, unknown> = {};
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('storage.import');

  // Cookies are browser-scoped, so they restore without a page origin. Doing
  // them first means a following navigation already carries the session.
  const cookies: Array<Record<string, unknown>> = [
    ...(hasCookies ? (args.cookies as Array<Record<string, unknown>>) : []),
    ...(hasState && Array.isArray(args.state?.cookies)
      ? (args.state.cookies as Array<Record<string, unknown>>)
      : []),
  ];
  if (cookies.length > 0) {
    const prepared: Array<Record<string, unknown>> = [];
    const skipped: string[] = [];
    for (const c of cookies) {
      const name = typeof c.name === 'string' ? c.name : '';
      if (!name) continue;
      const url = typeof c.url === 'string' && c.url ? c.url : cookieUrlFor(c);
      if (!url && typeof c.domain !== 'string') {
        skipped.push(name);
        continue;
      }
      prepared.push({
        name,
        value: String(c.value ?? ''),
        ...(c.domain ? { domain: c.domain } : {}),
        ...(url ? { url } : {}),
        ...(c.path ? { path: c.path } : {}),
        ...(c.secure === undefined ? {} : { secure: c.secure }),
        ...(c.httpOnly === undefined ? {} : { httpOnly: c.httpOnly }),
        ...(c.http_only === undefined ? {} : { httpOnly: c.http_only }),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        // A session cookie has no expiry; forwarding a null would pin it to 1970.
        ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
      });
    }
    if (prepared.length > 0) {
      await instance.browserSession.send('Storage.setCookies', { cookies: prepared });
    }
    out.cookies_imported = prepared.length;
    if (skipped.length > 0) out.cookies_skipped = skipped;
  }

  // DOM storage is origin-scoped and needs a real page, so it is only touched
  // when there is something to write.
  const stores: Array<{ kind: Kind; items: Record<string, string> }> = [];
  if (hasItems) stores.push({ kind: args.kind ?? 'local', items: args.items as Record<string, string> });
  if (hasState) {
    if (args.state?.localStorage?.items) stores.push({ kind: 'local', items: args.state.localStorage.items });
    if (args.state?.sessionStorage?.items) stores.push({ kind: 'session', items: args.state.sessionStorage.items });
  }

  const written: Record<string, string[]> = {};
  for (const store of stores) {
    const { target, storageId, origin } = await storageIdFor(ctx, args, store.kind);
    if (args.clear_first) await target.session.send('DOMStorage.clear', { storageId });
    const keys = Object.keys(store.items);
    for (const key of keys) {
      await target.session.send('DOMStorage.setDOMStorageItem', {
        storageId,
        key,
        value: String(store.items[key] ?? ''),
      });
    }
    written[store.kind] = keys;
    out.origin = origin;
    out.target_id = target.handle;
  }

  if (stores.length > 0) {
    out.imported = Object.values(written).reduce((n, k) => n + k.length, 0);
    out.keys = written;
    out.cleared_first = args.clear_first === true;
  }
  return out;
}

export async function exportStorage(
  ctx: OpsContext,
  args: StorageArgs & { save_path?: string },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  const payload: Record<string, unknown> = { url: target.info.url, captured_at: new Date().toISOString() };

  for (const kind of ['local', 'session'] as Kind[]) {
    try {
      const { storageId, origin } = await storageIdFor(ctx, args, kind);
      const { entries } = await target.session.send<{ entries: string[][] }>(
        'DOMStorage.getDOMStorageItems',
        { storageId },
      );
      payload[`${kind}Storage`] = { origin, items: Object.fromEntries(entries as Array<[string, string]>) };
    } catch (err) {
      payload[`${kind}Storage`] = { error: (err as Error).message };
    }
  }

  try {
    const { cookies } = await instance.browserSession.send<{ cookies: unknown[] }>('Storage.getCookies');
    payload.cookies = cookies;
  } catch (err) {
    payload.cookies = { error: (err as Error).message };
  }

  const artifact = ctx.stores.artifacts.put('storage_export', Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
    browserId: instance.id,
    label: 'storage',
    mime: 'application/json',
    sourceRef: target.handle,
  });

  const out: Record<string, unknown> = {
    target_id: target.handle,
    artifact: toArtifactRef(artifact),
  };
  if (args.save_path) {
    out.saved_to = ctx.stores.artifacts.exportTo(artifact.artifact_handle, args.save_path);
  }
  return out;
}

/* ------------------------------- cookies -------------------------------- */

export interface CookieArgs {
  browser_id?: string;
}

export async function listCookies(
  ctx: OpsContext,
  args: CookieArgs & { domain_contains?: string; name?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  const { cookies } = await instance.browserSession.send<{
    cookies: Array<Record<string, unknown>>;
  }>('Storage.getCookies');

  const filtered = cookies.filter(
    (c) =>
      (!args.domain_contains || String(c.domain ?? '').includes(args.domain_contains)) &&
      (!args.name || c.name === args.name),
  );

  return {
    browser_id: instance.id,
    total: cookies.length,
    returned: filtered.length,
    cookies: filtered.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      // CDP returns -1 for session cookies.
      expires: typeof c.expires === 'number' && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
      session: c.session,
      http_only: c.httpOnly,
      secure: c.secure,
      same_site: c.sameSite ?? null,
      size: c.size,
    })),
  };
}

export async function setCookie(
  ctx: OpsContext,
  args: CookieArgs & {
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    http_only?: boolean;
    same_site?: 'Strict' | 'Lax' | 'None';
    expires?: number;
  },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('storage.cookies.set');
  if (!args.url && !args.domain) {
    throw new AgentBrowserError('bad_args', 'Provide `url` or `domain` so Chromium knows where the cookie belongs.');
  }
  await instance.browserSession.send('Storage.setCookies', {
    cookies: [
      {
        name: args.name,
        value: args.value,
        ...(args.url ? { url: args.url } : {}),
        ...(args.domain ? { domain: args.domain } : {}),
        ...(args.path ? { path: args.path } : {}),
        ...(args.secure === undefined ? {} : { secure: args.secure }),
        ...(args.http_only === undefined ? {} : { httpOnly: args.http_only }),
        ...(args.same_site ? { sameSite: args.same_site } : {}),
        ...(args.expires === undefined ? {} : { expires: args.expires }),
      },
    ],
  });
  return { browser_id: instance.id, name: args.name, set: true };
}

export async function deleteCookies(
  ctx: OpsContext,
  args: CookieArgs & { name: string; domain?: string; path?: string; url?: string },
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('storage.cookies.delete');
  await instance.browserSession.send('Network.deleteCookies', {
    name: args.name,
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.path ? { path: args.path } : {}),
    ...(args.url ? { url: args.url } : {}),
  });
  return { browser_id: instance.id, name: args.name, deleted: true };
}

export async function clearCookies(
  ctx: OpsContext,
  args: CookieArgs,
): Promise<Record<string, unknown>> {
  const instance = await ctx.registry.resolve(args.browser_id);
  instance.requireControl('storage.cookies.clear');
  await instance.browserSession.send('Storage.clearCookies');
  return { browser_id: instance.id, cleared: true };
}

/* ------------------------------ IndexedDB -------------------------------- */

export async function listDatabases(
  ctx: OpsContext,
  args: StorageArgs,
): Promise<Record<string, unknown>> {
  const { target, origin } = await storageIdFor(ctx, args, 'local');
  await target.session.trySend('IndexedDB.enable');
  const { databaseNames } = await target.session.send<{ databaseNames: string[] }>(
    'IndexedDB.requestDatabaseNames',
    { securityOrigin: origin },
  );
  return { target_id: target.handle, origin, databases: databaseNames };
}

export async function describeDatabase(
  ctx: OpsContext,
  args: StorageArgs & { database: string },
): Promise<Record<string, unknown>> {
  const { target, origin } = await storageIdFor(ctx, args, 'local');
  await target.session.trySend('IndexedDB.enable');
  const { databaseWithObjectStores } = await target.session.send<{
    databaseWithObjectStores: {
      name: string;
      version: number;
      objectStores: Array<{
        name: string;
        keyPath: unknown;
        autoIncrement: boolean;
        indexes: Array<{ name: string; keyPath: unknown; unique: boolean; multiEntry: boolean }>;
      }>;
    };
  }>('IndexedDB.requestDatabase', { securityOrigin: origin, databaseName: args.database });

  return {
    target_id: target.handle,
    origin,
    database: databaseWithObjectStores.name,
    version: databaseWithObjectStores.version,
    object_stores: databaseWithObjectStores.objectStores.map((store) => ({
      name: store.name,
      key_path: store.keyPath,
      auto_increment: store.autoIncrement,
      indexes: store.indexes.map((i) => ({
        name: i.name,
        key_path: i.keyPath,
        unique: i.unique,
        multi_entry: i.multiEntry,
      })),
    })),
  };
}

export async function queryDatabase(
  ctx: OpsContext,
  args: StorageArgs & {
    database: string;
    object_store: string;
    index?: string;
    skip?: number;
    limit?: number;
  },
): Promise<Record<string, unknown>> {
  const { target, origin } = await storageIdFor(ctx, args, 'local');
  await target.session.trySend('IndexedDB.enable');
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);

  const { objectStoreDataEntries, hasMore } = await target.session.send<{
    objectStoreDataEntries: Array<{
      key: { type: string; value?: unknown; description?: string };
      primaryKey: { type: string; value?: unknown };
      value: { type: string; value?: unknown; description?: string };
    }>;
    hasMore: boolean;
  }>('IndexedDB.requestData', {
    securityOrigin: origin,
    databaseName: args.database,
    objectStoreName: args.object_store,
    // indexName must be OMITTED to read by primary key. Passing an empty
    // string makes Chromium answer "Could not get index" rather than falling
    // back, so this is a presence test, not a default.
    ...(args.index ? { indexName: args.index } : {}),
    skipCount: Math.max(args.skip ?? 0, 0),
    pageSize: limit,
  });

  return {
    target_id: target.handle,
    origin,
    database: args.database,
    object_store: args.object_store,
    returned: objectStoreDataEntries.length,
    has_more: hasMore,
    skip: args.skip ?? 0,
    records: objectStoreDataEntries.map((entry) => ({
      key: entry.key.value ?? entry.key.description,
      primary_key: entry.primaryKey.value ?? null,
      value: entry.value.value ?? entry.value.description ?? null,
    })),
  };
}

/**
 * CDP's IndexedDB domain is read/delete only, so writes go through the page's
 * own IndexedDB API. The tool surface hides that split.
 */
export async function putRecord(
  ctx: OpsContext,
  args: StorageArgs & { database: string; object_store: string; value: unknown; key?: unknown },
): Promise<Record<string, unknown>> {
  const { instance, target } = await pageOf(ctx, args);
  instance.requireControl('storage.indexeddb.put');

  const { result, exceptionText } = await evaluate(instance, target, {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(${JSON.stringify(args.database)});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = db.transaction(${JSON.stringify(args.object_store)}, 'readwrite');
        const store = tx.objectStore(${JSON.stringify(args.object_store)});
        const key = await new Promise((resolve, reject) => {
          const req = ${args.key === undefined
            ? `store.put(${JSON.stringify(args.value)})`
            : `store.put(${JSON.stringify(args.value)}, ${JSON.stringify(args.key)})`};
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        return { ok: true, key };
      } finally {
        db.close();
      }
    })()`,
  });
  if (exceptionText) throw new AgentBrowserError('indexeddb_put_failed', exceptionText);

  return {
    target_id: target.handle,
    database: args.database,
    object_store: args.object_store,
    ...(result.value as Record<string, unknown>),
  };
}

export async function clearObjectStore(
  ctx: OpsContext,
  args: StorageArgs & { database: string; object_store: string },
): Promise<Record<string, unknown>> {
  const { instance, target, origin } = await storageIdFor(ctx, args, 'local');
  instance.requireControl('storage.indexeddb.clear');
  await target.session.trySend('IndexedDB.enable');
  await target.session.send('IndexedDB.clearObjectStore', {
    securityOrigin: origin,
    databaseName: args.database,
    objectStoreName: args.object_store,
  });
  return { target_id: target.handle, database: args.database, object_store: args.object_store, cleared: true };
}

export async function deleteDatabase(
  ctx: OpsContext,
  args: StorageArgs & { database: string },
): Promise<Record<string, unknown>> {
  const { instance, target, origin } = await storageIdFor(ctx, args, 'local');
  instance.requireControl('storage.indexeddb.delete_database');
  await target.session.trySend('IndexedDB.enable');
  await target.session.send('IndexedDB.deleteDatabase', {
    securityOrigin: origin,
    databaseName: args.database,
  });
  return { target_id: target.handle, database: args.database, deleted: true };
}

/* ---------------------------- Cache Storage ------------------------------ */

export async function listCaches(
  ctx: OpsContext,
  args: StorageArgs,
): Promise<Record<string, unknown>> {
  const { target, origin } = await storageIdFor(ctx, args, 'local');
  const { caches } = await target.session.send<{
    caches: Array<{ cacheId: string; securityOrigin: string; cacheName: string }>;
  }>('CacheStorage.requestCacheNames', { securityOrigin: origin });
  return {
    target_id: target.handle,
    origin,
    caches: caches.map((c) => ({ cache_id: c.cacheId, name: c.cacheName, origin: c.securityOrigin })),
  };
}

export async function listCacheEntries(
  ctx: OpsContext,
  args: StorageArgs & { cache_id: string; skip?: number; limit?: number; path_filter?: string },
): Promise<Record<string, unknown>> {
  const { target } = await pageOf(ctx, args);
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
  const { cacheDataEntries, returnCount } = await target.session.send<{
    cacheDataEntries: Array<{
      requestURL: string;
      requestMethod: string;
      responseStatus: number;
      responseStatusText: string;
      responseTime: number;
      responseType: string;
    }>;
    returnCount: number;
  }>('CacheStorage.requestEntries', {
    cacheId: args.cache_id,
    skipCount: Math.max(args.skip ?? 0, 0),
    pageSize: limit,
    ...(args.path_filter ? { pathFilter: args.path_filter } : {}),
  });
  return {
    target_id: target.handle,
    cache_id: args.cache_id,
    total: returnCount,
    returned: cacheDataEntries.length,
    entries: cacheDataEntries.map((e) => ({
      url: e.requestURL,
      method: e.requestMethod,
      status: e.responseStatus,
      status_text: e.responseStatusText,
      response_type: e.responseType,
    })),
  };
}

export async function usage(ctx: OpsContext, args: StorageArgs): Promise<Record<string, unknown>> {
  const { instance, target, origin } = await storageIdFor(ctx, args, 'local');
  interface UsageAndQuota {
    usage: number;
    quota: number;
    overrideActive: boolean;
    usageBreakdown: Array<{ storageType: string; usage: number }>;
  }
  // This must go to the TARGET session, not the browser session: the browser
  // session has no storage partition to resolve the origin against and answers
  // "Internal error". Verified against Chrome 151.
  const info = await target.session.send<UsageAndQuota>('Storage.getUsageAndQuota', { origin });
  return {
    target_id: target.handle,
    origin,
    usage_bytes: info.usage,
    quota_bytes: info.quota,
    percent_used: info.quota ? Number(((info.usage / info.quota) * 100).toFixed(2)) : null,
    breakdown: info.usageBreakdown
      .filter((b) => b.usage > 0)
      .map((b) => ({ type: b.storageType, bytes: b.usage }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

export async function clearOrigin(
  ctx: OpsContext,
  args: StorageArgs & { types?: string[] },
): Promise<Record<string, unknown>> {
  const { instance, target, origin } = await storageIdFor(ctx, args, 'local');
  instance.requireControl('storage.clear_origin');
  const types = (args.types ?? ['all']).join(',');
  await instance.browserSession.send('Storage.clearDataForOrigin', { origin, storageTypes: types });
  return { target_id: target.handle, origin, cleared_types: types };
}
