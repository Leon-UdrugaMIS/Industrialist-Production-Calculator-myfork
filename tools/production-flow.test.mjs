import assert from 'node:assert/strict';
import { after, test } from 'node:test';
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
const solverPipeline = await viteServer.ssrLoadModule('/src/solver/solverPipeline.ts');
const flowSolver = await viteServer.ssrLoadModule('/src/solver/flowSolver.ts');
const idGenerator = await viteServer.ssrLoadModule('/src/utils/idGenerator.ts');
const precision = await viteServer.ssrLoadModule('/src/utils/precision.ts');
const registry = await viteServer.ssrLoadModule('/src/data/registry.ts');

after(async () => {
  registry.setSpecialRecipeOverrides({}, []);
  flowSolver.clearFlowCache();
  await viteServer.close();
});

function recipeNode(id, recipeId, settings = {}, machineCount = 1) {
  return {
    id,
    type: 'recipe',
    position: { x: 0, y: 0 },
    data: { recipeId, machineCount, settings },
  };
}

function itemSpawner(id, quantity, productId = 'p_oak_log') {
  return recipeNode(id, 'r_item_spawner_01', { product_id: productId, quantity });
}

function fluidSpawner(id, quantity, productId = 'p_water') {
  return recipeNode(id, 'r_fluid_spawner_01', {
    product_id: productId,
    quantity,
    temperature: 18,
  });
}

function paperMill(id) {
  return recipeNode(id, 'r_paper_mill_01');
}

function edge(id, source, target, targetInputIndex = 0, sourceOutputIndex = 0) {
  return {
    id,
    source,
    sourceHandle: idGenerator.buildHandleId(source, 'output', sourceOutputIndex),
    target,
    targetHandle: idGenerator.buildHandleId(target, 'input', targetInputIndex),
  };
}

function solve(nodes, edges) {
  flowSolver.clearFlowCache();
  return solverPipeline.solveFlowPipeline(nodes, edges, {});
}

function assertRatesEquivalent(actual, expected, context) {
  assert.ok(
    precision.areRatesEquivalent(actual, expected),
    `${context}: expected ${expected}, received ${actual}`,
  );
}

function assertFeasibleAllocations(nodes, edges, snapshot) {
  const outgoingByHandle = new Map();
  const incomingByHandle = new Map();
  let totalOutputFlow = 0;
  let totalInputFlow = 0;

  for (const connection of edges) {
    const flow = snapshot.edgeFlows[connection.id];
    assert.equal(Number.isFinite(flow), true, `edge ${connection.id} must have a finite flow`);
    assert.ok(flow >= 0, `edge ${connection.id} must not carry reverse flow`);

    const sourceHandle = connection.sourceHandle;
    const targetHandle = connection.targetHandle;
    const sourceNode = snapshot.results.get(connection.source);
    const targetNode = snapshot.results.get(connection.target);
    const sourceIndex = idGenerator.parseHandleId(sourceHandle).index;
    const targetIndex = idGenerator.parseHandleId(targetHandle).index;
    const sourcePort = sourceNode.outputFlows[sourceIndex];
    const targetPort = targetNode.inputFlows[targetIndex];

    assert.ok(
      flow <= sourcePort.rate || precision.areRatesEquivalent(flow, sourcePort.rate),
      `edge ${connection.id} exceeds source capacity ${sourcePort.rate}`,
    );
    assert.ok(
      flow <= targetPort.rate || precision.areRatesEquivalent(flow, targetPort.rate),
      `edge ${connection.id} exceeds target capacity ${targetPort.rate}`,
    );

    outgoingByHandle.set(sourceHandle, (outgoingByHandle.get(sourceHandle) ?? 0) + flow);
    incomingByHandle.set(targetHandle, (incomingByHandle.get(targetHandle) ?? 0) + flow);
  }

  for (const node of nodes) {
    const result = snapshot.results.get(node.id);
    assert.ok(result, `missing flow result for node ${node.id}`);

    result.outputFlows.forEach((port, index) => {
      totalOutputFlow += port.connected;
      const handle = idGenerator.buildHandleId(node.id, 'output', index);
      assertRatesEquivalent(
        port.connected,
        outgoingByHandle.get(handle) ?? 0,
        `${node.id} output ${index} connected flow`,
      );
      assert.ok(
        port.connected <= port.rate || precision.areRatesEquivalent(port.connected, port.rate),
        `${node.id} output ${index} exceeds production capacity`,
      );
    });

    result.inputFlows.forEach((port, index) => {
      totalInputFlow += port.connected;
      const handle = idGenerator.buildHandleId(node.id, 'input', index);
      assertRatesEquivalent(
        port.connected,
        incomingByHandle.get(handle) ?? 0,
        `${node.id} input ${index} connected flow`,
      );
      assert.ok(
        port.connected <= port.rate || precision.areRatesEquivalent(port.connected, port.rate),
        `${node.id} input ${index} exceeds demand capacity`,
      );
    });
  }

  assertRatesEquivalent(totalOutputFlow, totalInputFlow, 'allocated flow conservation');
}

