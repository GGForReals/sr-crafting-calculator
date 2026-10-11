// app.js - Crafting calculator and interactive production graph
// - loadRecipes: data-only (no DOM mutations)
// - init: canonical initializer, populates UI and wires handlers
// - Full renderGraph and zoom/pan implementations restored from banked code
// - Guards against internal keys starting with "_"
// - Non-invasive safety nets only

'use strict';

/* ===============================
   Configuration & Constants
   =============================== */
const MACHINE_COL_WIDTH = 220;
const GRAPH_ROW_HEIGHT = 120;
const GRAPH_CONTENT_PAD = 64;

const MACHINE_COLORS = {
  "Smelter":      "#e67e22",
  "Furnace":      "#d63031",
  "Fabricator":   "#0984e3",
  "Mega Press":   "#6c5ce7",
  "Assembler":    "#00b894",
  "Refinery":     "#e84393",
  "Compounder":   "#00cec9",
  "Pyro Forge":   "#a55eea",
  "Constructorizer v.2": "#f1c40f",
  "Pressurizer":  "#4b7bec",
  "Fabricator v.2": "#3f8fe0",
  "Furnace v.2":    "#eb6b6b",
  "Compounder v.2": "#33e0da",
  "Constructorizer": "#8d6e63",
  "Facturer":       "#34495e"
};

// Confirmed via community comments on starrupture.tools (items per minute, per purity).
const ORE_EXCAVATOR_RATES = {
  v1: { impure: 60, normal: 120, pure: 240 },
  v2: { impure: 180, normal: 300, pure: 480 }
};

const SPECIAL_EXTRACTORS = {
  "Helium-3": 240,
  "Goethite Ore": 400,
  "Sulphur Ore": 240
};

const DRAG_THRESHOLD_PX = 8;
const TOUCH_THRESHOLD_PX = 12;
const PULSE_STAGGER_MS = 90;

const FORCED_RAW_ORES = ['Calcium Ore', 'Titanium Ore', 'Wolfram Ore'];
const LEFT_OF_CONSUMER_RAWS = ['Helium-3', 'Sulphur Ore'];
const BBM_ID = 'Basic Building Material';

/* ===============================
   Globals
   =============================== */
let RECIPES = {};
let TIERS = {};

let ITEM_TIER_OVERRIDES = new Map();
let ACTIVE_PLAN = null;
let SELECTED_GRAPH_NODE = null;
let RAIL_PLANNING = null;
let GRAPH_MODE = 'simple';

function getItemTier(name) {
  return ITEM_TIER_OVERRIDES.get(name) || ACTIVE_PLAN?.tier || 'v1';
}

function renderItemTierToggle(name) {
  const selectedTier = getItemTier(name);
  const nextTier = selectedTier === 'v1' ? 'v2' : 'v1';
  return `<button type="button" class="item-tier-toggle" data-tier-item="${escapeHtml(name)}" value="${selectedTier}" aria-label="Upgraded machine for ${escapeHtml(name)}" aria-pressed="${selectedTier === 'v2'}" title="Switch ${escapeHtml(name)} to ${nextTier}">
    <span class="is-active" aria-hidden="true">${selectedTier}</span>
  </button>`;
}

function renderMachineTierToggle(name) {
  const selectedTier = getItemTier(name);
  const nextTier = selectedTier === 'v1' ? 'v2' : 'v1';
  return `<button type="button" class="machine-tier-toggle" data-tier-item="${escapeHtml(name)}" value="${selectedTier}" aria-label="${escapeHtml(name)} machine ${selectedTier}; switch to ${nextTier}" aria-pressed="${selectedTier === 'v2'}" title="Switch to ${nextTier}">${selectedTier}</button>`;
}

function isTierTwoBuilding(buildingName) {
  return /v\.\d+$/.test(buildingName || '');
}

/* ===============================
   Utilities
   =============================== */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===============================
   Theme helpers
   =============================== */
function isDarkMode() {
  if (document.documentElement.classList.contains('dark')) return true;
  if (document.body.classList.contains('dark') || document.body.classList.contains('dark-mode')) return true;
  const saved = localStorage.getItem('darkMode');
  if (saved === 'true') return true;
  if (saved === 'false') return false;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
  return false;
}

function applyThemeClass(dark) {
  if (dark) {
    document.documentElement.classList.add('dark');
    document.body.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
    document.body.classList.remove('dark');
  }
  if (typeof window._updateGraphThemeVars === 'function') {
    try { window._updateGraphThemeVars(); } catch (e) { /* ignore */ }
  } else {
    const vars = {
      '--line-color': dark ? '#dcdcdc' : '#444444',
      '--spine-color': dark ? '#bdbdbd' : '#666666',
      '--raw-edge-color': '#333333',
      '--label-box-fill': dark ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.92)',
      '--label-box-stroke': dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      '--label-text-fill': dark ? '#ffffff' : '#111111',
      '--label-text-stroke': dark ? '#000000' : '#ffffff',
      '--label-text-stroke-width': dark ? '1.0' : '0.6',
      '--anchor-dot-fill': dark ? '#ffffff' : '#2c3e50',
      '--anchor-dot-stroke': dark ? '#000000' : '#ffffff',
      '--bypass-fill': dark ? '#ffffff' : '#2c3e50',
      '--bypass-stroke': dark ? '#000000' : '#ffffff'
    };
    document.querySelectorAll('.graphWrapper').forEach(w => {
      for (const [k, v] of Object.entries(vars)) w.style.setProperty(k, v);
    });
  }
}

function setupDarkMode() {
  const toggle = document.getElementById("darkModeToggle");
  if (!toggle) return;

  const dark = isDarkMode();
  applyThemeClass(dark);
  toggle.textContent = dark ? "☀️ Light Mode" : "🌙 Dark Mode";

  toggle.addEventListener("click", () => {
    const nowDark = !document.documentElement.classList.contains('dark');
    applyThemeClass(nowDark);
    localStorage.setItem('darkMode', nowDark ? 'true' : 'false');
    toggle.textContent = nowDark ? "☀️ Light Mode" : "🌙 Dark Mode";
  });
}

/* ===============================
   Toast helper
   =============================== */
function showToast(message) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* ===============================
   Info bubble behavior
   =============================== */
(function () {
  const infoBtn = document.getElementById('infoButton');
  const infoPanel = document.getElementById('infoPanel');
  const infoClose = document.getElementById('infoClose');

  if (!infoBtn || !infoPanel) return;

  function openPanel() {
    const btnRect = infoBtn.getBoundingClientRect();
    infoPanel.style.top = (window.scrollY + btnRect.bottom + 8) + 'px';
    infoPanel.style.left = (window.scrollX + btnRect.left) + 'px';
    infoPanel.classList.add('open');
    infoPanel.setAttribute('aria-hidden', 'false');
    infoBtn.setAttribute('aria-expanded', 'true');
    infoClose.focus();
  }

  function closePanel() {
    infoPanel.classList.remove('open');
    infoPanel.setAttribute('aria-hidden', 'true');
    infoBtn.setAttribute('aria-expanded', 'false');
    infoBtn.focus();
  }

  infoBtn.addEventListener('click', function () {
    const expanded = infoBtn.getAttribute('aria-expanded') === 'true';
    if (expanded) closePanel(); else openPanel();
  });

  infoClose.addEventListener('click', closePanel);

  document.addEventListener('click', function (e) {
    if (!infoPanel.classList.contains('open')) return;
    if (infoPanel.contains(e.target) || infoBtn.contains(e.target)) return;
    closePanel();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && infoPanel.classList.contains('open')) closePanel();
  });

  window.addEventListener('resize', function () {
    if (infoPanel.classList.contains('open')) openPanel();
  });
  window.addEventListener('scroll', function () {
    if (infoPanel.classList.contains('open')) openPanel();
  });
})();

/* ===============================
   Data loading & recipe helpers
   - loadRecipes: data-only, returns RECIPES and TIERS
   =============================== */
