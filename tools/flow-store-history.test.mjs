import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
});
const lookup = await viteServer.ssrLoadModule('/src/data/lookup.ts');
await lookup.initializeDatabase();
const { useFlowStore } = await viteServer.ssrLoadModule('/src/stores/useFlowStore.ts');
const idGenerator = await viteServer.ssrLoadModule('/src/utils/idGenerator.ts');

after(async () => {
  await viteServer.close();
});

beforeEach(() => {
  useFlowStore.getState().setNodesAndEdges([], [], {
    recordHistory: false,
    resetHistory: true,
  });
});

function groupNode(collapsed = false) {
  return {
    id: 'group-1',
    type: 'group',
    position: { x: 0, y: 0 },
    data: {
      label: 'Group',
      collapsed,
      handlesReady: false,
      inputProxyHandleIds: [],
      outputProxyHandleIds: [],
    },
  };
}

function recipeNode(id, recipeId, groupId, x) {
  return {
    id,
    type: 'recipe',
    position: { x, y: 40 },
    data: { recipeId, machineCount: 1, settings: {}, ...(groupId ? { groupId } : {}) },
  };
}

function edge(id, source, target, data = {}) {
  return {
    id,
    source,
    sourceHandle: idGenerator.buildHandleId(source, 'output', 0),
    target,
    targetHandle: idGenerator.buildHandleId(target, 'input', 0),
    data,
  };
}

function graph({ collapsed = false } = {}) {
  const nodes = [
    groupNode(collapsed),
    recipeNode('source', 'r_item_spawner_01', 'group-1', 40),
    recipeNode('internal-target', 'r_paper_mill_01', 'group-1', 280),
    recipeNode('outside-target', 'r_paper_mill_01', undefined, 620),
  ];
  const routes = {
    controlPoints: [{ x: 100, y: 120 }],
    orthogonalTurns: [{ x: 140, y: 180 }],
    routeLabel: 'preserve this metadata',
    custom: { owner: 'user' },
  };
  const edges = [
    edge('internal-edge', 'source', 'internal-target', structuredClone(routes)),
    edge('boundary-edge', 'source', 'outside-target', structuredClone(routes)),
    edge('self-loop', 'source', 'source', structuredClone(routes)),
  ];
  useFlowStore.getState().setNodesAndEdges(nodes, edges, {
    recordHistory: false,
    resetHistory: true,
  });
}

function positionsFor(ids) {
  const nodesById = useFlowStore.getState().nodesMap;
  return new Map(
    ids.map((id) => {
      const node = nodesById.get(id);
      assert.ok(node, `expected node ${id}`);
      return [id, { x: node.position.x, y: node.position.y }];
    }),
  );
}

function edgeById(id) {
  const edge = useFlowStore.getState().edges.find((candidate) => candidate.id === id);
  assert.ok(edge, `expected edge ${id}`);
  return edge;
}

function routeData(id) {
  return edgeById(id).data;
}

function assertTranslatedRoutes(id, dx, dy) {
  const route = routeData(id);
  assert.deepEqual(route.controlPoints, [{ x: 100 + dx, y: 120 + dy }]);
  assert.deepEqual(route.orthogonalTurns, [{ x: 140 + dx, y: 180 + dy }]);
  assert.equal(route.routeLabel, 'preserve this metadata');
  assert.deepEqual(route.custom, { owner: 'user' });
}

