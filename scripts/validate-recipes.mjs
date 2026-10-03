import { readFile } from 'node:fs/promises';
import { validateRecipeDataset } from '../lib/recipeValidation.js';

const data = JSON.parse(await readFile(new URL('../data/recipes.json', import.meta.url), 'utf8'));
validateRecipeDataset(data, { minimumCount: 50 });
console.log(`Validated ${Object.keys(data).length} recipes, including alternate recipes and dependency cycles.`);