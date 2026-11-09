import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = {
  Powder: { inputs: { Ore: 1 }, output: 1, time: 1, building: 'Pulverizer' },
  Plate: {
    inputs: { Powder: 2 }, output: 2, time: 4, building: 'Furnace',
    altBuilding: { inputs: { Powder: 3 }, output: 3, time: 3, building: 'Furnace v.2' }
  },
  Wire: {
    inputs: { Plate: 2 }, output: 1, time: 6, building: 'Fabricator',
    altBuilding: { inputs: { Plate: 1, Ore: 1 }, output: 2, time: 4, building: 'Fabricator v.2' }
  },
  Circuit: { inputs: { Wire: 2, Plate: 1 }, output: 1, time: 12, building: 'Assembler' },
  Device: { inputs: { Circuit: 1, Wire: 2, Plate: 3 }, output: 1, time: 30, building: 'Mega Press' }
};

async function routeCalculator(page, recipes) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://calculator.test') return route.abort();
    if (url.pathname === '/data/recipes.json') return route.fulfill({ json: recipes });
    const assets = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'application/javascript'],
      '/style.css': ['style.css', 'text/css'],
      '/lib/recipeValidation.js': ['lib/recipeValidation.js', 'application/javascript'],
      '/lib/railPlanning.js': ['lib/railPlanning.js', 'application/javascript']
    };
    const asset = assets[url.pathname];
    if (!asset) return route.fulfill({ status: 404, body: 'Not found' });
    await route.fulfill({ body: await readFile(new URL(asset[0], import.meta.url)), contentType: asset[1] });
  });
}

