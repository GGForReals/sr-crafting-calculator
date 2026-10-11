import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRailSegments, estimateComplexGraphCost, expandMachineGraph, groupRailLabelRuns, recommendMachineInputPorts, recommendRail, recommendRailModulator, recommendRailModulatorForRailCounts, COMPLEX_GRAPH_WORK_LIMIT, RAIL_BUILDINGS, RAIL_TIERS } from './lib/railPlanning.js';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('rail recommendations use the lowest sufficient tier and parallel counts', () => {
  for (const [index, capacity] of RAIL_TIERS.entries()) {
    assert.equal(recommendRail(capacity).tier, index + 1);
    if (index < 4) assert.equal(recommendRail(capacity + 0.01).tier, index + 2);
  }
  assert.deepEqual(recommendRail(3001), { capacity: 1500, tier: 5, count: 3 });
  assert.deepEqual(recommendRail(241, 120), { capacity: 120, tier: 1, count: 3 });
  assert.throws(() => recommendRail(Infinity));
});

test('auto rail recommendations respect the highest unlocked tier', () => {
  assert.deepEqual(recommendRail(1000, null, 240), { capacity: 240, tier: 2, count: 5 });
  assert.deepEqual(recommendRail(1000, null, 750), { capacity: 750, tier: 4, count: 2 });
  assert.deepEqual(recommendRail(1000, null, 1500), { capacity: 1500, tier: 5, count: 1 });
  assert.deepEqual(recommendRail(1000, 480, 240), { capacity: 480, tier: 3, count: 3 });
  assert.throws(() => recommendRail(1000, null, 360));
});

test('shared bypass combines traffic only on the overlapping route', () => {
  const nodes = [
    { id: 'Ore', x: 100, y: 100, depth: 0 },
    { id: 'Part', x: 320, y: 100, depth: 1 },
    { id: 'Consumer', x: 540, y: 100, depth: 2 },
    { id: 'Root', x: 760, y: 100, depth: 3, rate: 10 }
  ];
  const segments = buildRailSegments(nodes, [
    { from: 'Root', to: 'Ore', rate: 100 },
    { from: 'Root', to: 'Part', rate: 50 },
    { from: 'Consumer', to: 'Ore', rate: 30 }
  ], 'Root');
  const bypass = segments.filter(segment => segment.bypass);
  assert.equal(bypass.find(segment => segment.x1 === 140).rate, 130);
  assert.equal(bypass.find(segment => segment.x1 === 360).rate, 180);
  assert.equal(bypass.find(segment => segment.x1 === 500).rate, 150);
  assert.ok(segments.some(segment => segment.finalOutput && segment.x1 === 782 && segment.rate === 10));
});

test('raw material flow routes remain covered by the shared rail model', () => {
  const nodes = [
    { id: 'Titanium Ore', x: 100, y: 100, depth: 0, raw: true },
    { id: 'Wolfram Ore', x: 100, y: 220, depth: 0, raw: true },
    { id: 'Basic Building Material', x: 320, y: 100, depth: 1 }
  ];
  const segments = buildRailSegments(nodes, [
    { from: 'Basic Building Material', to: 'Titanium Ore', rate: 135 },
    { from: 'Basic Building Material', to: 'Wolfram Ore', rate: 135 }
  ], 'Basic Building Material');
  const oreFeed = segments.find(segment => segment.x1 === 140 && segment.x2 === 280 && segment.y1 === 100 && segment.y2 === 100);
  assert.ok(oreFeed);
  assert.equal(oreFeed.rate, 270);
  assert.deepEqual(oreFeed.flows, { 'Titanium Ore': 135, 'Wolfram Ore': 135 });

  const sharedOreNodes = [
    { id: 'Titanium Ore', x: 100, y: 100, depth: 0, raw: true },
    { id: 'Part A', x: 320, y: 100, depth: 1 },
    { id: 'Part B', x: 320, y: 220, depth: 1 }
  ];
  const sharedOreSegments = buildRailSegments(sharedOreNodes, [
    { from: 'Part A', to: 'Titanium Ore', rate: 135 },
    { from: 'Part B', to: 'Titanium Ore', rate: 135 }
  ], 'Part A');
  assert.ok(sharedOreSegments.some(segment => segment.x1 === 140 && segment.y1 === 100 && segment.x2 === 280 && segment.y2 === 100 && segment.rate === 270 && segment.flows['Titanium Ore'] === 270));
});

