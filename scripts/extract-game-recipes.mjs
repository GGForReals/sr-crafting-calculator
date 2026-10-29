// extract-game-recipes.mjs
// Builds a recipe dataset straight from the installed StarRupture game files.
//
// Why this exists: starrupture.tools (our previous only source) stopped tracking the
// Update 2 recipe rebalance, so the published calculator drifted away from the game.
// The cooked game data is the authoritative source, so we read it directly.
//
// Usage:
//   node scripts/extract-game-recipes.mjs [--game-dir <path>] [--write] [--json <path>]
//
// Without --write it only reports what it found and how it differs from data/recipes.json.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openContainer } from '../lib/ioStore.js';
import { parseZenPackage, exportPayload, parseStringTablePairs } from '../lib/zenPackage.js';
import { validateRecipeDataset } from '../lib/recipeValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = path.join(__dirname, '..', 'data', 'recipes.json');
const OVERRIDES_PATH = path.join(__dirname, 'game-extract-overrides.json');

const DEFAULT_GAME_DIRS = [
  'F:/Program Files (x86)/Steam/steamapps/common/StarRupture',
  'C:/Program Files (x86)/Steam/steamapps/common/StarRupture',
];

const CRAFTING_PREFIX = '../../../StarRupture/Content/Chimera/Crafting/';
const STRING_TABLE_PREFIX = '../../../StarRupture/Content/Chimera/Localization/StringTables/';

// An input/output entry is a 2-byte unversioned fragment header (2 values, no skips)
// followed by an object reference and a count.
const ENTRY_HEADER = 0x0500;
const ENTRY_SIZE = 10;
const MAX_REASONABLE_COUNT = 10000;
const MAX_REASONABLE_INPUTS = 12;
// Recipes that craft in the class-default time omit the property entirely.
const DEFAULT_CRAFT_TIME = 10;

function findGameDir(explicit) {
  const candidates = explicit ? [explicit] : DEFAULT_GAME_DIRS;
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'StarRupture', 'Content', 'Paks'))) return candidate;
  }
  throw new Error(
    `Could not find a StarRupture install. Pass --game-dir <path> pointing at the folder containing StarRupture/Content/Paks.`,
  );
}