async function fetchJson(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Fetch failed: ${url} (${resp.status})`);
  return resp.json();
}

async function loadRecipes() {
  RAIL_PLANNING = await import('./lib/railPlanning.js?v=20261011-aggregated-routing');
  const { validateRecipeDataset } = await import('./lib/recipeValidation.js');
  const localPath = "data/recipes.json";
  const remotePath = "https://srcraftingcalculations.github.io/sr-crafting-calculator/data/recipes.json";

  let data = null;
  try {
    data = validateRecipeDataset(await fetchJson(localPath));
    console.info("Loaded recipes from local data/recipes.json");
  } catch (localErr) {
    console.warn("Local recipes.json not found or failed to load, falling back to remote:", localErr);
    try {
      data = validateRecipeDataset(await fetchJson(remotePath));
      console.info("Loaded recipes from remote URL");
    } catch (remoteErr) {
      console.error("Failed to load recipes from remote URL as well:", remoteErr);
      const out = document.getElementById("outputArea");
      if (out) out.innerHTML = `<p style="color:red;">Error loading recipe data. Please try again later.</p>`;
      return {};
    }
  }

  if (!data || typeof data !== "object") {
    console.error("Invalid recipe data format");
    return {};
  }

  // Assign RECIPES and compute TIERS purely in memory
  RECIPES = data;
  TIERS = {};

  for (const [name, recipe] of Object.entries(RECIPES)) {
    if (typeof recipe?.tier === "number") TIERS[name] = recipe.tier;
    else TIERS[name] = 0;
  }

  // propagate tiers until stable (bounded passes)
  let changed = true;
  for (let pass = 0; pass < 50 && changed; pass++) {
    changed = false;
    for (const [name, recipe] of Object.entries(RECIPES)) {
      if (!recipe || !recipe.inputs) continue;
      let maxInputTier = -1;
      for (const inputName of Object.keys(recipe.inputs)) {
        const t = TIERS[inputName] ?? 0;
        if (t > maxInputTier) maxInputTier = t;
      }
      const newTier = (maxInputTier >= 0) ? (maxInputTier + 1) : 1;
      if (TIERS[name] !== newTier) {
        TIERS[name] = newTier;
        changed = true;
      }
    }
  }

  // Ensure BBM exists and is at least 0
  TIERS[BBM_ID] = TIERS[BBM_ID] ?? 0;

  window.RECIPES = RECIPES;
  window.TIERS = TIERS;
  console.info("Recipes loaded:", Object.keys(RECIPES).length, "items");
  return RECIPES;
}

/* ===============================
   Expand production chain
   =============================== */
function getRecipe(name, tier = getItemTier(name)) {
  if (!Object.hasOwn(RECIPES, name)) return null;
  const base = RECIPES[name];
  if (!base) return null;
  if (!base.altBuilding) return base;

  const wantV2 = tier === 'v2';
  const baseIsV2 = isTierTwoBuilding(base.building);
  if (wantV2 === baseIsV2) return base;

  // Preference doesn't match this recipe's tier — use the alternate-tier variant instead.
  const alt = base.altBuilding;
  return { inputs: alt.inputs, output: alt.output, time: alt.time, building: alt.building };
}

function expandChain(item, targetRate) {
  const chain = {};
  const machineTotals = {};
  const extractorTotals = {};
  const pending = {};
  const processed = {};
  const queue = [];
  const recipeDepths = new Map();
  function recipeDepth(name) {
    if (recipeDepths.has(name)) return recipeDepths.get(name);
    const recipe = getRecipe(name);
    const depth = recipe ? 1 + Math.max(0, ...Object.keys(recipe.inputs).map(recipeDepth)) : 0;
    recipeDepths.set(name, depth);
    return depth;
  }
  recipeDepth(item);

  function trackExtractor(name, rate) {
    extractorTotals[name] = (extractorTotals[name] || 0) + rate;
  }

  function enqueue(name, rate) {
    const recipe = getRecipe(name);
    if (!recipe) {
      trackExtractor(name, rate);
      if (!chain[name]) {
        chain[name] = { rate, raw: true, building: "RAW", machines: 0, inputs: {} };
      } else {
        chain[name].rate += rate;
      }
      return;
    }
    pending[name] = (pending[name] || 0) + rate;
    if (!processed[name]) queue.push(name);
  }

  enqueue(item, targetRate);

  while (queue.length > 0) {
    queue.sort((first, second) => recipeDepth(second) - recipeDepth(first));
    const current = queue.shift();
    if (processed[current]) continue;
    processed[current] = true;

    const rate = pending[current];
    const recipe = getRecipe(current);
    if (!recipe) {
      trackExtractor(current, rate);
      continue;
    }

    const craftsPerMin = rate / recipe.output;
    const outputPerMinPerMachine = (recipe.output * 60) / recipe.time;
    const machines = Math.ceil(rate / outputPerMinPerMachine);

    chain[current] = {
      rate,
      raw: false,
      building: recipe.building,
      machines,
      inputs: {}
    };

    machineTotals[recipe.building] = (machineTotals[recipe.building] || 0) + machines;

    for (const [input, qty] of Object.entries(recipe.inputs)) {
      const inputRate = craftsPerMin * qty;
      chain[current].inputs[input] = inputRate;
      enqueue(input, inputRate);
    }
  }

  return { chain, machineTotals, extractorTotals };
}

/* ===============================
   Depth computation & graph data
   =============================== */
function computeDepthsFromTiers(chain, rootItem) {
  const depths = {};
  const visiting = new Set();

  function depthFor(item) {
    if (Object.hasOwn(depths, item)) return depths[item];
    if (visiting.has(item)) throw new Error('Cyclic production chain.');
    const data = chain[item];
    if (!data || data.raw) return (depths[item] = 0);
    visiting.add(item);
    const inputDepths = Object.keys(data.inputs || {}).map(depthFor);
    depths[item] = 1 + Math.max(0, ...inputDepths);
    visiting.delete(item);
    return depths[item];
  }

  for (const item of Object.keys(chain || {})) depthFor(item);
  for (const rawName of LEFT_OF_CONSUMER_RAWS) {
    if (!chain[rawName]?.raw) continue;
    const consumers = Object.entries(chain).filter(([, data]) => Object.hasOwn(data.inputs || {}, rawName));
    if (consumers.length) depths[rawName] = Math.min(...consumers.map(([name]) => depths[name])) - 1;
  }

  return depths;
}

/* ===============================
   Zoom / pan utilities (pointer-based)
   =============================== */
function ensureResetButton() {
  let btn = document.querySelector('.graphResetButton');
  const graphArea = document.getElementById('graphArea');
  if (!graphArea) return null;

  if (btn && btn.nextElementSibling !== graphArea) {
    btn.remove();
    btn = null;
  }

  if (!btn) {
    btn = document.createElement('div');
    btn.className = 'graphResetButton';
    btn.innerHTML = `<div class="graph-mode-toggle" role="group" aria-label="Graph detail"><button type="button" data-graph-mode="simple" aria-pressed="true">Simple</button><button type="button" data-graph-mode="complex" aria-pressed="false">Complex</button></div><button id="resetViewBtn" type="button">Reset view</button><button id="toggleRailInfoBtn" type="button" aria-pressed="false">Hide rail info</button>`;
    graphArea.parentNode.insertBefore(btn, graphArea);
    btn.style.display = 'flex';
    btn.style.justifyContent = 'center';
    btn.style.alignItems = 'center';
    btn.style.padding = '8px 12px';
    btn.style.boxSizing = 'border-box';
    btn.style.background = 'transparent';
    btn.style.zIndex = '20';
    btn.style.pointerEvents = 'auto';
  }

  const railInfoBtn = btn.querySelector('#toggleRailInfoBtn');
  const modeButtons = [...btn.querySelectorAll('[data-graph-mode]')];
  for (const modeButton of modeButtons) {
    if (modeButton._graphModeBound) continue;
    modeButton._graphModeBound = true;
    modeButton.addEventListener('click', () => {
      const nextMode = modeButton.dataset.graphMode;
      if (GRAPH_MODE === nextMode || !ACTIVE_PLAN) return;
      GRAPH_MODE = nextMode;
      for (const button of modeButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.graphMode === GRAPH_MODE));
      }
      SELECTED_GRAPH_NODE = null;
      renderActivePlan();
    });
  }
  if (railInfoBtn && !railInfoBtn._railInfoToggleBound) {
    railInfoBtn._railInfoToggleBound = true;
    railInfoBtn.addEventListener('click', () => {
      const hidden = graphArea.classList.toggle('hide-rail-info');
      railInfoBtn.textContent = hidden ? 'Show rail info' : 'Hide rail info';
      railInfoBtn.setAttribute('aria-pressed', String(hidden));
    });
  }

  function syncGraphControls() {
    for (const modeButton of modeButtons) {
      const selected = modeButton.dataset.graphMode === GRAPH_MODE;
      modeButton.setAttribute('aria-pressed', String(selected));
    }
    if (railInfoBtn) {
      const hidden = graphArea.classList.contains('hide-rail-info');
      railInfoBtn.textContent = hidden ? 'Show rail info' : 'Hide rail info';
      railInfoBtn.setAttribute('aria-pressed', String(hidden));
    }
  }

  syncGraphControls();

  return btn;
}

function setupGraphZoom(containerEl, { autoFit = true, resetButtonEl = null } = {}) {
  if (!containerEl) return;

  const svg = containerEl.querySelector('svg.graphSVG');
  const zoomLayer = svg.querySelector('#zoomLayer');
  const resetBtn = resetButtonEl || document.querySelector('#resetViewBtn');

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;
  let activePointerId = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let dragThreshold = DRAG_THRESHOLD_PX;
  const touchPointers = new Map();
  let pinchDistance = 0;
  let pinchCenter = null;

  function getContentBBox() {
    try { return zoomLayer.getBBox(); } catch (e) { return { x: 0, y: 0, width: svg.clientWidth, height: svg.clientHeight }; }
  }

  function getViewSizeInSvgCoords() {
    const rect = svg.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    const style = getComputedStyle(containerEl);
    const left = Math.max(rect.left, containerRect.left + parseFloat(style.paddingLeft));
    const top = Math.max(rect.top, containerRect.top + parseFloat(style.paddingTop));
    const right = Math.min(rect.right, containerRect.right - parseFloat(style.paddingRight));
    const bottom = Math.min(rect.bottom, containerRect.bottom - parseFloat(style.paddingBottom));
    const ptTL = svg.createSVGPoint(); ptTL.x = left; ptTL.y = top;
    const ptBR = svg.createSVGPoint(); ptBR.x = right; ptBR.y = bottom;
    const svgTL = ptTL.matrixTransform(svg.getScreenCTM().inverse());
    const svgBR = ptBR.matrixTransform(svg.getScreenCTM().inverse());
    return { x: svgTL.x, y: svgTL.y, width: svgBR.x - svgTL.x, height: svgBR.y - svgTL.y };
  }

  function clampTranslation(proposedTx, proposedTy, proposedScale) {
    const bbox = getContentBBox();           // SVG coords
    const view = getViewSizeInSvgCoords();   // SVG coords

    // Fixed visible buffer (independent of zoom)
    const buffer = Math.max(12, Math.min(view.width, view.height) * 0.04);

    // Compute min/max allowed translation in SVG coords
    const minTx = view.x + buffer - (bbox.x + bbox.width) * proposedScale;
    const maxTx = view.x + view.width - buffer - bbox.x * proposedScale;

    const minTy = view.y + buffer - (bbox.y + bbox.height) * proposedScale;
    const maxTy = view.y + view.height - buffer - bbox.y * proposedScale;

    return {
      tx: Math.min(maxTx, Math.max(minTx, proposedTx)),
      ty: Math.min(maxTy, Math.max(minTy, proposedTy))
    };
  }

  function applyTransform() {
    const clamped = clampTranslation(tx, ty, scale);
    tx = clamped.tx;
    ty = clamped.ty;
    zoomLayer.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
  }

  function zoomAt(newScale, cx, cy) {
    const pt = svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

    const localX = (svgP.x - tx) / scale;
    const localY = (svgP.y - ty) / scale;

    const newTx = svgP.x - newScale * localX;
    const newTy = svgP.y - newScale * localY;

    scale = newScale;
    tx = newTx;
    ty = newTy;

    applyTransform();
  }

  function getPinchGeometry() {
    const points = [...touchPointers.values()].slice(0, 2);
    const dx = points[1].x - points[0].x;
    const dy = points[1].y - points[0].y;
    return {
      distance: Math.hypot(dx, dy),
      center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
    };
  }

  function onWheel(ev) {
    ev.preventDefault();
    const delta = -ev.deltaY;
    const factor = delta > 0 ? 1.08 : 0.92;
    const newScale = Math.min(3, Math.max(0.25, +(scale * factor).toFixed(3)));
    zoomAt(newScale, ev.clientX, ev.clientY);
  }
  svg.addEventListener('wheel', onWheel, { passive: false });

  function onPointerDown(ev) {
    if (ev.pointerType === 'touch') {
      touchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchPointers.size >= 2) {
        isPanning = false;
        activePointerId = null;
        svg._graphPointerDragged = true;
        const geometry = getPinchGeometry();
        pinchDistance = geometry.distance;
        pinchCenter = geometry.center;
        return;
      }
    } else if (!ev.isPrimary) {
      return;
    }
    if (ev.button !== 0) return;
    isPanning = true;
    svg._graphPointerDragged = false;
    activePointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    pointerStartX = ev.clientX;
    pointerStartY = ev.clientY;
    dragThreshold = ev.pointerType === 'touch' ? TOUCH_THRESHOLD_PX : DRAG_THRESHOLD_PX;
  }
  svg.addEventListener('pointerdown', onPointerDown);

  function onPointerMove(ev) {
    if (ev.pointerType === 'touch' && touchPointers.has(ev.pointerId)) {
      touchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchPointers.size >= 2) {
        const geometry = getPinchGeometry();
        if (pinchDistance > 0) {
          const p0 = svg.createSVGPoint(); p0.x = pinchCenter.x; p0.y = pinchCenter.y;
          const p1 = svg.createSVGPoint(); p1.x = geometry.center.x; p1.y = geometry.center.y;
          const svg0 = p0.matrixTransform(svg.getScreenCTM().inverse());
          const svg1 = p1.matrixTransform(svg.getScreenCTM().inverse());
          tx += svg1.x - svg0.x;
          ty += svg1.y - svg0.y;
          const newScale = Math.min(3, Math.max(0.25, scale * geometry.distance / pinchDistance));
          zoomAt(newScale, geometry.center.x, geometry.center.y);
          svg._graphPointerDragged = true;
        }
        pinchDistance = geometry.distance;
        pinchCenter = geometry.center;
        return;
      }
    }
    if (!isPanning || ev.pointerId !== activePointerId) return;
    if (!svg._graphPointerDragged) {
      if (Math.hypot(ev.clientX - pointerStartX, ev.clientY - pointerStartY) < dragThreshold) return;
      svg._graphPointerDragged = true;
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
      svg.style.cursor = 'grabbing';
    }
    const dxScreen = ev.clientX - startX;
    const dyScreen = ev.clientY - startY;
    startX = ev.clientX;
    startY = ev.clientY;

    const p0 = svg.createSVGPoint(); p0.x = 0; p0.y = 0;
    const p1 = svg.createSVGPoint(); p1.x = dxScreen; p1.y = dyScreen;
    const svg0 = p0.matrixTransform(svg.getScreenCTM().inverse());
    const svg1 = p1.matrixTransform(svg.getScreenCTM().inverse());
    const dxSvg = svg1.x - svg0.x;
    const dySvg = svg1.y - svg0.y;

    tx += dxSvg;
    ty += dySvg;
    applyTransform();
  }
  window.addEventListener('pointermove', onPointerMove);

  function onPointerEnd(ev) {
    const wasPinching = pinchDistance > 0;
    if (ev.pointerType === 'touch') touchPointers.delete(ev.pointerId);
    if (touchPointers.size >= 2) {
      const geometry = getPinchGeometry();
      pinchDistance = geometry.distance;
      pinchCenter = geometry.center;
      isPanning = false;
      activePointerId = null;
      return;
    }
    if (wasPinching && touchPointers.size === 1) {
      const [pointerId, point] = touchPointers.entries().next().value;
      pinchDistance = 0;
      pinchCenter = null;
      isPanning = true;
      activePointerId = pointerId;
      startX = pointerStartX = point.x;
      startY = pointerStartY = point.y;
      dragThreshold = TOUCH_THRESHOLD_PX;
      return;
    }
    pinchDistance = 0;
    pinchCenter = null;
    if (!isPanning || ev.pointerId !== activePointerId) return;
    isPanning = false;
    activePointerId = null;
    try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
    svg.style.cursor = 'grab';
  }
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  svg.style.cursor = 'grab';

  function computeAutoFit() {
    const bbox = getContentBBox();
    const view = getViewSizeInSvgCoords();
    if (bbox.width === 0 || bbox.height === 0) {
      scale = 1; tx = 0; ty = 0; applyTransform(); return;
    }

    const pad = 0.92;
    const scaleX = (view.width * pad) / bbox.width;
    const scaleY = (view.height * pad) / bbox.height;
    const fitScale = Math.min(scaleX, scaleY);

    scale = Math.min(3, fitScale);

    const layerW = bbox.width * scale;
    const layerH = bbox.height * scale;
    tx = view.x + (view.width - layerW) / 2 - bbox.x * scale;
    ty = view.y + (view.height - layerH) / 2 - bbox.y * scale;

    applyTransform();
  }

  function resetView() {
    computeAutoFit();
    showToast("View reset");
  }
  if (resetBtn) resetBtn.onclick = resetView;

  const autoFitFrame = autoFit ? requestAnimationFrame(() => computeAutoFit()) : null;
  if (!autoFit) applyTransform();

  containerEl._teardownGraphZoom = () => {
    if (autoFitFrame !== null) cancelAnimationFrame(autoFitFrame);
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    window.removeEventListener('pointercancel', onPointerEnd);
    if (resetBtn?.onclick === resetView) resetBtn.onclick = null;
  };

}

// Build graph nodes and logical links from the expanded chain
function buildGraphData(chain, rootItem) {
  const nodes = [];
  const links = [];
  const nodeMap = new Map();
  const depths = typeof computeDepthsFromTiers === 'function'
    ? computeDepthsFromTiers(chain, rootItem || null)
    : {};

  // Create node objects for every item in the chain
  for (const [item, data] of Object.entries(chain || {})) {
    const node = {
      id: item,
      label: item,
      kind: data.raw ? 'raw-source' : 'machine',
      raw: !!data.raw,
      building: data.building || null,
      machines: data.machines || 0,
      rate: data.rate || 0,
      inputs: Object.assign({}, data.inputs || {}),
      inputPorts: data.raw ? null : RAIL_PLANNING.recommendMachineInputPorts(
        data.inputs || {},
        Math.max(1, Math.ceil(Number(data.machines) || 1)),
        ACTIVE_PLAN?.railMode === 'manual' ? Number(ACTIVE_PLAN.rail) : null,
        ACTIVE_PLAN?.railMode === 'auto' ? Number(ACTIVE_PLAN.rail) : null
      )
    };
    nodes.push(node);
    nodeMap.set(item, node);
  }

  // Create logical links: consumer -> input
  for (const [consumer, data] of Object.entries(chain || {})) {
    const inputs = data.inputs || {};
    for (const inputName of Object.keys(inputs)) {
      // Only add links when both ends exist in the node set
      if (nodeMap.has(consumer) && nodeMap.has(inputName)) {
        links.push({ from: consumer, to: inputName, rate: inputs[inputName] });
      }
    }
  }

  // Compute depths (columns) using existing tier logic
  // Attach depth to nodes (default to 0)
  for (const n of nodes) {
    n.depth = Number.isFinite(Number(depths[n.id])) ? Number(depths[n.id]) : 0;
  }

  return { nodes, links };
}

function renderGraph(nodes, links, rootItem) {
  const nodeRadius = 22;
  const LABEL_OFFSET = 6;
  const pooled = nodes.some(node => node.machineIndex !== undefined);
  const productGroups = new Map();
  for (const node of nodes) {
    const product = node.productId || node.id;
    if (!productGroups.has(product)) productGroups.set(product, []);
    productGroups.get(product).push(node.id);
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeForLink = id => nodeById.get(id) || nodeById.get(productGroups.get(id)?.[0]);

  const BYPASS_RADIUS = 5;
  const BYPASS_Y_OFFSET = 34;

  function roundCoord(v) { return Math.round(v * 100) / 100; }

  // ---------------------------------
  // Defaults
  // ---------------------------------
  for (const n of nodes) {
    if (typeof n.depth === 'undefined') n.depth = 0;
    if (typeof n.machines === 'undefined') n.machines = 0;
  }

  // ---------------------------------
  // Normalize depths
  // ---------------------------------
  const uniqueDepths = [...new Set(nodes.map(n => Number(n.depth) || 0))].sort((a,b)=>a-b);
  const depthMap = new Map(uniqueDepths.map((d,i)=>[d,i]));
  nodes.forEach(n => n.depth = depthMap.get(Number(n.depth)) ?? 0);

  const columns = {};
  for (const n of nodes) {
    if (!columns[n.depth]) columns[n.depth] = [];
    columns[n.depth].push(n);
  }

  const depthsSorted = Object.keys(columns).map(Number).sort((a,b)=>a-b);
  const depthIndex = new Map(depthsSorted.map((d,i)=>[d,i]));

  for (const [depth, colNodes] of Object.entries(columns)) {
    const idx = depthIndex.get(Number(depth)) ?? 0;
    colNodes.sort((a,b)=>String(a.label||a.id).localeCompare(String(b.label||b.id)));
    colNodes.forEach((node,i)=>{
      node.x = roundCoord(idx * MACHINE_COL_WIDTH + 100);
      node.y = roundCoord(i * GRAPH_ROW_HEIGHT + 100);
    });
  }

  // ---------------------------------
  // Bypass detection (HELPER DOTS)
  // ---------------------------------

  const bypassOutputDepths = new Set();
  const bypassInputDepths  = new Set();

  // Links are consumer -> input
  for (const link of links) {
    const consumer = nodeForLink(link.from);
    const producer = nodeForLink(link.to);
    if (!consumer || !producer) continue;

    const gap = consumer.depth - producer.depth;

    if (gap > 1) {
      // output bypass on producer column
      bypassOutputDepths.add(producer.depth);

      // input bypass on consumer column
      bypassInputDepths.add(consumer.depth);
    }
  }

  // vertical padding for bypass dots
  const bypassExtraTop =
    (bypassOutputDepths.size || bypassInputDepths.size)
      ? BYPASS_Y_OFFSET + BYPASS_RADIUS + 12
      : 0;

  // ---------------------------------
  // ViewBox
  // ---------------------------------
  const xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const railLabelSidePad = GRAPH_CONTENT_PAD;
  const contentX = minX - nodeRadius - railLabelSidePad;
  const railLabelTopPad = 112;
  const contentY =
    minY - nodeRadius - GRAPH_CONTENT_PAD - bypassExtraTop - railLabelTopPad;
  const contentW = (maxX - minX) + nodeRadius*2 + railLabelSidePad*2;
  const contentH =
    (maxY - minY) +
    nodeRadius * 2 +
    GRAPH_CONTENT_PAD * 2 +
    bypassExtraTop +
    railLabelTopPad;

  let inner = '';

  const nodeObstacles = nodes.flatMap(node => {
    const labelWidth = Math.max(48, String(node.label || node.id).length * 7 + 20);
    const labelHeight = 13 + 6 * 2;
    const labelTop = node.y - nodeRadius - LABEL_OFFSET - labelHeight;
    return [
      { left: node.x - labelWidth / 2 - 4, right: node.x + labelWidth / 2 + 4, top: labelTop - 4, bottom: labelTop + labelHeight + 4 },
      { left: node.x - nodeRadius - 4, right: node.x + nodeRadius + 4, top: node.y - nodeRadius - 4, bottom: node.y + nodeRadius + 4 }
    ];
  });
  const nodeEndpoints = new Set(nodes.flatMap(node => [
    `${node.x - nodeRadius}:${node.y}`,
    `${node.x + nodeRadius}:${node.y}`,
    `${node.x}:${node.y - nodeRadius}`,
    `${node.x}:${node.y + nodeRadius}`
  ]));
  const productInputs = new Set(links.map(link => link.to));
  const directInputs = new Map();
  for (const link of links) {
    if (!directInputs.has(link.from)) directInputs.set(link.from, []);
    directInputs.get(link.from).push(...(pooled ? productGroups.get(link.to) || [] : [link.to]));
  }
  const railLabelObstacles = [];
  const labelClearance = 4;
  function overlapsRailLabel(bounds) {
    return railLabelObstacles.some(obstacle =>
      bounds.left < obstacle.right && bounds.right > obstacle.left &&
      bounds.top < obstacle.bottom && bounds.bottom > obstacle.top
    );
  }
  function reserveRailLabel(bounds) {
    railLabelObstacles.push({
      left: bounds.left - labelClearance,
      right: bounds.right + labelClearance,
      top: bounds.top - labelClearance,
      bottom: bounds.bottom + labelClearance
    });
  }
  function railLabelPosition(segment, label) {
    const horizontal = segment.y1 === segment.y2;
    const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    const width = label.length * 7 + 6;
    if (horizontal && length <= 20) return null;
    if (length < Math.max(70, width + labelClearance * 2 + 8)) return null;
    const inputSpine = !horizontal && nodes.some(node => node.x - 40 === segment.x1);
    const anchor = horizontal ? 'middle' : (inputSpine ? 'end' : 'start');
    const fractions = horizontal ? [0.5, 0.35, 0.65, 0.2, 0.8, 0.05, 0.95] : [0.5];
    const offsets = horizontal ? [12, 32, 52, 72, 92, 112, 132, 152, 172] : [12];
    for (const offset of offsets) {
      for (const fraction of fractions) {
        const x = horizontal
          ? segment.x1 + (segment.x2 - segment.x1) * fraction
          : segment.x1 + (inputSpine ? -offset : offset);
        const y = horizontal
          ? segment.y1 - offset
          : segment.y1 + (segment.y2 - segment.y1) * fraction;
        const left = anchor === 'middle' ? x - width / 2 : (anchor === 'end' ? x - width : x);
        const bounds = { left, right: left + width, top: y - 14, bottom: y + 2 };
        const overlapsNode = nodeObstacles.some(obstacle => bounds.left < obstacle.right && bounds.right > obstacle.left && bounds.top < obstacle.bottom && bounds.bottom > obstacle.top);
        if (overlapsNode || overlapsRailLabel(bounds)) continue;
        reserveRailLabel(bounds);
        return { x, y, anchor };
      }
    }
    return null;
  }

  const railSegments = pooled
    ? RAIL_PLANNING.buildAggregatedRailSegments(nodes, links, rootItem)
    : RAIL_PLANNING.buildRailSegments(nodes, links, rootItem);
  const manualCapacity = ACTIVE_PLAN?.railMode === 'manual' ? Number(ACTIVE_PLAN.rail) : null;
  const maxAvailableCapacity = ACTIVE_PLAN?.railMode === 'auto' ? Number(ACTIVE_PLAN.rail) : null;
  const railRecommendations = railSegments.map(segment =>
    RAIL_PLANNING.recommendRail(segment.rate, manualCapacity, maxAvailableCapacity)
  );
  const railLabelRuns = RAIL_PLANNING.groupRailLabelRuns(railSegments, railRecommendations);
  inner = railSegments.map((segment, index) => {
    if (segment.finalOutput) return '';
    const recommendation = railRecommendations[index];
    const label = `${recommendation.count > 1 ? recommendation.count + ' x ' : ''}v${recommendation.tier}`;
    const details = Object.entries(segment.flows).map(([item, rate]) => `${item}: ${Number(rate.toFixed(2))}/min`).join('; ');
    const routeDescription = segment.bypass ? 'Bypass' : 'Rail';
    const parallelHint = GRAPH_MODE === 'complex' && recommendation.count > 1
      ? ` Consider Multirail ${recommendation.count <= 3 ? '3' : '5'} support for ${recommendation.count} parallel rails; capacity is still evaluated per rail.`
      : '';
    const title = `${routeDescription} ${index + 1}: ${Number(segment.rate.toFixed(2))} items/min; ${label} (${recommendation.capacity}/min each). ${details}${parallelHint}`;
    const horizontal = segment.y1 === segment.y2;
    const midpointX = (segment.x1 + segment.x2) / 2;
    const midpointY = (segment.y1 + segment.y2) / 2;
    const isMachineConnector = nodeEndpoints.has(`${segment.x1}:${segment.y1}`) || nodeEndpoints.has(`${segment.x2}:${segment.y2}`);
    const arrow = horizontal
      ? `${midpointX + segment.direction * 7},${midpointY} ${midpointX - segment.direction * 3},${midpointY - 4} ${midpointX - segment.direction * 3},${midpointY + 4}`
      : `${midpointX},${midpointY + segment.direction * 7} ${midpointX - 4},${midpointY - segment.direction * 3} ${midpointX + 4},${midpointY - segment.direction * 3}`;
    return `<g class="rail-segment" data-rail-segment="${index}" data-node-kind="shared-rail" data-consumers="${escapeHtml(JSON.stringify(segment.consumers || []))}" data-rate="${segment.rate}" data-bypass="${segment.bypass}" data-tier="${recommendation.tier}" data-count="${recommendation.count}">
      <title>${escapeHtml(title)}</title>
      <line x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}" stroke="var(--line-color)" stroke-width="1.6" />
      <line class="rail-hit-target" x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}" stroke="transparent" stroke-width="14" />
      ${isMachineConnector ? '' : `<polygon points="${arrow}" fill="var(--line-color)" />`}
    </g>`;
  }).join('');
  const renderedRailLabels = railLabelRuns.map(run => {
    const segment = run.horizontal
      ? { x1: run.start, y1: run.fixed, x2: run.end, y2: run.fixed }
      : { x1: run.fixed, y1: run.start, x2: run.fixed, y2: run.end };
    const position = railLabelPosition(segment, run.label);
    if (!position) return '';
    const dataRun = `data-rail-run="${run.segmentIndexes.join(',')}"`;
    return `<text class="rail-tier-label" ${dataRun} x="${position.x}" y="${position.y}" text-anchor="${position.anchor}" font-size="12">${escapeHtml(run.label)}</text>`;
  }).join('');
  const renderedRailLabelCount = (renderedRailLabels.match(/class="rail-tier-label(?:\s|")/g) || []).length;
  inner += renderedRailLabels;

  const junctions = new Map();
  const endpointRailCounts = new Map();
  for (const segment of railSegments) {
    if (segment.finalOutput) continue;
    const railCount = RAIL_PLANNING.recommendRail(segment.rate, manualCapacity, maxAvailableCapacity).count;
    const endpoints = [
      [segment.x1, segment.y1],
      [segment.x2, segment.y2]
    ];
    for (const [x, y] of endpoints) {
      const touchesNode = nodeEndpoints.has(`${x}:${y}`);
      const key = `${x}:${y}`;
      if (!touchesNode) junctions.set(key, { x, y });
      if (!endpointRailCounts.has(key)) endpointRailCounts.set(key, []);
      endpointRailCounts.get(key).push(railCount);
    }
  }
  inner += [...junctions.values()].map(({ x, y }) => {
    const railCounts = endpointRailCounts.get(`${x}:${y}`) || [];
    const modulator = GRAPH_MODE === 'complex' ? RAIL_PLANNING.recommendRailModulatorForRailCounts(railCounts) : null;
    const standardTitle = 'Rail Connector: standard drone-rail join or split.';
    const hardware = modulator
      ? `Candidate: ${modulator === 'modulator3' ? 'Rail Modulator 3' : 'Rail Modulator 5'} because adjacent segments change from ${Math.min(...railCounts)} to ${Math.max(...railCounts)} parallel rails. Verify routing in-game.`
      : standardTitle;
    return `<g class="rail-junction${modulator ? ' rail-junction-candidate' : ''}" data-structure="${modulator || 'railConnector'}" data-adjacent-rail-counts="${[...new Set(railCounts)].sort((first, second) => first - second).join(',')}"${modulator ? ' pointer-events="visiblePainted"' : ' pointer-events="none"'}><title>${escapeHtml(hardware)}</title><circle cx="${x}" cy="${y}" r="5" fill="var(--bypass-fill)" stroke="var(--bypass-stroke)" stroke-width="1.2" /></g>`;
  }).join('');

  // ---------------------------------
  // Nodes
  // ---------------------------------
  for (const node of nodes) {
    const fillColor = node.raw
      ? "#f4d03f"
      : MACHINE_COLORS[node.building] || "#95a5a6";

    const rawLabel = String(node.label || node.id);
    const label = escapeHtml(rawLabel);

    const fontSize = 13;
    const padX = 10, padY = 6;
    const width = Math.max(48, rawLabel.length * 7 + padX * 2);
    const height = fontSize + padY * 2;

    // Machine count shown inside node
    const machineCount =
      Number.isFinite(Number(node.machines)) && node.machines > 0
        ? Math.ceil(node.machines)
        : "";

    inner += `
      <g class="graph-node ${node.raw ? 'graph-source' : 'graph-machine'}" data-node-kind="${node.kind}" data-id="${escapeHtml(node.id)}" data-product-id="${escapeHtml(node.productId || node.id)}" data-inputs="${escapeHtml(JSON.stringify(directInputs.get(pooled ? node.productId : node.id) || []))}" tabindex="0" role="button" aria-label="${node.raw ? `Raw source ${escapeHtml(node.id)}` : `Inspect inputs for ${escapeHtml(node.id)}`}" aria-pressed="false">
        ${node.raw ? `<title>Raw source: ${escapeHtml(node.id)}. Supplies ${Number(node.rate.toFixed(2))}/min to its recipe consumers.</title>` : ''}
        ${(node.productId || node.id) === rootItem ? (() => {
          const outputRail = RAIL_PLANNING.recommendRail(node.rate, manualCapacity, maxAvailableCapacity);
          return `<title>Final output: ${Number(node.rate.toFixed(2))} items/min; ${outputRail.count > 1 ? outputRail.count + ' x ' : ''}v${outputRail.tier} (${outputRail.capacity}/min each)</title>`;
        })() : ''}
        <!-- label box -->
        <rect
          x="${node.x - width / 2}"
          y="${node.y - nodeRadius - LABEL_OFFSET - height}"
          width="${width}"
          height="${height}"
          rx="6"
          fill="var(--label-box-fill)"
          stroke="var(--label-box-stroke)" />

        <text
          x="${node.x}"
          y="${node.y - nodeRadius - LABEL_OFFSET - height / 2}"
          text-anchor="middle"
          dy="0.35em"
          font-size="${fontSize}"
          font-weight="700"
          fill="var(--label-text-fill)">
          ${label}
        </text>

        <!-- node circle -->
        <circle
          cx="${node.x}"
          cy="${node.y}"
          r="${nodeRadius}"
          fill="${fillColor}"
          stroke="#2c3e50"
          stroke-width="2"/>

        ${!node.raw && node.inputPorts ? (() => {
          const ports = node.inputPorts;
          const displayedPortCount = ports.inputNodesPerMachine;
          const visiblePortCount = Math.min(displayedPortCount, 7);
          const portMarkers = Array.from({ length: visiblePortCount }, (_, index) => {
            const offsetY = visiblePortCount === 1 ? 0 : (index - (visiblePortCount - 1) / 2) * 5;
            const portX = node.x - Math.sqrt(Math.max(0, nodeRadius * nodeRadius - offsetY * offsetY));
            return `<circle class="machine-input-port" cx="${portX}" cy="${node.y + offsetY}" r="4" fill="${fillColor}" stroke="var(--line-color)" stroke-width="2" />`;
          }).join('');
          const overflow = displayedPortCount > visiblePortCount ? `<text class="machine-input-port-overflow" x="${node.x - nodeRadius - 3}" y="${node.y - 14}" text-anchor="end">+${displayedPortCount - visiblePortCount}</text>` : '';
          const description = `${ports.inputNodesPerMachine} input node${ports.inputNodesPerMachine === 1 ? '' : 's'} at v${ports.tier} per machine.`;
          return `<g class="machine-input-ports" data-input-nodes-per-machine="${ports.inputNodesPerMachine}" data-total-input-nodes="${ports.totalInputNodes}" data-input-rate-per-machine="${ports.ratePerMachine}" data-rail-tier="${ports.tier}" data-rail-count-per-machine="${ports.count}"><title>${description} ${Number(ports.ratePerMachine.toFixed(2))}/min aggregate inputs per machine; ${ports.totalInputNodes} total selected-tier input nodes across ${ports.machineCount} machines. Items may share each rail under pull demand.</title>${portMarkers}${overflow}</g>`;
        })() : ''}
        ${node.raw || productInputs.has(pooled ? node.productId : node.id) ? `<g class="node-output-feed" data-node-kind="${node.raw ? 'raw-source-output' : 'machine-output'}"><title>${node.raw ? 'Raw source output feed' : 'Product output feed'}: ${Number(node.rate.toFixed(2))}/min</title><circle cx="${node.x + nodeRadius}" cy="${node.y}" r="4" fill="${fillColor}" stroke="var(--line-color)" stroke-width="2" /></g>` : ''}

        <!-- machine count inside node -->
        ${
          machineCount !== ""
            ? `
            <text
              x="${node.x}"
              y="${node.y}"
              class="nodeNumber">
              ${machineCount}
            </text>
            `
            : ""
        }
        ${node.raw ? `<text class="sourceNodeMarker" x="${node.x}" y="${node.y}" text-anchor="middle" dominant-baseline="central">RAW</text>` : ''}
      </g>
    `;
  }

  return `
    <div class="graphWrapper">
      <svg class="graphSVG" data-rail-label-run-count="${railLabelRuns.length}" data-rail-label-rendered-count="${renderedRailLabelCount}" viewBox="${contentX} ${contentY} ${contentW} ${contentH}">
        <g id="zoomLayer">
          ${inner}
        </g>
      </svg>
    </div>
  `;
}

function attachNodePointerHandlers(wrapper) {
  if (!wrapper) return;
  if (wrapper._nodePointerHandlersInstalled) return;
  wrapper._nodePointerHandlersInstalled = true;

  const svg = wrapper.querySelector('svg.graphSVG');
  if (!svg) return;

  const groups = [...svg.querySelectorAll('g.graph-node[data-id]')];
  const railGroups = [...svg.querySelectorAll('g.rail-segment')];

  function updateSelection() {
    const selected = groups.find(group => group.dataset.id === SELECTED_GRAPH_NODE);
    if (!selected) SELECTED_GRAPH_NODE = null;
    const inputs = selected ? JSON.parse(selected.dataset.inputs) : [];
    for (const group of groups) {
      const isSelected = group === selected;
      const inputIndex = inputs.indexOf(group.dataset.id);
      group.classList.toggle('graph-selected', isSelected);
      group.classList.toggle('graph-input', inputIndex >= 0);
      group.classList.toggle('graph-pulsing', isSelected || inputIndex >= 0);
      group.setAttribute('aria-pressed', String(isSelected));
      group.style.setProperty('--pulse-delay', `${inputIndex >= 0 ? (inputIndex + 1) * PULSE_STAGGER_MS : 0}ms`);
    }
    for (const rail of railGroups) {
      const consumers = JSON.parse(rail.dataset.consumers || '[]');
      rail.classList.toggle('rail-selected', !!selected && consumers.includes(selected.dataset.id));
    }
    if (selected) svg.dataset.selectedNode = SELECTED_GRAPH_NODE;
    else delete svg.dataset.selectedNode;
  }

  function toggleSelection(group) {
    SELECTED_GRAPH_NODE = SELECTED_GRAPH_NODE === group.dataset.id ? null : group.dataset.id;
    updateSelection();
  }

  function activatePointerTarget(event) {
    if (svg._graphPointerDragged) return;
    const group = event.target.closest('g.graph-node[data-id]');
    if (group) {
      group.focus({ preventScroll: true });
      toggleSelection(group);
    } else {
      SELECTED_GRAPH_NODE = null;
      updateSelection();
    }
  }
  svg.addEventListener('click', event => {
    if (event.pointerType !== 'touch') activatePointerTarget(event);
  });
  svg.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') activatePointerTarget(event);
  });
  svg.addEventListener('keydown', event => {
    const group = event.target.closest('g.graph-node[data-id]');
    if (!group) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleSelection(group);
    } else if (event.key === 'Escape') {
      SELECTED_GRAPH_NODE = null;
      updateSelection();
    }
  });
  updateSelection();
}

/* ===============================
   Render table + graph
   =============================== */
function renderTable(chainObj, rootItem, rate, railSpeed) {
  const { chain, machineTotals, extractorTotals } = chainObj;

  // Build graph data (nodes + links) and ensure depths are attached
  const graph = buildGraphData(chain, rootItem);
  let nodes = graph.nodes || [];
  let links = graph.links || [];
  const complexCost = RAIL_PLANNING.estimateComplexGraphCost(nodes, links, rootItem);
  const complexLimitExceeded = GRAPH_MODE === 'complex' && complexCost.workUnits > RAIL_PLANNING.COMPLEX_GRAPH_WORK_LIMIT;
  if (GRAPH_MODE === 'complex' && !complexLimitExceeded) {
    ({ nodes, links } = RAIL_PLANNING.expandPooledMachineGraph(
      nodes,
      links,
      rootItem,
      ACTIVE_PLAN?.railMode === 'manual' ? Number(ACTIVE_PLAN.rail) : null,
      ACTIVE_PLAN?.railMode === 'auto' ? Number(ACTIVE_PLAN.rail) : null
    ));
  }

  // Compute depths using existing helper
  const depths = typeof computeDepthsFromTiers === 'function'
    ? computeDepthsFromTiers(chain, rootItem)
    : {};

  // Collect non-raw items grouped by their computed depth
  const levelGroups = {};
  for (const [item, data] of Object.entries(chain || {})) {
    if (data && data.raw) continue; // skip raw items entirely
    const depth = Number.isFinite(Number(depths[item])) ? Number(depths[item]) : 0;
    if (!levelGroups[depth]) levelGroups[depth] = [];
    levelGroups[depth].push([item, data]);
  }

  // If there are no non-raw items, ensure we still render something sensible
  const uniqueDepths = Object.keys(levelGroups).map(Number);
  if (uniqueDepths.length === 0) {
    // Nothing to show in table (all raw or empty chain)
    const graphHTML = renderGraph(nodes, links, rootItem);
    const graphArea = document.getElementById("graphArea");
    if (!graphArea) return;
    const prevWrapper = graphArea.querySelector(".graphWrapper");
    if (prevWrapper && prevWrapper._teardownGraphZoom) {
      try { prevWrapper._teardownGraphZoom(); } catch (e) { /* ignore */ }
    }
    ensureResetButton();
    graphArea.innerHTML = graphHTML;
    const wrapper = graphArea.querySelector(".graphWrapper");
    const resetBtn = document.querySelector('#resetViewBtn');
    setupGraphZoom(wrapper, { autoFit: true, resetButtonEl: resetBtn });
    attachNodePointerHandlers(wrapper);

    const out = document.getElementById("outputArea");
    if (out) out.innerHTML = `<h2>Production chain for ${escapeHtml(String(rate))} / min of ${escapeHtml(rootItem)}</h2><p>No non-raw items to display in the table.</p>`;
    return;
  }

  // Normalize depths to sequential level numbers starting at 0 (lowest depth -> Level 0)
  const depthsAsc = uniqueDepths.slice().sort((a,b) => a - b); // ascending
  const depthToLevelIndex = {};
  depthsAsc.forEach((d, idx) => { depthToLevelIndex[d] = idx; });

  // Render order: visually show highest depth first (descending)
  const sortedDepthsDesc = depthsAsc.slice().sort((a,b) => b - a);

  // Build graph HTML area first (so graph renders above/beside table as before)
  const graphHTML = `${complexLimitExceeded ? `<p class="graph-mode-notice" role="status">Complex view is paused for this plan because its estimated rendering cost is high (${complexCost.machineNodes} machine nodes, ${complexCost.aggregatedRouteLegs} estimated route legs). The Simple graph remains available.</p>` : ''}${renderGraph(nodes, links, rootItem)}`;

  const graphArea = document.getElementById("graphArea");
  if (!graphArea) return;

  // Teardown previous zoom if present
  const prevWrapper = graphArea.querySelector(".graphWrapper");
  if (prevWrapper && prevWrapper._teardownGraphZoom) {
    try { prevWrapper._teardownGraphZoom(); } catch (e) { /* ignore */ }
  }

  ensureResetButton();
  graphArea.innerHTML = graphHTML;
  const wrapper = graphArea.querySelector(".graphWrapper");
  const resetBtn = document.querySelector('#resetViewBtn');
  setupGraphZoom(wrapper, { autoFit: true, resetButtonEl: resetBtn });
  attachNodePointerHandlers(wrapper);

  // Build table HTML
  let html = `
    <h2>Production chain for ${escapeHtml(String(rate))} / min of ${escapeHtml(rootItem)}</h2>
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Qty/min</th>
          <th>Output/machine</th>
          <th>Machines</th>
          <th>Machine Type</th>
          <th>Inputs (per min)</th>
          <th>Input Rail</th>
        </tr>
      </thead>
      <tbody>
  `;

  // Render levels from highest to lowest, but label them using normalized Level indices
  for (const depth of sortedDepthsDesc) {
    const rows = levelGroups[depth] || [];
    if (!rows.length) continue;

    const levelLabel = depthToLevelIndex[depth] ?? 0;
    html += `<tr><td colspan="7"><strong>--- Level ${levelLabel} ---</strong></td></tr>`;

    // Sort items alphabetically within the level for stable ordering
    rows.sort((a,b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));

    for (const [item, data] of rows) {
      // data.raw already filtered out above
      let outputPerMachine = "—";
      let machines = "—";
      let railsNeeded = "—";
      const fillColor = MACHINE_COLORS[data.building] || "#576574";

      const recipe = getRecipe(item);
      if (recipe && recipe.output && recipe.time) {
        outputPerMachine = Math.ceil((recipe.output * 60) / recipe.time);
      }
      machines = Number.isFinite(Number(data.machines)) ? Math.ceil(data.machines) : "—";
      const inputPorts = RAIL_PLANNING.recommendMachineInputPorts(
        data.inputs || {},
        Math.max(1, Math.ceil(Number(data.machines) || 1)),
        ACTIVE_PLAN?.railMode === 'manual' ? railSpeed : null,
        ACTIVE_PLAN?.railMode === 'auto' ? railSpeed : null
      );
      railsNeeded = `${inputPorts.inputNodesPerMachine} input node${inputPorts.inputNodesPerMachine === 1 ? '' : 's'}/machine, v${inputPorts.tier} each (${inputPorts.totalInputNodes} total)`;

      // Inputs: list each input as "Name: X/min" sorted by name; include raw inputs if present
      const inputsList = Object.entries(data.inputs || {})
        .sort((a,b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
        .map(([iname, amt]) => `${escapeHtml(iname)}: ${Math.ceil(amt)}/min`)
        .join("<br>") || "—";

      html += `
        <tr>
          <td>${escapeHtml(item)}</td>
          <td>${Math.ceil(data.rate || 0)}</td>
          <td>${outputPerMachine}</td>
          <td>${machines}</td>
          <td class="machine-type-cell" style="background-color:${fillColor}; color:#ffffff; text-shadow: 0 0 3px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,0.85);"><span>${escapeHtml(data.building || "—")}</span>${RECIPES[item]?.altBuilding ? renderMachineTierToggle(item) : ''}</td>
          <td>${inputsList}</td>
          <td>${railsNeeded}</td>
        </tr>
      `;
    }
  }

  html += `</tbody></table>`;

  // Machines required summary (unchanged)
  html += `
    <h3>MACHINES REQUIRED (total)</h3>
    <table>
      <thead><tr><th>Machine Type</th><th>Count</th></tr></thead>
      <tbody>
        ${Object.entries(machineTotals || {}).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
          <tr><td>${escapeHtml(type)}</td><td>${Math.ceil(count)}</td></tr>
        `).join("")}
      </tbody>
    </table>
  `;

  // Extraction summary
  html += `
    <h3>EXTRACTION REQUIRED</h3>
    <table>
      <thead>
        <tr><th>Resource</th><th>Machine Tier</th><th>Impure</th><th>Normal</th><th>Pure</th><th>Qty/min</th></tr>
      </thead>
      <tbody>
  `;

  const sortedExtractors = Object.entries(extractorTotals || {}).filter(([_, qty]) => qty > 0).sort((a, b) => b[1] - a[1]);
  for (const [resource, qty] of sortedExtractors) {
    const rounded = Math.ceil(qty);
    if (SPECIAL_EXTRACTORS[resource]) {
      const normal = Math.ceil(rounded / SPECIAL_EXTRACTORS[resource]);
      html += `<tr><td>${escapeHtml(resource)}</td><td></td><td>—</td><td>${normal}</td><td>—</td><td>${rounded}</td></tr>`;
    } else {
      const oreRates = ORE_EXCAVATOR_RATES[getItemTier(resource)] || ORE_EXCAVATOR_RATES.v1;
      const impure = Math.ceil(rounded / oreRates.impure);
      const normal = Math.ceil(rounded / oreRates.normal);
      const pure = Math.ceil(rounded / oreRates.pure);
      html += `<tr><td>${escapeHtml(resource)}</td><td>${renderItemTierToggle(resource)}</td><td>${impure}</td><td>${normal}</td><td>${pure}</td><td>${rounded}</td></tr>`;
    }
  }

  html += `</tbody></table>`;

  // Inject into output area
  const out = document.getElementById("outputArea");
  if (out) out.innerHTML = html;
}

