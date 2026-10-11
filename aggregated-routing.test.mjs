import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { buildAggregatedRailSegments, buildRailSegments, expandMachineGraph, expandPooledMachineGraph, recommendRail } from './lib/railPlanning.js';

function positionMachines(nodes) {
  const columns = new Map();
  for (const node of nodes) {
    if (!columns.has(node.depth)) columns.set(node.depth, []);
    columns.get(node.depth).push(node);
  }
  for (const [depth, column] of columns) {
    column.sort((first, second) => first.label.localeCompare(second.label));
    column.forEach((node, index) => {
      node.x = 100 + depth * 220;
      node.y = 100 + index * 120;
    });
  }
}

function compareSegments(expected, actual) {
  const key = segment => JSON.stringify([segment.x1, segment.y1, segment.x2, segment.y2]);
  const reference = new Map(expected.map(segment => [key(segment), segment]));
  assert.equal(actual.length, expected.length);
  assert.deepEqual(actual.map(key), expected.map(key));
  for (const segment of actual) {
    const previous = reference.get(key(segment));
    assert.ok(previous, `Unexpected segment ${key(segment)}`);
    assert.ok(Math.abs(segment.rate - previous.rate) <= 1e-8 * Math.max(1, previous.rate));
    assert.deepEqual(Object.keys(segment.flows).sort(), Object.keys(previous.flows).sort());
    for (const item of Object.keys(previous.flows)) {
      assert.ok(Math.abs(segment.flows[item] - previous.flows[item]) <= 1e-8 * Math.max(1, previous.flows[item]));
    }
    assert.deepEqual([...segment.consumers].sort(), [...previous.consumers].sort());
    for (const property of ['bypass', 'finalOutput', 'direction']) assert.equal(segment[property], previous[property]);
    for (const capacity of [120, 240, 480, 750, 1500]) {
      for (const manual of [true, false]) {
        const current = recommendRail(segment.rate, manual ? capacity : null, manual ? null : capacity);
        const prior = recommendRail(previous.rate, manual ? capacity : null, manual ? null : capacity);
        if (JSON.stringify(current) !== JSON.stringify(prior)) {
          const nearBoundary = [120, 240, 480, 750, 1500].some(value => {
            const boundary = Math.round(segment.rate / value) * value;
            return boundary > 0 && Math.abs(segment.rate - boundary) < 1e-8 && Math.abs(previous.rate - boundary) < 1e-8;
          });
          assert.ok(nearBoundary, `Non-rounding recommendation change on ${key(segment)}`);
        } else {
          assert.deepEqual(current, prior);
        }
      }
    }
  }
}

test('pooled expansion retains group links instead of allocating machine pairs', () => {
  const nodes = [
    { id: 'Part', label: 'Part', machines: 100, rate: 120, inputs: {} },
    { id: 'Root', label: 'Root', machines: 100, rate: 120, inputs: { Part: 120 } }
  ];
  const links = [{ from: 'Root', to: 'Part', rate: 120 }];
  const graph = expandPooledMachineGraph(nodes, links, 'Root');
  assert.equal(graph.nodes.length, 200);
  assert.equal(graph.links, links);
  assert.equal(graph.links.length, 1);
});

test('rail recommendations tolerate summation drift but not meaningful excess demand', () => {
  assert.deepEqual(recommendRail(240 + 1e-11, 120), { capacity: 120, tier: 1, count: 2 });
  assert.deepEqual(recommendRail(240 + 1e-11), { capacity: 240, tier: 2, count: 1 });
  assert.equal(recommendRail(240.000001, 120).count, 3);
  assert.equal(recommendRail(240.000001).tier, 3);
  for (const capacity of [120, 240, 480, 750, 1500]) {
    const lanes = Math.floor(1000000000 / capacity);
    const boundary = lanes * capacity;
    assert.equal(recommendRail(boundary, capacity).count, lanes);
    assert.equal(recommendRail(boundary + boundary * 1e-13, capacity).count, lanes);
    assert.equal(recommendRail(boundary + 0.01, capacity).count, lanes + 1);
    assert.equal(recommendRail(0, capacity).count, 1);
    assert.equal(recommendRail(1e-15, capacity).count, 1);
  }
});