test('browser rail plans conserve demand, suggest sufficient capacity, and restore modes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://calculator.test') return route.abort();
      const assets = {
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'application/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/data/recipes.json': ['data/recipes.json', 'application/json'],
        '/lib/recipeValidation.js': ['lib/recipeValidation.js', 'application/javascript'],
        '/lib/railPlanning.js': ['lib/railPlanning.js', 'application/javascript']
      };
      const asset = assets[url.pathname];
      if (!asset) return route.fulfill({ status: 404, body: 'Not found' });
      await route.fulfill({ body: await readFile(new URL(asset[0], import.meta.url)), contentType: asset[1] });
    });
    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    assert.equal(await page.locator('#railModeToggle').getAttribute('data-mode'), 'auto');
    assert.equal(await page.locator('#railSelect').isDisabled(), false);
    assert.equal(await page.locator('#railSelectLabel').innerText(), 'Rail Version:');
    const failures = await page.evaluate(() => {
      const failures = [];
      const names = Object.keys(RECIPES);
      for (const mode of ['v1', 'v2', 'mixed']) {
        for (const item of names) {
          ITEM_TIER_OVERRIDES.clear();
          if (mode === 'mixed') names.forEach((name, index) => {
            if (index % 2 === 0 && RECIPES[name].altBuilding) ITEM_TIER_OVERRIDES.set(name, 'v2');
          });
          ACTIVE_PLAN = { item, rate: 1000, rail: '120', tier: mode === 'v2' ? 'v2' : 'v1', railMode: 'auto' };
          const { chain } = expandChain(item, 1000);
          renderActivePlan();
          const nodeBoxes = [...document.querySelectorAll('.graph-node')].flatMap(node =>
            [...node.querySelectorAll(':scope > rect, :scope > circle')].map(shape => ({ name: node.dataset.id, box: shape.getBBox() }))
          );
          const labels = [...document.querySelectorAll('.rail-tier-label')];
          const labelBoxes = labels.map(label => label.getBBox());
          const overlap = (first, second) => first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
          for (const [index, bounds] of labelBoxes.entries()) {
            for (const node of nodeBoxes) {
              if (overlap(bounds, node.box)) failures.push({ mode, item, node: node.name, label: labels[index].textContent, issue: 'rail label covers node' });
            }
            if (labelBoxes.slice(index + 1).some(other => overlap(bounds, other))) failures.push({ mode, item, issue: 'rail labels overlap' });
          }
          for (const [name, data] of Object.entries(chain)) {
            if (name !== item) {
              const demand = Object.values(chain).reduce((total, consumer) => total + (consumer.inputs[name] || 0), 0);
              if (Math.abs(demand - data.rate) > 0.00001) failures.push({ mode, item, name, issue: 'demand' });
            }
            const circle = [...document.querySelectorAll('.graph-node')].find(node => node.dataset.id === name).querySelector('circle');
            const outputX = Number(circle.getAttribute('cx')) + 22;
            const outputY = Number(circle.getAttribute('cy'));
            const exit = [...document.querySelectorAll('.rail-segment')].find(segment => {
              const line = segment.querySelector('line');
              return Number(line.getAttribute('x1')) === outputX && Number(line.getAttribute('y1')) === outputY;
            });
            if (name === item) {
              if (exit) failures.push({ mode, item, name, issue: 'unexpected final output line' });
              if (!circle.parentElement.querySelector('title')?.textContent.includes('Final output')) failures.push({ mode, item, name, issue: 'missing final output accounting' });
            } else if (!exit || Math.abs(Number(exit.dataset.rate) - data.rate) > 0.00001) failures.push({ mode, item, name, issue: 'output flow' });
          }
          if (!document.querySelector('.rail-junction')) failures.push({ mode, item, issue: 'missing junction dots' });
          for (const segment of document.querySelectorAll('.rail-segment')) {
            const line = segment.querySelector('line');
            const endpointTouchesMachine = [...document.querySelectorAll('.graph-node > circle')].some(circle => {
              const centerX = Number(circle.getAttribute('cx'));
              const centerY = Number(circle.getAttribute('cy'));
              return ['1', '2'].some(endpoint => centerY === Number(line.getAttribute(`y${endpoint}`)) && Math.abs(centerX - Number(line.getAttribute(`x${endpoint}`))) === 22);
            });
            if (Boolean(segment.querySelector('polygon')) === endpointTouchesMachine) failures.push({ mode, item, issue: 'incorrect connector arrow' });
            const rate = Number(segment.dataset.rate);
            const tier = Number(segment.dataset.tier);
            const count = Number(segment.dataset.count);
            const capacity = RAIL_PLANNING.RAIL_TIERS[tier - 1];
            if (rate > capacity * count + 0.00001) failures.push({ mode, item, issue: 'insufficient capacity' });
            if (count === 1 && tier > 1 && rate <= RAIL_PLANNING.RAIL_TIERS[tier - 2]) failures.push({ mode, item, issue: 'oversized tier' });
          }
        }
      }
      return failures;
    });
    assert.deepEqual(failures, []);

    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    await page.selectOption('#itemSelect', 'Stator');
    await page.fill('#rateInput', '600');
    await page.selectOption('#tierSelect', 'v2');
    await page.selectOption('#railSelect', '240');
    await page.click('#calcButton');
    assert.equal(new URL(page.url()).searchParams.get('railMode'), 'auto');
    assert.ok((await page.locator('.rail-segment').evaluateAll(segments => segments.map(segment => Number(segment.dataset.tier)))).every(tier => tier <= 2));
    assert.equal(await page.locator('#railSelectLabel').innerText(), 'Rail Version:');
    assert.ok(await page.locator('.rail-segment[data-bypass="true"]').count() > 0);
    assert.equal(await page.locator('.rail-summary').count(), 0);
    const railDetails = () => page.locator('.rail-segment > title').allTextContents();
    const automatic = await railDetails();
    await page.locator('#railModeToggle').click();
    assert.equal(await page.locator('#railModeToggle').getAttribute('data-mode'), 'manual');
    assert.equal(await page.locator('#railSelectLabel').innerText(), 'Rail Version:');
    await page.selectOption('#railSelect', '240');
    assert.deepEqual(await railDetails(), automatic);
    await page.click('#calcButton');
    assert.ok((await page.locator('.rail-segment').evaluateAll(segments => segments.map(segment => segment.dataset.tier))).every(tier => tier === '2'));
    await page.reload();
    await page.waitForSelector('.rail-segment', { state: 'attached' });
    assert.equal(await page.locator('#railModeToggle').getAttribute('data-mode'), 'manual');
    assert.equal(await page.locator('#railSelect').inputValue(), '240');
    await page.locator('#railModeToggle').click();
    await page.click('#calcButton');
    await page.reload();
    await page.waitForSelector('.rail-segment', { state: 'attached' });
    assert.equal(await page.locator('#railModeToggle').getAttribute('data-mode'), 'auto');
    const before = await railDetails();
    await page.locator('.machine-tier-toggle[data-tier-item="Stator"]').click();
    assert.notDeepEqual(await railDetails(), before);
    await page.goto('http://calculator.test/?item=Stator&rate=120&rail=480&tier=v1');
    await page.waitForSelector('.rail-segment', { state: 'attached' });
    assert.equal(await page.locator('#railModeToggle').getAttribute('data-mode'), 'manual');
    const railSegments = page.locator('.rail-segment');
    const railToggle = page.locator('#toggleRailInfoBtn');
    assert.equal(await railSegments.first().evaluate(segment => getComputedStyle(segment).display), 'inline');
    const railLabels = page.locator('.rail-tier-label');
    const junctions = page.locator('.rail-junction');
    assert.ok(await railLabels.count() > 0);
    await railToggle.click();
    assert.equal(await railSegments.first().evaluate(segment => getComputedStyle(segment).display), 'inline');
    assert.equal(await railLabels.first().evaluate(label => getComputedStyle(label).display), 'none');
    assert.equal(await junctions.first().evaluate(dot => getComputedStyle(dot).display), 'inline');
    await page.locator('.machine-tier-toggle[data-tier-item="Stator"]').click();
    assert.equal(await railSegments.first().evaluate(segment => getComputedStyle(segment).display), 'inline');
    assert.equal(await railLabels.first().evaluate(label => getComputedStyle(label).display), 'none');
    await railToggle.click();
    assert.equal(await railLabels.first().evaluate(label => getComputedStyle(label).display), 'block');

    await page.goto('http://calculator.test/?item=Standard%20Ammo&rate=1500&rail=1500&tier=v1&railMode=auto');
    await page.waitForSelector('.rail-segment', { state: 'attached' });
    const ammoRow = page.locator('#outputArea tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^Standard Ammo$/ }) });
    assert.match(await ammoRow.locator('td').nth(6).innerText(), /1 input node\/machine, v2 each \(8 total\)/);
    const buildingMaterialRow = page.locator('#outputArea tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^Basic Building Material$/ }) });
    assert.match(await buildingMaterialRow.locator('td').nth(6).innerText(), /1 input node\/machine, v1 each \(5 total\)/);
    const wolframBarRow = page.locator('#outputArea tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^Wolfram Bar$/ }) });
    assert.match(await wolframBarRow.locator('td').nth(6).innerText(), /1 input node\/machine, v1 each \(2 total\)/);
    assert.ok(await page.locator('.graph-source[data-node-kind="raw-source"]').count() > 0);
    assert.ok(await page.locator('.graph-machine[data-node-kind="machine"]').count() > 0);
    const ammoGraphNode = page.locator('.graph-node[data-id="Standard Ammo"]');
    const ammoInputPorts = ammoGraphNode.locator('.machine-input-ports');
    assert.equal(await ammoInputPorts.count(), 1);
    assert.equal(await ammoInputPorts.getAttribute('data-input-nodes-per-machine'), '1');
    assert.equal(await ammoInputPorts.getAttribute('data-total-input-nodes'), '8');
    assert.equal(await ammoInputPorts.getAttribute('data-input-rate-per-machine'), '206.25');
    assert.equal(await ammoGraphNode.locator('.node-output-feed').count(), 0);
    const ammoNodeFill = await ammoGraphNode.locator(':scope > circle').getAttribute('fill');
    assert.equal(await ammoInputPorts.locator('.machine-input-port').count(), 1);
    assert.ok((await ammoInputPorts.locator('.machine-input-port').getAttribute('fill')) === ammoNodeFill);
    assert.equal(await page.locator('.graph-node[data-id="Wolfram Powder"] .node-output-feed').count(), 1);
    const buildingGraphNode = page.locator('.graph-node[data-id="Basic Building Material"]');
    const buildingInputPorts = buildingGraphNode.locator('.machine-input-ports');
    assert.equal(await buildingInputPorts.getAttribute('data-input-rate-per-machine'), '54');
    const simpleNodeCount = await page.locator('.graph-node').count();
    const complexMode = page.locator('[data-graph-mode="complex"]');
    assert.equal(await page.locator('[data-graph-mode="simple"]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      RAIL_PLANNING = { ...RAIL_PLANNING, expandMachineGraph: () => { throw new Error('Complex rendering must not allocate pairwise links'); } };
    });
    await complexMode.click();
    await page.waitForSelector('.graph-node[data-id="Standard Ammo::1"]');
    assert.equal(await page.locator('.graph-node[data-product-id="Standard Ammo"]').count(), 8);
    assert.ok(await page.locator('.graph-node').count() > simpleNodeCount);
    assert.equal(await complexMode.getAttribute('aria-pressed'), 'true');
    await page.locator('.graph-node[data-id="Standard Ammo::1"]').evaluate(node => {
      const svg = node.closest('svg.graphSVG');
      svg._graphPointerDragged = false;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await page.locator('.graph-node[data-id="Standard Ammo::1"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('.graph-input').count() > 0);
    assert.ok(await page.locator('.rail-segment.rail-selected').count() > 0);
    await page.locator('[data-graph-mode="simple"]').click();
    await page.waitForSelector('.graph-node[data-id="Standard Ammo"]');

    await page.goto('http://calculator.test/?item=Standard%20Ammo&rate=1500&rail=120&tier=v1&railMode=auto');
    await page.waitForSelector('.graph-node[data-id="Standard Ammo"] .machine-input-ports');
    const v1AmmoInputPorts = page.locator('.graph-node[data-id="Standard Ammo"] .machine-input-ports');
    assert.equal(await v1AmmoInputPorts.getAttribute('data-input-nodes-per-machine'), '2');
    assert.equal(await v1AmmoInputPorts.getAttribute('data-rail-tier'), '1');
    assert.equal(await v1AmmoInputPorts.locator('.machine-input-port').count(), 2);
    const wolframPowderNode = page.locator('.graph-node[data-id="Wolfram Powder"]');
    assert.equal(
      await wolframPowderNode.locator('.machine-input-port').getAttribute('r'),
      await wolframPowderNode.locator('.node-output-feed circle').getAttribute('r')
    );
    assert.equal(
      await wolframPowderNode.locator('.machine-input-port').getAttribute('stroke-width'),
      await wolframPowderNode.locator('.node-output-feed circle').getAttribute('stroke-width')
    );

    await page.goto('http://calculator.test/?item=Standard%20Ammo&rate=1000&rail=1500&tier=v2&railMode=auto');
    await page.waitForSelector('.graph-node[data-id="Standard Ammo"]');
    await page.locator('[data-graph-mode="complex"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('.graph-node[data-id="Standard Ammo::1"]');
    const ammoComplexLabels = await page.evaluate(() => ({
      segmentCount: document.querySelectorAll('.rail-segment').length,
      labelCount: document.querySelectorAll('.rail-tier-label').length,
      shortLabelCount: document.querySelectorAll('.rail-tier-label-short').length
    }));
    assert.ok(ammoComplexLabels.labelCount > 0);
    assert.equal(ammoComplexLabels.shortLabelCount, 0);
    assert.ok(ammoComplexLabels.labelCount <= ammoComplexLabels.segmentCount);

    await page.goto('http://calculator.test/?item=Carbon%20Sonar&rate=60&rail=1500&tier=v2&railMode=auto');
    await page.waitForSelector('.graph-node[data-id="Carbon Sonar"]');
    const columnLabels = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.rail-tier-label')];
      return [...document.querySelectorAll('.rail-segment')].flatMap(segment => {
        const line = segment.querySelector('line');
        const x1 = Number(line.getAttribute('x1'));
        const x2 = Number(line.getAttribute('x2'));
        const y1 = Number(line.getAttribute('y1'));
        const y2 = Number(line.getAttribute('y2'));
        if (x1 !== x2 || ![500, 580].includes(x1) || y1 < 100 || y2 > 460) return [];
        const label = labels.find(value => value.dataset.railRun === segment.dataset.railSegment);
        return [{ midpoint: (y1 + y2) / 2, labelY: label ? Number(label.getAttribute('y')) : null, railX: x1, labelX: label ? Number(label.getAttribute('x')) : null }];
      });
    });
    assert.equal(columnLabels.length, 6);
    assert.ok(columnLabels.every(label => label.labelY === label.midpoint));
    assert.ok(columnLabels.every(label => Math.abs(label.labelX - label.railX) === 12));

    await page.goto('http://calculator.test/?item=Carbon%20Sonar&rate=60&rail=1500&tier=v1&railMode=auto');
    await page.waitForSelector('.graph-node[data-id="Carbon Sonar"]');
    const simpleLabelBounds = await page.evaluate(() => {
      GRAPH_MODE = 'simple';
      ACTIVE_PLAN.rate = 60;
      renderActivePlan();
      const svg = document.querySelector('.graphSVG');
      const viewBox = svg.viewBox.baseVal;
      const targetSegment = svg.querySelector('.rail-segment[data-rail-segment="194"]');
      const targetLabel = [...svg.querySelectorAll('.rail-tier-label')].find(label => label.dataset.railRun.split(',').includes('194'));
      return [...svg.querySelectorAll('.rail-tier-label')].map(label => {
        const box = label.getBBox();
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          inside: box.x >= viewBox.x && box.y >= viewBox.y && box.x + box.width <= viewBox.x + viewBox.width && box.y + box.height <= viewBox.y + viewBox.height,
          targetSegment: label === targetLabel,
          targetLabelY: label === targetLabel ? Number(label.getAttribute('y')) : null,
          targetSegmentY: targetSegment ? [Number(targetSegment.querySelector('line').getAttribute('y1')), Number(targetSegment.querySelector('line').getAttribute('y2'))] : []
        };
      });
    });
    assert.ok(simpleLabelBounds.length > 0);
    assert.ok(simpleLabelBounds.every(bounds => bounds.inside));
    const targetFlowLabel = simpleLabelBounds.find(bounds => bounds.targetSegment);
    assert.ok(targetFlowLabel, 'Expected a distinct rail label on the Helium-3 to Goethite Ore trunk span');
    assert.equal(targetFlowLabel.targetLabelY, 400);
    assert.deepEqual(targetFlowLabel.targetSegmentY, [340, 460]);
    for (let first = 0; first < simpleLabelBounds.length; first++) {
      for (let second = first + 1; second < simpleLabelBounds.length; second++) {
        const a = simpleLabelBounds[first];
        const b = simpleLabelBounds[second];
        const separated = a.x + a.width + 4 <= b.x || b.x + b.width + 4 <= a.x || a.y + a.height + 4 <= b.y || b.y + b.height + 4 <= a.y;
        assert.ok(separated, `Rail labels are too close: ${a.x},${a.y} and ${b.x},${b.y}`);
      }
    }
    const v1InputGutters = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.rail-tier-label')];
      return [...document.querySelectorAll('.rail-segment')].flatMap(segment => {
        const line = segment.querySelector('line');
        const x = Number(line.getAttribute('x1'));
        const y1 = Number(line.getAttribute('y1'));
        const y2 = Number(line.getAttribute('y2'));
        if (x !== Number(line.getAttribute('x2')) || ![280, 500].includes(x) || y1 < 100 || y2 > 580) return [];
        const label = labels.find(value => value.dataset.railRun === segment.dataset.railSegment);
        return [{
          expected: `${Number(segment.dataset.count) > 1 ? segment.dataset.count + ' x ' : ''}v${segment.dataset.tier}`,
          text: label?.textContent,
          midpoint: (y1 + y2) / 2,
          labelY: label ? Number(label.getAttribute('y')) : null,
          offset: label ? x - Number(label.getAttribute('x')) : null
        }];
      });
    });
    assert.equal(v1InputGutters.length, 8);
    assert.ok(v1InputGutters.every(label => label.text === label.expected && label.labelY === label.midpoint && label.offset === 12));
    const pooledOnboardFeeds = await page.evaluate(() => {
      ACTIVE_PLAN.rate = 5;
      GRAPH_MODE = 'complex';
      renderActivePlan();
      return [...document.querySelectorAll('.graph-node[data-product-id="Onboard Instruments"]')]
        .map(node => ({ id: node.dataset.id, inputs: JSON.parse(node.dataset.inputs).sort() }));
    });
    assert.equal(pooledOnboardFeeds.length, 3);
    assert.ok(pooledOnboardFeeds.every(node => JSON.stringify(node.inputs) === JSON.stringify(pooledOnboardFeeds[0].inputs)));
    const railLabelDensity = await page.evaluate(() => ({
      segmentCount: document.querySelectorAll('.rail-segment').length,
      labelCount: document.querySelectorAll('.rail-tier-label').length
    }));
    assert.ok(railLabelDensity.segmentCount > 100);
    assert.ok(railLabelDensity.labelCount > 25, `Rail labels unexpectedly suppressed: ${railLabelDensity.labelCount}`);
    assert.ok(railLabelDensity.labelCount <= railLabelDensity.segmentCount);

    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto('http://calculator.test/?item=Standard%20Ammo&rate=1000000&rail=1500&tier=v2&railMode=auto');
    await page.waitForSelector('.graph-node[data-id="Standard Ammo"]');
    await page.locator('[data-graph-mode="complex"]').click();
    await page.waitForSelector('.graph-mode-notice');
    const mobileGraphLayout = await page.evaluate(() => {
      const notice = document.querySelector('.graph-mode-notice');
      return {
        heights: [...document.querySelectorAll('.graphResetButton button')].map(button => button.getBoundingClientRect().height),
        noticeWidth: notice.getBoundingClientRect().width,
        noticeOverflow: notice.scrollWidth > notice.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    assert.ok(mobileGraphLayout.heights.every(height => height >= 44));
    assert.ok(mobileGraphLayout.noticeWidth >= 250);
    assert.equal(mobileGraphLayout.noticeOverflow, false);
    assert.equal(mobileGraphLayout.pageOverflow, false);

  } finally {
    await browser.close();
  }
});

test('rail hardware keeps connector behavior separate from capacity', () => {
  assert.equal(RAIL_BUILDINGS.railConnector.role, 'standard-join-split');
  assert.equal(RAIL_BUILDINGS.roundabout.railSpeedRule, 'fastest-connected-rail');
  assert.equal(RAIL_BUILDINGS.roundabout.addsRailCapacity, false);
  assert.equal(RAIL_BUILDINGS.multirail3.kind, 'parallel-support');
  assert.equal(recommendRailModulator(2), 'modulator3');
  assert.equal(recommendRailModulator(3), 'modulator3');
  assert.equal(recommendRailModulator(4), 'modulator5');
  assert.equal(recommendRailModulator(5), 'modulator5');
  assert.equal(recommendRailModulator(6), null);
  assert.throws(() => recommendRailModulator(1));
  assert.throws(() => recommendRailModulator(2.5));
  assert.equal(recommendRailModulatorForRailCounts([1, 1, 1]), null);
  assert.equal(recommendRailModulatorForRailCounts([1, 2, 2]), 'modulator3');
  assert.equal(recommendRailModulatorForRailCounts([2, 4, 4]), 'modulator5');
  assert.equal(recommendRailModulatorForRailCounts([1, 6]), null);
  assert.throws(() => recommendRailModulatorForRailCounts([1, 0]));
});

test('machine input nodes use aggregate recipe demand per installed machine', () => {
  const inputPorts = recommendMachineInputPorts({
    'Titanium Ore': 800,
    'Wolfram Ore': 700,
    'Titanium Rod': 900,
    'Wolfram Wire': 700
  }, 2, null, 750);
  assert.equal(inputPorts.totalRate, 3100);
  assert.equal(inputPorts.ratePerMachine, 1550);
  assert.equal(inputPorts.tier, 4);
  assert.equal(inputPorts.inputNodesPerMachine, 3);
  assert.equal(inputPorts.totalInputNodes, 6);
});

test('complex graph expansion preserves requested item flows across machine instances', () => {
  const graph = expandMachineGraph([
    { id: 'Ore', label: 'Ore', raw: true, rate: 90, machines: 0, inputs: {} },
    { id: 'Part', label: 'Part', raw: false, rate: 90, machines: 3, inputs: { Ore: 90 } },
    { id: 'Root', label: 'Root', raw: false, rate: 90, machines: 2, inputs: { Part: 90 } },
    { id: 'Solo', label: 'Solo', raw: false, rate: 90, machines: 1, inputs: {} }
  ], [
    { from: 'Part', to: 'Ore', rate: 90 },
    { from: 'Root', to: 'Part', rate: 90 }
  ], 'Root');

  assert.equal(graph.nodes.length, 7);
  assert.equal(graph.nodes.filter(node => node.productId === 'Root').length, 2);
  assert.equal(graph.nodes.find(node => node.id === 'Solo::1').label, 'Solo');
  assert.equal(graph.nodes.find(node => node.id === 'Root::1').label, 'Root #1');
  assert.equal(graph.nodes.find(node => node.id === 'Part::1').inputPorts.inputNodesPerMachine, 1);
  for (const consumer of ['Root::1', 'Root::2']) {
    const feeds = graph.links.filter(link => link.from === consumer && link.item === 'Part');
    assert.deepEqual(feeds.map(link => link.to).sort(), ['Part::1', 'Part::2', 'Part::3']);
    assert.ok(feeds.every(link => link.rate === 15));
  }
  for (const item of ['Ore', 'Part']) {
    assert.equal(graph.links.filter(link => link.item === item).reduce((total, link) => total + link.rate, 0), 90);
  }
});

test('complex graph guard estimates pooled route work instead of imposing a machine-count limit', () => {
  const manyMachinesFewLinks = estimateComplexGraphCost([
    { id: 'Root', raw: false, machines: 501 }
  ], [], 'Root');
  assert.equal(manyMachinesFewLinks.machineNodes, 501);
  assert.ok(manyMachinesFewLinks.workUnits < COMPLEX_GRAPH_WORK_LIMIT);

  const denseFanOut = estimateComplexGraphCost([
    { id: 'Part', raw: false, machines: 100 },
    { id: 'Root', raw: false, machines: 100 }
  ], [{ from: 'Root', to: 'Part', rate: 100 }], 'Root');
  assert.equal(denseFanOut.supplyLinks, 10000);
  assert.equal(denseFanOut.routeLegs, 50100);
  assert.equal(denseFanOut.aggregatedRouteLegs, 501);
  assert.ok(denseFanOut.workUnits < COMPLEX_GRAPH_WORK_LIMIT);
  const oversized = estimateComplexGraphCost([
    { id: 'Part', raw: false, machines: 2000 },
    { id: 'Root', raw: false, machines: 2000 }
  ], [{ from: 'Root', to: 'Part', rate: 100 }], 'Root');
  assert.ok(oversized.workUnits > COMPLEX_GRAPH_WORK_LIMIT);
});

test('rail labels group continuous segments only while their recommendation and direction match', () => {
  const runs = groupRailLabelRuns([
    { x1: 0, y1: 0, x2: 20, y2: 0, rate: 50, bypass: false },
    { x1: 20, y1: 0, x2: 40, y2: 0, rate: 60, bypass: false },
    { x1: 40, y1: 0, x2: 60, y2: 0, rate: 150, bypass: false },
    { x1: 20, y1: 0, x2: 20, y2: 40, rate: 50, bypass: false },
    { x1: 60, y1: 0, x2: 80, y2: 0, rate: 50, bypass: true }
  ], [
    { tier: 1, count: 1 },
    { tier: 1, count: 1 },
    { tier: 2, count: 1 },
    { tier: 1, count: 1 },
    { tier: 1, count: 1 }
  ]);

  assert.deepEqual(runs.map(run => [run.label, run.segmentIndexes]), [
    ['v1', [0, 1]],
    ['v2', [2]],
    ['v1', [3]],
    ['v1', [4]]
  ]);

  const compositionRuns = groupRailLabelRuns([
    { x1: 100, y1: 0, x2: 100, y2: 40, rate: 180, bypass: false, flows: { Ore: 100, Oil: 80 } },
    { x1: 100, y1: 40, x2: 100, y2: 80, rate: 150, bypass: false, flows: { Ore: 100, Oil: 50 } },
    { x1: 100, y1: 80, x2: 100, y2: 120, rate: 100, bypass: false, flows: { Ore: 100 } }
  ], [
    { tier: 2, count: 1 },
    { tier: 2, count: 1 },
    { tier: 2, count: 1 }
  ]);
  assert.deepEqual(compositionRuns.map(run => run.segmentIndexes), [[0], [1], [2]]);
});