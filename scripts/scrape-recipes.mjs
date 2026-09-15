// scrape-recipes.mjs
// Rebuilds data/recipes.json by scraping https://starrupture.tools directly.
// Replaces the old Google Apps Script + Cloudflare Worker pipeline.
//
// Usage: node scripts/scrape-recipes.mjs
// Requires: npm install, then `npx playwright install --with-deps chromium`

import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'recipes.json');
const MANUAL_RECIPES_PATH = path.join(__dirname, 'manual-recipes.json');

const SEARCH_API = 'https://starrupture.tools/api/search';
const NAV_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 350;
const MAX_RETRIES = 2;

// Buildings are only treated as valid factory machines if the site categorizes them as
// one of these. "survival" (e.g. Basic Item Printer) are player crafting stations, and
// "unknown"/other categories are buildings with no assigned production role yet.
// This replaces the old hardcoded HARD_SKIP_SLUGS/SKIP_MACHINES lists from the legacy
// Apps Script pipeline, which went stale as the game added new buildings and items —
// junk/placeholder items are now excluded naturally because they simply have no
// Crafting section or no assigned building on the site, not via a static list.
const ALLOWED_BUILDING_CATEGORIES = new Set(['crafting', 'processing', 'temperature']);

// Known typos on starrupture.tools itself (not scraping errors) that are unlikely to
// ever get fixed upstream. Applied to both recipe names and input names.
const NAME_CORRECTIONS = {
  'Scafolding': 'Scaffolding',
};

function correctName(name) {
  return NAME_CORRECTIONS[name] || name;
}

function correctInputs(inputs) {
  return Object.fromEntries(Object.entries(inputs).map(([name, qty]) => [correctName(name), qty]));
}

function applyNameCorrections(recipes) {
  const corrected = {};
  for (const [name, recipe] of Object.entries(recipes)) {
    const fixed = { ...recipe, inputs: correctInputs(recipe.inputs) };
    if (fixed.altBuilding) {
      fixed.altBuilding = { ...fixed.altBuilding, inputs: correctInputs(fixed.altBuilding.inputs) };
    }
    corrected[correctName(name)] = fixed;
  }
  return corrected;
}

// Machine families that exist in both a v.1 and v.2 building, each with its own
// recipe list. Used to attach an "altBuilding" variant so the frontend can offer
// a v1/v2 toggle instead of only ever showing the tier the item page picks as canonical.
const TIERED_BUILDING_SLUGS = {
  'Fabricator': 'crafter',
  'Fabricator v.2': 'crafter-tier2',
  'Furnace': 'furnace',
  'Furnace v.2': 'furnace-tier2',
  'Compounder': 'synthetizer',
  'Compounder v.2': 'synthetizer-tier2',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBuildingCategories() {
  const resp = await fetch(SEARCH_API, { headers: { 'User-Agent': 'sr-crafting-calculator-scraper' } });
  if (!resp.ok) throw new Error(`Search API returned ${resp.status}`);
  const entries = await resp.json();
  const categoryByName = new Map();
  for (const e of entries) {
    if (e.type !== 'building') continue;
    // If a building name maps to multiple categories (dupes/variants), prefer an allowed one.
    const existing = categoryByName.get(e.name);
    if (!existing || (!ALLOWED_BUILDING_CATEGORIES.has(existing) && ALLOWED_BUILDING_CATEGORIES.has(e.category))) {
      categoryByName.set(e.name, e.category);
    }
  }
  return categoryByName;
}

async function fetchItemList() {
  const resp = await fetch(SEARCH_API, { headers: { 'User-Agent': 'sr-crafting-calculator-scraper' } });
  if (!resp.ok) throw new Error(`Search API returned ${resp.status}`);
  const entries = await resp.json();
  const seen = new Set();
  return entries.filter((e) => {
    if (e.type !== 'item' || e.category !== 'resource') return false;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

// Runs in the browser context against a single item page.
function extractCrafting() {
  const heading = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent.trim() === 'Crafting');
  if (!heading) return null;
  const section = heading.closest('section');
  const content = section?.querySelector('[data-slot="card-content"]');
  if (!content) return null;

  const result = { building: null, inputs: {}, outputQty: 1, time: null };
  for (const group of Array.from(content.children)) {
    const label = group.querySelector('h3')?.textContent.trim();
    if (label === 'Building') {
      const a = group.querySelector('a[href^="/buildings/"]');
      result.building = a ? a.textContent.trim() : null;
    } else if (label === 'Inputs') {
      for (const sec of Array.from(group.querySelectorAll('section'))) {
        const a = sec.querySelector('a[href^="/items/"]');
        if (!a) continue;
        const qtyText = sec.querySelector('div.ml-auto')?.textContent.trim() ?? 'x1';
        result.inputs[a.textContent.trim()] = parseInt(qtyText.replace(/^x/i, ''), 10) || 1;
      }
    } else if (label === 'Output') {
      const qtyText = group.querySelector('section div.ml-auto')?.textContent.trim() ?? 'x1';
      result.outputQty = parseInt(qtyText.replace(/^x/i, ''), 10) || 1;
    } else if (label === 'Duration') {
      const match = group.querySelector('p')?.textContent.match(/([\d.]+)\s*seconds?/);
      result.time = match ? parseFloat(match[1]) : null;
    }
  }
  return result;
}

async function scrapeItem(page, item) {
  const url = `https://starrupture.tools${item.url}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(500);
      return await page.evaluate(extractCrafting);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`  ! failed to scrape ${item.name} (${item.id}): ${err.message}`);
        return null;
      }
      await sleep(1000);
    }
  }
  return null;
}

// Runs in the browser context against a building page's Crafting table.
// Returns one row per item that building can produce.
function extractBuildingRecipes() {
  const heading = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent.trim() === 'Crafting');
  if (!heading) return [];
  const content = heading.closest('section')?.querySelector('[data-slot="card-content"]');
  if (!content) return [];

  return Array.from(content.querySelectorAll('tbody tr')).map((row) => {
    const cells = row.querySelectorAll('td');
    const outputSection = cells[0]?.querySelector('section');
    const itemName = outputSection?.querySelector('a[href^="/items/"]')?.textContent.trim() ?? null;
    const outputQtyText = outputSection?.querySelector('div.ml-auto')?.textContent.trim() ?? 'x1';

    const inputs = {};
    for (const sec of Array.from(cells[1]?.querySelectorAll('section') ?? [])) {
      const a = sec.querySelector('a[href^="/items/"]');
      if (!a) continue;
      const qtyText = sec.querySelector('div.ml-auto')?.textContent.trim() ?? 'x1';
      inputs[a.textContent.trim()] = parseInt(qtyText.replace(/^x/i, ''), 10) || 1;
    }

    return {
      itemName,
      inputs,
      output: parseInt(outputQtyText.replace(/^x/i, ''), 10) || 1,
      time: parseFloat(cells[2]?.textContent.trim()) || null,
    };
  }).filter((r) => r.itemName);
}

async function scrapeBuildingRecipes(page, buildingName, slug) {
  const url = `https://starrupture.tools/buildings/${slug}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(500);
      return await page.evaluate(extractBuildingRecipes);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`  ! failed to scrape building ${buildingName} (${slug}): ${err.message}`);
        return [];
      }
      await sleep(1000);
    }
  }
  return [];
}