test('aggregated routing matches pairwise geometry, flows and consumer attribution', () => {
  for (const count of [1, 2, 3, 7, 12]) {
    for (const rate of [0.001, 120, 240, 1500, 3179.25]) {
      const nodes = [
        { id: 'Ore', label: 'Ore', raw: true, depth: 0, rate: rate * 2, inputs: {} },
        { id: 'Part', label: 'Part', depth: 1, machines: count, rate, inputs: { Ore: rate } },
        { id: 'Other', label: 'Other', depth: 2, machines: count + 1, rate: rate / 2, inputs: { Part: rate / 2 } },
        { id: 'Root', label: 'Root', depth: 3, machines: count + 2, rate, inputs: { Ore: rate, Part: rate / 2, Other: rate / 2 } }
      ];
      const links = [
        { from: 'Part', to: 'Ore', rate },
        { from: 'Other', to: 'Part', rate: rate / 2 },
        { from: 'Root', to: 'Ore', rate },
        { from: 'Root', to: 'Part', rate: rate / 2 },
        { from: 'Root', to: 'Other', rate: rate / 2 }
      ];
      const expanded = expandMachineGraph(nodes, links, 'Root');
      positionMachines(expanded.nodes);
      compareSegments(
        buildRailSegments(expanded.nodes, expanded.links, 'Root'),
        buildAggregatedRailSegments(expanded.nodes, links, 'Root')
      );
    }
  }
});

test('aggregated routing rejects pooled machines in different columns', () => {
  assert.throws(() => buildAggregatedRailSegments([
    { id: 'Part::1', productId: 'Part', x: 100, y: 100, depth: 0 },
    { id: 'Part::2', productId: 'Part', x: 320, y: 100, depth: 1 },
    { id: 'Root::1', productId: 'Root', x: 540, y: 100, depth: 2 }
  ], [{ from: 'Root', to: 'Part', rate: 120 }], 'Root'), /column and depth/);
});

