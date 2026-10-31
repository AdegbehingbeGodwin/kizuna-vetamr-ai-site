/* GitHub Pages adapter: read-only snapshots and exact sample replays only. */
(function () {
  const isStatic = document.documentElement.dataset.runtime === "static";
  window.VETAMR_STATIC = isStatic;
  if (!isStatic) return;

  const originalFetch = window.fetch.bind(window);
  const cache = new Map();
  const response = value => new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" }
  });
  const unsupported = () => {
    throw new Error("This action needs the Python application. Run python run.py locally. The Pages demo supports only bundled sample replays.");
  };
  async function snapshot(name) {
    if (!cache.has(name)) {
      const res = await originalFetch(`data/${name}.json`);
      if (!res.ok) throw new Error(`Could not load demo data: ${name}`);
      cache.set(name, await res.json());
    }
    return cache.get(name);
  }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  }

  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);
    const path = url.pathname;
    const method = (init.method || "GET").toUpperCase();
    const readRoutes = {
      "/api/meta/filters": "filters", "/api/analytics/pareto": "pareto",
      "/api/analytics/trends": "trends", "/api/analytics/geo": "geo",
      "/api/sample/leaflets": "sample_leaflets", "/api/sample/amu": "sample_amu",
      "/api/sample/barcodes": "sample_barcodes", "/api/sample/multilingual": "sample_multilingual",
      "/api/sample/pcu": "sample_pcu", "/api/health": "health", "/api/curate/status": "curate_status"
    };
    if (method === "GET" && readRoutes[path]) return response(await snapshot(readRoutes[path]));
    if (method === "GET" && path === "/api/products") {
      let records = (await snapshot("products")).map(product => ({
        ...product,
        primary_inn: product.active_ingredients?.[0]?.canonical_inn,
        primary_atcvet: product.active_ingredients?.[0]?.atcvet_code,
        primary_chemical_class: product.active_ingredients?.[0]?.chemical_class,
        woah_criticality: product.active_ingredients?.[0]?.woah_classification,
        species_json: product.target_species
      }));
      const query = url.searchParams;
      const search = (query.get("search") || "").toLowerCase();
      if (search) records = records.filter(p => [p.product_name, p.primary_inn, p.primary_atcvet, p.manufacturer, p.country]
        .some(v => String(v || "").toLowerCase().includes(search)));
      for (const [param, field] of [["country", "country"], ["chemical_class", "primary_chemical_class"], ["criticality", "woah_criticality"]]) {
        const value = query.get(param);
        if (value && value !== "All") records = records.filter(p => p[field] === value);
      }
      const species = query.get("species");
      if (species && species !== "All") records = records.filter(p =>
        (typeof p.species_json === "string" ? JSON.parse(p.species_json) : p.species_json || [])
          .some(v => v.toLowerCase().includes(species.toLowerCase())));
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      const limit = Math.max(1, Number(query.get("limit")) || 150);
      return response(records.slice(offset, offset + limit));
    }
    const productMatch = path.match(/^\/api\/products\/(\d+)$/);
    if (method === "GET" && productMatch) {
      const product = (await snapshot("products")).find(p => p.id === Number(productMatch[1]));
      if (!product) throw new Error("Product not found in the bundled snapshot");
      return response(product);
    }
    if (method === "GET" && path === "/api/sample/amu/csv") {
      const rows = (await snapshot("sample_amu")).records;
      const fields = Object.keys(rows[0]);
      const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
      return new Response([fields.map(quote).join(","), ...rows.map(row => fields.map(key => quote(row[key])).join(","))].join("\r\n"), {
        headers: { "Content-Type": "text/csv" }
      });
    }
    if (method === "POST" && path === "/api/extract") {
      const body = JSON.parse(init.body || "{}");
      const sample = (await snapshot("precomputed_extractions")).find(item => item.content.trim() === (body.text || "").trim());
      if (!sample) return unsupported();
      return response({ ...sample.extraction, extraction_method: "precomputed_sample_replay" });
    }
    if (method === "POST" && path === "/api/verify/amu") {
      const inputData = JSON.parse(init.body || "null");
      const sample = await snapshot("sample_amu");
      if (JSON.stringify(canonical(inputData)) !== JSON.stringify(canonical(sample))) return unsupported();
      return response(await snapshot("sample_verification"));
    }
    return unsupported();
  };
})();


/**
 * VetAMR-AI Client Application
 * Browser interface for reference records, extraction, and AMU calculations.
 * Handles API queries, reactive visualizations, AI extraction, barcode resolution,
 * epidemiological PCU calculations, divergence tracking, and WOAH ANIMUSE verification.
 */

let paretoChartInstance = null;
let classChartInstance = null;
let speciesChartInstance = null;
let sampleLeaflets = [];
let currentExtractedProduct = null;
let latestVerificationReport = null;
let activeWoahData = null;
let currentWoahOption = 1;

// Sample Barcodes & Packaging data
const SAMPLE_BARCODES = [
  "(01)00300694120015(17)261231(10)LOT-TX8921(21)SN100482",
  "(01)00845123000542(17)270630(10)LOT-BY4019(21)SN948123",
  "(01)03401298711045(17)251130(10)LOT-FR7712(21)SN552190"
];