function sumEdgeFlows(snapshot, edges) {
  return edges.reduce((sum, connection) => sum + snapshot.edgeFlows[connection.id], 0);
}

test('a built-in paper recipe receives its full input from the dynamic special-recipe source', () => {
  const nodes = [itemSpawner('logs', 1), paperMill('paper')];
  const edges = [edge('logs-to-paper', 'logs', 'paper')];
  const snapshot = solve(nodes, edges);

  assertFeasibleAllocations(nodes, edges, snapshot);
  const producer = snapshot.results.get('logs').outputFlows[0];
  const paper = snapshot.results.get('paper');

  assertRatesEquivalent(producer.rate, 1, 'spawner production');
  assertRatesEquivalent(producer.connected, 1, 'spawner routed production');
  assertRatesEquivalent(paper.inputFlows[0].rate, 1, 'paper-mill input demand');
  assertRatesEquivalent(paper.inputFlows[0].connected, 1, 'paper-mill input allocation');
  assertRatesEquivalent(paper.inputFlows[0].deficit, 0, 'paper-mill input deficit');
  assert.equal(paper.inputFlows[0].hasDeficiency, false);
  assertRatesEquivalent(paper.outputFlows[0].rate, 2, 'paper production rate');
  assertRatesEquivalent(paper.outputFlows[0].excess, 2, 'unrouted paper excess');
});

test('multiple producers supply one shared consumer up to its demand', () => {
  const nodes = [
    itemSpawner('small-source', 0.4),
    itemSpawner('large-source', 0.6),
    paperMill('paper'),
  ];
  const edges = [
    edge('small-to-paper', 'small-source', 'paper'),
    edge('large-to-paper', 'large-source', 'paper'),
  ];
  const snapshot = solve(nodes, edges);

  assertFeasibleAllocations(nodes, edges, snapshot);
  assertRatesEquivalent(snapshot.results.get('paper').inputFlows[0].connected, 1, 'shared demand');
  assertRatesEquivalent(
    snapshot.results.get('small-source').outputFlows[0].connected,
    0.4,
    'small source allocation',
  );
  assertRatesEquivalent(
    snapshot.results.get('large-source').outputFlows[0].connected,
    0.6,
    'large source allocation',
  );
  assertRatesEquivalent(sumEdgeFlows(snapshot, edges), 1, 'total shared flow');
});

test('multiple consumers share a source without exceeding source or consumer capacities', () => {
  const nodes = [itemSpawner('shared-source', 1.5), paperMill('paper-a'), paperMill('paper-b')];
  const edges = [
    edge('shared-to-a', 'shared-source', 'paper-a'),
    edge('shared-to-b', 'shared-source', 'paper-b'),
  ];
  const snapshot = solve(nodes, edges);
  const reorderedEdges = [...edges].reverse();
  const reordered = solve([...nodes].reverse(), reorderedEdges);

  assertFeasibleAllocations(nodes, edges, snapshot);
  assertFeasibleAllocations([...nodes].reverse(), reorderedEdges, reordered);

  for (const [allocation, connections, order] of [
    [snapshot, edges, 'forward'],
    [reordered, reorderedEdges, 'reversed'],
  ]) {
    assertRatesEquivalent(
      sumEdgeFlows(allocation, connections),
      1.5,
      `${order} source-limited total flow`,
    );
    assertRatesEquivalent(
      allocation.results.get('shared-source').outputFlows[0].connected,
      1.5,
      `${order} source allocation`,
    );
    const deficits = ['paper-a', 'paper-b'].map(
      (id) => allocation.results.get(id).inputFlows[0].deficit,
    );
    assertRatesEquivalent(deficits[0] + deficits[1], 0.5, `${order} combined consumer deficit`);
  }
});