/* ===============================
   Run calculator & UI wiring
   =============================== */
function renderActivePlan() {
  const { item, rate, rail, tier, railMode = 'manual' } = ACTIVE_PLAN;
  const chainObj = expandChain(item, rate);
  renderTable(chainObj, item, rate, Number(rail));

  const params = new URLSearchParams({ item, rate, rail, tier, railMode });
  if (ITEM_TIER_OVERRIDES.size) {
    params.set('tiers', JSON.stringify(Object.fromEntries([...ITEM_TIER_OVERRIDES].sort(([first], [second]) => first.localeCompare(second)))));
  }
  history.replaceState(null, "", "?" + params.toString());
}

function getNaturalRateForSelected() {
  const item = document.getElementById('itemSelect')?.value;
  const tier = document.getElementById('tierSelect')?.value === 'v2' ? 'v2' : 'v1';
  const recipe = getRecipe(item, tier);
  return recipe ? (recipe.output * 60) / recipe.time : null;
}

function resetRateToRecipe() {
  const rateInput = document.getElementById('rateInput');
  const rate = getNaturalRateForSelected();
  if (rateInput) rateInput.value = rate !== null ? rate : '';
}

function runCalculator() {
  const item = document.getElementById('itemSelect').value;
  const rateInput = document.getElementById('rateInput');
  let rate = parseFloat(rateInput.value);
  if (Number.isFinite(rate) && rate <= 0) {
    resetRateToRecipe();
    rate = parseFloat(rateInput.value);
  }

  if (!Object.hasOwn(RECIPES, item) || !Number.isFinite(rate) || rate <= 0 || rate > 1000000000) {
    document.getElementById("outputArea").innerHTML = "<p style='color:red;'>Please select an item and enter a valid rate.</p>";
    return;
  }

  const rail = document.getElementById("railSelect").value;
  const tier = document.getElementById("tierSelect").value === 'v2' ? 'v2' : 'v1';
  if (ACTIVE_PLAN && ACTIVE_PLAN.tier !== tier) ITEM_TIER_OVERRIDES.clear();
  const railMode = document.getElementById('railModeToggle').dataset.mode;
  ACTIVE_PLAN = { item, rate, rail, tier, railMode };
  SELECTED_GRAPH_NODE = null;
  renderActivePlan();
}