const MULTILINGUAL_PRESETS = [
  {
    country: "Peru",
    agency: "SENASA",
    text: `LABORATORIOS VETERINARIOS ANDINOS S.A.
OXITETRA-MAX L.A. 200 mg/mL - Frasco por 250 mL
Reg. SENASA N° F.03.01.N.0841

COMPOSICIÓN:
Cada 1 mL contiene:
Oxitetraciclina dihidrato base ......... 200 mg
Excipientes c.s.p. ...................... 1 mL

INDICACIONES:
Tratamiento de infecciones respiratorias y enteritis en bovinos, ovinos y porcinos.
VÍA DE ADMINISTRACIÓN:
Vía intramuscular profunda.

PERIODO DE RETIRO:
Carne: 28 días. Leche: 7 días.`
  },
  {
    country: "France",
    agency: "ANSES-ANMV",
    text: `CEVA SANTÉ ANIMALE
ENROXIL 100 mg/ml SOLUTION INJECTABLE POUR BOVINS ET PORCINS
Autorisation de mise sur le marché : FR/V/8912301/2018

COMPOSITION :
1 ml contient :
Enrofloxacine ........................... 100 mg
Alcool benzylique ...................... 20 mg

ESPÈCES CIBLES :
Bovins, porcins et ovins.
VOIE D'ADMINISTRATION :
Voie sous-cutanée pour les bovins, voie intramusculaire pour les porcins.

TEMPS D'ATTENTE :
Viande et abats : Bovins (10 jours), Porcins (13 jours).`
  },
  {
    country: "Brazil",
    agency: "MAPA Brasil",
    text: `OUROFINO SAÚDE ANIMAL
AMOXIFIN L.A. 150 mg/mL - Frasco 100 mL
Licenciado no Ministério da Agricultura sob nº 8.912/2019

FÓRMULA:
Cada 100 mL contém:
Amoxicilina (como tri-hidrato) ......... 15,0 g
Veículo q.s.p. .......................... 100 mL

INDICAÇÕES E ESPÉCIES:
Indicado para bovinos, suínos e ovinos no tratamento de infecções bacterianas.
VIA E DOSAGEM:
Administrar via intramuscular na dose de 1 mL para cada 10 kg de peso vivo.

PERÍODO DE CARÊNCIA:
Bovinos: Abate 14 dias após a última aplicação. Leite: 3 dias.`
  }
];

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  if (window.VETAMR_STATIC) {
    for (const el of document.querySelectorAll('input[type="file"]')) {
      el.disabled = true;
      el.title = "Uploads require the local Python application";
    }
  }
  if (window.lucide) lucide.createIcons();
  initAMUDropZone();
  await loadFilterMetadata();
  await loadProducts();
  await loadSampleLeafletsList();
});

// -------------------------------------------------------------
// Theme Management (Light / Dark Mode)
// -------------------------------------------------------------

function initTheme() {
  const savedTheme = localStorage.getItem("vetamr_theme") ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  const newTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(newTheme);
  localStorage.setItem("vetamr_theme", newTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.getElementById("theme-icon");
  if (icon) {
    icon.setAttribute("data-lucide", theme === "dark" ? "moon" : "sun");
    if (window.lucide) lucide.createIcons();
  }

  // Update existing charts for theme contrast
  if (paretoChartInstance) {
    loadAnalytics();
  }
}

function getThemeColors() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    textColor: isDark ? "#f8fafc" : "#0f172a",
    mutedColor: isDark ? "#94a3b8" : "#475569",
    gridColor: isDark ? "#334155" : "#e2e8f0",
    accentColor: isDark ? "#fb923c" : "#ea580c",
    accentLight: isDark ? "rgba(251, 146, 60, 0.25)" : "#fff7ed"
  };
}

// -------------------------------------------------------------
// Navigation Segmented Control
// -------------------------------------------------------------

function switchTab(tabId) {
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.style.display = "none";
  });
  document.querySelectorAll(".ui-segmented-control button").forEach(b => {
    b.classList.remove("active");
    b.setAttribute("aria-selected", "false");
  });

  const targetPanel = document.getElementById(`tab-${tabId}`);
  const targetNav = document.getElementById(`nav-${tabId}`);

  if (targetPanel) {
    targetPanel.style.display = "flex";
  }
  if (targetNav) {
    targetNav.classList.add("active");
    targetNav.setAttribute("aria-selected", "true");
  }

  if (tabId === "analytics") {
    loadAnalytics();
    loadGeoSurveillance();
  } else if (tabId === "verification") {
    if (!document.getElementById("amu-submission-input").value.trim()) {
      loadSampleAMUSubmission();
    }
  }

  if (window.lucide) lucide.createIcons();
}

// -------------------------------------------------------------
// TAB 1: Global Reference Repository & CDC Sync
// -------------------------------------------------------------

async function loadFilterMetadata() {
  try {
    const res = await fetch("/api/meta/filters");
    const data = await res.json();

    const countrySelect = document.getElementById("filter-country");
    data.countries.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      countrySelect.appendChild(opt);
    });

    const classSelect = document.getElementById("filter-class");
    data.chemical_classes.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      classSelect.appendChild(opt);
    });

    const speciesSelect = document.getElementById("filter-species");
    data.species.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      speciesSelect.appendChild(opt);
    });
  } catch (err) {
    console.error("Filter metadata error:", err);
  }
}

let filterDebounceTimer;
function debounceFilter() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(loadProducts, 250);
}

async function loadProducts() {
  const search = document.getElementById("filter-search").value.trim();
  const country = document.getElementById("filter-country").value;
  const chemClass = document.getElementById("filter-class").value;
  const species = document.getElementById("filter-species").value;
  const criticality = document.getElementById("filter-criticality").value;

  const params = new URLSearchParams();
  if (search) params.append("search", search);
  if (country && country !== "All") params.append("country", country);
  if (chemClass && chemClass !== "All") params.append("chemical_class", chemClass);
  if (species && species !== "All") params.append("species", species);
  if (criticality && criticality !== "All") params.append("criticality", criticality);
  params.append("limit", "500");

  try {
    const res = await fetch(`/api/products?${params.toString()}`);
    const products = await res.json();
    renderProductsTable(products);

    const countBadge = document.getElementById("repo-count-badge");
    countBadge.textContent = `${products.length} catalog records shown`;
  } catch (err) {
    console.error("Error loading products:", err);
  }
}

