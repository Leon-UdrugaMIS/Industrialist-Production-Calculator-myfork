import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'vite';

globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0);

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
});
const idb = await viteServer.ssrLoadModule('/src/persistence/idb.ts');
const lookup = await viteServer.ssrLoadModule('/src/data/lookup.ts');
await lookup.initializeDatabase();
const transformer = await viteServer.ssrLoadModule('/src/persistence/transformer.ts');
const autosaveWriter = await viteServer.ssrLoadModule('/src/persistence/autosaveWriter.ts');
const savesOverlay = await viteServer.ssrLoadModule(
  '/src/components/overlays/SavesOverlay/savesOverlayStore.ts',
);
const flowStoreModule = await viteServer.ssrLoadModule('/src/stores/useFlowStore.ts');
const settingsStoreModule = await viteServer.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
const uiStoreModule = await viteServer.ssrLoadModule('/src/stores/useUIStore.ts');
const dataStoreModule = await viteServer.ssrLoadModule('/src/stores/useDataStore.ts');
const tutorialStoreModule = await viteServer.ssrLoadModule('/src/stores/useTutorialStore.ts');

const db = await globalThis.__industrialistDatabaseConnectionState.promise;
assert.ok(db);
const defaults = structuredClone(settingsStoreModule.useGlobalSettingsStore.getState().settings);
const recipe = lookup.getAllRecipes().find((entry) => entry.id === 'r_paper_mill_01');
const product = lookup.getDefaultProducts().find((entry) => entry.id !== 'any_item');
assert.ok(recipe);
assert.ok(product);

after(async () => {
  await viteServer.close();
});

beforeEach(async () => {
  await db.clear('saves');
  await db.clear('autosave');
  await db.clear('data_overrides');
  await lookup.reloadDatabase();
  flowStoreModule.useFlowStore.getState().setNodesAndEdges([], []);
  settingsStoreModule.useGlobalSettingsStore.setState({ settings: structuredClone(defaults) });
  uiStoreModule.useUIStore.setState({
    confirm: async (options) => (options.threeWay ? 'cancel' : false),
  });
  autosaveWriter.markStartupAutosaveLoadComplete();
});

function productOverride(offset) {
  return {
    id: `product:${product.id}`,
    data: { ...product, sell_price: product.sell_price + offset },
  };
}

function recipeNode(id) {
  return {
    id,
    type: 'recipe',
    position: { x: 20, y: 30 },
    data: { recipeId: recipe.id, machineCount: 1, settings: {} },
  };
}

function saveRecord(id, nodeId, overrides = [], globalPollution = 29) {
  const data = transformer.serializeCanvas([recipeNode(nodeId)], [], overrides);
  data.globalSettings = { ...data.globalSettings, global_pollution: globalPollution };
  return { id, name: id, timestamp: 1, data };
}

function setConfirm(result) {
  uiStoreModule.useUIStore.setState({
    confirm: async (options) =>
      options.threeWay ? result : result === true || result === 'confirm',
  });
}

function makeStore() {
  return savesOverlay.createSavesOverlayStore();
}

async function importSaveText(store, text) {
  const previousFileReader = globalThis.FileReader;
  let readComplete = Promise.resolve();
  class TestFileReader {
    readAsText() {
      readComplete = Promise.resolve(this.onload({ target: { result: text } }));
    }
  }
  globalThis.FileReader = TestFileReader;
  const input = { files: [{}], value: 'save.json' };
  try {
    await store.getState().handleImportJson({ target: input });
    await readComplete;
  } finally {
    globalThis.FileReader = previousFileReader;
  }
  return input;
}

async function withOverrideReadFailure(action) {
  const originalGetAll = db.getAll.bind(db);
  db.getAll = async function (storeName, ...args) {
    if (storeName === 'data_overrides') throw new Error('simulated override read failure');
    return originalGetAll.call(this, storeName, ...args);
  };
  try {
    return await action();
  } finally {
    db.getAll = originalGetAll;
  }
}

