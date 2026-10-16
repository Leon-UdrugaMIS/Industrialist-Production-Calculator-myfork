import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { SaveData, SaveRecord, AutosaveRecord } from '../types/saves';

interface SavesDB extends DBSchema {
  saves: {
    key: string;
    value: SaveRecord;
  };
  autosave: {
    key: string;
    value: AutosaveRecord;
  };
  autosave_meta: {
    key: string;
    value: { key: string; autosaveId: string; modifiedAt: number };
  };
  data_overrides: {
    key: string;
    value: { id: string; data: Record<string, unknown> };
  };
  wiki_bucket_cache: {
    key: string;
    value: WikiBucketCacheRecord;
  };
}

const DB_NAME = 'industrialist_saves_db';
const DB_VERSION = 4;
const LATEST_AUTOSAVE_POINTER_KEY = 'latest';

export interface WikiBucketCacheRecord {
  id: string;
  bucket: string;
  querySignature: string;
  rows: Record<string, unknown>[];
  contentHash: string;
  fetchedAt: number;
  checkedAt: number;
}

interface DatabaseConnectionState {
  promise: Promise<IDBPDatabase<SavesDB> | null> | null;
}

interface IndustrialistGlobalScope {
  __industrialistDatabaseConnectionState?: DatabaseConnectionState;
}

function getConnectionState(): DatabaseConnectionState {
  const scope = globalThis as typeof globalThis & IndustrialistGlobalScope;
  scope.__industrialistDatabaseConnectionState ??= { promise: null };
  return scope.__industrialistDatabaseConnectionState;
}

function getDB(): Promise<IDBPDatabase<SavesDB> | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  const connectionState = getConnectionState();
  if (!connectionState.promise) {
    const openingPromise: Promise<IDBPDatabase<SavesDB> | null> = openDB<SavesDB>(
      DB_NAME,
      DB_VERSION,
      {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore('saves', { keyPath: 'id' });
            db.createObjectStore('autosave', { keyPath: 'id' });
          }
          if (oldVersion < 2) {
            if (!db.objectStoreNames.contains('data_overrides')) {
              db.createObjectStore('data_overrides', { keyPath: 'id' });
            }
          }
          if (oldVersion < 3) {
            if (!db.objectStoreNames.contains('wiki_bucket_cache')) {
              db.createObjectStore('wiki_bucket_cache', { keyPath: 'id' });
            }
          }
          if (oldVersion < 4) {
            db.createObjectStore('autosave_meta', { keyPath: 'key' });
          }
        },
        blocking() {
          void openingPromise.then((db) => {
            db?.close();
            if (connectionState.promise === openingPromise) {
              connectionState.promise = null;
            }
          });
        },
        terminated() {
          if (connectionState.promise === openingPromise) {
            connectionState.promise = null;
          }
        },
      },
    ).catch((err) => {
      console.warn(
        'IndexedDB failed to open (Incognito mode or quota limit), resetting promise cache:',
        err,
      );
      if (connectionState.promise === openingPromise) {
        connectionState.promise = null;
      }
      return null;
    });
    connectionState.promise = openingPromise;
  }
  return connectionState.promise;
}

export async function getSaves(): Promise<SaveRecord[]> {
  try {
    const db = await getDB();
    if (!db) return [];
    return await db.getAll('saves');
  } catch (err) {
    console.warn('Failed to get saves from IndexedDB:', err);
    return [];
  }
}

export async function saveSave(record: SaveRecord): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    const tx = db.transaction('saves', 'readwrite');
    const existing = await tx.store.get(record.id);
    if (
      typeof existing?.data?.version === 'number' &&
      existing.data.version > record.data.version
    ) {
      await tx.done;
      console.warn(
        `Refusing to overwrite save ${record.id}: stored version ${existing.data.version} is newer than incoming version ${record.data.version}.`,
      );
      return false;
    }
    await tx.store.put(record);
    await tx.done;
    return true;
  } catch (err) {
    console.warn('Failed to save record to IndexedDB:', err);
    return false;
  }
}

export async function deleteSave(id: string): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.delete('saves', id);
    return true;
  } catch (err) {
    console.warn('Failed to delete save from IndexedDB:', err);
    return false;
  }
}

export async function renameSave(id: string, newName: string): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    const record = await db.get('saves', id);
    if (!record) return false;
    record.name = newName;
    record.timestamp = Date.now();
    await db.put('saves', record);
    return true;
  } catch (err) {
    console.warn('Failed to rename save in IndexedDB:', err);
    return false;
  }
}

export interface AutosaveWriteOptions {
  modifiedAt?: number;
  publishLatest?: boolean;
}

