import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('per-item tiers update the displayed plan immediately and survive shared links', async () => {
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
        '/lib/recipeValidation.js': ['lib/recipeValidation.js', 'application/javascript'],
        '/data/recipes.json': ['data/recipes.json', 'application/json']
      };
      const asset = assets[url.pathname];
      if (!asset) return route.fulfill({ status: 404, body: 'Not found' });
      await route.fulfill({ body: await readFile(new URL(asset[0], import.meta.url)), contentType: asset[1] });
    });
    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    await page.selectOption('#itemSelect', 'Basic Fuel');
    await page.fill('#rateInput', '120');
    await page.selectOption('#tierSelect', 'v2');
    assert.equal(await page.locator('#outputArea').innerText(), '');
    assert.equal(page.url(), 'http://calculator.test/');
    await page.click('#calcButton');
    assert.equal(await page.evaluate(() => isTierTwoBuilding(getRecipe('Liquid Helium').building)), true);
    assert.ok((await page.locator('[data-tier-item]').evaluateAll(elements => elements.map(element => element.value))).every(value => value === 'v2'));
    const allUpgraded = await page.locator('#outputArea').innerText();
    await page.selectOption('#tierSelect', 'v1');
    assert.equal(await page.locator('#outputArea').innerText(), allUpgraded);
    await page.click('#calcButton');

    const wolfram = page.locator('[data-tier-item="Wolfram Powder"]');
    const helium = page.locator('[data-tier-item="Liquid Helium"]');
    const ore = page.locator('[data-tier-item="Wolfram Ore"]');
    assert.equal((await wolfram.innerText()).trim(), 'v1');
    const before = await page.locator('#outputArea').innerText();
    const beforeGraph = await page.locator('#graphArea').innerHTML();
    const beforeUrl = page.url();
    await wolfram.click();
    await ore.click();
    assert.notEqual(await page.locator('#outputArea').innerText(), before);
    assert.notEqual(await page.locator('#graphArea').innerHTML(), beforeGraph);
    assert.notEqual(page.url(), beforeUrl);
    assert.equal(await wolfram.getAttribute('value'), 'v2');
    assert.equal(await helium.getAttribute('value'), 'v1');
    assert.equal((await wolfram.innerText()).trim(), 'v2');
    assert.equal(await wolfram.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#outputArea select').count(), 0);
    const fixedTierCells = await page.locator('#outputArea table').first().locator('tbody tr').evaluateAll(rows => rows.filter(row => row.cells.length === 8 && !row.cells[5].querySelector('button')).map(row => row.cells[5].textContent));
    assert.ok(fixedTierCells.length > 0);
    assert.ok(fixedTierCells.every(text => text === ''));
    assert.equal(await page.evaluate(() => getRecipe('Wolfram Powder').building), 'Furnace v.2');
    assert.equal(await page.evaluate(() => isTierTwoBuilding(getRecipe('Liquid Helium').building)), false);
    const chain = await page.evaluate(() => expandChain('Basic Fuel', 120));
    assert.ok(chain.machineTotals['Furnace v.2'] > 0);
    assert.ok(chain.machineTotals.Furnace > 0);
    const oreCounts = await ore.locator('..').locator('..').locator('td').allTextContents();
    const expectedCounts = await page.evaluate(() => {
      const quantity = Math.ceil(expandChain('Basic Fuel', 120).extractorTotals['Wolfram Ore']);
      return ['impure', 'normal', 'pure'].map(purity => String(Math.ceil(quantity / ORE_EXCAVATOR_RATES.v2[purity])));
    });
    assert.deepEqual(oreCounts.slice(2, 5), expectedCounts);

    const sharedUrl = page.url();
    const sharedOutput = await page.locator('#outputArea').innerText();
    await page.goto(sharedUrl);
    await page.waitForSelector('[data-tier-item="Wolfram Powder"]');
    assert.equal(await wolfram.getAttribute('value'), 'v2');
    assert.equal(await ore.getAttribute('value'), 'v2');
    assert.equal(await page.locator('#outputArea').innerText(), sharedOutput);

    await page.selectOption('#itemSelect', 'Aerogel');
    await page.fill('#rateInput', '999');
    await page.selectOption('#railSelect', '1500');
    await page.selectOption('#tierSelect', 'v2');
    assert.equal(await page.locator('#outputArea').innerText(), sharedOutput);
    await helium.click();
    assert.notEqual(await page.locator('#outputArea').innerText(), sharedOutput);
    const activeParams = new URL(page.url()).searchParams;
    assert.equal(activeParams.get('item'), 'Basic Fuel');
    assert.equal(activeParams.get('rate'), '120');
    assert.equal(activeParams.get('rail'), '120');
    assert.equal(activeParams.get('tier'), 'v1');
    assert.equal(await page.evaluate(() => isTierTwoBuilding(getRecipe('Liquid Helium').building)), true);
    await helium.press('Space');
    assert.equal(await page.evaluate(() => isTierTwoBuilding(getRecipe('Liquid Helium').building)), false);
    assert.equal(await helium.getAttribute('aria-pressed'), 'false');
    assert.equal(JSON.parse(new URL(page.url()).searchParams.get('tiers'))['Liquid Helium'], undefined);

    for (const tiers of ['{broken', JSON.stringify({ 'Wolfram Powder': 'v9', Unknown: 'v2' }), 'null', '[]']) {
      const url = new URL(sharedUrl);
      url.searchParams.set('tiers', tiers);
      await page.goto(url.href);
      await page.waitForSelector('[data-tier-item="Wolfram Powder"]');
      assert.equal(await wolfram.getAttribute('value'), 'v1');
    }
    const legacyUrl = new URL(sharedUrl);
    legacyUrl.searchParams.set('tier', 'v2');
    legacyUrl.searchParams.set('tiers', JSON.stringify({ 'Liquid Helium': 'v1' }));
    await page.goto(legacyUrl.href);
    await page.waitForSelector('[data-tier-item="Wolfram Powder"]');
    assert.equal(await wolfram.getAttribute('value'), 'v2');
    assert.equal(await helium.getAttribute('value'), 'v1');
    assert.equal(await ore.getAttribute('value'), 'v2');
    assert.equal(new URL(page.url()).searchParams.get('tier'), 'v2');
    await page.reload();
    await page.waitForSelector('[data-tier-item="Wolfram Powder"]');
    assert.equal(await wolfram.getAttribute('value'), 'v2');
    assert.equal(await helium.getAttribute('value'), 'v1');
    await wolfram.click();
    assert.equal(JSON.parse(new URL(page.url()).searchParams.get('tiers'))['Wolfram Powder'], 'v1');
    await wolfram.press('Enter');
    assert.equal(JSON.parse(new URL(page.url()).searchParams.get('tiers'))['Wolfram Powder'], undefined);
    await page.selectOption('#tierSelect', 'v1');
    await page.click('#calcButton');
    assert.ok((await page.locator('[data-tier-item]').evaluateAll(elements => elements.map(element => element.value))).every(value => value === 'v1'));
    assert.equal(new URL(page.url()).searchParams.has('tiers'), false);
    await page.click('#clearStateBtn');
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1 && !location.search);
    assert.equal(await page.locator('#outputArea').innerText(), '');
    for (const width of [320, 390, 600]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(sharedUrl);
      await page.waitForSelector('[data-tier-item="Wolfram Powder"]');
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll('#controls button, #controls select, #controls input, .item-tier-toggle')].map(element => element.getBoundingClientRect().height),
        tableScrolls: document.querySelector('#outputArea').scrollWidth > document.querySelector('#outputArea').clientWidth
      }));
      assert.ok(layout.page <= layout.viewport, `Page overflows at ${width}px`);
      assert.ok(layout.targets.every(height => height >= 44), `Tap targets too small at ${width}px`);
      assert.equal(layout.tableScrolls, true);
      await wolfram.scrollIntoViewIfNeeded();
      const previousPosition = await wolfram.evaluate(element => ({ top: element.getBoundingClientRect().top, scroll: document.querySelector('#outputArea').scrollLeft }));
      await wolfram.click();
      assert.equal(await wolfram.getAttribute('value'), 'v1');
      assert.equal(await page.evaluate(() => isTierTwoBuilding(getRecipe('Wolfram Powder').building)), false);
      const currentPosition = await wolfram.evaluate(element => ({ top: element.getBoundingClientRect().top, scroll: document.querySelector('#outputArea').scrollLeft, focused: document.activeElement === element }));
      assert.ok(Math.abs(currentPosition.top - previousPosition.top) <= 2, `Selected row jumps at ${width}px`);
      assert.equal(currentPosition.scroll, previousPosition.scroll);
      assert.equal(currentPosition.focused, true);
    }
  } finally {
    await browser.close();
  }
});