async function withOverrideWriteFailure(action) {
  const originalTransaction = db.transaction.bind(db);
  db.transaction = function (storeNames, mode, ...args) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    if (mode === 'readwrite' && names.includes('data_overrides')) {
      throw new Error('simulated override transaction failure');
    }
    return originalTransaction(storeNames, mode, ...args);
  };
  try {
    return await action();
  } finally {
    db.transaction = originalTransaction;
  }
}

test('a successful override read distinguishes nonempty data from an empty set', async () => {
  const override = productOverride(1);
  assert.equal(await idb.saveDataOverride(override.id, override.data), true);
  assert.deepEqual(await idb.getDataOverrides(), [override]);

  await db.clear('data_overrides');
  assert.deepEqual(await idb.getDataOverrides(), []);
});

test('valid custom overrides pass the save-restore validation entry point', () => {
  const result = savesOverlay.validateSaveOverrides([productOverride(1)]);
  assert.deepEqual(result, { valid: true, errorMessages: [] });
});

test('an override-read failure prevents named-save creation', async () => {
  const store = makeStore();
  store.getState().setNewSaveName('Should not be created');

  await withOverrideReadFailure(() => store.getState().handleCreateSave('button'));

  assert.equal((await idb.getSaves()).length, 0);
  assert.equal(store.getState().status.type, 'error');
  assert.match(store.getState().status.message, /not created.*could not be read/i);
  store.getState().clearStatus();
});

test('an override-read failure stops tutorial startup and reports the storage error', async () => {
  let shownConfirmation;
  uiStoreModule.useUIStore.setState({
    confirm: async (options) => {
      shownConfirmation = options;
      return false;
    },
  });
  const nodesBefore = structuredClone(flowStoreModule.useFlowStore.getState().nodes);

  await withOverrideReadFailure(() =>
    tutorialStoreModule.useTutorialStore.getState().startTutorial('first-production-chain'),
  );

  assert.equal(tutorialStoreModule.useTutorialStore.getState().activeTutorialId, null);
  assert.deepEqual(flowStoreModule.useFlowStore.getState().nodes, nodesBefore);
  assert.equal(shownConfirmation.title, 'TUTORIAL COULD NOT START');
  assert.match(shownConfirmation.message, /could not be read/i);
});

test('an override-read failure preserves the existing named-save snapshot on overwrite', async () => {
  const original = saveRecord('named-overwrite', 'saved-before-failure', [productOverride(1)]);
  assert.equal(await idb.saveSave(original), true);
  const store = makeStore();
  setConfirm(true);

  await withOverrideReadFailure(() => store.getState().handleOverwriteSave(original));

  assert.deepEqual(await idb.getSaves(), [original]);
  assert.equal(store.getState().status.type, 'error');
  assert.match(store.getState().status.message, /not overwritten.*could not be read/i);
  store.getState().clearStatus();
});

test('an override-read failure preserves the previous autosave snapshot', async () => {
  const previous = {
    id: 'autosave-read-failure',
    timestamp: 1,
    data: transformer.serializeCanvas([recipeNode('autosaved-before-failure')], []),
  };
  await db.put('autosave', previous);

  await withOverrideReadFailure(() =>
    assert.rejects(autosaveWriter.saveCurrentAutosave(previous.id), /could not be read/i),
  );

  assert.deepEqual(await db.get('autosave', previous.id), previous);
});