function getAutosaveModifiedAt(record: AutosaveRecord): number {
  if (typeof record.modifiedAt === 'number' && Number.isFinite(record.modifiedAt)) {
    return record.modifiedAt;
  }
  return typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
    ? record.timestamp
    : 0;
}

function isNewerAutosave(
  candidate: { autosaveId: string; modifiedAt: number },
  current: { autosaveId: string; modifiedAt: number } | null,
): boolean {
  if (!current) return true;
  if (candidate.modifiedAt !== current.modifiedAt) {
    return candidate.modifiedAt > current.modifiedAt;
  }
  return candidate.autosaveId.localeCompare(current.autosaveId) < 0;
}

async function ensureLatestAutosavePointer(
  tx: IDBPTransaction<SavesDB, ['autosave', 'autosave_meta'], 'readwrite'>,
): Promise<{ key: string; autosaveId: string; modifiedAt: number } | null> {
  const autosaves = tx.objectStore('autosave');
  const metadata = tx.objectStore('autosave_meta');
  const pointer = await metadata.get(LATEST_AUTOSAVE_POINTER_KEY);
  if (pointer?.autosaveId === '') return null;
  if (pointer && (await autosaves.get(pointer.autosaveId))) return pointer;

  const records = await autosaves.getAll();
  let newest: AutosaveRecord | null = null;
  for (const record of records) {
    const candidate = {
      autosaveId: record.id,
      modifiedAt: getAutosaveModifiedAt(record),
    };
    if (
      isNewerAutosave(
        candidate,
        newest ? { autosaveId: newest.id, modifiedAt: getAutosaveModifiedAt(newest) } : null,
      )
    ) {
      newest = record;
    }
  }

  if (!newest) {
    await metadata.put({
      key: LATEST_AUTOSAVE_POINTER_KEY,
      autosaveId: '',
      modifiedAt: 0,
    });
    return null;
  }

  const seededPointer = {
    key: LATEST_AUTOSAVE_POINTER_KEY,
    autosaveId: newest.id,
    modifiedAt: getAutosaveModifiedAt(newest),
  };
  await metadata.put(seededPointer);
  return seededPointer;
}

export async function getAutosave(id = 'latest'): Promise<AutosaveRecord | null> {
  try {
    const db = await getDB();
    if (!db) {
      throw new Error('IndexedDB is unavailable, so the browser autosave could not be read.');
    }
    const tx = db.transaction(['autosave', 'autosave_meta'] as const, 'readwrite');
    const autosaves = tx.objectStore('autosave');
    const exactRecord = await autosaves.get(id);
    const pointer = await ensureLatestAutosavePointer(tx);
    const record = exactRecord ?? (pointer ? await autosaves.get(pointer.autosaveId) : undefined);
    await tx.done;
    return record ?? null;
  } catch (err) {
    console.warn('Failed to get autosave from IndexedDB:', err);
    throw err;
  }
}

export async function saveAutosave(
  data: SaveData,
  id = 'latest',
  options: AutosaveWriteOptions = {},
): Promise<void> {
  const db = await getDB();
  if (!db) {
    throw new Error('IndexedDB not available');
  }
  const tx = db.transaction(['autosave', 'autosave_meta'] as const, 'readwrite');
  const autosaves = tx.objectStore('autosave');
  const metadata = tx.objectStore('autosave_meta');
  const existing = await autosaves.get(id);
  if (typeof existing?.data?.version === 'number' && existing.data.version > data.version) {
    await tx.done;
    throw new Error(
      `Autosave version ${existing.data.version} is newer than this app supports. The original autosave was preserved.`,
    );
  }

  const pointer = await ensureLatestAutosavePointer(tx);
  const pointerRecord = pointer ? await autosaves.get(pointer.autosaveId) : undefined;
  const modifiedAt = options.modifiedAt ?? Date.now();
  const record: AutosaveRecord = {
    id,
    timestamp: Date.now(),
    modifiedAt,
    data,
  };
  await autosaves.put(record);

  const pointerIsFutureVersion =
    typeof pointerRecord?.data?.version === 'number' && pointerRecord.data.version > data.version;
  const candidatePointer = { autosaveId: id, modifiedAt };
  const currentPointer = pointer
    ? { autosaveId: pointer.autosaveId, modifiedAt: pointer.modifiedAt }
    : null;
  if (
    options.publishLatest !== false &&
    !pointerIsFutureVersion &&
    isNewerAutosave(candidatePointer, currentPointer)
  ) {
    await metadata.put({
      key: LATEST_AUTOSAVE_POINTER_KEY,
      ...candidatePointer,
    });
  }
  await tx.done;
}