test('external supply prunes only supplied branches and restores graph, totals, tiers, and shared plans', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await routeCalculator(page, fixture);
    await page.goto('http://calculator.test/?item=Device&rate=10');
    await page.waitForSelector('[data-supply-item="Wire"]');
    const plan = () => page.evaluate(() => expandChain(ACTIVE_PLAN.item, ACTIVE_PLAN.rate));
    const baseline = await plan();
    assert.equal(baseline.chain.Wire.rate, 40);
    assert.equal(baseline.chain.Plate.rate, 120);
    assert.equal(baseline.extractorTotals.Ore, 120);
    assert.equal(await page.locator('[data-supply-item="Device"]').count(), 0);

    await page.locator('[data-supply-item="Wire"]').click();
    let current = await plan();
    assert.deepEqual(current.externalTotals, { Wire: 40 });
    assert.equal(current.chain.Wire.machines, 0);
    assert.deepEqual(current.chain.Wire.inputs, {});
    assert.equal(current.machineTotals.Fabricator, undefined);
    assert.equal(current.chain.Plate.rate, 40);
    assert.equal(current.extractorTotals.Ore, 40);
    const source = page.locator('.graph-external[data-product-id="Wire"]');
    assert.equal(await source.count(), 1);
    assert.equal(await source.getAttribute('data-node-kind'), 'external-source');
    assert.equal(await source.locator('.sourceNodeMarker').textContent(), 'EXT');
    assert.equal(await source.locator('.machine-input-ports').count(), 0);
    assert.match(await page.locator('.external-supply-table').innerText(), /Wire\s+40/);
    assert.equal(await page.locator('[data-supply-item="Wire"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-supply-item="Wire"]').evaluate(element => document.activeElement === element), true);

    await page.locator('.graph-node[data-product-id="Circuit"]').click();
    assert.match(await source.getAttribute('class'), /graph-input/);
    assert.ok(await page.locator('.rail-selected').count() > 0);
    await page.locator('[data-graph-mode="complex"]').click();
    assert.equal(await source.count(), 1);
    assert.equal(await source.locator('.nodeNumber').count(), 0);
    assert.equal(await page.locator('.graph-machine[data-product-id="Wire"]').count(), 0);
    assert.equal(await page.locator('.graph-machine[data-product-id="Circuit"]').count(), current.chain.Circuit.machines);

    await page.locator('[data-supply-item="Circuit"]').click();
    current = await plan();
    assert.deepEqual(current.externalTotals, { Circuit: 10, Wire: 20 });
    assert.equal(current.chain.Plate.rate, 30);
    assert.equal(current.extractorTotals.Ore, 30);
    assert.equal(current.machineTotals.Assembler, undefined);

    await page.locator('[data-supply-item="Plate"]').click();
    current = await plan();
    assert.deepEqual(current.externalTotals, { Circuit: 10, Wire: 20, Plate: 30 });
    assert.deepEqual(current.extractorTotals, {});
    assert.deepEqual(current.machineTotals, { 'Mega Press': 5 });
    assert.equal(await page.locator('.graph-external').count(), 3);
    const sharedUrl = page.url();
    assert.deepEqual(JSON.parse(new URL(sharedUrl).searchParams.get('supplied')), ['Circuit', 'Plate', 'Wire']);
    await page.goto(sharedUrl);
    await page.waitForSelector('.external-supply-table');
    assert.deepEqual(await plan(), current);
    await page.locator('[data-supply-item="Plate"]').press('Space');
    await page.locator('[data-supply-item="Circuit"]').click();
    await page.locator('[data-supply-item="Wire"]').click();
    assert.deepEqual(await plan(), baseline);
    assert.equal(new URL(page.url()).searchParams.has('supplied'), false);

    await page.locator('[data-tier-item="Wire"]').click();
    const upgraded = await plan();
    assert.equal(upgraded.chain.Wire.building, 'Fabricator v.2');
    await page.locator('[data-supply-item="Wire"]').click();
    await page.selectOption('#itemSelect', 'Plate');
    await page.fill('#rateInput', '999');
    await page.selectOption('#tierSelect', 'v2');
    await page.locator('[data-supply-item="Wire"]').click();
    assert.deepEqual(await plan(), upgraded);
    assert.equal(new URL(page.url()).searchParams.get('item'), 'Device');
    assert.equal(new URL(page.url()).searchParams.get('rate'), '10');
    assert.equal(new URL(page.url()).searchParams.get('tier'), 'v1');

    const dormantUrl = new URL(sharedUrl);
    dormantUrl.searchParams.set('supplied', JSON.stringify(['Circuit', 'Plate', 'Wire', 'Powder']));
    await page.goto(dormantUrl.href);
    await page.waitForSelector('.external-supply-table');
    const dormant = await page.locator('.external-supply-table tr').filter({ has: page.locator('[data-supply-item="Powder"]') }).innerText();
    assert.match(dormant, /Not required by this plan/);
    assert.equal((await plan()).externalTotals.Powder, undefined);
    await page.locator('[data-supply-item="Powder"]').click();
    assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get('supplied')), ['Circuit', 'Plate', 'Wire']);

    await page.goto(sharedUrl);
    await page.waitForSelector('.external-supply-table');
    await page.selectOption('#itemSelect', 'Wire');
    await page.locator('#calcButton').click();
    assert.equal(await page.evaluate(() => EXTERNAL_SUPPLIES.has('Wire')), false);
    assert.equal((await plan()).chain.Wire.raw, false);
    await page.locator('#clearStateBtn').click();
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1 && !location.search);
    assert.equal(await page.evaluate(() => EXTERNAL_SUPPLIES.size), 0);
    assert.equal(await page.locator('#outputArea').innerText(), '');
  } finally {
    await browser.close();
  }
});

