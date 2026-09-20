import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRecipeWrite } from './scripts/scrape-recipes.mjs';

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