export async function publishAutosaveAsLatest(id: string): Promise<void> {
  const db = await getDB();
  if (!db) throw new Error('IndexedDB not available');

  const tx = db.transaction(['autosave', 'autosave_meta'] as const, 'readwrite');
  const autosaves = tx.objectStore('autosave');
  const metadata = tx.objectStore('autosave_meta');
  const record = await autosaves.get(id);
  if (!record) {
    await tx.done;
    throw new Error(`Autosave ${id} could not be published because its record is missing.`);
  }

  const pointer = await ensureLatestAutosavePointer(tx);
  const pointerRecord = pointer ? await autosaves.get(pointer.autosaveId) : undefined;
  const pointerIsFutureVersion =
    typeof pointerRecord?.data?.version === 'number' &&
    pointerRecord.data.version > record.data.version;
  const candidatePointer = {
    autosaveId: record.id,
    modifiedAt: getAutosaveModifiedAt(record),
  };
  const currentPointer = pointer
    ? { autosaveId: pointer.autosaveId, modifiedAt: pointer.modifiedAt }
    : null;
  if (!pointerIsFutureVersion && isNewerAutosave(candidatePointer, currentPointer)) {
    await metadata.put({
      key: LATEST_AUTOSAVE_POINTER_KEY,
      ...candidatePointer,
    });
  }
  await tx.done;
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  if (!db) return;

  await Promise.all([
    db.clear('autosave'),
    db.clear('autosave_meta'),
    db.clear('data_overrides'),
    db.clear('wiki_bucket_cache'),
  ]);
}

export async function getWikiBucketCache(id: string): Promise<WikiBucketCacheRecord | null> {
  try {
    const db = await getDB();
    if (!db) return null;
    const record = await db.get('wiki_bucket_cache', id);
    return record ?? null;
  } catch (err) {
    console.warn('Failed to get wiki bucket cache from IndexedDB:', err);
    return null;
  }
}

export async function saveWikiBucketCache(record: WikiBucketCacheRecord): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.put('wiki_bucket_cache', record);
    return true;
  } catch (err) {
    console.warn('Failed to save wiki bucket cache in IndexedDB:', err);
    return false;
  }
}

export async function clearWikiBucketCache(): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.clear('wiki_bucket_cache');
    return true;
  } catch (err) {
    console.warn('Failed to clear wiki bucket cache in IndexedDB:', err);
    return false;
  }
}

export async function getDataOverrides(): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const db = await getDB();
  if (!db) {
    throw new Error(
      'IndexedDB is unavailable. Custom data overrides could not be read, so the save was not changed.',
    );
  }

  try {
    return await db.getAll('data_overrides');
  } catch (err) {
    console.warn('Failed to get data overrides from IndexedDB:', err);
    throw new Error(
      'Custom data overrides could not be read from IndexedDB, so the save was not changed.',
      { cause: err },
    );
  }
}

export async function saveDataOverride(
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.put('data_overrides', { id, data });
    return true;
  } catch (err) {
    console.warn('Failed to save data override in IndexedDB:', err);
    return false;
  }
}

export async function batchSaveDataOverrides(
  entries: { id: string; data: Record<string, unknown> }[],
): Promise<boolean> {
  if (entries.length === 0) return true;
  try {
    const db = await getDB();
    if (!db) return false;
    const tx = db.transaction('data_overrides', 'readwrite');
    const store = tx.objectStore('data_overrides');
    const writes = await Promise.allSettled([tx.done, ...entries.map((entry) => store.put(entry))]);
    const failedWrite = writes.find((result) => result.status === 'rejected');
    if (failedWrite?.status === 'rejected') throw failedWrite.reason;
    return true;
  } catch (err) {
    console.warn('Failed to batch-save data overrides in IndexedDB:', err);
    return false;
  }
}

export async function deleteDataOverride(id: string): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.delete('data_overrides', id);
    return true;
  } catch (err) {
    console.warn('Failed to delete data override in IndexedDB:', err);
    return false;
  }
}

export async function clearDataOverrides(): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    await db.clear('data_overrides');
    return true;
  } catch (err) {
    console.warn('Failed to clear data overrides in IndexedDB:', err);
    return false;
  }
}

export async function clearCategoryDataOverrides(
  category: 'products' | 'machines' | 'recipes' | 'researches' | 'special_recipes',
): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;

    const prefix =
      category === 'products'
        ? 'product:'
        : category === 'machines'
          ? 'machine:'
          : category === 'recipes'
            ? 'recipe:'
            : category === 'researches'
              ? 'research:'
              : 'special_recipe:';

    const tx = db.transaction('data_overrides', 'readwrite');
    const store = tx.objectStore('data_overrides');

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.key.startsWith(prefix)) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }

    await tx.done;
    return true;
  } catch (err) {
    console.warn(`Failed to clear category overrides for ${category} in IndexedDB:`, err);
    return false;
  }
}
