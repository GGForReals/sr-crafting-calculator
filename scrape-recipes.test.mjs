import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRecipeWrite, getItemPageUrl, loadSearchSnapshot } from './scripts/scrape-recipes.mjs';
import { readFile } from 'node:fs/promises';

test('keeps the previous recipe set when the live scrape temporarily drops below the safety threshold', () => {
  const decision = decideRecipeWrite(43, 96, 50);
  assert.equal(decision.action, 'keep-existing');
});

test('fails when there is no previous recipe set to fall back to', () => {
  const decision = decideRecipeWrite(10, 0, 50);
  assert.equal(decision.action, 'fail');
});

test('writes the new scrape when it clears the safety threshold', () => {
  const decision = decideRecipeWrite(56, 96, 50);
  assert.equal(decision.action, 'write');
});

test('scraper navigation stays within the expected item origin and path', () => {
  assert.equal(getItemPageUrl('/items/calcium-powder'), 'https://starrupture.tools/items/calcium-powder');
  for (const value of ['https://example.com/items/test', '//example.com/items/test', '@example.com', '/items/../../admin', '/items/..\\..\\admin', null]) {
    assert.throws(() => getItemPageUrl(value));
  }
});

test('Search API 403 preserves only a validated existing dataset', async () => {
  const previous = JSON.parse(await readFile(new URL('data/recipes.json', import.meta.url), 'utf8'));
  const options = {
    loadItems: async () => { throw new Error('Search API returned 403'); },
    loadCategories: async () => new Map(),
    loadPrevious: async () => previous
  };
  const snapshot = await loadSearchSnapshot(options);
  assert.equal(snapshot.keptPrevious, true);
  assert.equal(snapshot.previousCount, Object.keys(previous).length);
  assert.equal(snapshot.reason, 'Search API returned 403');
  assert.equal(snapshot.items, undefined);
  await assert.rejects(loadSearchSnapshot({ ...options, loadPrevious: async () => null }), /403/);
  await assert.rejects(loadSearchSnapshot({ ...options, loadPrevious: async () => ({ Invalid: {} }) }));
});

test('available Search API proceeds with fresh item and category data', async () => {
  const items = [{ name: 'Item' }];
  const buildingCategories = new Map([['Furnace', 'processing']]);
  const snapshot = await loadSearchSnapshot({
    loadItems: async () => items,
    loadCategories: async () => buildingCategories,
    loadPrevious: async () => { throw new Error('Fallback must not run'); }
  });
  assert.deepEqual(snapshot, { items, buildingCategories });
});