test('whole-group movement translates both internal routes and position undo/redo restores them', () => {
  graph();
  const store = useFlowStore.getState();
  const ids = ['group-1', 'source', 'internal-target'];
  const startPositions = positionsFor(ids);
  const graphVersion = store.graphVersion;
  const beforeInternal = structuredClone(routeData('internal-edge'));
  const beforeBoundary = structuredClone(routeData('boundary-edge'));

  store.captureDragStart(ids, 'group-1');
  store.moveNodesFromSnapshots(startPositions, 12, -7, 'group-1');
  store.commitDragStop(ids);

  assertTranslatedRoutes('internal-edge', 12, -7);
  assert.deepEqual(routeData('boundary-edge'), beforeBoundary);
  assertTranslatedRoutes('self-loop', 12, -7);
  assert.equal(useFlowStore.getState().graphVersion, graphVersion);
  assert.equal(useFlowStore.getState().historyPast.length, 1);
  assert.equal(useFlowStore.getState().historyPast[0].kind, 'position');

  useFlowStore.getState().undo();
  assert.deepEqual(routeData('internal-edge'), beforeInternal);
  assert.deepEqual(routeData('boundary-edge'), beforeBoundary);
  assertTranslatedRoutes('self-loop', 0, 0);
  assert.deepEqual(
    ['group-1', 'source', 'internal-target'].map((id) => {
      const node = useFlowStore.getState().nodesMap.get(id);
      return { id, x: node.position.x, y: node.position.y };
    }),
    ids.map((id) => ({ id, ...startPositions.get(id) })),
  );
  assert.equal(useFlowStore.getState().graphVersion, graphVersion);

  useFlowStore.getState().redo();
  assertTranslatedRoutes('internal-edge', 12, -7);
  assert.deepEqual(routeData('boundary-edge'), beforeBoundary);
  assertTranslatedRoutes('self-loop', 12, -7);
  assert.equal(useFlowStore.getState().graphVersion, graphVersion);
});

test('moving one member shifts its self-loop but leaves group-internal routes in place', () => {
  graph();
  const graphVersion = useFlowStore.getState().graphVersion;
  const beforeInternal = structuredClone(routeData('internal-edge'));
  const startPositions = positionsFor(['source']);
  const sourceBefore = startPositions.get('source');

  useFlowStore.getState().captureDragStart(['source']);
  useFlowStore.getState().moveNodesFromSnapshots(startPositions, -8, 16);
  useFlowStore.getState().commitDragStop(['source']);

  assert.deepEqual(routeData('internal-edge'), beforeInternal);
  assertTranslatedRoutes('self-loop', -8, 16);
  assert.deepEqual(useFlowStore.getState().nodesMap.get('source').position, {
    x: sourceBefore.x - 8,
    y: sourceBefore.y + 16,
  });
  assert.deepEqual(
    useFlowStore
      .getState()
      .historyPast.at(-1)
      .edgeRoutes.map(({ id }) => id),
    ['self-loop'],
  );
  assert.equal(useFlowStore.getState().graphVersion, graphVersion);
});

test('collapsed-group movement shifts hidden internal routes and leaves boundary proxies alone', () => {
  graph();
  useFlowStore.getState().collapseGroup('group-1');
  useFlowStore
    .getState()
    .updateGroupNodeData('group-1', { handlesReady: true }, { recordHistory: false });
  useFlowStore.getState().clearHistory();

  const proxy = edgeById('proxy-boundary-edge');
  const proxyBefore = structuredClone(proxy);
  const internalBefore = structuredClone(routeData('internal-edge'));
  const graphVersion = useFlowStore.getState().graphVersion;
  assert.equal(useFlowStore.getState().nodesMap.get('source').hidden, true);
  assert.equal(useFlowStore.getState().nodesMap.get('internal-target').hidden, true);
  assert.equal(
    useFlowStore.getState().edges.some((candidate) => candidate.id === 'proxy-internal-edge'),
    false,
  );

  const ids = ['group-1', 'source', 'internal-target'];
  const startPositions = positionsFor(ids);
  useFlowStore.getState().captureDragStart(ids, 'group-1');
  useFlowStore.getState().moveNodesFromSnapshots(startPositions, 5, 11, 'group-1');
  useFlowStore.getState().commitDragStop(ids);

  assert.deepEqual(routeData('internal-edge').controlPoints, [
    { x: internalBefore.controlPoints[0].x + 5, y: internalBefore.controlPoints[0].y + 11 },
  ]);
  assert.deepEqual(routeData('internal-edge').orthogonalTurns, [
    { x: internalBefore.orthogonalTurns[0].x + 5, y: internalBefore.orthogonalTurns[0].y + 11 },
  ]);
  assert.deepEqual(edgeById('proxy-boundary-edge'), proxyBefore);
  assert.deepEqual(routeData('boundary-edge'), {
    controlPoints: [{ x: 100, y: 120 }],
    orthogonalTurns: [{ x: 140, y: 180 }],
    routeLabel: 'preserve this metadata',
    custom: { owner: 'user' },
  });
  assert.equal(useFlowStore.getState().graphVersion, graphVersion);
});