async function main() {
  console.log('Fetching item list and building categories...');
  const [items, buildingCategories] = await Promise.all([fetchItemList(), fetchBuildingCategories()]);
  console.log(`Found ${items.length} candidate items. Scraping crafting data...`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const recipes = {};

  for (const [index, item] of items.entries()) {
    const crafting = await scrapeItem(page, item);
    const hasInputs = crafting && Object.keys(crafting.inputs).length > 0;
    const validQuantities =
      hasInputs &&
      crafting.time > 0 &&
      crafting.outputQty > 0 &&
      Object.values(crafting.inputs).every((qty) => qty > 0);
    const buildingIsAllowed = crafting?.building && ALLOWED_BUILDING_CATEGORIES.has(buildingCategories.get(crafting.building));

    if (crafting && buildingIsAllowed && validQuantities) {
      recipes[item.name] = {
        inputs: crafting.inputs,
        output: crafting.outputQty,
        time: crafting.time,
        building: crafting.building,
      };
    }
    if ((index + 1) % 25 === 0) {
      console.log(`  ...${index + 1}/${items.length} processed`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await browser.close();

  // Fill in items the site doesn't classify as craftable resources (e.g. ammo),
  // but only where the live scrape didn't already produce that recipe.
  const manualRecipes = JSON.parse(await readFile(MANUAL_RECIPES_PATH, 'utf8'));
  let manualAddedCount = 0;
  for (const [name, recipe] of Object.entries(manualRecipes)) {
    if (!recipes[name]) {
      recipes[name] = recipe;
      manualAddedCount++;
    }
  }
  if (manualAddedCount > 0) {
    console.log(`Added ${manualAddedCount} manual recipe(s) not found on the site.`);
  }

  // Attach alternate-tier recipes for items produced by a dual-tier machine family
  // (e.g. Furnace vs Furnace v.2), so the frontend can offer a v1/v2 toggle.
  console.log('Scraping tiered building pages for v1/v2 alternates...');
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage();
  const buildingRecipesByName = {};
  for (const [buildingName, slug] of Object.entries(TIERED_BUILDING_SLUGS)) {
    const rows = await scrapeBuildingRecipes(page2, buildingName, slug);
    buildingRecipesByName[buildingName] = Object.fromEntries(rows.map((r) => [r.itemName, r]));
    await sleep(REQUEST_DELAY_MS);
  }
  await browser2.close();

  let altAddedCount = 0;
  for (const [name, recipe] of Object.entries(recipes)) {
    const family = recipe.building.replace(/ v\.\d+$/, '');
    const siblingBuilding = recipe.building === family ? `${family} v.2` : family;
    const siblingRows = buildingRecipesByName[siblingBuilding];
    const siblingRow = siblingRows?.[name];
    if (siblingRow) {
      recipe.altBuilding = {
        building: siblingBuilding,
        inputs: siblingRow.inputs,
        output: siblingRow.output,
        time: siblingRow.time,
      };
      altAddedCount++;
    }
  }
  if (altAddedCount > 0) {
    console.log(`Attached ${altAddedCount} alternate-tier recipe(s).`);
  }

  const correctedRecipes = applyNameCorrections(recipes);
  const sorted = Object.fromEntries(Object.keys(correctedRecipes).sort().map((k) => [k, correctedRecipes[k]]));
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  console.log(`Done. Wrote ${Object.keys(sorted).length} recipes to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