test('equivalent connection and node orders preserve maximum flow through a constrained network', () => {
  const flexible = itemSpawner('flexible-source', 1);
  const constrained = itemSpawner('constrained-source', 1);
  const firstConsumer = paperMill('first-consumer');
  const secondConsumer = paperMill('second-consumer');
  const nodes = [flexible, constrained, firstConsumer, secondConsumer];
  const edges = [
    edge('flexible-to-first', 'flexible-source', 'first-consumer'),
    edge('flexible-to-second', 'flexible-source', 'second-consumer'),
    edge('constrained-to-first', 'constrained-source', 'first-consumer'),
  ];

  const forward = solve(nodes, edges);
  const reorderedEdges = [edges[2], edges[1], edges[0]];
  const reversed = solve([...nodes].reverse(), reorderedEdges);

  assertFeasibleAllocations(nodes, edges, forward);
  assertFeasibleAllocations([...nodes].reverse(), reorderedEdges, reversed);
  assertRatesEquivalent(sumEdgeFlows(forward, edges), 2, 'forward-order maximum flow');
  assertRatesEquivalent(sumEdgeFlows(reversed, reorderedEdges), 2, 'reordered maximum flow');
  assertRatesEquivalent(
    sumEdgeFlows(forward, edges),
    sumEdgeFlows(reversed, reorderedEdges),
    'maximum flow across insertion orders',
  );
  for (const snapshot of [forward, reversed]) {
    assertRatesEquivalent(
      snapshot.results.get('first-consumer').inputFlows[0].connected,
      1,
      'first constrained consumer satisfaction',
    );
    assertRatesEquivalent(
      snapshot.results.get('second-consumer').inputFlows[0].connected,
      1,
      'second constrained consumer satisfaction',
    );
  }
});

test('disconnected consumers remain deficient and zero-capacity sources carry no flow', () => {
  const disconnectedNodes = [
    itemSpawner('limited-source', 0.5),
    paperMill('reachable'),
    paperMill('unreachable'),
  ];
  const connectedEdges = [edge('limited-to-reachable', 'limited-source', 'reachable')];
  const disconnected = solve(disconnectedNodes, connectedEdges);

  assertFeasibleAllocations(disconnectedNodes, connectedEdges, disconnected);
  assertRatesEquivalent(
    disconnected.results.get('reachable').inputFlows[0].connected,
    0.5,
    'reachable allocation',
  );
  assertRatesEquivalent(
    disconnected.results.get('reachable').inputFlows[0].deficit,
    0.5,
    'reachable deficit',
  );
  assertRatesEquivalent(
    disconnected.results.get('unreachable').inputFlows[0].connected,
    0,
    'unreachable allocation',
  );
  assertRatesEquivalent(
    disconnected.results.get('unreachable').inputFlows[0].deficit,
    1,
    'unreachable deficit',
  );
  assert.equal(disconnected.results.get('unreachable').inputFlows[0].hasDeficiency, true);

  const zeroNodes = [itemSpawner('zero-source', 0), paperMill('zero-target')];
  const zeroEdges = [edge('zero-to-target', 'zero-source', 'zero-target')];
  const zero = solve(zeroNodes, zeroEdges);

  assertFeasibleAllocations(zeroNodes, zeroEdges, zero);
  assertRatesEquivalent(zero.edgeFlows['zero-to-target'], 0, 'flow from zero-capacity source');
  assertRatesEquivalent(
    zero.results.get('zero-source').outputFlows[0].rate,
    0,
    'zero source capacity',
  );
  assertRatesEquivalent(
    zero.results.get('zero-target').inputFlows[0].deficit,
    1,
    'zero-source target deficit',
  );
});

