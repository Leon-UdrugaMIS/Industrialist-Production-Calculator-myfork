import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { createServer } from 'vite';

const databaseName = 'industrialist_saves_db';
const legacyDb = await openDB(databaseName, 3, {
  upgrade(db) {
    db.createObjectStore('saves', { keyPath: 'id' });
    db.createObjectStore('autosave', { keyPath: 'id' });
    db.createObjectStore('data_overrides', { keyPath: 'id' });
    db.createObjectStore('wiki_bucket_cache', { keyPath: 'id' });
  },
});

const records = [
  { id: 'latest', timestamp: 100, data: { version: 4, nodes: [], edges: [] } },
  { id: 'tab:older', timestamp: 200, data: { version: 4, nodes: [], edges: [] } },
  { id: 'tab:newest', timestamp: 300, data: { version: 4, nodes: [], edges: [] } },
];
for (const record of records) await legacyDb.put('autosave', record);
legacyDb.close();

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
});
const idb = await viteServer.ssrLoadModule('/src/persistence/idb.ts');

after(async () => {
  await viteServer.close();
});

test('upgrading v3 autosaves seeds a stable v4 newest pointer without rewriting records', async () => {
  const restored = await idb.getAutosave('tab:new');
  assert.deepEqual(restored, records[2]);

  const db = await globalThis.__industrialistDatabaseConnectionState.promise;
  assert.ok(db);
  assert.equal(db.version, 4);
  assert.equal(db.objectStoreNames.contains('autosave_meta'), true);
  assert.deepEqual(await db.get('autosave_meta', 'latest'), {
    key: 'latest',
    autosaveId: 'tab:newest',
    modifiedAt: 300,
  });
  for (const record of records) {
    assert.deepEqual(await db.get('autosave', record.id), record);
  }
});