test('changing targets resets external supplies without affecting pending or same-target setup edits', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const recipes = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
    await routeCalculator(page, recipes);
    await page.goto('http://calculator.test/?item=Battery&rate=15');
    await page.waitForSelector('[data-supply-item="Sulphuric Acid"]');
    await page.locator('[data-supply-item="Sulphuric Acid"]').click();
    await page.fill('#rateInput', '30');
    await page.selectOption('#railSelect', '480');
    await page.selectOption('#tierSelect', 'v2');
    await page.locator('#calcButton').click();
    assert.deepEqual(await page.evaluate(() => [...EXTERNAL_SUPPLIES]), ['Sulphuric Acid']);
    assert.equal(await page.locator('.graph-external[data-product-id="Sulphuric Acid"]').count(), 1);
    await page.reload();
    await page.waitForSelector('.graph-external');
    assert.deepEqual(await page.evaluate(() => [...EXTERNAL_SUPPLIES]), ['Sulphuric Acid']);

    await page.selectOption('#itemSelect', 'Anti-Radiation Covers');
    assert.equal(await page.evaluate(() => ACTIVE_PLAN.item), 'Battery');
    assert.deepEqual(await page.evaluate(() => [...EXTERNAL_SUPPLIES]), ['Sulphuric Acid']);
    await page.locator('#calcButton').click();
    assert.equal(await page.evaluate(() => ACTIVE_PLAN.item), 'Anti-Radiation Covers');
    assert.equal(await page.evaluate(() => EXTERNAL_SUPPLIES.size), 0);
    assert.equal(await page.locator('.graph-external').count(), 0);
    assert.equal(await page.locator('.external-supply-table').count(), 0);
    assert.equal(new URL(page.url()).searchParams.has('supplied'), false);
    assert.equal(await page.locator('[data-supply-item="Sulphuric Acid"]').getAttribute('aria-pressed'), 'false');
    await page.selectOption('#itemSelect', 'Battery');
    await page.locator('#calcButton').click();
    assert.equal(await page.evaluate(() => EXTERNAL_SUPPLIES.size), 0);
  } finally {
    await browser.close();
  }
});

test('shared external supplies reject invalid values and safely display hostile names on mobile', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const hostile = '<img src=x onerror="window.__xss=true">';
    await routeCalculator(page, {
      ...fixture,
      [hostile]: { inputs: { Ore: 1 }, output: 1, time: 1, building: 'Furnace' },
      HostileTarget: { inputs: { [hostile]: 2 }, output: 1, time: 1, building: 'Assembler' }
    });

    for (const supplied of ['{broken', 'null', '{}', '1', '[]', JSON.stringify(['Device', 'Ore', 'Unknown', '__proto__', 'constructor', {}, null, 2])]) {
      await page.goto('http://calculator.test/?' + new URLSearchParams({ item: 'Device', rate: '10', supplied }));
      await page.waitForSelector('.graph-node');
      assert.equal(await page.locator('.graph-external').count(), 0);
      assert.equal((await page.evaluate(() => expandChain('Device', 10))).extractorTotals.Ore, 120);
      assert.equal(new URL(page.url()).searchParams.has('supplied'), false);
    }
    await page.goto('http://calculator.test/?' + new URLSearchParams({ item: 'Device', rate: '10', supplied: JSON.stringify(['Wire', 'Unknown', 'Wire']) }));
    await page.waitForSelector('.graph-external');
    assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get('supplied')), ['Wire']);
    await page.goto('http://calculator.test/?' + new URLSearchParams({ item: 'HostileTarget', rate: '10', supplied: JSON.stringify([hostile]) }));
    await page.waitForSelector('.graph-external');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#outputArea img, #graphArea img').count(), 0);
    assert.equal(await page.locator('.graph-external').getAttribute('data-product-id'), hostile);
    assert.match(await page.locator('.external-supply-table').innerText(), /20/);
    assert.deepEqual((await page.evaluate(() => expandChain('HostileTarget', 10))).extractorTotals, {});
    for (const width of [320, 390, 600]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll('.supply-toggle')].map(element => element.getBoundingClientRect().height)
      }));
      assert.ok(layout.page <= layout.viewport, `Page overflows at ${width}px`);
      assert.ok(layout.targets.every(height => height >= 44));
    }
    await page.locator('[data-supply-item]').click();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#outputArea img, #graphArea img').count(), 0);
    assert.equal(await page.locator('.graph-external').count(), 0);
  } finally {
    await browser.close();
  }
});

