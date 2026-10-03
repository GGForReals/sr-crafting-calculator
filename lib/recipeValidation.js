function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || name.startsWith('_') || /[\u0000-\u001f\u007f]/.test(name) || Object.hasOwn(Object.prototype, name) || name === 'prototype') {
    throw new Error('Invalid or reserved recipe, input, or building name.');
  }
}

function validateQuantity(value, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid ${label}: expected a finite positive number no greater than ${maximum}.`);
  }
}

function validateVariant(recipe, allowAlternate) {
  if (!isRecord(recipe) || !isRecord(recipe.inputs)) throw new Error('Recipe and inputs must be objects.');
  const allowed = new Set(['inputs', 'output', 'time', 'building', 'tier', ...(allowAlternate ? ['altBuilding'] : [])]);
  if (Object.keys(recipe).some(key => !allowed.has(key))) throw new Error('Unsupported recipe field.');
  validateName(recipe.building);
  validateQuantity(recipe.output, 1000000, 'output');
  validateQuantity(recipe.time, 86400, 'crafting time');
  if (Object.hasOwn(recipe, 'tier') && (!Number.isSafeInteger(recipe.tier) || recipe.tier < 0 || recipe.tier > 1000)) {
    throw new Error('Invalid recipe tier.');
  }
  const inputs = Object.entries(recipe.inputs);
  if (inputs.length > 64) throw new Error('Too many recipe inputs.');
  for (const [name, quantity] of inputs) {
    validateName(name);
    validateQuantity(quantity, 1000000, 'input quantity');
  }
  if (Object.hasOwn(recipe, 'altBuilding')) validateVariant(recipe.altBuilding, false);
}

export function validateRecipeDataset(data, { minimumCount = 1 } = {}) {
  if (!isRecord(data)) throw new Error('Recipe dataset must be an object.');
  const entries = Object.entries(data);
  if (entries.length < minimumCount || entries.length > 2000) throw new Error('Recipe count is outside the allowed range.');
  for (const [name, recipe] of entries) {
    validateName(name);
    validateVariant(recipe, true);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error('Cyclic recipe dependencies are not supported.');
    if (visited.has(name)) return;
    visiting.add(name);
    const recipe = data[name];
    const inputs = [...Object.keys(recipe.inputs), ...Object.keys(recipe.altBuilding?.inputs || {})];
    for (const input of inputs) {
      if (Object.hasOwn(data, input)) visit(input);
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const [name] of entries) visit(name);
  return data;
}