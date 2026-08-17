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

export async function get(
  ctx: OpsContext,
  args: StorageArgs & { kind?: Kind; key: string; as_json?: boolean },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const { target, storageId, origin } = await storageIdFor(ctx, args, kind);
  const { entries } = await target.session.send<{ entries: string[][] }>('DOMStorage.getDOMStorageItems', {
    storageId,
  });
  const found = entries.find(([key]) => key === args.key);
  if (!found) {
    return { target_id: target.handle, kind, origin, key: args.key, found: false };
  }
  const value = found[1] ?? '';
  const out: Record<string, unknown> = {
    target_id: target.handle,
    kind,
    origin,
    key: args.key,
    found: true,
    size: value.length,
    value,
  };
  if (args.as_json) {
    try {
      out.parsed = JSON.parse(value);
    } catch (err) {
      out.parse_error = (err as Error).message;
    }
  }
  return out;
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
  args: StorageArgs & { kind?: Kind; key: string },
): Promise<Record<string, unknown>> {
  const kind = args.kind ?? 'local';
  const { instance, target, storageId, origin } = await storageIdFor(ctx, args, kind);
  instance.requireControl(`storage.${kind}.remove`);
  await target.session.send('DOMStorage.removeDOMStorageItem', { storageId, key: args.key });
  return { target_id: target.handle, kind, origin, key: args.key, removed: true };
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