async function failedRestorePreservesProject(restoreAction) {
  const priorOverride = productOverride(1);
  const incomingOverride = productOverride(2);
  assert.equal(await idb.saveDataOverride(priorOverride.id, priorOverride.data), true);
  const record = saveRecord('restore-write-failure', 'loaded-node', [incomingOverride], 57);
  const store = makeStore();
  flowStoreModule.useFlowStore.getState().setNodesAndEdges([recipeNode('current-node')], []);
  settingsStoreModule.useGlobalSettingsStore.setState({
    settings: { ...defaults, global_pollution: 73 },
  });
  uiStoreModule.useUIStore.getState().setSavesOverlayOpen(true);
  setConfirm('confirm');
  const nodesBefore = structuredClone(flowStoreModule.useFlowStore.getState().nodes);
  const settingsBefore = structuredClone(
    settingsStoreModule.useGlobalSettingsStore.getState().settings,
  );
  const dataVersionBefore = dataStoreModule.useDataStore.getState().dbVersion;

  await withOverrideWriteFailure(() => store.getState()[restoreAction](record));

  assert.deepEqual(flowStoreModule.useFlowStore.getState().nodes, nodesBefore);
  assert.deepEqual(settingsStoreModule.useGlobalSettingsStore.getState().settings, settingsBefore);
  assert.equal(dataStoreModule.useDataStore.getState().dbVersion, dataVersionBefore);
  assert.equal(uiStoreModule.useUIStore.getState().isSavesOverlayOpen, true);
  assert.deepEqual(await idb.getDataOverrides(), [priorOverride]);
  assert.equal(store.getState().status.type, 'error');
  assert.match(store.getState().status.message, /overrides could not be saved/i);
  store.getState().clearStatus();
}

test('an override-write failure prevents overwrite-load from applying canvas or settings', async () => {
  await failedRestorePreservesProject('handleOverwriteLoad');
});

test('an override-write failure prevents merge-load from applying canvas or settings', async () => {
  await failedRestorePreservesProject('handleMergeLoad');
});

for (const [action, title] of [
  ['handleOverwriteLoad', 'LOAD FAILED'],
  ['handleMergeLoad', 'MERGE FAILED'],
]) {
  test(`${action} visibly reports an unsupported save version without changing the project`, async () => {
    const record = saveRecord('future-save', 'future-node');
    record.data.version = 999;
    const store = makeStore();
    const existingNodes = [recipeNode('existing-node')];
    flowStoreModule.useFlowStore.getState().setNodesAndEdges(existingNodes, []);
    settingsStoreModule.useGlobalSettingsStore.setState({
      settings: { ...defaults, global_pollution: 73 },
    });
    uiStoreModule.useUIStore.getState().setSavesOverlayOpen(true);
    let shownConfirmation;
    uiStoreModule.useUIStore.setState({
      confirm: async (options) => {
        shownConfirmation = options;
        return false;
      },
    });

    await store.getState()[action](record);

    assert.equal(shownConfirmation.title, title);
    assert.match(shownConfirmation.message, /newer than this app supports \(version 4\)/);
    assert.deepEqual(
      flowStoreModule.useFlowStore.getState().nodes.map((node) => node.id),
      ['existing-node'],
    );
    assert.equal(
      settingsStoreModule.useGlobalSettingsStore.getState().settings.global_pollution,
      73,
    );
    assert.equal(uiStoreModule.useUIStore.getState().isSavesOverlayOpen, true);
    assert.equal(store.getState().status.type, 'error');
  });
}

for (const [version, explanation] of [
  [999, /newer than this app supports \(version 4\)/],
  [0, /no explicit migration exists/],
  [-1, /no explicit migration exists/],
]) {
  test(`save version ${version} is rejected before the imported record is stored`, async () => {
    const record = saveRecord('unsupported-save', 'unsupported-node');
    record.data.version = version;
    const store = makeStore();
    let shownConfirmation;
    uiStoreModule.useUIStore.setState({
      confirm: async (options) => {
        shownConfirmation = options;
        return false;
      },
    });

    const input = await importSaveText(store, JSON.stringify(record));

    assert.deepEqual(await idb.getSaves(), []);
    assert.equal(input.value, '');
    assert.equal(shownConfirmation.title, 'IMPORT FAILED');
    assert.match(shownConfirmation.message, /not imported/i);
    assert.match(shownConfirmation.message, explanation);
    assert.equal(store.getState().status.type, 'error');
  });
}

test('supported historical saves pass import validation', async () => {
  const record = saveRecord('legacy-save', 'legacy-node');
  record.data.version = 2;
  delete record.data.globalSettings.current_month;
  delete record.data.nodes[0].machineCountConstraint;
  const store = makeStore();

  await importSaveText(store, JSON.stringify(record));

  const [imported] = await idb.getSaves();
  assert.ok(imported);
  assert.equal(imported.data.version, 2);
  assert.deepEqual(
    transformer.deserializeCanvas(imported.data).nodes.map((node) => node.id),
    ['legacy-node'],
  );
});

