# StarRupture Crafting Calculator

A web-based calculator for planning and optimizing production chains in **StarRupture**, the sci-fi factory-building game. This tool helps players determine machine counts, input/output rates, rail requirements, and raw extraction needs for any item at any throughput.

Maintained by GGforReals.

## 🔧 Features

- Full production chain breakdown by crafting level, with an interactive pan/zoom graph
- Simple view groups machines by product; Complex view expands individual machines and their pooled ingredient feeds. Single-machine steps omit redundant numbering. Graph detail is a session-only choice, not stored in shared links.
- Click or tap a graph node to pulse it and its direct inputs; click again, click the background, or press Escape to clear. Enter and Space also select nodes, and reduced-motion users receive a static highlight
- Machine type, output rate, and quantity calculations
- **Per-item machine tier toggles (v1 / v2)** — click once to switch standard or upgraded buildings for each production step where both recipes exist; fixed-version machines have an empty tier cell
- Machine Version selects all v1 or all v2 (where available) when Calculate generates the plan; changing the version waits for Calculate and resets individual overrides when applied
- Input material flow rates per minute
- Rail throughput selector — v1 through v5 (120 / 240 / 480 / 750 / 1500 per minute)
- Auto/Manual rail planning: minimum suggested tiers for shared traffic segments, bypasses, and final output, with compact graph labels and material-flow tooltips. See [RAIL_PLANNING.md](RAIL_PLANNING.md) for routing assumptions and capacity limitations.
- Machine input nodes are sized from aggregate ingredient demand per installed machine; shared rail segments are sized independently from all traffic crossing them.
- Rail Connector junctions and advisory Modulator candidates for rail-count transitions in Complex view. These are steady-state planning estimates, not a verified factory blueprint or load-balancing simulation.
- Complex expansion is guarded by estimated node and pooled-route work, rather than a fixed machine limit. Expensive plans retain the grouped graph with a notice.
- Raw ore extraction breakdown (Impure / Normal / Pure), tier-aware for Ore Excavator v1 vs v2
- Production and per-resource Ore Excavator tier changes update the displayed plan immediately, including its graph, machine counts, material requirements, and shareable link
- Shareable links that preserve item, rate, rail, and machine tier settings
- Mobile controls with touch-sized targets and horizontally scrolling tables with pinned production item names
- Dark mode toggle for visual comfort
- Instant browser access — no install required

## 🚀 Live Site

Access the calculator here:  
**[https://starrupturecraftingcalculator.com](https://starrupturecraftingcalculator.com)**

## 🔄 Recipe Data

`data/recipes.json` is extracted directly from the installed game by
[scripts/extract-game-recipes.mjs](scripts/extract-game-recipes.mjs). The game's own cooked data is the only
authoritative source: third-party sites can lag behind a game update by weeks, which is exactly what happened
after the Update 2 recipe rebalance.

The extractor:
- Reads the UE5 IoStore containers (`pakchunk0-Windows.utoc` / `.ucas`) in place, with no dependencies and
  without unpacking or modifying the game install
- Decodes every `CR_*` recipe asset for its ingredients, amounts, output amount and craft duration
- Derives the producing machine from the `CRC_*` collection assets, which list the recipes each machine offers
- Resolves player-facing names from the game's localization string tables — internal asset names are dev names
  and are frequently misleading (`I_UberOil` is Plastic, and the `CRC_Refinery`/`CRC_Pressurizer` collections
  belong to the opposite buildings)
- Attaches an alternate recipe (`altBuilding`) for items craftable in both a v.1 and v.2 tier machine,
  powering the per-item machine tier choices
- Applies the hand-verified fixups in [scripts/game-extract-overrides.json](scripts/game-extract-overrides.json)
  for names that follow no derivable convention, and to exclude scenario/placeholder content

Only numeric recipe data is read — no art, icons or other game assets.

Because this needs the game installed, it is run locally and the result is committed:

```bash
npm install
npm run extract-game-recipes            # dry run: reports what would change
npm run extract-game-recipes -- --write # update data/recipes.json
```

It finds a Steam install automatically; pass `--game-dir "D:\path\to\StarRupture"` if yours is elsewhere.
Re-run it after each game update, review the diff, then commit.

### Website cross-check

[scripts/scrape-recipes.mjs](scripts/scrape-recipes.mjs) still scrapes
[starrupture.tools](https://starrupture.tools) with Playwright, but it is now only a cross-check — it never
publishes. The weekly `.github/workflows/cross-check-recipes.yml` workflow runs it and reports how far the
site has drifted from the committed game data in the run summary. If the site blocks or breaks the scrape,
the run fails loudly rather than silently keeping the previous dataset.

```bash
npx playwright install --with-deps chromium
npm run scrape-recipes
```

This replaces the previous Google Apps Script + Google Sheet + Cloudflare Worker pipeline, which is no longer used.

## Tests

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the security review, completed checks, and unresolved hosting/third-party-script risks. Recipe data is validated in the browser, scraper, and publishing workflow.

Run `npm test` after installing dependencies and Chromium. The browser regression test covers machine versions, live mixed production and extraction tiers, isolation from pending setup edits, shared links (including legacy blanket-tier links), invalid overrides, Clear, and mobile layout, scroll, and focus preservation.
Graph tests cover direct-input selection, raw resources, recipe redraws, keyboard activation, reduced motion, and mouse/touch panning without accidental selection.
Rail tests also cover pooled feed conservation, graph modes, work-based expansion limits, rail-count transition hints, label bounds and spacing, and vertical labels attached to their own spans. Short machine-to-spine connector stubs intentionally have no inline label; each segment retains its hover details.

## 🐛 Issues, Ideas, or Corrections

If you spot incorrect data, encounter a bug, or want to suggest a feature, open an issue on this repository
or use the contact link in the calculator's Info panel.