/* ===============================
   Initialization
   - init() is the single canonical initializer
   =============================== */
async function init() {
  if (window._initHasRun) return;
  window._initHasRun = true;

  setupDarkMode();

  // Load data (data-only)
  await loadRecipes();

  // Ensure RECIPES/TIERS are available
  RECIPES = RECIPES || {};
  TIERS = TIERS || {};
  TIERS[BBM_ID] = TIERS[BBM_ID] ?? 0;

  // UI elements
  const itemSelect = document.getElementById('itemSelect');
  const rateInput = document.getElementById("rateInput");
  const railSelect = document.getElementById("railSelect");
  const railSelectLabel = document.getElementById('railSelectLabel');
  const railModeToggle = document.getElementById('railModeToggle');
  const updateRailMode = () => {
    const isManual = railModeToggle.dataset.mode === 'manual';
    railSelect.disabled = false;
    railSelectLabel.textContent = 'Rail Version:';
    railModeToggle.textContent = `Rail Mode: ${isManual ? 'Manual' : 'Auto'}`;
    railModeToggle.setAttribute('aria-label', `Rail Mode: ${isManual ? 'Manual' : 'Auto'}`);
    railModeToggle.setAttribute('aria-pressed', String(isManual));
  };
  railModeToggle.addEventListener('click', () => {
    railModeToggle.dataset.mode = railModeToggle.dataset.mode === 'auto' ? 'manual' : 'auto';
    updateRailMode();
  });
  updateRailMode();
  const outputArea = document.getElementById("outputArea");
  outputArea?.addEventListener('click', event => {
    const button = event.target.closest('button[data-tier-item]');
    if (!button || !ACTIVE_PLAN || !['v1', 'v2'].includes(button.value)) return;
    const name = button.dataset.tierItem;
    const isMachineTier = button.classList.contains('machine-tier-toggle');
    const nextTier = button.value === 'v1' ? 'v2' : 'v1';
    const previousTop = button.getBoundingClientRect().top;
    const previousScroll = outputArea.scrollLeft;
    if (nextTier !== ACTIVE_PLAN.tier) ITEM_TIER_OVERRIDES.set(name, nextTier);
    else ITEM_TIER_OVERRIDES.delete(name);
    renderActivePlan();
    outputArea.scrollLeft = previousScroll;
    const replacement = [...outputArea.querySelectorAll('[data-tier-item]')].find(element => element.dataset.tierItem === name && element.value === nextTier && element.classList.contains(isMachineTier ? 'machine-tier-toggle' : 'item-tier-toggle'));
    if (replacement) {
      replacement.focus({ preventScroll: true });
      window.scrollBy(0, replacement.getBoundingClientRect().top - previousTop);
    }
  });

  // Populate rail select
  if (railSelect) railSelect.innerHTML = `
    <option value="120">v1 (120/min)</option>
    <option value="240">v2 (240/min)</option>
    <option value="480">v3 (480/min)</option>
    <option value="750">v4 (750/min)</option>
    <option value="1500">v5 (1500/min)</option>
  `;

  // Reset rate input
  if (rateInput) { rateInput.value = ""; rateInput.placeholder = "Rate (/min)"; }

  // Populate item select with placeholder + filtered items
  if (itemSelect) {
    const items = Object.keys(RECIPES || {}).filter(k => typeof k === 'string' && !k.startsWith('_')).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    // Build options preserving placeholder
    itemSelect.innerHTML = `<option value="" disabled selected>Select Item Here</option>` +
      items.map(it => `<option value="${escapeHtml(it)}">${escapeHtml(it)}</option>`).join("");
  }

  // Rate input behavior
  if (itemSelect && rateInput) {
    itemSelect.addEventListener("change", resetRateToRecipe);

    rateInput.addEventListener("input", () => {
      if (rateInput.value.trim() !== '' && Number(rateInput.value) <= 0) resetRateToRecipe();
    });

    rateInput.addEventListener("blur", () => {
      if (rateInput.value.trim() === '' || Number(rateInput.value) <= 0) resetRateToRecipe();
    });

    rateInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (rateInput.value.trim() === '' || Number(rateInput.value) <= 0) resetRateToRecipe();
      } else if (e.key === "Escape") {
        resetRateToRecipe();
        rateInput.focus();
      }
    });
  }

  // Read shared params from URL and apply safely (guard internal keys)
  const params = new URLSearchParams(window.location.search);
  const sharedItem = params.get("item");
  const sharedRate = params.get("rate");
  const sharedRail = params.get("rail");
  const sharedTier = params.get("tier");
  if (params.get('railMode') === 'manual' || (!params.has('railMode') && params.has('rail'))) {
    railModeToggle.dataset.mode = 'manual';
  } else {
    railModeToggle.dataset.mode = 'auto';
  }
  updateRailMode();
  const tierSelect = document.getElementById("tierSelect");

  if (sharedItem && itemSelect && !sharedItem.startsWith('_')) {
    // Only set if the option exists; otherwise leave placeholder
    const opt = Array.from(itemSelect.options).find(o => o.value === sharedItem);
    if (opt) itemSelect.value = sharedItem;
  }
  if (sharedRate && rateInput) rateInput.value = sharedRate;
  if (sharedRail && railSelect && [...railSelect.options].some(option => option.value === sharedRail)) railSelect.value = sharedRail;
  if (sharedTier === 'v1' || sharedTier === 'v2') tierSelect.value = sharedTier;
  try {
    const sharedOverrides = JSON.parse(params.get('tiers') || '{}');
    if (sharedOverrides && typeof sharedOverrides === 'object' && !Array.isArray(sharedOverrides)) {
      for (const [name, tier] of Object.entries(sharedOverrides)) {
        if ((tier === 'v1' || tier === 'v2') && (RECIPES[name]?.altBuilding || FORCED_RAW_ORES.includes(name))) {
          ITEM_TIER_OVERRIDES.set(name, tier);
        }
      }
    }
  } catch {}
  if (sharedItem && sharedRate && !sharedItem.startsWith('_')) runCalculator();

  // Buttons wiring
  const calcButton = document.getElementById("calcButton");
  if (calcButton) calcButton.addEventListener("click", runCalculator);

  const clearBtn = document.getElementById("clearStateBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      // Reset to this same page with no query params, regardless of domain/environment.
      window.location.href = window.location.origin + window.location.pathname;
    });
  }

  const shareButton = document.getElementById("shareButton");
  if (shareButton) {
    shareButton.addEventListener("click", () => {
      const url = window.location.href;
      navigator.clipboard.writeText(url).then(() => showToast("Shareable link copied!")).catch(() => {
        const temp = document.createElement("input");
        temp.value = url;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
        showToast("Shareable link copied!");
      });
    });
  }

  // Safety net: remove any internal-key options that somehow appeared (non-invasive)
  if (itemSelect) {
    Array.from(itemSelect.options).forEach(o => { if (o.value && o.value.startsWith('_')) o.remove(); });
    // Ensure placeholder remains selected if nothing else selected
    if (!itemSelect.value) itemSelect.value = "";
  }
}

