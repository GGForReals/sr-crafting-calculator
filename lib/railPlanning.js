export const RAIL_TIERS = [120, 240, 480, 750, 1500];
export const COMPLEX_GRAPH_WORK_LIMIT = 30000;

export const RAIL_BUILDINGS = Object.freeze({
  railConnector: Object.freeze({
    kind: 'junction',
    role: 'standard-join-split',
    source: 'transport-database'
  }),
  roundabout: Object.freeze({
    kind: 'junction',
    railSpeedRule: 'fastest-connected-rail',
    addsRailCapacity: false,
    source: 'official-update-2'
  }),
  modulator3: Object.freeze({
    kind: 'merge-split',
    maxRails: 3,
    source: 'community-rail-guide'
  }),
  modulator5: Object.freeze({
    kind: 'merge-split',
    maxRails: 5,
    source: 'transport-database'
  }),
  multirail3: Object.freeze({
    kind: 'parallel-support',
    maxRails: 3,
    source: 'transport-database'
  }),
  multirail5: Object.freeze({
    kind: 'parallel-support',
    maxRails: 5,
    source: 'transport-database'
  })
});

export function recommendRailModulator(railCount) {
  if (!Number.isInteger(railCount) || railCount < 2) throw new Error('A rail modulator needs at least two rails.');
  if (railCount <= RAIL_BUILDINGS.modulator3.maxRails) return 'modulator3';
  if (railCount <= RAIL_BUILDINGS.modulator5.maxRails) return 'modulator5';
  return null;
}

export function recommendRailModulatorForRailCounts(railCounts) {
  if (!Array.isArray(railCounts) || railCounts.some(count => !Number.isInteger(count) || count < 1)) {
    throw new Error('Junction rail counts must be positive integers.');
  }
  if (new Set(railCounts).size < 2) return null;
  return recommendRailModulator(Math.max(...railCounts));
}

export function estimateComplexGraphCost(nodes, links, rootItem) {
  const groups = new Map(nodes.map(node => [node.id, node.raw ? 1 : Math.max(1, Math.ceil(Number(node.machines) || 1))]));
  const machineNodes = nodes.reduce((total, node) => total + (node.raw ? 0 : groups.get(node.id)), 0);
  const sourceNodes = nodes.filter(node => node.raw).length;
  let supplyLinks = 0;
  for (const link of links) {
    if (!Number.isFinite(link.rate) || link.rate <= 0) continue;
    supplyLinks += (groups.get(link.from) || 0) * (groups.get(link.to) || 0);
  }
  const outputLinks = groups.get(rootItem) || 0;
  const routeLegs = supplyLinks * 5 + outputLinks;
  return {
    machineNodes,
    sourceNodes,
    supplyLinks,
    routeLegs,
    workUnits: machineNodes + sourceNodes + supplyLinks * 6 + outputLinks
  };
}

export function recommendRail(rate, manualCapacity = null, maxAvailableCapacity = null) {
  if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid rail demand.');
  if (manualCapacity !== null && !RAIL_TIERS.includes(manualCapacity)) throw new Error('Invalid rail capacity.');
  if (maxAvailableCapacity !== null && !RAIL_TIERS.includes(maxAvailableCapacity)) throw new Error('Invalid maximum available rail capacity.');
  const capacity = manualCapacity ?? (
    maxAvailableCapacity === null
      ? RAIL_TIERS.find(value => value >= rate) ?? RAIL_TIERS.at(-1)
      : RAIL_TIERS.find(value => value >= rate && value <= maxAvailableCapacity) ?? maxAvailableCapacity
  );
  return { capacity, tier: RAIL_TIERS.indexOf(capacity) + 1, count: Math.max(1, Math.ceil(rate / capacity)) };
}

export function groupRailLabelRuns(segments, recommendations) {
  const lanes = new Map();
  segments.forEach((segment, index) => {
    if (segment.finalOutput) return;
    const horizontal = segment.y1 === segment.y2;
    const fixed = horizontal ? segment.y1 : segment.x1;
    const label = `${recommendations[index].count > 1 ? `${recommendations[index].count} x ` : ''}v${recommendations[index].tier}`;
    const flowSignature = Object.keys(segment.flows || {}).sort().join('|');
    const laneKey = `${horizontal ? 'h' : 'v'}:${fixed}:${label}:${segment.bypass}:${flowSignature}:${horizontal ? '' : index}`;
    if (!lanes.has(laneKey)) lanes.set(laneKey, { horizontal, fixed, label, bypass: segment.bypass, segments: [] });
    lanes.get(laneKey).segments.push({ index, start: horizontal ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2), end: horizontal ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2) });
  });

  const runs = [];
  for (const lane of lanes.values()) {
    lane.segments.sort((first, second) => first.start - second.start);
    let run = null;
    for (const part of lane.segments) {
      if (!run || part.start > run.end) {
        if (run) runs.push({ ...lane, ...run });
        run = { start: part.start, end: part.end, segmentIndexes: [part.index] };
      } else {
        run.end = Math.max(run.end, part.end);
        run.segmentIndexes.push(part.index);
      }
    }
    if (run) runs.push({ ...lane, ...run });
  }
  return runs;
}

