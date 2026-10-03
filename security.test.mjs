import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('hostile URLs and imported strings cannot execute HTML or corrupt calculator state', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let fixture = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://calculator.test') return route.abort();
      if (url.pathname === '/data/recipes.json') return route.fulfill({ json: fixture });
      const assets = {
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'application/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/lib/recipeValidation.js': ['lib/recipeValidation.js', 'application/javascript']
      };
      const asset = assets[url.pathname];
      if (!asset) return route.fulfill({ status: 404, body: 'Not found' });
      await route.fulfill({ body: await readFile(new URL(asset[0], import.meta.url)), contentType: asset[1] });
    });

    for (const rate of ['0', '-1', 'NaN', 'Infinity', '1e999', '1e300', '1000000001']) {
      await page.goto('http://calculator.test/?' + new URLSearchParams({ item: 'Basic Fuel', rate }));
      await page.waitForFunction(() => document.querySelector('#outputArea').textContent.includes('valid rate'));
      assert.equal(await page.locator('.graph-node').count(), 0);
    }

    await page.goto('http://calculator.test/?' + new URLSearchParams({ item: 'constructor', rate: '120', rail: '999', tiers: '{"__proto__":"v2","constructor":"v2"}' }));
    await page.waitForFunction(() => document.querySelector('#itemSelect').options.length > 1);
    assert.equal(await page.evaluate(() => getRecipe('constructor')), null);
    assert.equal(await page.locator('#railSelect').inputValue(), '120');
    assert.equal(await page.evaluate(() => Object.prototype.polluted), undefined);
    assert.equal(await page.locator('.graph-node').count(), 0);

    const item = '<img src=x onerror="window.__xss = true">';
    const raw = '<svg onload="window.__xss = true">';
    fixture = { [item]: { inputs: { [raw]: 1 }, output: 1, time: 3, building: '<img src=x onerror="window.__xss = true">' } };
    await page.goto('http://calculator.test/?' + new URLSearchParams({ item, rate: '120' }));
    await page.waitForSelector('.graph-node');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#outputArea img, #graphArea img').count(), 0);
    assert.equal(await page.locator('.graph-node').count(), 2);
    assert.ok((await page.locator('#outputArea').innerText()).includes(item));

    fixture = JSON.parse('{"Item":{"inputs":{"constructor":1},"output":1,"time":3,"building":"Furnace"}}');
    await page.goto('http://calculator.test/');
    await page.waitForFunction(() => document.querySelector('#outputArea').textContent.includes('Error loading recipe data'));
    assert.equal(await page.locator('.graph-node').count(), 0);
  } finally {
    await browser.close();
  }
});