test('Battery supply controls align beside item names on desktop and mobile', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const recipes = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
    await routeCalculator(page, recipes);
    await page.goto('http://calculator.test/?item=Battery&rate=15');
    await page.waitForSelector('[data-supply-item="Electronics"]');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator('[data-production-item] .production-item').evaluateAll(elements => elements.map(element => {
        const name = element.querySelector('.production-item-name').getBoundingClientRect();
        const button = element.querySelector('.supply-toggle')?.getBoundingClientRect();
        const row = element.getBoundingClientRect();
        return {
          gap: button ? button.left - name.right : null,
          aligned: button ? Math.abs((name.top + name.height / 2) - (button.top + button.height / 2)) : 0,
          height: button?.height,
          contained: !button || (button.right <= row.right + 1 && button.left >= row.left)
        };
      }));
      assert.ok(layout.every(row => row.contained && row.aligned <= 1));
      assert.ok(layout.filter(row => row.gap !== null).every(row => row.gap >= 12 && row.height >= 44));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.locator('[data-supply-item="Electronics"]').click();
    assert.equal(await page.locator('.external-supply-table [data-supply-item="Electronics"]').innerText(), 'Produce here');
    await page.locator('[data-supply-item="Electronics"]').click();
    assert.equal(await page.locator('[data-production-item="Electronics"] .supply-toggle').count(), 1);
  } finally {
    await browser.close();
  }
});