export function recommendMachineInputPorts(inputRates, machineCount, manualCapacity = null, maxAvailableCapacity = null) {
  if (!Number.isFinite(machineCount) || machineCount <= 0) throw new Error('Invalid machine count.');
  const flows = Object.fromEntries(Object.entries(inputRates || {}).sort(([first], [second]) => first.localeCompare(second, undefined, { sensitivity: 'base' })));
  const totalRate = Object.values(flows).reduce((sum, rate) => sum + rate, 0);
  const ratePerMachine = totalRate / machineCount;
  const recommendation = recommendRail(ratePerMachine, manualCapacity, maxAvailableCapacity);
  return {
    kind: 'machine-input-ports',
    flows,
    totalRate,
    machineCount,
    ratePerMachine,
    inputNodesPerMachine: recommendation.count,
    totalInputNodes: recommendation.count * machineCount,
    ...recommendation
  };
}

export function expandMachineGraph(nodes, links, rootItem, manualCapacity = null, maxAvailableCapacity = null) {
  const machineGroups = new Map();
  const expandedNodes = [];

  for (const node of nodes) {
    const productId = node.productId || node.id;
    if (node.raw) {
      const source = { ...node, productId };
      expandedNodes.push(source);
      machineGroups.set(productId, [source]);
      continue;
    }

    const machineCount = Math.max(1, Math.ceil(Number(node.machines) || 1));
    const machineInputs = Object.fromEntries(Object.entries(node.inputs || {}).map(([item, rate]) => [item, rate / machineCount]));
    const machines = Array.from({ length: machineCount }, (_, index) => {
      const id = `${node.id}::${index + 1}`;
      const machine = {
        ...node,
        id,
        productId,
        label: machineCount === 1 ? (node.label || productId) : `${node.label || productId} #${index + 1}`,
        machineIndex: index + 1,
        machineTotal: machineCount,
        machines: 1,
        rate: (Number(node.rate) || 0) / machineCount,
        inputs: { ...machineInputs },
        inputPorts: recommendMachineInputPorts(machineInputs, 1, manualCapacity, maxAvailableCapacity)
      };
      expandedNodes.push(machine);
      return machine;
    });
    machineGroups.set(productId, machines);
  }

  const expandedLinks = [];
  for (const link of links) {
    const producers = machineGroups.get(link.to) || [];
    const consumers = machineGroups.get(link.from) || [];
    if (!producers.length || !consumers.length || !Number.isFinite(link.rate) || link.rate <= 0) continue;
    const sharedRate = link.rate / (producers.length * consumers.length);
    for (const consumer of consumers) {
      for (const producer of producers) {
        expandedLinks.push({ from: consumer.id, to: producer.id, rate: sharedRate, item: link.to });
      }
    }
  }

  return { nodes: expandedNodes, links: expandedLinks, rootItem };
}

export function buildRailSegments(nodes, links, rootItem) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const legs = [];
  const addRoute = (points, rate, item, consumer) => {
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      if (start[0] === end[0] && start[1] === end[1]) continue;
      legs.push({ start, end, rate, item, consumer });
    }
  };
  for (const link of links) {
    const producer = byId.get(link.to);
    const consumer = byId.get(link.from);
    if (!producer || !consumer || !Number.isFinite(link.rate) || link.rate <= 0) continue;
    const outputX = producer.x + 40;
    const inputX = consumer.x - 40;
    const routeY = consumer.depth - producer.depth > 1 ? -20 : 100;
    const inputPortY = consumer.y;
    const inputPortX = consumer.x - 22;
    addRoute([[producer.x + 22, producer.y], [outputX, producer.y], [outputX, routeY], [inputX, routeY], [inputX, inputPortY], [inputPortX, inputPortY]], link.rate, link.item || producer.productId || producer.id, consumer.id);
  }
  for (const root of nodes.filter(node => (node.productId || node.id) === rootItem)) {
    if (root.rate > 0) addRoute([[root.x + 22, root.y], [root.x + 62, root.y]], root.rate, root.productId || root.id, 'Final output');
  }

  const lanes = new Map();
  for (const leg of legs) {
    const horizontal = leg.start[1] === leg.end[1];
    const fixed = horizontal ? leg.start[1] : leg.start[0];
    const key = `${horizontal ? 'h' : 'v'}:${fixed}`;
    if (!lanes.has(key)) lanes.set(key, { horizontal, fixed, legs: [] });
    lanes.get(key).legs.push(leg);
  }
  const segments = [];
  for (const lane of lanes.values()) {
    const axis = lane.horizontal ? 0 : 1;
    const boundaries = [...new Set(lane.legs.flatMap(leg => [leg.start[axis], leg.end[axis]]))].sort((first, second) => first - second);
    for (let index = 1; index < boundaries.length; index++) {
      const start = boundaries[index - 1];
      const end = boundaries[index];
      const traffic = lane.legs.filter(leg => Math.min(leg.start[axis], leg.end[axis]) <= start && Math.max(leg.start[axis], leg.end[axis]) >= end);
      if (!traffic.length) continue;
      const flows = new Map();
      for (const leg of traffic) flows.set(leg.item, (flows.get(leg.item) || 0) + leg.rate);
      segments.push({
        x1: lane.horizontal ? start : lane.fixed,
        y1: lane.horizontal ? lane.fixed : start,
        x2: lane.horizontal ? end : lane.fixed,
        y2: lane.horizontal ? lane.fixed : end,
        rate: traffic.reduce((total, leg) => total + leg.rate, 0),
        flows: Object.fromEntries(flows),
        consumers: [...new Set(traffic.map(leg => leg.consumer))],
        bypass: lane.horizontal && lane.fixed === -20,
        finalOutput: traffic.every(leg => leg.consumer === 'Final output'),
        direction: traffic[0].end[axis] > traffic[0].start[axis] ? 1 : -1
      });
    }
  }
  return segments;
}