test('aggregated routing matches real recipe layouts in both machine versions', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://calculator.test') return route.abort();
      const pathname = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css', 'lib/railPlanning.js', 'lib/recipeValidation.js', 'data/recipes.json'].includes(pathname)) {
        return route.fulfill({ status: 404, body: 'Not found' });
      }
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
      await route.fulfill({ body: await readFile(new URL(pathname, import.meta.url)), contentType });
    });
    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    const result = await page.evaluate(() => {
      const failures = [];
      const benchmarks = [];
      let checked = 0;
      let boundaryDifferences = 0;
      for (const tier of ['v1', 'v2']) {
        const cases = Object.keys(RECIPES).map(item => ({ item, rate: 120 }));
        cases.push({ item: 'Carbon Sonar', rate: 5 }, { item: 'Carbon Sonar', rate: 60 });
        for (const { item, rate } of cases) {
          ITEM_TIER_OVERRIDES.clear();
          ACTIVE_PLAN = { item, rate, rail: '1500', tier, railMode: 'auto' };
          const graph = buildGraphData(expandChain(item, rate).chain, item);
          const cost = RAIL_PLANNING.estimateComplexGraphCost(graph.nodes, graph.links, item);
          if (cost.supplyLinks > 180000) continue;
          const expanded = RAIL_PLANNING.expandMachineGraph(graph.nodes, graph.links, item);
          const depths = [...new Set(expanded.nodes.map(node => node.depth))].sort((first, second) => first - second);
          for (const [columnIndex, depth] of depths.entries()) {
            expanded.nodes.filter(node => node.depth === depth)
              .sort((first, second) => first.label.localeCompare(second.label))
              .forEach((node, index) => { node.x = columnIndex * 220 + 100; node.y = index * 120 + 100; });
          }
          const started = performance.now();
          const previous = RAIL_PLANNING.buildRailSegments(expanded.nodes, expanded.links, item);
          const pairwiseMs = performance.now() - started;
          const aggregatedStart = performance.now();
          const current = RAIL_PLANNING.buildAggregatedRailSegments(expanded.nodes, graph.links, item);
          const aggregatedMs = performance.now() - aggregatedStart;
          const key = segment => JSON.stringify([segment.x1, segment.y1, segment.x2, segment.y2]);
          const reference = new Map(previous.map(segment => [key(segment), segment]));
          if (previous.length !== current.length) failures.push({ tier, item, rate, issue: 'segment count' });
          if (JSON.stringify(previous.map(key)) !== JSON.stringify(current.map(key))) failures.push({ tier, item, rate, issue: 'segment order' });
          for (const segment of current) {
            const prior = reference.get(key(segment));
            if (!prior) { failures.push({ tier, item, rate, issue: 'geometry' }); continue; }
            const close = (first, second) => Math.abs(first - second) <= 1e-8 * Math.max(1, Math.abs(first));
            const sorted = values => JSON.stringify([...values].sort());
            if (!close(segment.rate, prior.rate) || sorted(Object.keys(segment.flows)) !== sorted(Object.keys(prior.flows)) || Object.keys(segment.flows).some(name => !close(segment.flows[name], prior.flows[name]))) {
              failures.push({ tier, item, rate, issue: 'flow' });
            }
            if (sorted(segment.consumers) !== sorted(prior.consumers) || ['direction', 'bypass', 'finalOutput'].some(property => segment[property] !== prior[property])) {
              failures.push({ tier, item, rate, issue: 'attribution or direction' });
            }
            const recommendation = RAIL_PLANNING.recommendRail(segment.rate, null, 1500);
            const oldRecommendation = RAIL_PLANNING.recommendRail(prior.rate, null, 1500);
            if (JSON.stringify(recommendation) !== JSON.stringify(oldRecommendation)) {
              const nearBoundary = RAIL_PLANNING.RAIL_TIERS.some(capacity => {
                const boundary = Math.round(segment.rate / capacity) * capacity;
                return boundary > 0 && Math.abs(segment.rate - boundary) < 1e-7 && Math.abs(prior.rate - boundary) < 1e-7;
              });
              if (nearBoundary) boundaryDifferences++;
              else failures.push({ tier, item, rate, issue: 'recommendation' });
            }
          }
          checked++;
          if (item === 'Carbon Sonar') benchmarks.push({ tier, rate, nodes: expanded.nodes.length, pairLinks: expanded.links.length, segments: current.length, pairwiseMs, aggregatedMs });
        }
      }
      return { checked, failures: failures.slice(0, 20), boundaryDifferences, benchmarks };
    });
    assert.ok(result.checked > 100);
    assert.deepEqual(result.failures, []);
    assert.equal(result.boundaryDifferences, 0);
    console.log(JSON.stringify(result));
    const labelComparison = await page.evaluate(() => {
      const original = RAIL_PLANNING;
      ITEM_TIER_OVERRIDES.clear();
      ACTIVE_PLAN = { item: 'Carbon Sonar', rate: 5, rail: '1500', tier: 'v2', railMode: 'auto' };
      GRAPH_MODE = 'complex';
      const capture = () => [...document.querySelectorAll('.rail-tier-label')].map(label => ({
        text: label.textContent,
        x: label.getAttribute('x'),
        y: label.getAttribute('y'),
        run: label.dataset.railRun
      }));
      renderActivePlan();
      const aggregated = capture();
      try {
        RAIL_PLANNING = {
          ...original,
          buildAggregatedRailSegments: (nodes, links, root) => {
            const groups = new Map();
            for (const node of nodes) {
              const item = node.productId || node.id;
              if (!groups.has(item)) groups.set(item, []);
              groups.get(item).push(node);
            }
            const pairs = [];
            for (const link of links) {
              const producers = groups.get(link.to) || [];
              const consumers = groups.get(link.from) || [];
              for (const consumer of consumers) {
                for (const producer of producers) {
                  pairs.push({ from: consumer.id, to: producer.id, item: link.to, rate: link.rate / (producers.length * consumers.length) });
                }
              }
            }
            return original.buildRailSegments(nodes, pairs, root);
          }
        };
        renderActivePlan();
        return { aggregated, pairwise: capture() };
      } finally {
        RAIL_PLANNING = original;
      }
    });
    assert.ok(labelComparison.aggregated.length > 0);
    assert.deepEqual(labelComparison.aggregated, labelComparison.pairwise);
  } finally {
    await browser.close();
  }
});