/* ===============================
   Expose reloadRecipes for runtime refresh
   =============================== */
async function reloadRecipes() {
  RECIPES = {};
  TIERS = {};
  await loadRecipes();
  // Re-populate select if present
  const itemSelect = document.getElementById('itemSelect');
  if (itemSelect) {
    const items = Object.keys(RECIPES || {}).filter(k => typeof k === 'string' && !k.startsWith('_')).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const prev = itemSelect.value;
    itemSelect.innerHTML = `<option value="" disabled>Select Item Here</option>` +
      items.map(it => `<option value="${escapeHtml(it)}">${escapeHtml(it)}</option>`).join("");
    if (prev && items.includes(prev)) itemSelect.value = prev;
  }

  if (window._lastSelectedItem) {
    const rate = window._lastSelectedRate || 60;
    const { chain } = expandChain(window._lastSelectedItem, rate);
    const graph = buildGraphData(chain, window._lastSelectedItem);
    document.getElementById('graphArea').innerHTML = renderGraph(graph.nodes, graph.links, window._lastSelectedItem);
    attachNodePointerHandlers(document.querySelector('.graphWrapper'));
  }
}

/* ===============================
   Boot
   - Only call init() here; do not call loadRecipes() elsewhere
   =============================== */
init().catch(err => console.error("init error:", err));