// "/Game/Chimera/Items/I_PseudorubberInsulator" -> "Pseudorubber Insulator"
export function assetNameToDisplayName(assetPath) {
  const leaf = assetPath.split('/').pop() ?? assetPath;
  const bare = leaf.replace(/^(I|CR|CRC|BD|DA)_/, '');
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// The published dataset models upgraded machines as a "v.2" alternate of the base
// machine rather than as a separate building.
export function isTieredVariant(buildingName) {
  return / v\.\d+$/.test(buildingName);
}

// Scans an export payload for the recipe's input/output entries. The surrounding struct
// uses unversioned serialization (no property names), but the entries themselves are a
// fixed, self-consistent 10-byte shape, and the array length sits immediately before the
// first entry. That is enough to read inputs, output, and duration positionally.
export function decodeRecipeEntries(payload, resolveObjectRef) {
  const entries = [];
  for (let offset = 0; offset + ENTRY_SIZE <= payload.length; offset++) {
    if (payload.readUInt16LE(offset) !== ENTRY_HEADER) continue;
    const ref = payload.readInt32LE(offset + 2);
    const count = payload.readInt32LE(offset + 6);
    if (ref >= 0 || count <= 0 || count > MAX_REASONABLE_COUNT) continue;
    const name = resolveObjectRef(ref);
    if (!isItemReference(name)) continue;

    const previous = entries[entries.length - 1];
    if (previous && previous.offset + ENTRY_SIZE !== offset) entries.length = 0;
    entries.push({ offset, ref, count, name });
    offset += ENTRY_SIZE - 1;
  }

  if (entries.length < 2) return null;

  const first = entries[0];
  const declaredInputCount = first.offset >= 4 ? payload.readInt32LE(first.offset - 4) : -1;
  const looksDeclared = declaredInputCount > 0 && declaredInputCount <= MAX_REASONABLE_INPUTS;

  // The array length is serialized immediately before the first entry. If it disagrees with
  // what the scan found, an entry was missed and guessing would silently promote an input to
  // the output slot, so refuse to decode instead.
  if (looksDeclared && declaredInputCount >= entries.length) return null;

  const inputCount = looksDeclared ? declaredInputCount : entries.length - 1;
  const inputs = entries.slice(0, inputCount);
  const output = entries[inputCount];
  if (!output) return null;

  // The craft duration is the float immediately following the output entry. Unversioned
  // property serialization omits values that match the class default, so an absent or
  // nonsensical float means the recipe uses the default duration.
  const timeOffset = output.offset + ENTRY_SIZE;
  const time = timeOffset + 4 <= payload.length ? payload.readFloatLE(timeOffset) : null;
  const usable = Number.isFinite(time) && time > 0 && time < 10000;

  return {
    inputs: inputs.map((entry) => ({ item: entry.name, count: entry.count })),
    output: { item: output.name, count: output.count },
    time: usable ? Number(time.toFixed(4)) : DEFAULT_CRAFT_TIME,
    defaultedTime: !usable,
  };
}

// Craftable items are I_ assets, but they are not all under /Items/ (ammo lives in
// /Chimera/Weapons/AmmoTypes/, for example).
function isItemReference(objectPath) {
  if (!objectPath) return false;
  const leaf = objectPath.split('/').pop();
  return leaf.startsWith('I_');
}

function collectRecipeAssets(container) {
  const recipes = [];
  const collections = [];
  for (const assetPath of container.paths) {
    if (!assetPath.startsWith(CRAFTING_PREFIX) || !assetPath.endsWith('.uasset')) continue;
    const leaf = assetPath.slice(CRAFTING_PREFIX.length);
    if (leaf.includes('/')) continue;
    if (leaf.startsWith('CR_')) recipes.push(assetPath);
    else if (leaf.startsWith('CRC_')) collections.push(assetPath);
  }
  return { recipes, collections };
}

// Each CRC_<Building> asset imports the CR_ recipes that building can produce, so the
// building assignment falls out of the import table without decoding any properties.
function buildRecipeToBuildingMap(container, collections) {
  const map = new Map();
  for (const assetPath of collections) {
    const buildingAsset = assetPath.split('/').pop().replace(/\.uasset$/, '');
    const pkg = parseZenPackage(container.read(assetPath));
    for (const imported of pkg.importedPackageNames) {
      if (!imported.includes('/Crafting/CR_')) continue;
      const recipeName = imported.split('/').pop();
      if (!map.has(recipeName)) map.set(recipeName, []);
      map.get(recipeName).push(buildingAsset);
    }
  }
  return map;
}

async function loadOverrides() {
  try {
    return JSON.parse(await readFile(OVERRIDES_PATH, 'utf8'));
  } catch {
    return { items: {}, buildings: {}, ignoreRecipes: [] };
  }
}

// The display names players actually see live in the localization string tables, keyed by
// "<AssetSuffix>_name". Asset names lag behind renames (and carry dev-only spellings), so
// the string tables are the source of truth for naming. Items added by later content
// updates land in their own tables, so merge every table rather than just Items.uasset.
function loadDisplayNames(container) {
  const byKey = new Map();
  for (const assetPath of container.paths) {
    if (!assetPath.startsWith(STRING_TABLE_PREFIX) || !assetPath.endsWith('.uasset')) continue;
    let pairs;
    try {
      pairs = parseStringTablePairs(exportPayload(parseZenPackage(container.read(assetPath))));
    } catch {
      continue;
    }
    for (const [key, value] of pairs) {
      if (!byKey.has(key)) byKey.set(key, value);
    }
  }

  // Asset suffixes and localization keys disagree on casing/punctuation often enough
  // (PseudoRubber vs Pseudorubber, Anti-Radiation vs AntiRadiation) to warrant a
  // normalized lookup as a second chance before falling back to the asset name.
  const byNormalizedKey = new Map();
  for (const [key, value] of byKey) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!byNormalizedKey.has(normalized)) byNormalizedKey.set(normalized, value);
  }

  return {
    lookup(suffix) {
      const key = `${suffix}_name`;
      const exact = byKey.get(key);
      if (exact) return exact;
      const normalized = byNormalizedKey.get(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (normalized) return normalized;

      // Several items only carry a localized name on their "<Suffix>Blueprint" research
      // entry (e.g. SilicaSandBlueprint_name -> "Synthetic Silicon - Blueprint"). The
      // asset names are dev-era internal names, so this recovers the player-facing one.
      const blueprint =
        byKey.get(`${suffix}Blueprint_name`) ??
        byNormalizedKey.get(`${suffix}blueprint_name`.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (blueprint) return blueprint.replace(/\s*-\s*Blueprint$/i, '');

      return null;
    },
  };
}

export async function extractRecipes({ gameDir } = {}) {
  const root = findGameDir(gameDir);
  const paks = path.join(root, 'StarRupture', 'Content', 'Paks');
  const container = openContainer(
    path.join(paks, 'pakchunk0-Windows.utoc'),
    path.join(paks, 'pakchunk0-Windows.ucas'),
  );

  try {
    const overrides = await loadOverrides();
    const displayNames = loadDisplayNames(container);
    const unnamedItems = new Set();

    const itemName = (assetPath) => {
      const leaf = assetPath.split('/').pop();
      if (overrides.items?.[leaf]) return overrides.items[leaf];
      const localized = displayNames.lookup(leaf.replace(/^I_/, ''));
      if (localized) return localized.trim();

      unnamedItems.add(leaf);
      return assetNameToDisplayName(assetPath);
    };

    const buildingName = (asset) => {
      if (overrides.buildings?.[asset]) return overrides.buildings[asset];
      // Upgraded machines are separate CRC_<Name>Tier<N> collections but are presented as
      // "v.N" variants of their base machine.
      const tier = asset.match(/^(CRC_.+?)Tier(\d+)$/);
      if (tier) return `${buildingName(tier[1])} v.${tier[2]}`;
      const localized = displayNames.lookup(asset.replace(/^CRC_/, ''));
      return localized ? localized.trim() : assetNameToDisplayName(asset);
    };

    const { recipes: recipeAssets, collections } = collectRecipeAssets(container);
    const buildingMap = buildRecipeToBuildingMap(container, collections);
    const ignored = new Set(overrides.ignoreRecipes ?? []);
    const ignoredBuildings = new Set(overrides.ignoreBuildings ?? []);
    const ignoredItems = new Set(overrides.ignoreItems ?? []);
    const deprioritized = new Set(overrides.deprioritizeBuildings ?? []);

    // A single item can be produced by several machines (notably the v.1/v.2 tiers and the
    // handcrafting stations), each as its own CR_ asset. Collect every candidate first and
    // resolve a winner per item afterwards, instead of letting later assets clobber
    // earlier ones.
    const skipped = [];
    const candidates = [];
    for (const assetPath of recipeAssets) {
      const assetName = assetPath.split('/').pop().replace(/\.uasset$/, '');
      if (ignored.has(assetName)) continue;

      const pkg = parseZenPackage(container.read(assetPath));
      const decoded = decodeRecipeEntries(exportPayload(pkg), (ref) => pkg.resolveObjectRef(ref));
      if (!decoded || decoded.inputs.length === 0 || !decoded.time) {
        skipped.push({ asset: assetName, reason: decoded ? 'incomplete fields' : 'no recipe entries' });
        continue;
      }

      const buildings = (buildingMap.get(assetName) ?? []).filter(
        (asset) => !ignoredBuildings.has(asset),
      );
      if (buildings.length === 0) {
        skipped.push({ asset: assetName, reason: 'no building collection references it' });
        continue;
      }

      const inputs = {};
      for (const input of decoded.inputs) inputs[itemName(input.item)] = input.count;

      if (ignoredItems.has(decoded.output.item.split('/').pop())) {
        skipped.push({ asset: assetName, reason: 'placeholder output item' });
        continue;
      }

      for (const buildingAsset of buildings) {
        candidates.push({
          asset: assetName,
          item: itemName(decoded.output.item),
          building: buildingName(buildingAsset),
          secondary: deprioritized.has(buildingAsset),
          inputs,
          output: decoded.output.count,
          time: decoded.time,
        });
      }
    }

    const byItem = new Map();
    for (const candidate of candidates) {
      if (!byItem.has(candidate.item)) byItem.set(candidate.item, []);
      byItem.get(candidate.item).push(candidate);
    }

    const extracted = {};
    const ambiguous = [];
    for (const [item, group] of byItem) {
      const base = group
        .filter((entry) => !isTieredVariant(entry.building))
        .sort((a, b) => Number(a.secondary) - Number(b.secondary));
      const upgraded = group.filter((entry) => isTieredVariant(entry.building));
      const primary = base[0] ?? upgraded[0];
      // Only treat an upgraded machine as the "v.N" alternate when it is the upgrade of the
      // primary machine; an unrelated tiered machine that happens to craft the same item is
      // a separate production option, not a tier of this one.
      const alternate =
        base.length > 0
          ? upgraded.find((entry) => entry.building.startsWith(`${primary.building} v.`))
          : undefined;

      if (base.length > 1) {
        const buildings = [...new Set(base.map((entry) => entry.building))];
        if (buildings.length > 1) ambiguous.push(`${item}: produced by ${buildings.join(', ')}`);
      }

      extracted[item] = {
        inputs: primary.inputs,
        output: primary.output,
        time: primary.time,
        building: primary.building,
      };
      if (alternate) {
        extracted[item].altBuilding = {
          building: alternate.building,
          inputs: alternate.inputs,
          output: alternate.output,
          time: alternate.time,
        };
      }
    }

    return { extracted, skipped, ambiguous, unnamedItems: [...unnamedItems], gameDir: root };
  } finally {
    container.close();
  }
}

function diffDatasets(extracted, current) {
  const changed = [];
  const onlyInGame = [];
  const onlyInCurrent = [];

  for (const [name, recipe] of Object.entries(extracted)) {
    const existing = current[name];
    if (!existing) {
      onlyInGame.push(name);
      continue;
    }
    const differences = [];
    const allInputs = new Set([...Object.keys(recipe.inputs), ...Object.keys(existing.inputs)]);
    for (const input of allInputs) {
      const before = existing.inputs[input];
      const after = recipe.inputs[input];
      if (before !== after) differences.push(`${input}: ${before ?? '-'} -> ${after ?? '-'}`);
    }
    if (existing.output !== recipe.output) differences.push(`output: ${existing.output} -> ${recipe.output}`);
    if (Math.abs((existing.time ?? 0) - recipe.time) > 0.001) {
      differences.push(`time: ${existing.time} -> ${recipe.time}`);
    }
    if (differences.length > 0) changed.push({ name, differences });
  }

  for (const name of Object.keys(current)) {
    if (!extracted[name]) onlyInCurrent.push(name);
  }
  return { changed, onlyInGame, onlyInCurrent };
}

function stripInternalFields(extracted) {
  return Object.fromEntries(
    Object.keys(extracted)
      .sort()
      .map((name) => {
        const { _asset, _buildings, ...recipe } = extracted[name];
        return [name, recipe];
      }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const gameDirIndex = args.indexOf('--game-dir');
  const jsonIndex = args.indexOf('--json');
  const shouldWrite = args.includes('--write');

  const { extracted, skipped, ambiguous, unnamedItems, gameDir } = await extractRecipes({
    gameDir: gameDirIndex >= 0 ? args[gameDirIndex + 1] : undefined,
  });

  console.log(`Game install: ${gameDir}`);
  console.log(`Extracted ${Object.keys(extracted).length} recipes from the cooked game data.`);
  if (unnamedItems.length > 0) {
    console.log(`\n${unnamedItems.length} item(s) had no localized name (fell back to the asset name):`);
    console.log(`  ${unnamedItems.join(', ')}`);
  }
  if (ambiguous.length > 0) {
    console.log(`\n${ambiguous.length} item(s) are produced by more than one base machine:`);
    for (const entry of ambiguous) console.log(`  - ${entry}`);
  }
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} asset(s):`);
    for (const entry of skipped.slice(0, 20)) console.log(`  - ${entry.asset}: ${entry.reason}`);
    if (skipped.length > 20) console.log(`  ...and ${skipped.length - 20} more`);
  }

  const current = JSON.parse(await readFile(RECIPES_PATH, 'utf8'));
  const { changed, onlyInGame, onlyInCurrent } = diffDatasets(extracted, current);

  console.log(`\nAgainst the published dataset (${Object.keys(current).length} recipes):`);
  console.log(`  ${changed.length} recipe(s) differ`);
  console.log(`  ${onlyInGame.length} present only in the game data`);
  console.log(`  ${onlyInCurrent.length} present only in the published data`);

  if (changed.length > 0) {
    console.log('\nChanged recipes:');
    for (const entry of changed) console.log(`  ${entry.name}: ${entry.differences.join(', ')}`);
  }
  if (onlyInCurrent.length > 0) {
    console.log(`\nOnly in published data: ${onlyInCurrent.join(', ')}`);
  }

  const dataset = stripInternalFields(extracted);

  if (jsonIndex >= 0) {
    await writeFile(args[jsonIndex + 1], JSON.stringify(dataset, null, 2) + '\n', 'utf8');
    console.log(`\nWrote raw extraction to ${args[jsonIndex + 1]}`);
  }

  if (shouldWrite) {
    validateRecipeDataset(dataset, { minimumCount: 50 });
    await writeFile(RECIPES_PATH, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
    console.log(`\nWrote ${Object.keys(dataset).length} recipes to ${path.relative(process.cwd(), RECIPES_PATH)}`);
  } else {
    console.log('\nDry run. Re-run with --write to update data/recipes.json.');
  }
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