test('cyclic port connections terminate and preserve total capacity and demand deficits', () => {
  const nodes = [
    recipeNode('water-a', 'r_liquid_boiler_02'),
    recipeNode('water-b', 'r_liquid_boiler_02'),
    recipeNode('water-demand', 'r_liquid_boiler_02'),
  ];
  const edges = [
    edge('water-a-to-b', 'water-a', 'water-b'),
    edge('water-b-to-a', 'water-b', 'water-a'),
    edge('water-a-to-demand', 'water-a', 'water-demand'),
  ];
  const snapshot = solve(nodes, edges);

  assertFeasibleAllocations(nodes, edges, snapshot);
  assertRatesEquivalent(sumEdgeFlows(snapshot, edges), 1.2, 'cyclic network maximum flow');
  assertRatesEquivalent(snapshot.edgeFlows['water-a-to-b'], 0.6, 'first cycle connection');
  assertRatesEquivalent(snapshot.edgeFlows['water-b-to-a'], 0.6, 'return cycle connection');

  const inputDemand = nodes.reduce(
    (sum, node) => sum + snapshot.results.get(node.id).inputFlows[0].rate,
    0,
  );
  const connectedDemand = nodes.reduce(
    (sum, node) => sum + snapshot.results.get(node.id).inputFlows[0].connected,
    0,
  );
  const totalDeficit = nodes.reduce(
    (sum, node) => sum + snapshot.results.get(node.id).inputFlows[0].deficit,
    0,
  );
  assertRatesEquivalent(inputDemand, 1.8, 'cyclic network input demand');
  assertRatesEquivalent(connectedDemand, 1.2, 'cyclic network connected demand');
  assertRatesEquivalent(totalDeficit, 0.6, 'cyclic network unmet demand');
});

test('independent product networks allocate independently in one production graph', () => {
  const nodes = [
    itemSpawner('log-source', 1),
    paperMill('paper'),
    recipeNode('water-pump', 'r_water_pump_01', {}, 2),
    recipeNode('brine-extractor', 'r_lithium_brine_extractor_01'),
  ];
  const edges = [
    edge('logs-to-paper', 'log-source', 'paper'),
    edge('water-to-extractor', 'water-pump', 'brine-extractor'),
  ];
  const snapshot = solve(nodes, edges);

  assertFeasibleAllocations(nodes, edges, snapshot);
  assertRatesEquivalent(snapshot.edgeFlows['logs-to-paper'], 1, 'item-product flow');
  assertRatesEquivalent(snapshot.edgeFlows['water-to-extractor'], 2.5, 'fluid-product flow');
  assertRatesEquivalent(
    snapshot.results.get('water-pump').outputFlows[0].rate,
    2.7,
    'water-pump production',
  );
  assertRatesEquivalent(
    snapshot.results.get('water-pump').outputFlows[0].excess,
    0.2,
    'water-pump excess',
  );
  assertRatesEquivalent(
    snapshot.results.get('brine-extractor').inputFlows[0].deficit,
    0,
    'extractor water deficit',
  );
});

test('the flow-dependent waste facility derives auxiliary input rates from its connected ports', () => {
  const nodes = [
    itemSpawner('waste-items', 20),
    fluidSpawner('waste-fluid', 30),
    recipeNode('waste-facility', 'r_underground_waste_facility_01'),
  ];
  const edges = [
    edge('items-to-facility', 'waste-items', 'waste-facility', 0),
    edge('fluid-to-facility', 'waste-fluid', 'waste-facility', 1),
  ];
  const snapshot = solve(nodes, edges);
  const facilityFlow = snapshot.results.get('waste-facility');
  const resolvedRecipe = snapshot.nodeRecipes['waste-facility'];

  assertFeasibleAllocations(nodes, edges, snapshot);
  assert.ok(resolvedRecipe);
  assert.equal(resolvedRecipe.inputs[0].product_id, 'p_oak_log');
  assert.equal(resolvedRecipe.inputs[1].product_id, 'p_water');

  for (const derivedIndex of [2, 3]) {
    const derivedInput = resolvedRecipe.inputs[derivedIndex];
    const expectedRate = derivedInput.flowDependencies.reduce(
      (sum, dependency) =>
        sum +
        facilityFlow.inputFlows[dependency.sourceInputIndex].connected * dependency.coefficient,
      0,
    );
    assertRatesEquivalent(
      derivedInput.quantity,
      expectedRate,
      `flow-dependent input ${derivedIndex}`,
    );
    assertRatesEquivalent(
      facilityFlow.inputFlows[derivedIndex].rate,
      expectedRate,
      `solver rate for dependent input ${derivedIndex}`,
    );
  }
});

