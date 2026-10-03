import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRecipeDataset } from './lib/recipeValidation.js';

const validRecipe = () => ({ inputs: { Ore: 2 }, output: 1, time: 3, building: 'Furnace' });

test('current generated and manual datasets pass validation', async () => {
  for (const file of ['data/recipes.json', 'scripts/manual-recipes.json']) {
    const data = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.equal(validateRecipeDataset(data), data);
  }
});

test('rejects malformed datasets and unsafe numeric quantities', () => {
  for (const data of [null, [], {}, 'recipes']) assert.throws(() => validateRecipeDataset(data));
  for (const field of ['output', 'time']) {
    for (const value of [0, -1, Infinity, NaN, '2', null, 1000000000]) {
      assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), [field]: value } }));
    }
  }
  assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), inputs: [] } }));
  assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), inputs: { Ore: Infinity } } }));
  assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), altBuilding: { ...validRecipe(), time: 0 } } }));
});

test('rejects prototype-sensitive names and excessive data', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '_internal', 'bad\nname']) {
    assert.throws(() => validateRecipeDataset(Object.fromEntries([[name, validRecipe()]])));
    assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), inputs: Object.fromEntries([[name, 1]]) } }));
    assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), building: name } }));
  }
  assert.throws(() => validateRecipeDataset({ ['a'.repeat(201)]: validRecipe() }));
  assert.throws(() => validateRecipeDataset(Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`Item ${index}`, validRecipe()]))));
  assert.equal(Object.prototype.polluted, undefined);
});

test('rejects cyclic base and alternate recipes', () => {
  assert.throws(() => validateRecipeDataset({ Item: { ...validRecipe(), inputs: { Item: 1 } } }));
  assert.throws(() => validateRecipeDataset({
    Item: { ...validRecipe(), altBuilding: { ...validRecipe(), inputs: { Other: 1 } } },
    Other: { ...validRecipe(), inputs: { Item: 1 } }
  }));
});