test('external sources sit immediately before their earliest consumer in both graph modes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await routeCalculator(page, fixture);
    for (const supplied of [['Circuit'], ['Wire'], ['Circuit', 'Wire', 'Plate']]) {
      await page.goto(`http://calculator.test/?item=Device&rate=10&supplied=${encodeURIComponent(JSON.stringify(supplied))}`);
      await page.waitForSelector('.graph-external');
      const positions = await page.evaluate(() => {
        const { chain } = expandChain(ACTIVE_PLAN.item, ACTIVE_PLAN.rate);
        const depths = computeDepthsFromTiers(chain, ACTIVE_PLAN.item);
        return [...EXTERNAL_SUPPLIES].map(name => ({
          name,
          depth: depths[name],
          consumerDepths: Object.entries(chain)
            .filter(([, data]) => Object.hasOwn(data.inputs, name))
            .map(([consumer]) => depths[consumer])
        }));
      });
      for (const source of positions) {
        assert.equal(source.depth, Math.min(...source.consumerDepths) - 1);
        if (supplied.length === 1) assert.ok(source.depth > 0, 'Supply should move beyond the raw-resource column');
      }
      for (const mode of ['simple', 'complex']) {
        await page.locator(`[data-graph-mode="${mode}"]`).click();
        const nodes = await page.locator('.graph-node').evaluateAll(elements => elements.map(element => ({
          name: element.dataset.productId,
          inputs: JSON.parse(element.dataset.inputs),
          x: Number(element.querySelector(':scope > circle').getAttribute('cx'))
        })));
        const columns = [...new Set(nodes.map(node => node.x))].sort((a, b) => a - b);
        for (const name of supplied) {
          const sources = nodes.filter(node => node.name === name);
          assert.equal(sources.length, 1);
          const earliestConsumer = Math.min(...nodes.filter(node => node.inputs.includes(name)).map(node => node.x));
          assert.equal(columns.indexOf(sources[0].x) + 1, columns.indexOf(earliestConsumer),
            `${mode}: ${name} should be immediately before its earliest consumer`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

test('raw resources appear below crafted and external items in each graph column', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const recipes = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
    await routeCalculator(page, recipes);
    await page.goto('http://calculator.test/?item=Battery&rate=15');
    await page.waitForSelector('[data-supply-item="Electronics"]');
    let mixedColumns = 0;
    for (const supplied of [false, true]) {
      if (supplied) await page.locator('[data-supply-item="Electronics"]').click();
      for (const mode of ['simple', 'complex']) {
        await page.locator(`[data-graph-mode="${mode}"]`).click();
        const layout = await page.locator('.graph-node').evaluateAll(elements => {
          const columns = new Map();
          for (const element of elements) {
            const circle = element.querySelector(':scope > circle');
            const x = circle.getAttribute('cx');
            if (!columns.has(x)) columns.set(x, []);
            columns.get(x).push({
              name: element.dataset.id,
              raw: element.dataset.nodeKind === 'raw-source',
              y: Number(circle.getAttribute('cy'))
            });
          }
          return [...columns.values()];
        });
        for (const column of layout) {
          const raw = column.filter(node => node.raw);
          const crafted = column.filter(node => !node.raw);
          if (!raw.length || !crafted.length) continue;
          mixedColumns++;
          assert.ok(Math.min(...raw.map(node => node.y)) > Math.max(...crafted.map(node => node.y)),
            `Raw resources are not below other items in ${mode}: ${JSON.stringify(column)}`);
        }
        assert.equal(await page.locator('.graph-external').count(), supplied ? 1 : 0);
      }
    }
    assert.ok(mixedColumns >= 4, 'Expected mixed raw/crafted columns in both graph modes');
  } finally {
    await browser.close();
  }
});

test('bypasses conserve all real recipe demands across standard, upgraded, and mixed tiers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const recipes = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
    await routeCalculator(page, recipes);
    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    const result = await page.evaluate(() => {
      const failures = [];
      let checked = 0;
      const names = Object.keys(RECIPES);
      for (const tier of ['v1', 'v2', 'mixed']) {
        ITEM_TIER_OVERRIDES.clear();
        if (tier === 'mixed') {
          names.forEach((name, index) => {
            if (index % 2 === 0 && RECIPES[name].altBuilding) ITEM_TIER_OVERRIDES.set(name, 'v2');
          });
        }
        for (const root of names) {
          ACTIVE_PLAN = { item: root, rate: 17, rail: '120', tier: tier === 'v2' ? 'v2' : 'v1', railMode: 'auto' };
          EXTERNAL_SUPPLIES.clear();
          const intermediates = Object.keys(expandChain(root, 17).chain).filter(name => name !== root && Object.hasOwn(RECIPES, name));
          const choices = [...intermediates.map(name => [name]), intermediates];
          for (const supplied of choices) {
            EXTERNAL_SUPPLIES = new Set(supplied);
            const actual = expandChain(root, 17);
            const expected = new Map();
            const visit = (name, rate) => {
              expected.set(name, (expected.get(name) || 0) + rate);
              const recipe = getRecipe(name);
              if (!recipe || (name !== root && EXTERNAL_SUPPLIES.has(name))) return;
              for (const [ingredient, amount] of Object.entries(recipe.inputs)) visit(ingredient, rate / recipe.output * amount);
            };
            visit(root, 17);
            const near = (first, second) => Math.abs(first - second) <= 1e-9 * Math.max(1, Math.abs(second));
            const machines = {};
            const extraction = {};
            const external = {};
            if (Object.keys(actual.chain).length !== expected.size) failures.push(`${tier}/${root}: wrong branch count`);
            for (const [name, rate] of expected) {
              const data = actual.chain[name];
              if (!data || !near(data.rate, rate)) {
                failures.push(`${tier}/${root}/${name}: wrong rate`);
                continue;
              }
              const recipe = getRecipe(name);
              if (name !== root && EXTERNAL_SUPPLIES.has(name)) {
                external[name] = rate;
                if (!data.external || !data.raw || data.machines !== 0 || Object.keys(data.inputs).length) failures.push(`${tier}/${root}/${name}: not an external source`);
              } else if (recipe) {
                const count = Math.ceil(rate / (recipe.output * 60 / recipe.time));
                machines[recipe.building] = (machines[recipe.building] || 0) + count;
                if (data.machines !== count) failures.push(`${tier}/${root}/${name}: wrong machine count`);
              } else {
                extraction[name] = rate;
              }
            }
            for (const [key, values] of Object.entries({ machineTotals: machines, extractorTotals: extraction, externalTotals: external })) {
              if (Object.keys(actual[key]).length !== Object.keys(values).length || Object.entries(values).some(([name, value]) => !near(actual[key][name], value))) {
                failures.push(`${tier}/${root}: wrong ${key}`);
              }
            }
            const graph = buildGraphData(actual.chain, root);
            const expanded = RAIL_PLANNING.expandPooledMachineGraph(graph.nodes, graph.links, root);
            for (const name of Object.keys(external)) {
              const sources = expanded.nodes.filter(node => node.productId === name);
              if (sources.length !== 1 || sources[0].kind !== 'external-source' || !near(sources[0].rate, external[name])) {
                failures.push(`${tier}/${root}/${name}: expanded supply mismatch`);
              }
            }
            checked++;
          }
        }
      }
      return { checked, failures };
    });
    assert.ok(result.checked > 500, `Only checked ${result.checked} plans`);
    assert.deepEqual(result.failures, []);
  } finally {
    await browser.close();
  }
});