function renderProductsTable(products) {
  const tbody = document.getElementById("products-table-body");
  if (!products || products.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="padding: 32px; text-align: center; color: var(--muted);">
          No veterinary antibiotic products matched the specified filter criteria.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = products.map(p => {
    const primaryActive = p.active_ingredients && p.active_ingredients[0] ? p.active_ingredients[0] : null;
    const critClass = getCriticalityBadgeClass(primaryActive ? primaryActive.woah_classification : "VIA");

    return `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(p.product_name)}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">
            ${escapeHtml(p.registration_number || 'N/A')} &bull; ${escapeHtml(p.manufacturer || 'Unknown Manufacturer')}
          </div>
        </td>
        <td>
          <div style="font-weight: 500;">${escapeHtml(primaryActive ? primaryActive.canonical_inn : 'Unknown')}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">
            <code>${escapeHtml(primaryActive ? primaryActive.atcvet_code : '')}</code> &bull; ${escapeHtml(primaryActive ? primaryActive.chemical_class : '')}
          </div>
        </td>
        <td data-ui-number class="ui-numeric ui-numeric" style="font-size: 14px;">
          ${primaryActive ? `${primaryActive.standard_concentration_val} ${primaryActive.standard_concentration_unit}` : 'N/A'}
        </td>
        <td>
          <div>${escapeHtml(p.country)}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">${escapeHtml(p.regulatory_agency || 'National Authority')}</div>
        </td>
        <td>
          <div style="font-size: 12px; max-width: 220px; white-space: normal;">
            ${(p.target_species || []).join(', ')}
          </div>
        </td>
        <td>
          <span class="badge ${critClass}">
            ${primaryActive ? primaryActive.woah_classification : 'VIA'}
          </span>
        </td>
        <td style="text-align: right;">
          <button type="button" onclick="inspectProduct(${p.id})" style="font-size: 14px; min-height: 32px; padding: 4px 10px;">
            <span>Inspect</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function getCriticalityBadgeClass(crit) {
  if (crit === "VCIA") return "badge-vcia";
  if (crit === "VHIA") return "badge-vhia";
  return "badge-via";
}

async function inspectProduct(productId) {
  try {
    const res = await fetch(`/api/products/${productId}`);
    const prod = await res.json();

    document.getElementById("modal-title").textContent = prod.product_name;
    document.getElementById("modal-subtitle").textContent = `${prod.country} &bull; ${prod.regulatory_agency || 'Registry'} &bull; ${prod.registration_number || 'ID: ' + prod.id}`;

    const content = document.getElementById("modal-content");
    content.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
        <div class="stat-card" style="padding: 12px;">
          <span class="stat-label">Manufacturer</span>
          <span style="font-weight: 500; font-size: 14px;">${escapeHtml(prod.manufacturer || 'Unknown')}</span>
        </div>
        <div class="stat-card" style="padding: 12px;">
          <span class="stat-label">Extraction Method</span>
          <span style="font-weight: 500; font-size: 14px;">${escapeHtml(prod.source_type)}</span>
        </div>
        <div class="stat-card" style="padding: 12px;">
          <span class="stat-label">Completeness heuristic</span>
          <span data-ui-number style="font-weight: 600; font-size: 14px; color: var(--accent);">${(prod.confidence_score * 100).toFixed(0)}%</span>
        </div>
      </div>

      <div data-ui-stack style="gap: 8px;">
        <h4 style="font-size: 14px; font-weight: 600;">Active Ingredients</h4>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${(prod.active_ingredients || []).map(ai => `
            <div style="padding: 10px 14px; border-radius: 8px; background: var(--ui-surface-subtle); border: 1px solid var(--ui-border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <div>
                <strong style="font-size: 14px;">${escapeHtml(ai.canonical_inn)}</strong>
                <span style="font-size: 12px; color: var(--muted); margin-left: 8px;">(${escapeHtml(ai.chemical_class)})</span>
                <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">Raw label: "${escapeHtml(ai.raw_name)}"</div>
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <code class="ui-numeric" style="font-size: 14px;">${ai.standard_concentration_val} ${ai.standard_concentration_unit}</code>
                <span class="badge ${getCriticalityBadgeClass(ai.woah_classification)}">${ai.woah_classification}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div data-ui-stack style="gap: 6px;">
          <strong style="font-size: 12px; color: var(--muted); text-transform: uppercase;">Registered Presentations</strong>
          <div style="font-size: 14px;">${(prod.package_sizes || []).map(ps => `<div>&bull; ${escapeHtml(ps.raw_package_size)}</div>`).join('') || 'Standard packaging'}</div>
        </div>
        <div data-ui-stack style="gap: 6px;">
          <strong style="font-size: 12px; color: var(--muted); text-transform: uppercase;">Administration Routes</strong>
          <div style="font-size: 14px;">${(prod.routes_of_administration || []).join(', ') || 'Parental / Oral'}</div>
        </div>
      </div>

      <div data-ui-stack style="gap: 6px;">
        <strong style="font-size: 12px; color: var(--muted); text-transform: uppercase;">Target Animal Species</strong>
        <div style="font-size: 14px;">${(prod.target_species || []).join(', ')}</div>
      </div>

      ${prod.withdrawal_period ? `
        <div style="padding: 10px 14px; border-radius: 8px; background: var(--badge-vhia-bg); color: var(--badge-vhia-text); border: 1px solid var(--badge-vhia-border); font-size: 14px;">
          <strong>Official Withdrawal Period:</strong> ${escapeHtml(prod.withdrawal_period)}
        </div>
      ` : ''}

      ${prod.indications ? `
        <div data-ui-stack style="gap: 6px;">
          <strong style="font-size: 12px; color: var(--muted); text-transform: uppercase;">Approved Indications</strong>
          <div style="font-size: 14px; line-height: 1.5; color: var(--muted);">${escapeHtml(prod.indications)}</div>
        </div>
      ` : ''}
    `;

    document.getElementById("product-modal").style.display = "flex";
  } catch (err) {
    showToast("Could not load product details.");
  }
}

function closeProductModal() {
  document.getElementById("product-modal").style.display = "none";
}

// Registry Feed Demonstration & CDC Drawer
async function triggerRegulatorySync() {
  const btn = document.getElementById("btn-sync-regulatory");
  btn.disabled = true;
  showToast("Loading registry connector results; offline fixtures are used by default...");

  try {
    const res = await fetch("/api/sync/regulatory", { method: "POST" });
    const reports = await res.json();
    renderCdcLedger(reports);
    document.getElementById("cdc-log-drawer").style.display = "block";
    showToast(`Connector results: ${reports.length} authorities. Review status: fixtures are not verified updates.`);
  } catch (err) {
    showToast(`Sync error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function toggleCdcLedgerDrawer() {
  const drawer = document.getElementById("cdc-log-drawer");
  drawer.style.display = drawer.style.display === "none" ? "block" : "none";
  if (drawer.style.display === "block" && !document.getElementById("cdc-log-entries").children.length) {
    triggerRegulatorySync();
  }
}

function renderCdcLedger(reports) {
  const container = document.getElementById("cdc-log-entries");
  document.getElementById("cdc-log-timestamp").textContent = new Date().toLocaleTimeString();
  
  let allEvents = [];
  reports.forEach(r => {
    (r.cdc_change_log || []).forEach(evt => {
      allEvents.push({ ...evt, authority: r.authority, jurisdiction: r.jurisdiction });
    });
  });

  if (!allEvents.length) {
    container.innerHTML = `<div style="color: var(--muted); font-size: 14px;">No new regulatory revisions detected in ledger.</div>`;
    return;
  }

  container.innerHTML = allEvents.map(e => `
    <div style="padding: 8px 12px; border-radius: 6px; background: var(--ui-surface); border: 1px solid var(--ui-border); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
      <div>
        <span class="badge badge-via" style="font-size: 11px;">${escapeHtml(e.event_type || 'CHANGE')}</span>
        <strong style="margin-left: 6px; font-size: 14px;">${escapeHtml(e.product_name)}</strong>
        <span style="color: var(--muted); font-size: 12px; margin-left: 6px;">(${escapeHtml(e.active_substance)})</span>
        <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">${escapeHtml(e.details)}</div>
      </div>
      <span style="font-size: 11px; color: var(--muted); font-family: var(--ui-mono);">${escapeHtml(e.authority)}</span>
    </div>
  `).join('');
}

async function triggerCurationAgent() {
  const btn = document.getElementById("btn-curation-agent");
  btn.disabled = true;
  showToast("Loading bundled curated records...");

  try {
    const res = await fetch("/api/curate/run", { method: "POST" });
    const data = await res.json();
    showToast(data.message);
    await loadProducts();
  } catch (err) {
    showToast(`Curation error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------
// TAB 2: AI Multi-Modal Extractor & GS1 Barcode Resolver
// -------------------------------------------------------------

function loadSampleBarcode(idx) {
  document.getElementById("barcode-input").value = SAMPLE_BARCODES[idx] || "";
  resolveBarcode();
}

async function resolveBarcode() {
  const code = document.getElementById("barcode-input").value.trim();
  if (!code) {
    showToast("Please enter or scan a GS1 DataMatrix code");
    return;
  }

  try {
    const res = await fetch("/api/extract/barcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode: code })
    });
    const info = await res.json();
    renderBarcodeResult(info);
  } catch (err) {
    showToast(`Barcode decoding failed: ${err.message}`);
  }
}

function renderBarcodeResult(info) {
  const box = document.getElementById("barcode-result-display");
  box.style.display = "block";

  const isResolved = info.status === "RESOLVED_VERIFIED";
  box.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <div>
        <span class="badge ${isResolved ? 'badge-via' : 'badge-vhia'}">${escapeHtml(info.status)}</span>
        <strong style="margin-left: 8px; font-size: 14px;">${escapeHtml(info.matched_product_name || 'Unmapped GTIN')}</strong>
        ${info.canonical_inn ? `<span style="color: var(--muted); font-size: 14px;"> &bull; ${escapeHtml(info.canonical_inn)}</span>` : ''}
      </div>
      <div style="font-family: var(--ui-mono); font-size: 12px; color: var(--muted);">
        GTIN: <strong>${escapeHtml(info.gtin || 'None')}</strong> &bull; Lot: <strong>${escapeHtml(info.batch_lot || 'N/A')}</strong> &bull; Exp: <strong>${escapeHtml(info.expiry_date || 'N/A')}</strong>
      </div>
    </div>
  `;
}

function loadMultilingualSample(idx) {
  const sample = MULTILINGUAL_PRESETS[idx];
  if (!sample) return;
  document.getElementById("raw-text-input").value = sample.text;
  document.getElementById("extract-country").value = sample.country;
  document.getElementById("extract-agency").value = sample.agency;
  runExtraction();
}

async function loadSampleLeafletsList() {
  try {
    const res = await fetch("/api/sample/leaflets");
    sampleLeaflets = await res.json();
  } catch (err) {
    console.error("Leaflets list error:", err);
  }
}

function loadSampleLeaflet(idx) {
  if (sampleLeaflets && sampleLeaflets[idx]) {
    document.getElementById("raw-text-input").value = sampleLeaflets[idx].content;
    document.getElementById("extract-country").value = "United States";
    document.getElementById("extract-agency").value = "US FDA CVM";
    runExtraction();
  }
}

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const label = document.getElementById("upload-label");
  label.textContent = `Uploading: ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("country", document.getElementById("extract-country").value);
  formData.append("agency", document.getElementById("extract-agency").value);

  try {
    const res = await fetch("/api/extract/upload", {
      method: "POST",
      body: formData
    });
    const result = await res.json();
    label.textContent = `Extracted: ${file.name}`;
    renderExtractionOutput(result);
  } catch (err) {
    label.textContent = "Upload failed";
    showToast(`Upload error: ${err.message}`);
  }
}

async function runExtraction() {
  const text = document.getElementById("raw-text-input").value.trim();
  if (!text) {
    showToast("Please provide package leaflet text or upload a document");
    return;
  }

  const btn = document.getElementById("btn-extract");
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader-2" style="width: 16px; height: 16px; animation: spin 1s linear infinite;"></i><span>Extracting...</span>`;

  const statusBadge = document.getElementById("extraction-status");
  statusBadge.textContent = "Processing...";
  statusBadge.className = "badge badge-vhia";

  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text,
        country: document.getElementById("extract-country").value,
        regulatory_agency: document.getElementById("extract-agency").value
      })
    });
    const product = await res.json();
    currentExtractedProduct = product;
    renderExtractionOutput(product);
    statusBadge.textContent = window.VETAMR_STATIC ? "Sample replay" : "Complete";
    statusBadge.className = "badge badge-via";
  } catch (err) {
    statusBadge.textContent = "Failed";
    statusBadge.className = "badge badge-vcia";
    showToast(`Extraction failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="cpu" style="width: 16px; height: 16px;"></i><span>Run Entity Extraction</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

function renderExtractionOutput(product) {
  const container = document.getElementById("extraction-results-container");
  const actionsEl = document.getElementById("extraction-actions");

  container.innerHTML = `
    <div data-ui-stack style="gap: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px;">
        <div>
          <h3 style="font-size: 18px;">${escapeHtml(product.product_name)}</h3>
          <div style="font-size: 14px; color: var(--muted); margin-top: 2px;">
            ${escapeHtml(product.country)} &bull; ${escapeHtml(product.regulatory_agency || 'Registry')} &bull; Reg: ${escapeHtml(product.registration_number || 'Pending')}
          </div>
        </div>
        <div class="badge badge-via" data-ui-number style="font-size: 14px;">
          ${(product.confidence_score * 100).toFixed(0)}% field completeness (heuristic)
        </div>
      </div>

      <div data-ui-stack style="gap: 8px;">
        <span style="font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;">Standardized Active Ingredients</span>
        ${(product.active_ingredients || []).map(ai => `
          <div style="padding: 10px 12px; border-radius: 8px; background: var(--ui-surface-subtle); border: 1px solid var(--ui-border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div>
              <strong>${escapeHtml(ai.canonical_inn)}</strong>
              <span style="font-size: 12px; color: var(--muted); margin-left: 6px;">(${escapeHtml(ai.chemical_class)})</span>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <code class="ui-numeric" style="font-size: 14px;">${ai.standard_concentration_val} ${ai.standard_concentration_unit}</code>
              <span class="badge ${getCriticalityBadgeClass(ai.woah_classification)}">${ai.woah_classification}</span>
            </div>
          </div>
        `).join('')}
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="stat-card" style="padding: 10px;">
          <span class="stat-label">Package Sizes</span>
          <span style="font-size: 14px; font-weight: 500;">${(product.package_sizes || []).map(p => p.raw_package_size).join(', ') || 'Standard presentation'}</span>
        </div>
        <div class="stat-card" style="padding: 10px;">
          <span class="stat-label">Routes</span>
          <span style="font-size: 14px; font-weight: 500;">${(product.routes_of_administration || []).join(', ') || 'Parental'}</span>
        </div>
      </div>

      <div class="stat-card" style="padding: 10px;">
        <span class="stat-label">Target Animal Species</span>
        <span style="font-size: 14px; font-weight: 500;">${(product.target_species || []).join(', ')}</span>
      </div>

      ${product.withdrawal_period ? `
        <div style="padding: 8px 12px; border-radius: 8px; background: var(--badge-vhia-bg); color: var(--badge-vhia-text); border: 1px solid var(--badge-vhia-border); font-size: 12px;">
          <strong>Withdrawal period:</strong> ${escapeHtml(product.withdrawal_period)}
        </div>
      ` : ''}
    </div>
  `;

  actionsEl.style.display = "flex";
  if (window.lucide) lucide.createIcons();
}

async function consolidateExtractedProduct() {
  if (!currentExtractedProduct) return;

  const btn = document.getElementById("btn-consolidate");
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader-2" style="width: 14px; height: 14px; animation: spin 1s linear infinite;"></i><span>Consolidating...</span>`;

  try {
    const res = await fetch("/api/products/consolidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentExtractedProduct)
    });
    const result = await res.json();
    showToast(result.message);
    await loadProducts();
    btn.innerHTML = `<i data-lucide="check" style="width: 14px; height: 14px;"></i><span>Consolidated</span>`;
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="plus" style="width: 14px; height: 14px;"></i><span>Consolidate into Repository</span>`;
      if (window.lucide) lucide.createIcons();
    }, 2000);
  } catch (err) {
    showToast(`Consolidation error: ${err.message}`);
    btn.disabled = false;
  }
}

// -------------------------------------------------------------
// TAB 3: Analytics, Pareto 80/20 & Geospatial AMR Surveillance
// -------------------------------------------------------------

async function loadAnalytics() {
  try {
    const [paretoRes, trendsRes] = await Promise.all([
      fetch("/api/analytics/pareto").then(r => r.json()),
      fetch("/api/analytics/trends").then(r => r.json())
    ]);

    document.getElementById("stat-total-products").textContent = paretoRes.total_products;
    document.getElementById("stat-active-substances").textContent = paretoRes.total_active_substances;
    document.getElementById("stat-pareto-count").textContent = `${paretoRes.pareto_threshold_count} Substances`;
    document.getElementById("stat-vcia-pct").textContent = `${trendsRes.total_products ? ((trendsRes.by_criticality?.VCIA || 0) / trendsRes.total_products * 100).toFixed(1) : "0.0"}%`;
    document.getElementById("pareto-insight-text").textContent = paretoRes.summary;

    renderParetoChart(paretoRes.pareto_curve);
    renderClassChart(trendsRes.by_chemical_class);
    renderSpeciesChart(trendsRes.by_species);
    renderParetoTable(paretoRes.priority_benchmarks);

  } catch (err) {
    console.error("Analytics loading failed:", err);
  }
}

async function loadGeoSurveillance() {
  const tbody = document.getElementById("geo-surveillance-table-body");
  try {
    const res = await fetch("/api/analytics/geo");
    const metrics = await res.json();
    renderGeoSurveillanceTable(metrics);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding: 24px; text-align: center; color: var(--muted);">Failed to load geospatial data.</td></tr>`;
  }
}

function renderGeoSurveillanceTable(metrics) {
  const tbody = document.getElementById("geo-surveillance-table-body");
  if (!metrics || !metrics.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding: 24px; text-align: center; color: var(--muted);">No geospatial surveillance data available.</td></tr>`;
    return;
  }

  tbody.innerHTML = metrics.map(m => {
    let tierBadgeClass = "badge-via";
    if (m.divergence_risk_tier.includes("Elevated")) {
      tierBadgeClass = "badge-critical";
    } else if (m.divergence_risk_tier.includes("Moderate")) {
      tierBadgeClass = "badge-warning";
    }

    return `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(m.country)}</div>
          <div style="font-size: 11px; font-family: var(--ui-mono); color: var(--muted);">${escapeHtml(m.code)} &bull; ${m.lat.toFixed(1)}°, ${m.lng.toFixed(1)}°</div>
        </td>
        <td style="color: var(--muted);">${escapeHtml(m.region)}</td>
        <td data-ui-number class="ui-numeric ui-numeric" style="font-weight: 600;">${m.total_formulations}</td>
        <td data-ui-number class="ui-numeric ui-numeric">${m.distinct_active_substances}</td>
        <td data-ui-number class="ui-numeric ui-numeric" style="font-weight: 600; color: ${m.vcia_percentage > 35 ? '#e11d48' : 'var(--accent)'};">
          ${m.vcia_percentage}%
        </td>
        <td>${escapeHtml(m.top_chemical_class)}</td>
        <td>
          <span class="badge ${tierBadgeClass}">
            ${escapeHtml(m.divergence_risk_tier)}
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderParetoChart(curveData) {
  const ctx = document.getElementById("paretoChart").getContext("2d");
  if (paretoChartInstance) paretoChartInstance.destroy();

  const colors = getThemeColors();
  const labels = curveData.map(d => d.name);
  const cumValues = curveData.map(d => d.cum_pct);
  const shareValues = curveData.map(d => d.share_pct);

  paretoChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          type: "line",
          label: "Cumulative %",
          data: cumValues,
          borderColor: "#ea580c",
          backgroundColor: "#ea580c",
          borderWidth: 2,
          pointRadius: 3,
          yAxisID: "yCum"
        },
        {
          type: "bar",
          label: "Share of formulations %",
          data: shareValues,
          backgroundColor: colors.accentLight,
          borderRadius: 4,
          yAxisID: "yShare"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        yCum: {
          type: "linear",
          position: "right",
          min: 0,
          max: 105,
          ticks: { callback: v => v + "%", color: colors.mutedColor },
          grid: { drawOnChartArea: false }
        },
        yShare: {
          type: "linear",
          position: "left",
          min: 0,
          ticks: { callback: v => v + "%", color: colors.mutedColor },
          grid: { color: colors.gridColor }
        },
        x: {
          ticks: { font: { size: 10 }, color: colors.mutedColor },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          position: "top",
          labels: { color: colors.textColor, font: { family: "system-ui", size: 12 } }
        }
      }
    }
  });
}

function renderClassChart(classData) {
  const ctx = document.getElementById("classChart").getContext("2d");
  if (classChartInstance) classChartInstance.destroy();

  const colors = getThemeColors();
  const labels = Object.keys(classData);
  const data = Object.values(classData);

  classChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: [
          "#ea580c", "#2563eb", "#059669", "#d97706", "#7c3aed",
          "#0891b2", "#ea580c", "#4b5563", "#65a30d", "#0d9488"
        ],
        borderWidth: 1,
        borderColor: colors.gridColor
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 12, font: { size: 11 }, color: colors.textColor }
        }
      }
    }
  });
}

function renderSpeciesChart(speciesData) {
  const ctx = document.getElementById("speciesChart").getContext("2d");
  if (speciesChartInstance) speciesChartInstance.destroy();

  const colors = getThemeColors();
  const labels = Object.keys(speciesData);
  const data = Object.values(speciesData);

  speciesChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: "Registered formulations",
        data: data,
        backgroundColor: colors.accentColor,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      scales: {
        x: {
          ticks: { stepSize: 1, color: colors.mutedColor },
          grid: { color: colors.gridColor }
        },
        y: {
          ticks: { font: { size: 11 }, color: colors.textColor },
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function renderParetoTable(benchmarks) {
  const tbody = document.getElementById("pareto-table-body");
  tbody.innerHTML = benchmarks.map(b => {
    const isTier1 = b.benchmark_tier.includes("Tier 1");
    return `
      <tr>
        <td data-ui-number style="font-weight: 600;">${b.rank}</td>
        <td style="font-weight: 600;">${escapeHtml(b.inn_name)}</td>
        <td style="color: var(--muted);">${escapeHtml(b.chemical_class)}</td>
        <td>
          <span class="badge ${getCriticalityBadgeClass(b.woah_criticality)}">
            ${escapeHtml(b.woah_criticality)}
          </span>
        </td>
        <td data-ui-number class="ui-numeric">${b.product_count}</td>
        <td data-ui-number class="ui-numeric">${b.country_coverage_count}</td>
        <td data-ui-number class="ui-numeric ui-numeric">${b.share_percentage}%</td>
        <td data-ui-number class="ui-numeric ui-numeric" style="font-weight: 600; color: var(--accent);">${b.cumulative_percentage}%</td>
        <td>
          <span class="badge ${isTier1 ? 'badge-woah' : 'badge'}" style="${isTier1 ? '' : 'background: var(--ui-surface-subtle); border: 1px solid var(--ui-border);'}">
            ${isTier1 ? 'Tier 1 priority' : 'Tier 2 regional'}
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

// -------------------------------------------------------------
// TAB 4: AMU Verification, PCU Calculator & WOAH ANIMUSE Export
// -------------------------------------------------------------

function loadSamplePCUCensus() {
  document.getElementById("pcu-swine").value = "12500000";
  document.getElementById("pcu-bovine").value = "1500000";
  document.getElementById("pcu-poultry").value = "18000000";
  document.getElementById("pcu-aquaculture").value = "2500000";
  computePCUEstimate();
}

async function computePCUEstimate() {
  const swine = parseInt(document.getElementById("pcu-swine").value) || 0;
  const bovine = parseInt(document.getElementById("pcu-bovine").value) || 0;
  const poultry = parseInt(document.getElementById("pcu-poultry").value) || 0;
  const aquaculture = parseInt(document.getElementById("pcu-aquaculture").value) || 0;

  const activeKg = (latestVerificationReport && latestVerificationReport.total_active_substance_kg > 0)
    ? latestVerificationReport.total_active_substance_kg
    : 72500.0;

  const payload = {
    census_items: [
      { species_category: "swine", head_count: swine, custom_weight_kg: 65.0 },
      { species_category: "bovine", head_count: bovine, custom_weight_kg: 425.0 },
      { species_category: "poultry", head_count: poultry, custom_weight_kg: 1.0 },
      { species_category: "aquaculture", head_count: aquaculture, custom_weight_kg: 1.5 }
    ],
    total_active_kg: activeKg,
    country: "Surveillance Jurisdiction",
    year: 2024,
    active_substance_inn: "Oxytetracycline"
  };

  try {
    const res = await fetch("/api/analytics/pcu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const pcuRes = await res.json();
    renderPcuOutput(pcuRes, swine + bovine + poultry + aquaculture);
  } catch (err) {
    showToast(`PCU computation error: ${err.message}`);
  }
}

function renderPcuOutput(pcu, totalHeads) {
  document.getElementById("pcu-total-tonnes").textContent = `${pcu.total_biomass_tonnes.toLocaleString()} Tonnes`;
  document.getElementById("pcu-total-heads").textContent = `${totalHeads.toLocaleString()} total head count`;
  document.getElementById("pcu-mg-intensity").textContent = `${pcu.sales_intensity_mg_per_pcu.toFixed(2)} mg/PCU`;
  document.getElementById("pcu-tier-badge").textContent = pcu.evaluation_tier;
  document.getElementById("pcu-dddvet-units").textContent = `${pcu.total_dddvet_units.toLocaleString()} DDDvet`;
  document.getElementById("pcu-dddvet-per-animal").textContent = `${pcu.estimated_dddvet_per_animal_year.toFixed(2)} doses/head/yr`;
}

async function handleAMUFileUpload(event) {
  const file = event.target && event.target.files ? event.target.files[0] : (event.dataTransfer ? event.dataTransfer.files[0] : null);
  if (!file) return;

  const labelEl = document.getElementById("amu-upload-label");
  const originalText = labelEl ? labelEl.textContent : "Click to browse CSV / Excel file";
  if (labelEl) labelEl.textContent = `Uploading and verifying ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/verify/amu/upload", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(errData.detail || `Upload failed with status ${res.status}`);
    }

    latestVerificationReport = await res.json();
    if (labelEl) labelEl.textContent = `${file.name} (${latestVerificationReport.total_records} records verified)`;
    renderVerificationResults(latestVerificationReport);
    if (!window.VETAMR_STATIC) computePCUEstimate();
    showToast(`Verified ${latestVerificationReport.total_records} records from ${file.name}`);
  } catch (err) {
    if (labelEl) labelEl.textContent = originalText;
    showToast(`File upload verification error: ${err.message}`);
  }
}

async function downloadSampleAMUCsv() {
  try {
    const res = await fetch("/api/sample/amu/csv");
    if (!res.ok) throw new Error("Failed to download template");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "national_amu_sample_submission.csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Sample AMU submission CSV template downloaded.");
  } catch (err) {
    showToast(`Download error: ${err.message}`);
  }
}

function initAMUDropZone() {
  const dropZone = document.getElementById("amu-drop-zone");
  if (!dropZone) return;

  ["dragenter", "dragover"].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = "var(--accent)";
      dropZone.style.background = "var(--ui-surface-subtle)";
    }, false);
  });

  ["dragleave", "drop"].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = "var(--ui-border)";
      dropZone.style.background = "var(--ui-surface)";
    }, false);
  });

  dropZone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      handleAMUFileUpload({ dataTransfer: dt });
    }
  }, false);
}

async function loadSampleAMUSubmission() {
  try {
    const res = await fetch("/api/sample/amu");
    const data = await res.json();
    document.getElementById("amu-submission-input").value = JSON.stringify(data, null, 2);
    showToast("Loaded sample national AMU submission dataset.");
  } catch (err) {
    showToast("Could not load sample AMU data.");
  }
}

async function runAMUVerification() {
  const rawInput = document.getElementById("amu-submission-input").value.trim();
  if (!rawInput) {
    showToast("Please provide or load AMU submission JSON");
    return;
  }

  let batchData;
  try {
    batchData = JSON.parse(rawInput);
  } catch (err) {
    showToast("Invalid JSON format in submission input.");
    return;
  }

  try {
    const res = await fetch("/api/verify/amu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchData)
    });
    latestVerificationReport = await res.json();
    renderVerificationResults(latestVerificationReport);
    if (!window.VETAMR_STATIC) computePCUEstimate();
    showToast(window.VETAMR_STATIC ? "Bundled sample report replayed; no new audit was performed." : "AMU calculation complete; review matches and assumptions.");
  } catch (err) {
    showToast(`Verification failed: ${err.message}`);
  }
}

function renderVerificationResults(report) {
  document.getElementById("amu-results-container").style.display = "flex";

  document.getElementById("v-score").textContent = `${report.data_quality_score}%`;
  document.getElementById("v-total-kg").textContent = `${report.total_active_substance_kg.toLocaleString()} kg`;
  document.getElementById("v-vcia-kg").textContent = `${report.vcia_active_substance_kg.toLocaleString()} kg`;
  document.getElementById("v-vcia-pct").textContent = `${report.vcia_percentage}% of total active weight`;
  document.getElementById("v-verified-count").textContent = `${report.verified_count} of ${report.total_records}`;
  document.getElementById("v-warning-count").textContent = report.warning_count;
  document.getElementById("v-discrepancy-count").textContent = `${report.discrepancy_count} discrepancies &bull; ${report.divergence_alerts_count || 0} divergence alerts`;

  const tbody = document.getElementById("amu-table-body");
  tbody.innerHTML = report.detailed_rows.map((row, rIdx) => {
    let statusClass = "status-verified";
    let statusLabel = "Verified";
    if (row.status === "WARNING") {
      statusClass = "status-warning";
      statusLabel = "Warning";
    } else if (row.status === "DISCREPANCY") {
      statusClass = "status-discrepancy";
      statusLabel = "Discrepancy";
    }

    const divergenceAlerts = row.divergence_alerts || [];

    return `
      <tr>
        <td><code>${escapeHtml(row.record_id)}</code></td>
        <td>
          <div style="font-weight: 600;">${escapeHtml(row.reported_product_name)}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">Pack: ${escapeHtml(row.reported_pack_size)} &bull; ${escapeHtml(row.reported_species || 'Species not stated')}</div>
        </td>
        <td data-ui-number class="ui-numeric">${row.units_sold.toLocaleString()}</td>
        <td>
          ${row.matched_product_name ? `
            <div style="font-weight: 500;">${escapeHtml(row.matched_product_name)}</div>
            <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">Match: <span data-ui-number>${(row.confidence * 100).toFixed(0)}</span>%</div>
          ` : '<span style="color: #e11d48; font-style: italic; font-size: 12px;">No reference match</span>'}
        </td>
        <td>
          <div style="font-weight: 500;">${escapeHtml(row.matched_inn || 'Unrecognized')}</div>
          <div style="font-size: 12px; color: var(--accent); margin-top: 2px;"><code>${escapeHtml(row.verified_concentration || 'N/A')}</code></div>
        </td>
        <td data-ui-number class="ui-numeric" style="font-weight: 600; font-size: 14px;">
          ${row.calculated_active_substance_kg.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg
        </td>
        <td>
          <span class="badge ${statusClass}">
            ${statusLabel}
          </span>
          ${divergenceAlerts.length > 0 ? divergenceAlerts.map((da, aIdx) => `
            <div style="margin-top: 4px;">
              <button type="button" class="badge ${da.severity === 'CRITICAL' ? 'badge-critical' : 'badge-warning'}" style="cursor: pointer; text-align: left;" onclick="showDivergenceAlert(${rIdx}, ${aIdx})">
                <span>${escapeHtml(da.rule_code)}</span>
              </button>
            </div>
          `).join('') : ''}
          ${row.flags.length > 0 ? `
            <div style="font-size: 12px; color: var(--badge-vhia-text); margin-top: 4px;">
              ${row.flags.map(f => `<div>&bull; ${escapeHtml(f)}</div>`).join('')}
            </div>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function showDivergenceAlert(rowIndex, alertIndex) {
  if (!latestVerificationReport || !latestVerificationReport.detailed_rows[rowIndex]) return;
  const alert = latestVerificationReport.detailed_rows[rowIndex].divergence_alerts[alertIndex];
  if (!alert) return;

  document.getElementById("div-modal-title").textContent = alert.title;
  document.getElementById("div-modal-subtitle").textContent = `Rule: ${alert.rule_code} &bull; Severity: ${alert.severity} &bull; International Stewardship Discordance`;

  const body = document.getElementById("div-modal-body");
  body.innerHTML = `
    <div style="padding: 12px; border-radius: 8px; background: var(--ui-surface-subtle); border: 1px solid var(--ui-border); font-size: 14px; line-height: 1.5;">
      ${escapeHtml(alert.description)}
    </div>
    <div class="stat-card" style="padding: 12px;">
      <span class="stat-label">International One Health Discordance &bull; Human Impact</span>
      <span style="font-size: 14px; color: #e11d48; font-weight: 500;">${escapeHtml(alert.one_health_impact)}</span>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="stat-card" style="padding: 10px;">
        <span class="stat-label">Benchmark Jurisdictions</span>
        <span style="font-size: 12px;">${(alert.reference_jurisdictions || []).join(', ')}</span>
      </div>
      <div class="stat-card" style="padding: 10px;">
        <span class="stat-label">Recommended Regulatory Action</span>
        <span style="font-size: 12px;">${escapeHtml(alert.recommended_action)}</span>
      </div>
    </div>
  `;

  document.getElementById("divergence-modal").style.display = "flex";
}

function closeDivergenceModal() {
  document.getElementById("divergence-modal").style.display = "none";
}

// WOAH ANIMUSE Export & SHA-256 Certificate Modal
async function openWoahExportModal() {
  if (!latestVerificationReport) {
    showToast("Please run verification audit first");
    return;
  }

  try {
    const res = await fetch("/api/verify/woah/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: latestVerificationReport,
        country: "National Surveillance Authority",
        year: 2024
      })
    });
    activeWoahData = await res.json();
    
    const cert = activeWoahData.metadata.certificate;
    document.getElementById("woah-cert-id").textContent = cert.certificate_id;
    document.getElementById("woah-cert-hash").textContent = cert.sha256_checksum;
    document.getElementById("woah-cert-status").textContent = cert.status;

    switchWoahOption(1);
    document.getElementById("woah-export-modal").style.display = "flex";
  } catch (err) {
    showToast(`WOAH formatting failed: ${err.message}`);
  }
}

function closeWoahExportModal() {
  document.getElementById("woah-export-modal").style.display = "none";
}

function switchWoahOption(opt) {
  currentWoahOption = opt;
  [1, 2, 3].forEach(n => {
    const btn = document.getElementById(`woah-opt${n}-btn`);
    if (n === opt) {
      btn.className = "btn-primary";
    } else {
      btn.className = "";
    }
  });

  if (!activeWoahData) return;
  const container = document.getElementById("woah-preview-container");

  if (opt === 1) {
    const rows = activeWoahData.option_1_by_class || [];
    container.innerHTML = `
      <table style="width: 100%;">
        <thead>
          <tr>
            <th scope="col">Antimicrobial Class</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Active Weight (kg)</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Share %</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.antimicrobial_class)}</strong></td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.calculated_active_kg.toLocaleString()} kg</td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.percentage}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if (opt === 2) {
    const rows = activeWoahData.option_2_by_animal_group || [];
    container.innerHTML = `
      <table style="width: 100%;">
        <thead>
          <tr>
            <th scope="col">Antimicrobial Class</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Terrestrial (kg)</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Aquatic (kg)</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Companion (kg)</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Total (kg)</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.antimicrobial_class)}</strong></td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.terrestrial_kg.toLocaleString()}</td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.aquatic_kg.toLocaleString()}</td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.companion_kg.toLocaleString()}</td>
              <td data-ui-number class="ui-numeric ui-numeric" style="font-weight: 600;">${r.total_kg.toLocaleString()} kg</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else {
    const rows = activeWoahData.option_3_detailed_matrix || [];
    container.innerHTML = `
      <table style="width: 100%;">
        <thead>
          <tr>
            <th scope="col">Class</th>
            <th scope="col">Active Substance</th>
            <th scope="col">Category</th>
            <th scope="col">Species</th>
            <th scope="col" style="text-align: right;" class="ui-numeric">Active (kg)</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.antimicrobial_class)}</td>
              <td><strong>${escapeHtml(r.active_substance)}</strong></td>
              <td>${escapeHtml(r.target_animal_category)}</td>
              <td>${escapeHtml(r.reported_species)}</td>
              <td data-ui-number class="ui-numeric ui-numeric">${r.active_weight_kg.toFixed(2)} kg</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

async function downloadWoahCsv() {
  if (!latestVerificationReport) return;

  try {
    const res = await fetch("/api/verify/woah/export/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: latestVerificationReport,
        country: "National Surveillance Authority",
        year: 2024,
        option: currentWoahOption
      })
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `WOAH_ANIMUSE_Option${currentWoahOption}_Submission_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`WOAH ANIMUSE Option ${currentWoahOption} CSV downloaded.`);
  } catch (err) {
    showToast(`Download failed: ${err.message}`);
  }
}

function exportVerificationReport() {
  if (!latestVerificationReport || !latestVerificationReport.detailed_rows) {
    showToast("No verification results to export.");
    return;
  }

  const rows = latestVerificationReport.detailed_rows;
  const headers = ["RecordID", "ReportedProduct", "UnitsSold", "MatchedProduct", "ActiveSubstance", "CalculatedActiveKg", "Status", "AuditFlags"];
  
  const csvContent = [
    headers.join(","),
    ...rows.map(r => [
      r.record_id,
      `"${r.reported_product_name.replace(/"/g, '""')}"`,
      r.units_sold,
      `"${(r.matched_product_name || '').replace(/"/g, '""')}"`,
      `"${(r.matched_inn || '').replace(/"/g, '""')}"`,
      r.calculated_active_substance_kg,
      r.status,
      `"${r.flags.join('; ').replace(/"/g, '""')}"`
    ].join(","))
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `AMU_Verification_Audit_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Audit CSV report exported.");
}

// -------------------------------------------------------------
// Toast Notification & Utilities
// -------------------------------------------------------------

let toastTimeout;
function showToast(message) {
  const toast = document.getElementById("toast");
  const msgEl = document.getElementById("toast-message");
  msgEl.textContent = message;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(12px)";
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