test('import rejects an unsupported game mode before storing the save', async () => {
  const record = saveRecord('invalid-mode-save', 'invalid-mode-node');
  record.data.globalSettings = {
    ...record.data.globalSettings,
    difficulty: 'Sandbox',
    unlockedResearchIds: [],
  };
  const store = makeStore();
  let shownConfirmation;
  uiStoreModule.useUIStore.setState({
    confirm: async (options) => {
      shownConfirmation = options;
      return false;
    },
  });

  await importSaveText(store, JSON.stringify(record));

  assert.deepEqual(await idb.getSaves(), []);
  assert.equal(shownConfirmation.title, 'IMPORT FAILED');
  assert.match(
    shownConfirmation.message,
    /globalSettings\.difficulty must be a supported game mode/,
  );
});

test('import rejects unknown and prerequisite-inconsistent progression research IDs', async () => {
  const researchWithPrerequisite = lookup
    .getAllResearches()
    .find((research) => research.prerequisites.length > 0);
  assert.ok(researchWithPrerequisite);
  const invalidUnlockLists = [
    { difficulty: 'normal', unlockedResearchIds: ['edited-research-id'] },
    { difficulty: 'normal', unlockedResearchIds: [researchWithPrerequisite.id] },
    { difficulty: 'hard', unlockedResearchIds: ['s_energy_hand_crank'] },
    {
      difficulty: 'impossible',
      unlockedResearchIds: ['s_production_advanced_copper_extraction'],
    },
  ];

  for (const [index, invalidSettings] of invalidUnlockLists.entries()) {
    const record = saveRecord(`invalid-research-save-${index}`, `invalid-research-node-${index}`);
    record.data.globalSettings = {
      ...record.data.globalSettings,
      ...invalidSettings,
    };
    const store = makeStore();
    let shownConfirmation;
    uiStoreModule.useUIStore.setState({
      confirm: async (options) => {
        shownConfirmation = options;
        return false;
      },
    });

    await importSaveText(store, JSON.stringify(record));

    assert.deepEqual(await idb.getSaves(), []);
    assert.equal(shownConfirmation.title, 'IMPORT FAILED');
    assert.match(shownConfirmation.message, /unlockedResearchIds/);
  }
});

test('named save creation and restore retain custom overrides, graph, and settings', async () => {
  const override = productOverride(3);
  assert.equal(await idb.saveDataOverride(override.id, override.data), true);
  settingsStoreModule.useGlobalSettingsStore.setState({
    settings: { ...defaults, global_pollution: 29 },
  });
  flowStoreModule.useFlowStore.getState().setNodesAndEdges([recipeNode('saved-node')], []);

  const store = makeStore();
  store.getState().setNewSaveName('Successful round trip');
  await store.getState().handleCreateSave('button');

  const [record] = await idb.getSaves();
  assert.ok(record);
  assert.deepEqual(record.data.dataOverrides, [override]);
  assert.equal(store.getState().status.type, 'success');
  store.getState().clearStatus();

  flowStoreModule.useFlowStore.getState().setNodesAndEdges([recipeNode('old-node')], []);
  settingsStoreModule.useGlobalSettingsStore.setState({
    settings: { ...defaults, global_pollution: 7 },
  });
  const dbVersionBefore = dataStoreModule.useDataStore.getState().dbVersion;
  setConfirm('confirm');
  await store.getState().handleOverwriteLoad(record);

  assert.deepEqual(
    flowStoreModule.useFlowStore.getState().nodes.map((node) => node.id),
    ['saved-node'],
  );
  assert.equal(settingsStoreModule.useGlobalSettingsStore.getState().settings.global_pollution, 29);
  assert.deepEqual(await idb.getDataOverrides(), [override]);
  assert.equal(dataStoreModule.useDataStore.getState().dbVersion, dbVersionBefore + 1);
  assert.equal(uiStoreModule.useUIStore.getState().isSavesOverlayOpen, false);
});