test('the variable-input item dump pollution matches its 13/600 rate over 45 units per second', () => {
  const nodes = [
    itemSpawner('first-waste-source', 25),
    itemSpawner('second-waste-source', 20),
    recipeNode('item-dump', 'r_item_dump_01'),
  ];
  const edges = [
    edge('first-to-dump', 'first-waste-source', 'item-dump', 0),
    edge('second-to-dump', 'second-waste-source', 'item-dump', 1),
  ];
  const snapshot = solve(nodes, edges);
  const dumpFlow = snapshot.results.get('item-dump');
  const dumpRecipe = snapshot.nodeRecipes['item-dump'];

  assertFeasibleAllocations(nodes, edges, snapshot);
  assert.ok(dumpRecipe);
  assertRatesEquivalent(dumpFlow.inputFlows[0].rate, 30, 'first variable dump capacity');
  assertRatesEquivalent(dumpFlow.inputFlows[0].connected, 25, 'first variable dump allocation');
  assertRatesEquivalent(dumpFlow.inputFlows[1].rate, 30, 'second variable dump capacity');
  assertRatesEquivalent(dumpFlow.inputFlows[1].connected, 20, 'second variable dump allocation');
  const expectedPollution = (25 + 20) * (13 / 600);
  assertRatesEquivalent(
    dumpRecipe.pollution,
    expectedPollution,
    'dump pollution from the configured 13/600 per-flow rate and fixture flows',
  );
});

test('precision utilities preserve their zero, rate, deficit, excess, and machine-count boundaries', () => {
  const numericalZero = precision.RATE_NUMERICAL_ZERO;
  assert.equal(precision.normalizeSolverRate(numericalZero * 0.99), 0);
  assert.equal(precision.normalizeSolverRate(numericalZero), 0);
  assert.ok(precision.normalizeSolverRate(numericalZero * 1.01) > 0);
  assert.equal(precision.isPositiveSolverFlow(numericalZero), false);
  assert.equal(precision.isPositiveSolverFlow(numericalZero * 1.01), true);

  const absoluteRateTolerance = precision.RATE_ABSOLUTE_TOLERANCE;
  assert.equal(precision.areRatesEquivalent(0, absoluteRateTolerance * 0.99), true);
  assert.equal(precision.areRatesEquivalent(0, absoluteRateTolerance), true);
  assert.equal(precision.areRatesEquivalent(0, absoluteRateTolerance * 1.01), false);

  const rateTolerance = precision.getRateTolerance(100, 100);
  assert.equal(precision.getMeaningfulRateDelta(rateTolerance * 0.99, 100, 100), 0);
  assert.equal(precision.getMeaningfulRateDelta(rateTolerance, 100, 100), 0);
  assert.ok(precision.getMeaningfulRateDelta(rateTolerance * 1.01, 100, 100) > 0);
  assertRatesEquivalent(precision.getRateDeficit(10, 7.5), 2.5, 'rate deficit');
  assertRatesEquivalent(precision.getRateExcess(10, 7.5), 2.5, 'rate excess');
  assert.equal(precision.getRateDeficit(0, 0), 0);
  assert.equal(precision.getRateExcess(0, 0), 0);

  const statusTolerance = precision.getScaledTolerance(1000, 1000);
  assert.equal(precision.hasMeaningfulDeficit(1000, 1000 - statusTolerance * 0.99), false);
  assert.equal(precision.hasMeaningfulDeficit(1000, 1000 - statusTolerance), false);
  assert.equal(precision.hasMeaningfulDeficit(1000, 1000 - statusTolerance * 1.01), true);
  const excessScale = 0.001;
  const excessTolerance = precision.getRateTolerance(excessScale, excessScale);
  assert.equal(
    precision.hasMeaningfulExcess(excessScale, excessScale - excessTolerance * 0.99),
    false,
  );
  assert.equal(precision.hasMeaningfulExcess(excessScale, excessScale - excessTolerance), false);
  assert.equal(
    precision.hasMeaningfulExcess(excessScale, excessScale - excessTolerance * 1.01),
    true,
  );

  const integerTolerance = precision.getMachineIntegerTolerance(1);
  assert.equal(precision.isMachineCountNearInteger(1 + integerTolerance * 0.5), true);
  assert.equal(precision.isMachineCountNearInteger(1 + integerTolerance), true);
  assert.equal(precision.isMachineCountNearInteger(1 + integerTolerance * 2), false);
  assert.equal(precision.ceilMachineCount(1 + integerTolerance), 1);
  assert.equal(precision.ceilMachineCount(1 + integerTolerance * 2), 2);

  const comparisonTolerance = precision.getMachineCountComparisonTolerance(0, 0);
  assert.equal(precision.hasMeaningfulMachineCountDifference(0, comparisonTolerance * 0.99), false);
  assert.equal(precision.hasMeaningfulMachineCountDifference(0, comparisonTolerance), false);
  assert.equal(precision.hasMeaningfulMachineCountDifference(0, comparisonTolerance * 1.01), true);
});
