import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

test('graph selection pulses only the chosen node and its direct inputs', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const serveAsset = async route => {
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
    };
    await page.route('**/*', serveAsset);
    await page.goto('http://calculator.test/?item=Basic+Fuel&rate=120&rail=120&tier=v1');
    const fuel = page.locator('.graph-node[data-id="Basic Fuel"]');
    const helium = page.locator('.graph-node[data-id="Liquid Helium"]');
    const pulsingIds = async () => (await page.locator('.graph-pulsing').evaluateAll(groups => groups.map(group => group.dataset.id))).sort();
    await page.waitForFunction(() => document.querySelector('#zoomLayer')?.hasAttribute('transform'));
    const initialSize = await fuel.locator('circle').evaluate(circle => ({ width: circle.getBoundingClientRect().width, height: circle.getBoundingClientRect().height }));
    await fuel.click();
    const selectedSize = await fuel.locator('circle').evaluate(circle => ({ width: circle.getBoundingClientRect().width, height: circle.getBoundingClientRect().height }));
    assert.ok(Math.abs(selectedSize.width - initialSize.width) < 0.01);
    assert.ok(Math.abs(selectedSize.height - initialSize.height) < 0.01);
    assert.deepEqual(await pulsingIds(), ['Basic Fuel', 'Goethite Powder', 'Liquid Helium', 'Wolfram Powder'].sort());
    assert.equal(await fuel.getAttribute('aria-pressed'), 'true');
    assert.equal(await helium.getAttribute('aria-pressed'), 'false');
    await fuel.click();
    assert.deepEqual(await pulsingIds(), []);
    await helium.press('Enter');
    assert.deepEqual(await pulsingIds(), ['Liquid Helium', 'Hardening Agent', 'Pressurized Helium'].sort());
    await page.locator('[data-tier-item="Liquid Helium"]').click();
    assert.deepEqual(await pulsingIds(), ['Liquid Helium', 'Chemicals', 'Hardening Agent', 'Pressurized Helium'].sort());
    await helium.press('Space');
    assert.deepEqual(await pulsingIds(), []);
    const raw = page.locator('.graph-node[data-id="Wolfram Ore"]');
    await raw.press('Enter');
    assert.deepEqual(await pulsingIds(), ['Wolfram Ore']);
    await raw.press('Escape');
    assert.deepEqual(await pulsingIds(), []);
    await fuel.scrollIntoViewIfNeeded();
    const circle = await fuel.locator('circle').boundingBox();
    const beforePan = await page.locator('#zoomLayer').getAttribute('transform');
    await page.mouse.move(circle.x + circle.width / 2, circle.y + circle.height / 2);
    await page.mouse.down();
    await page.mouse.move(circle.x + circle.width / 2 + 40, circle.y + circle.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await page.locator('#zoomLayer').getAttribute('transform'), beforePan);
    assert.deepEqual(await pulsingIds(), []);
    await fuel.click();
    assert.equal(await fuel.getAttribute('aria-pressed'), 'true');
    await page.locator('.graphSVG').dispatchEvent('click');
    assert.deepEqual(await pulsingIds(), []);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await helium.press('Enter');
    assert.equal(await helium.locator('circle').evaluate(circle => getComputedStyle(circle).animationName), 'none');
    assert.equal(await helium.getAttribute('aria-pressed'), 'true');

    const mobile = await browser.newPage(devices['Pixel 5']);
    await mobile.route('**/*', serveAsset);
    await mobile.goto('http://calculator.test/?item=Calcium+Powder&rate=120&rail=120&tier=v1');
    const powder = mobile.locator('.graph-node[data-id="Calcium Powder"]');
    await powder.tap();
    assert.deepEqual((await mobile.locator('.graph-pulsing').evaluateAll(groups => groups.map(group => group.dataset.id))).sort(), ['Calcium Powder', 'Calcium Block'].sort());
    await powder.tap();
    assert.equal(await mobile.locator('.graph-pulsing').count(), 0);
    const touchCircle = await powder.locator('circle').boundingBox();
    const touchX = touchCircle.x + touchCircle.width / 2;
    const touchY = touchCircle.y + touchCircle.height / 2;
    const beforeTouchPan = await mobile.locator('#zoomLayer').getAttribute('transform');
    const client = await mobile.context().newCDPSession(mobile);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX + 40, y: touchY + 30 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notEqual(await mobile.locator('#zoomLayer').getAttribute('transform'), beforeTouchPan);
    assert.equal(await mobile.locator('.graph-pulsing').count(), 0);
    await mobile.locator('#resetViewBtn').click();
    await powder.tap();
    assert.equal(await powder.getAttribute('aria-pressed'), 'true');

    await page.goto('http://calculator.test/?item=Rotor&rate=120&rail=120&tier=v2');
    const plate = page.locator('.graph-node[data-id="Wolfram Plate"]');
    await plate.click();
    assert.deepEqual(await pulsingIds(), ['Wolfram Plate', 'Wolfram Powder', 'Wolfram Bar'].sort());
    const positions = await page.evaluate(() => {
      const circleFor = name => [...document.querySelectorAll('.graph-node')].find(node => node.dataset.id === name).querySelector('circle');
      return { plate: Number(circleFor('Wolfram Plate').getAttribute('cx')), powder: Number(circleFor('Wolfram Powder').getAttribute('cx')) };
    });
    assert.ok(positions.powder < positions.plate);
    await page.locator('[data-tier-item="Wolfram Plate"]').click();
    assert.deepEqual(await pulsingIds(), ['Wolfram Plate', 'Wolfram Bar'].sort());

    const violations = await page.evaluate(() => {
      const failures = [];
      for (const tier of ['v1', 'v2']) {
        ACTIVE_PLAN = { item: 'Rotor', rate: 120, rail: '120', tier };
        ITEM_TIER_OVERRIDES.clear();
        for (const name of Object.keys(RECIPES)) {
          const { chain } = expandChain(name, 120);
          const depths = computeDepthsFromTiers(chain, name);
          for (const [consumer, data] of Object.entries(chain)) {
            for (const input of Object.keys(data.inputs)) {
              if (depths[input] >= depths[consumer]) failures.push({ tier, root: name, consumer, input });
            }
          }
        }
      }
      return failures;
    });
    assert.deepEqual(violations, []);

    for (const viewport of [{ width: 1820, height: 900 }, { width: 1440, height: 700 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const clipped = await page.evaluate(async () => {
        const failures = [];
        for (const tier of ['v1', 'v2']) {
          ITEM_TIER_OVERRIDES.clear();
          for (const item of Object.keys(RECIPES)) {
            ACTIVE_PLAN = { item, rate: 120, rail: '120', tier };
            renderActivePlan();
            await new Promise(resolve => requestAnimationFrame(resolve));
            const wrapper = document.querySelector('.graphWrapper');
            const bounds = wrapper.getBoundingClientRect();
            const content = wrapper.querySelector('#zoomLayer').getBoundingClientRect();
            if (content.left < bounds.left - 1 || content.right > bounds.right + 1 || content.top < bounds.top - 1 || content.bottom > bounds.bottom + 1) failures.push({ item, tier, phase: 'initial' });
            wrapper.querySelector('#zoomLayer').setAttribute('transform', 'translate(10000,10000)');
            document.querySelector('#resetViewBtn').click();
            const resetContent = wrapper.querySelector('#zoomLayer').getBoundingClientRect();
            if (resetContent.left < bounds.left - 1 || resetContent.right > bounds.right + 1 || resetContent.top < bounds.top - 1 || resetContent.bottom > bounds.bottom + 1) failures.push({ item, tier, phase: 'reset' });
          }
        }
        return failures;
      });
      assert.deepEqual(clipped, [], `Graph clipping at ${viewport.width}x${viewport.height}`);
    }
  } finally {
    await browser.close();
  }
});