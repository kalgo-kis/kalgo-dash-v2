// Kalgo dashboard — single-file vanilla JS client.
// Loads dashboard_data/manifest.json, then lets the user pick an experiment.
// Bundled experiments load dashboard_data/{experiment_id}.json and render a full
// interactive view. Legacy experiments (no bundle) display summary stats only.

const COLORS = {
  green: "#3fb950", red: "#f85149", gray: "#6e7681",
  orange: "#db6d28", blue: "#58a6ff", purple: "#bc8cff",
  teal: "#39c5cf", gold: "#e3b341", cyan: "#56d4dd",
  text: "#e6edf3", textMuted: "#8b949e", border: "#30363d",
  surface: "#161b22", bg: "#0d1117",
};

// FlexGrid-tier shades for entry markers. Index 0 = base tier (lightest),
// 3 = flex tier 3 (darkest). Allows the chart to communicate which tier
// each entry belongs to without a legend.
const TIER_SHADES = {
  buy:  ["#a8e6b0", "#56d364", "#2ea043", "#1f6f2a"], // light → dark green
  sell: ["#ffb3ab", "#f85149", "#b62324", "#8b1414"], // light → dark red
};

// Resolve the active tier index for a given entry depth, given the bundle's
// per-tier `activates_at_depth` thresholds. Highest tier whose threshold ≤
// depth wins (matches GridEngine._active_tier semantics in the sim).
// Returns 0..3. Bundles without flex tiers (legacy / non-FlexGrid) get 0.
function tierIndexForDepth(depth, thresholds) {
  if (typeof depth !== "number" || depth < 0) return 0;
  if (thresholds.flex3 != null && depth >= thresholds.flex3) return 3;
  if (thresholds.flex2 != null && depth >= thresholds.flex2) return 2;
  if (thresholds.flex1 != null && depth >= thresholds.flex1) return 1;
  return 0;
}

function tierColorFor(side, depth, thresholds) {
  const idx = tierIndexForDepth(depth, thresholds);
  const palette = (side === "buy") ? TIER_SHADES.buy : TIER_SHADES.sell;
  return palette[idx];
}

// Pull tier thresholds out of policy_config. Missing tier sections (e.g.
// legacy bundles) yield null thresholds → tierIndexForDepth returns 0 →
// all entries render in the base shade. This preserves prior dashboard
// appearance for non-FlexGrid bundles.
function getTierThresholds(bundle) {
  const cfg = (bundle && bundle.policy_config) || {};
  const get = (k) => (cfg[k] && typeof cfg[k].activates_at_depth === "number")
    ? cfg[k].activates_at_depth : null;
  return { flex1: get("flex_tier_1"), flex2: get("flex_tier_2"), flex3: get("flex_tier_3") };
}

const state = {
  manifest: null,
  currentBundle: null,
  priceChart: null,
  bankChart: null,
  candleSeries: null,
  bankSeries: null,
  capitalLine: null,
  markerIndex: {},     // time -> [marker] for hover lookup
  accountsById: {},    // account_num -> account
  fullPriceRange: null, // [from, to] seconds
  hwmSeries: null,     // high-water mark line on pool chart
};

// ----- helpers -----
function setStatus(msg) {
  document.getElementById("status-chip").textContent = msg;
}
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(d);
}
function fmtDate(s) {
  if (!s) return "—";
  return String(s).replace("T", " ").slice(0, 16);
}
function toUnix(val) {
  // v2 bundles send unix seconds as numbers; legacy bundles send strings — handle both.
  if (val == null) return null;
  if (typeof val === "number") return Math.floor(val);
  const t = Date.parse(String(val).replace(" ", "T"));
  return isNaN(t) ? null : Math.floor(t / 1000);
}

function fmtUnix(t) {
  if (t == null) return "—";
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ----- load manifest & populate selector -----
// In harness mode (local server detected), fetch /api/manifest which combines
// shared (dashboard_data/) + scratch (experiments/scratch/) bundles. In
// read-only mode (live URL), fall back to the static dashboard_data/manifest.json.
async function loadManifest() {
  setStatus("loading manifest…");
  let m = null;
  if (state.harness) {
    try {
      const r = await fetch("/api/manifest");
      if (r.ok) m = await r.json();
    } catch { /* fall through to static */ }
  }
  if (!m) {
    const resp = await fetch("dashboard_data/manifest.json");
    if (!resp.ok) throw new Error("manifest.json not found");
    m = await resp.json();
  }
  state.manifest = m;
  const scratchCount = (m.experiments || []).filter(e => e.source === "scratch").length;
  const tail = scratchCount ? ` · ${scratchCount} scratch` : "";
  setStatus(`${m.count} experiments${tail}`);
  refreshSelector();
}

function getFilteredSorted() {
  const fold = document.getElementById("fold-filter").value;
  const sort = document.getElementById("sort-select").value;
  const onlyBundled = document.getElementById("only-bundled").checked;
  // Phase 2: source filter (all / shared / scratch / by user prefix)
  const source = document.getElementById("source-filter")?.value || "all";
  const userPrefix = (document.getElementById("source-user-filter")?.value || "").trim().toLowerCase();
  let list = state.manifest.experiments.slice();
  if (fold !== "all") list = list.filter(e => e.fold === fold);
  if (onlyBundled) list = list.filter(e => e.bundled);
  if (source === "shared") list = list.filter(e => e.source === "shared");
  else if (source === "scratch") list = list.filter(e => e.source === "scratch");
  else if (source === "user" && userPrefix) {
    list = list.filter(e => (e.filename || "").toLowerCase().startsWith(userPrefix + "_"));
  }
  switch (sort) {
    case "tr_desc": list.sort((a,b) => (b.total_return||0) - (a.total_return||0)); break;
    case "tr_asc":  list.sort((a,b) => (a.total_return||0) - (b.total_return||0)); break;
    case "recent":  list.sort((a,b) => (b.timestamp||"").localeCompare(a.timestamp||"")); break;
    default:        list.sort((a,b) => (b.bundled - a.bundled) || ((b.total_return||0) - (a.total_return||0)));
  }
  return list;
}

function refreshSelector() {
  const sel = document.getElementById("experiment-select");
  const list = getFilteredSorted();
  sel.innerHTML = "";
  for (const e of list) {
    const opt = document.createElement("option");
    const tr = e.total_return != null ? e.total_return.toFixed(3) + "x" : "n/a";
    const tag = e.source === "scratch" ? "[scratch] " : (e.bundled ? "● " : "  ");
    opt.textContent = `${tag}[${e.fold}] ${e.experiment_id}  —  TR ${tr}  (${e.total_accounts || "?"} accts)`;
    opt.value = e.experiment_id + "||" + e.fold;
    sel.appendChild(opt);
  }
  // auto-select first bundled experiment
  const firstBundled = list.find(e => e.bundled);
  if (firstBundled) {
    sel.value = firstBundled.experiment_id + "||" + firstBundled.fold;
    loadExperiment(firstBundled);
  } else if (list.length) {
    sel.value = list[0].experiment_id + "||" + list[0].fold;
    loadExperiment(list[0]);
  }
}

// ----- load one experiment bundle -----
async function loadExperiment(entry) {
  setStatus(`loading ${entry.experiment_id}…`);
  if (!entry.bundled) {
    // show summary-only view
    renderSummaryOnly(entry);
    setStatus("legacy experiment — no per-account data");
    updateBundleActions(entry);
    return;
  }
  // Manifest entries from /api/manifest carry an explicit `filename` so scratch
  // bundles (named scratch_<job_id>.json, not <experiment_id>.json) load
  // correctly. Fall back to the legacy convention for static manifests.
  const fname = entry.filename || `${entry.experiment_id}.json`;
  const resp = await fetch(`dashboard_data/${fname}`);
  if (!resp.ok) {
    setStatus(`failed to load ${fname}`);
    return;
  }
  const b = await resp.json();
  state.currentBundle = b;
  state.currentEntry = entry;
  state.accountsById = {};
  for (const a of b.accounts) state.accountsById[a.num] = a;
  // Phase 2: renumber trade IDs into the unified `A{acct}.B{N}.T{N}` format
  // (chronological per-account, side-agnostic). Affects every consumer of
  // entry.id: compliance table, chart hover, search, basket-panel display.
  renumberTradeIDs(b);
  renderBundle(b);
  setStatus(`loaded: ${b.accounts.length} accounts, ${b.candles_m15.length} candles`);
  updateBundleActions(entry);
  // Form-as-viewer (Phase 2): populate the Run Experiment form with this
  // bundle's params so the form is the single param surface.
  if (state.harness) populateFormFromBundle(b);
}

// ----- render -----
function renderSummaryOnly(entry) {
  state.currentBundle = null;
  document.getElementById("hdr-experiment-id").textContent = entry.experiment_id;
  document.getElementById("hdr-fold-period").textContent = `${entry.fold} · ${entry.eval_start}..${entry.eval_end}`;
  document.getElementById("hdr-poolreturn").textContent = "—";
  document.getElementById("hdr-poolreturn-sub").textContent = "";
  document.getElementById("hdr-expectancy").textContent = "—";
  document.getElementById("hdr-profitfactor").textContent = "—";
  document.getElementById("hdr-extractionratio").textContent = "—";
  document.getElementById("hdr-winrate").textContent = "—";
  document.getElementById("hdr-costs").textContent = "—";
  document.getElementById("data-warning-card").style.display = "";
  document.getElementById("data-warning-text").textContent =
    "Legacy — no per-account records. Re-run with patched harness.";

  clearCharts();
  const tableBody = document.querySelector("#accounts-table tbody");
  if (tableBody) tableBody.innerHTML = "";
  document.getElementById("detail-body").innerHTML = "<div class='placeholder'>Bundle this experiment for interactive account inspection.</div>";
}

function renderBundle(b) {
  // fleet summary bar
  const m = b.metrics || {};
  const accounts = b.accounts || [];
  document.getElementById("hdr-experiment-id").textContent = b.experiment_id;
  document.getElementById("hdr-fold-period").textContent = `${b.fold} · ${b.eval_start}..${b.eval_end}`;
  document.getElementById("data-warning-card").style.display = "none";

  // Compute investor economics first — header metrics + table + chart all depend on it.
  const startingCap = b.starting_capital || m.bank_start || 5000;
  const totalWithdrawn = accounts.reduce((s, a) => s + (a.withdrawn || 0), 0);
  const stakePerAcct = m.stake_per_account || (accounts[0]?.stake || 1000);
  const econ = computeInvestorEconomics(accounts, startingCap, stakePerAcct);
  state._investorEcon = econ;

  // Investor Return: total_distributed / total_called
  if (econ) {
    const invReturn = econ.totals.returnOnCalled;
    const prEl = document.getElementById("hdr-poolreturn");
    prEl.textContent = fmtNum(invReturn, 2) + "x";
    prEl.className = "metric-value " + (invReturn >= 1.0 ? "green" : "red");
    document.getElementById("hdr-poolreturn-sub").textContent =
      `${fmtMoney(econ.totals.totalCalled)} called \u2192 ${fmtMoney(econ.totals.totalDistributed)} returned`;

    // Capital Efficiency: % of commitment actually called
    const capEff = econ.totals.capitalEfficiency;
    const xrEl = document.getElementById("hdr-extractionratio");
    xrEl.textContent = fmtNum(capEff * 100, 0) + "%";
    xrEl.className = "metric-value " + (capEff < 1.0 ? "green" : "text");
  }

  // Win/loss stats
  const winners = accounts.filter(a => (a.net || 0) >= 0);
  const losers = accounts.filter(a => (a.net || 0) < 0);
  const winRate = accounts.length > 0 ? winners.length / accounts.length : 0;
  const avgWin = winners.length ? winners.reduce((s, a) => s + (a.net || 0), 0) / winners.length : 0;
  const avgLoss = losers.length ? losers.reduce((s, a) => s + Math.abs(a.net || 0), 0) / losers.length : 0;
  const lossRate = accounts.length > 0 ? losers.length / accounts.length : 0;

  // Expectancy: (winRate * avgWin) - (lossRate * avgLoss)
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
  const expEl = document.getElementById("hdr-expectancy");
  expEl.textContent = `${expectancy >= 0 ? "+" : ""}${fmtMoney(expectancy)}`;
  expEl.className = "metric-value " + (expectancy > 0 ? "green" : "red");

  // Profit Factor: sum(positive_nets) / sum(abs(negative_nets))
  const sumPosNets = winners.reduce((s, a) => s + (a.net || 0), 0);
  const sumNegNets = losers.reduce((s, a) => s + Math.abs(a.net || 0), 0);
  const profitFactor = sumNegNets > 0 ? sumPosNets / sumNegNets : (sumPosNets > 0 ? Infinity : 0);
  const pfEl = document.getElementById("hdr-profitfactor");
  pfEl.textContent = profitFactor === Infinity ? "\u221E" : fmtNum(profitFactor, 2);
  pfEl.className = "metric-value " + (profitFactor > 1.0 ? "green" : "red");

  // Win Rate: N/M (XX%)
  document.getElementById("hdr-winrate").textContent = `${winners.length}/${accounts.length} (${fmtNum(winRate * 100, 0)}%)`;

  // Costs %: (|commission| + |swap|) / withdrawn * 100
  const totalComm = m.total_commission || 0;
  const totalSwap = m.total_swap || 0;
  const costsPct = totalWithdrawn > 0 ? (Math.abs(totalComm) + Math.abs(totalSwap)) / totalWithdrawn * 100 : 0;
  document.getElementById("hdr-costs").textContent = fmtNum(costsPct, 1) + "%";

  // accounts table (must run before charts — computes investor economics)
  renderAccountsTable(accounts);

  // charts
  clearCharts();
  setupCharts();
  populatePriceChart(b);
  populateBankChart(b);

  // Final fit-content on the price chart. Both charts auto-sync via the
  // logical-range handlers. Deferred via requestAnimationFrame so any
  // layout pass from populate functions completes first.
  requestAnimationFrame(() => {
    const count = b.candles_m15?.length || 0;
    if (count > 0 && state.priceChart) {
      state._syncing = false;
      state.priceChart.timeScale().fitContent();
    }
  });

  // Phase 2: experiment_config_panel removed. The form (#runner-form) is now
  // the param viewer/editor. Compliance and notes still need to render —
  // hooks below.
  renderComplianceTablePanel(b);
  loadExperimentNotes(b);

  // reset detail panel
  document.getElementById("detail-body").innerHTML = `<div class="placeholder">Click a deploy marker on the chart or a table row to inspect an account. ${accounts.length} accounts loaded.</div>`;
  document.getElementById("close-detail-btn").style.display = "none";
}

// Notes: load from localStorage by experiment id. Persist on edit.
function loadExperimentNotes(b) {
  const expId = b.experiment_id || "";
  const notesKey = `kalgo_notes_${expId}`;
  const savedNotes = localStorage.getItem(notesKey) || "";
  const notesEl = document.getElementById("experiment-notes");
  if (!notesEl) return;
  notesEl.value = savedNotes;
  notesEl.oninput = () => {
    localStorage.setItem(notesKey, notesEl.value);
  };
}

// ----- Trade-Compliance Spreadsheet -----
//
// For every entry trade in the bundle, compute the EXPECTED lot and EXPECTED
// spacing (from the previous same-side entry in the same basket cycle) using
// the configured tier params, then compare to the ACTUAL trade. Surface any
// mismatch so the user can quickly find trades that don't match the intended
// strategy.
//
// Inputs:
//   bundle.policy_config.{base_tier, flex_tier_1/2/3, grid}
//     - tier.activates_at_depth, tier.spacing_pips, tier.tp_pips, tier.expected_lot
//   bundle.accounts[].trace.grid_entry_events[]  (price, lots, dir, depth_at_entry)
//   bundle.accounts[].basket_close_events[]      (closed_basket, time)
//
// Tolerance:
//   - Lot: exact (lots are quantized to 0.01)
//   - Spacing: ±2 pips (allows for tick-level execution variance)
//
// Depth-from-tag is what each entry already carries; we additionally track
// the "basket cycle depth" (depth within the current open basket on this
// side, reset on each close). For the engine these are the same, but
// computing it from the close events is useful as a cross-check.

const COMPLIANCE_SPACING_TOL_PIPS = 2.0;
const PIP_PRICE = 0.0001;

function getTiersFromConfig(cfg) {
  // Returns sorted ascending by activates_at_depth: [base, flex1?, flex2?, flex3?]
  const out = [];
  if (cfg && cfg.base_tier) {
    out.push({
      name: "base",
      label: "base",
      depth: 0,
      spacing_pips: cfg.base_tier.spacing_pips,
      tp_pips: cfg.base_tier.tp_pips,
      expected_lot: cfg.base_tier.expected_lot,
    });
  }
  for (const k of ["flex_tier_1", "flex_tier_2", "flex_tier_3"]) {
    const t = cfg && cfg[k];
    if (!t || typeof t.activates_at_depth !== "number") continue;
    out.push({
      name: k,
      label: k.replace("flex_tier_", "flex "),
      depth: t.activates_at_depth,
      spacing_pips: t.spacing_pips,
      tp_pips: t.tp_pips,
      expected_lot: t.expected_lot,
    });
  }
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

function activeTierForDepth(tiers, depth) {
  // Highest tier whose activates_at_depth ≤ depth
  let active = tiers[0];
  for (const t of tiers) if (t.depth <= depth) active = t;
  return active;
}

// EXACT per-trade P&L (matches the broker's bookkeeping to the cent).
//
// The broker computes basket P&L for a TP/recovery_tp/surrender close as:
//   basket.pnl = pip_value × Σ_i (close_price - entry_i [or entry_i - close_price]) × lots_i
//   basket.commission = Σ_i lots_i × $3   (close-side only; entry-side was charged at fill)
//
// We back out each trade's exact gross P&L by proportional split of basket.pnl
// over the gross-pnl-share of each position. Per-trade close commission = lots × $3.
// Entry commission was lots × $3 (charged at fill — also exact).
// Per-trade total round-trip commission = lots × $6.
//
// For non-TP trades (open at blowup or EOT), the bundle doesn't carry
// per-position close prices. We compute the residual = acct.net − Σ TP-trade-net
// per account and distribute it across the open trades by lots, so the
// account-level sum exactly equals acct.net (which already includes swap
// and stop-out losses).

const COMMISSION_PER_LOT_SIDE = 3.0;
const COMMISSION_PER_LOT_RT   = COMMISSION_PER_LOT_SIDE * 2;

// Find the M15 candle whose timestamp is closest to (and ≤) `unixTime`.
// Used to approximate stop-out / EOT exit prices when the broker doesn't
// emit a close event per position (blowups + survivor baskets at end of test).
function findCandleAtTime(bundle, unixTime) {
  const candles = bundle.candles_m15 || [];
  if (!candles.length || !unixTime) return null;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= unixTime) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo];
}

function buildComplianceRows(bundle) {
  const cfg = bundle.policy_config || {};
  const tiers = getTiersFromConfig(cfg);
  if (!tiers.length) return [];

  // Approximate the EOT close time from the last candle, used for survivor
  // baskets that the runner closes via _close_all_eot.
  const lastCandle = (bundle.candles_m15 || []).slice(-1)[0];
  const eotTime = lastCandle ? lastCandle.t : null;

  const rows = [];
  for (const acct of (bundle.accounts || [])) {
    const entries = (acct.trace && acct.trace.grid_entry_events) || [];
    const closes  = acct.basket_close_events || [];

    // Merge entries + closes chronologically
    const events = [];
    for (const e of entries) {
      const t = e.time_unix || (e.time && toUnix(e.time)) || 0;
      events.push({ kind: "entry", time: t, data: e });
    }
    for (const c of closes) {
      const t = toUnix(c.time);
      if (t) events.push({ kind: "close", time: t, data: c });
    }
    events.sort((a, b) => a.time - b.time);

    // Per-side basket state: depth (count) + last entry price for spacing check.
    // Also track rows of the currently-open basket so we can backfill exit_price
    // and pnl when the basket closes.
    const state = {
      buy:  { depth: 0, lastPrice: null, openRows: [] },
      sell: { depth: 0, lastPrice: null, openRows: [] },
    };

    for (const ev of events) {
      if (ev.kind === "entry") {
        const e = ev.data;
        const sideKey = (e.dir || "").toLowerCase();
        if (sideKey !== "buy" && sideKey !== "sell") continue;
        const s = state[sideKey];
        const depth = s.depth;          // depth BEFORE this entry (0-indexed)
        const tier = activeTierForDepth(tiers, depth);

        // Lot expectation
        const actualLot = e.lots;
        const expectedLot = tier.expected_lot;
        const lotOk = Math.abs(actualLot - expectedLot) < 0.005;

        // Spacing expectation (only meaningful for non-first entries)
        const expectedSpacing = tier.spacing_pips;
        let actualSpacing = null, spacingOk = null;
        if (s.lastPrice !== null) {
          actualSpacing = Math.abs(e.price - s.lastPrice) / PIP_PRICE;
          spacingOk = Math.abs(actualSpacing - expectedSpacing) <= COMPLIANCE_SPACING_TOL_PIPS;
        }

        const row = {
          id: e.id || "",
          acct: acct.num,
          time: ev.time,
          side: sideKey.toUpperCase(),
          depth: depth,             // depth-before-entry; matches engine's _active_tier(depth)
          tier: tier.label,
          tier_name: tier.name,
          price: e.price,
          // Exact close info from the bundle (joined by entry_id from the
          // broker's per_position close events). Null only if the trade
          // never closed (shouldn't happen — every position closes via
          // some path in the engine).
          exit_price: (e.exit_price != null) ? e.exit_price : null,
          exit_reason: e.exit_reason || null,
          exit_time_unix: e.exit_time_unix || null,
          pnl: (e.pnl_net != null) ? e.pnl_net : null,
          actual_lot: actualLot,
          expected_lot: expectedLot,
          lot_ok: lotOk,
          actual_spacing: actualSpacing,    // null for first entry of basket
          expected_spacing: expectedSpacing,
          spacing_ok: spacingOk,            // null for first entry of basket
          ok: lotOk && (spacingOk === null || spacingOk),
        };
        rows.push(row);

        s.depth += 1;
        s.lastPrice = e.price;
      } else {
        // Basket close: just reset the per-side basket-cycle state (used for
        // depth / spacing tracking). Per-trade exit_price and pnl come from
        // the bundle's exact per-position close info that bundle.py joined
        // by entry_id — see entry construction below.
        const sideKey = (ev.data.closed_basket || "").toLowerCase();
        if (sideKey === "buy" || sideKey === "sell") {
          state[sideKey].depth = 0;
          state[sideKey].lastPrice = null;
        }
      }
    }

    // Per-account exact tie-out adjustments. Two effects exist outside the
    // broker's per-trade realized_pnl:
    //   1. SWAP — debited from balance over time, not per trade.
    //   2. NEGATIVE BALANCE PROTECTION (NBP) — when broker's true trading
    //      loss exceeds the account's stake, residual is capped at 0 and
    //      acct.net is bounded at (withdrawn - stake). The "absorbed" loss
    //      doesn't reach the trader.
    // Both are real, account-level accounting. We distribute them across
    // the account's trades proportionally to (lots × hours-held) so the
    // displayed Σ per-trade pnl ties to acct.net to the floating-point cent.
    const acctRows = rows.filter(r => r.acct === acct.num);
    if (acctRows.length > 0) {
      const swap = (typeof acct.swap === "number") ? acct.swap : 0;
      const sumPnL = acctRows.reduce((s, r) => s + (r.pnl || 0), 0);
      // Total adjustment that needs to be distributed: (acct.net - Σ pnl_net - swap_already_in?).
      // pnl is broker-exact realized − commission; swap and NBP are NOT in it.
      // So target adjustment = acct.net - Σ pnl_net.
      const adjustment = acct.net - sumPnL;
      if (Math.abs(adjustment) > 1e-6) {
        const isSurvivor = (acct.outcome === "survived" || acct.reason === "end_of_eval");
        const fallbackClose = isSurvivor ? eotTime : (toUnix(acct.blowup_time) || eotTime);
        const weights = acctRows.map(r => {
          const exitT = r.exit_time_unix || fallbackClose || r.time;
          const hours = Math.max(1, (exitT - r.time) / 3600);
          return r.actual_lot * hours;
        });
        const totalW = weights.reduce((s, w) => s + w, 0);
        if (totalW > 0) {
          for (let i = 0; i < acctRows.length; i++) {
            acctRows[i].pnl = (acctRows[i].pnl || 0) + adjustment * (weights[i] / totalW);
          }
        }
      }
    }
  }

  return rows;
}

const _complianceState = {
  rows: [],
  filtered: [],
  sortKey: "time",
  sortDir: 1,            // 1 = asc, -1 = desc
  showOnlyIssues: false,
  searchTerm: "",        // case-insensitive substring match against id / acct / side / tier
};

function renderComplianceTablePanel(bundle) {
  const container = document.getElementById("trade-compliance");
  if (!container) return;

  const rows = buildComplianceRows(bundle);
  _complianceState.rows = rows;
  _complianceState.sortKey = "time";
  _complianceState.sortDir = 1;
  _complianceState.showOnlyIssues = false;
  _complianceState.searchTerm = "";

  if (!rows.length) {
    container.innerHTML = `<div class="placeholder">No trades found in this bundle.</div>`;
    return;
  }

  const okCount  = rows.filter(r => r.ok).length;
  const badCount = rows.length - okCount;

  container.innerHTML = `
    <div class="tc-header">
      <h4>Trade Compliance</h4>
      <span class="tc-summary" id="tc-summary">
        <span class="ok">${okCount} OK</span> ·
        <span class="${badCount ? 'bad' : 'muted'}">${badCount} ${badCount === 1 ? 'issue' : 'issues'}</span>
        of ${rows.length} trades
      </span>
      <div class="tc-controls">
        <input type="text" id="tc-search" placeholder="search id / acct / basket… (e.g. A9.B5 or BUY)" />
        <button id="tc-all"    class="active">All</button>
        <button id="tc-issues">Issues only</button>
      </div>
    </div>
    <div class="tc-scroll" id="tc-scroll"></div>
  `;

  document.getElementById("tc-all").onclick = () => {
    _complianceState.showOnlyIssues = false;
    document.getElementById("tc-all").classList.add("active");
    document.getElementById("tc-issues").classList.remove("active");
    redrawComplianceBody();
  };
  document.getElementById("tc-issues").onclick = () => {
    _complianceState.showOnlyIssues = true;
    document.getElementById("tc-issues").classList.add("active");
    document.getElementById("tc-all").classList.remove("active");
    redrawComplianceBody();
  };

  // Search box: matches case-insensitively against id / acct / side / tier.
  // Examples: "A8.S3" -> all trades in account 8's sell basket #3.
  //           "A11"   -> all trades in account 11.
  //           "BUY"   -> all buy entries.
  //           "flex 3" -> all flex 3 tier trades.
  let searchDebounce = null;
  document.getElementById("tc-search").oninput = (ev) => {
    const v = ev.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      _complianceState.searchTerm = v.trim().toLowerCase();
      redrawComplianceBody();
    }, 80);
  };

  redrawComplianceBody();
}

const TC_COLUMNS = [
  { key: "id",              label: "ID",       align: "left" },
  { key: "time",            label: "Time",     align: "left" },
  { key: "side",            label: "Side",     align: "left" },
  { key: "depth",           label: "Depth",    align: "num" },
  { key: "tier",            label: "Tier",     align: "left" },
  { key: "price",           label: "Entry",    align: "num" },
  { key: "exit_price",      label: "Exit",     align: "num" },
  { key: "pnl",             label: "P&L $",    align: "num" },
  { key: "actual_lot",      label: "Lot (act / exp)",   align: "num" },
  { key: "actual_spacing",  label: "Spacing pips (act / exp)", align: "num" },
  { key: "ok",              label: "OK?",      align: "left" },
];

function redrawComplianceBody() {
  const scrollEl = document.getElementById("tc-scroll");
  if (!scrollEl) return;

  let rows = _complianceState.rows;
  if (_complianceState.showOnlyIssues) rows = rows.filter(r => !r.ok);
  if (_complianceState.searchTerm) {
    const term = _complianceState.searchTerm;
    rows = rows.filter(r => {
      // Build a single haystack of fields the user might search:
      // id, account number, side, tier label.
      const h = (r.id + " A" + r.acct + " " + r.side + " " + r.tier).toLowerCase();
      return h.includes(term);
    });
  }

  // Update summary count to reflect current filter
  const summaryEl = document.getElementById("tc-summary");
  if (summaryEl) {
    const okC  = rows.filter(r => r.ok).length;
    const badC = rows.length - okC;
    const totalRows = _complianceState.rows.length;
    const filterNote = (rows.length !== totalRows)
      ? ` <span class="muted">(${rows.length}/${totalRows} matching)</span>` : "";
    summaryEl.innerHTML = (
      `<span class="ok">${okC} OK</span> · ` +
      `<span class="${badC ? 'bad' : 'muted'}">${badC} ${badC === 1 ? 'issue' : 'issues'}</span>` +
      ` of ${rows.length} trades` + filterNote
    );
  }

  // Sort
  const k = _complianceState.sortKey;
  const dir = _complianceState.sortDir;
  rows = [...rows].sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });

  const fmtPrice = (p) => (typeof p === "number") ? p.toFixed(5) : "—";
  const fmtLot   = (l) => (typeof l === "number") ? l.toFixed(2) : "—";
  const fmtPips  = (p) => (typeof p === "number") ? p.toFixed(1) : "—";
  const fmtTime  = (t) => {
    if (!t) return "—";
    const d = new Date(t * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  const headerHTML = TC_COLUMNS.map(c => {
    const sortCls = (c.key === k) ? (dir === 1 ? "sort-asc" : "sort-desc") : "";
    return `<th data-key="${c.key}" class="${c.align === 'num' ? 'num' : ''} ${sortCls}">${c.label}</th>`;
  }).join("");

  // Body — capped at 5000 rows for performance; filter narrows otherwise
  const cap = 5000;
  const slice = rows.slice(0, cap);

  const bodyHTML = slice.map(r => {
    const sideCls = r.side === "BUY" ? "side-buy" : "side-sell";
    const lotCell = r.lot_ok
      ? `<span class="ok">${fmtLot(r.actual_lot)}</span> <span class="delta">/ ${fmtLot(r.expected_lot)}</span>`
      : `<span class="bad">${fmtLot(r.actual_lot)}</span> <span class="delta">/ ${fmtLot(r.expected_lot)}</span>`;

    let spCell;
    if (r.actual_spacing === null) {
      spCell = `<span class="muted">— first of basket</span>`;
    } else {
      spCell = r.spacing_ok
        ? `<span class="ok">${fmtPips(r.actual_spacing)}</span> <span class="delta">/ ${fmtPips(r.expected_spacing)}</span>`
        : `<span class="bad">${fmtPips(r.actual_spacing)}</span> <span class="delta">/ ${fmtPips(r.expected_spacing)}</span>`;
    }

    const okCell = r.ok ? `<span class="ok">\u2713</span>` : `<span class="bad">\u2717</span>`;

    const pnlCell = (r.pnl == null)
      ? `<span class="muted">—</span>`
      : `<span class="${r.pnl >= 0 ? 'ok' : 'bad'}">${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}</span>`;
    const exitCell = (r.exit_price == null)
      ? `<span class="muted">—</span>`
      : fmtPrice(r.exit_price);

    return `<tr class="${r.ok ? '' : 'bad'}">
      <td class="trade-id">${r.id || '—'}</td>
      <td>${fmtTime(r.time)}</td>
      <td class="${sideCls}">${r.side}</td>
      <td class="num">${r.depth}</td>
      <td>${r.tier}</td>
      <td class="num">${fmtPrice(r.price)}</td>
      <td class="num">${exitCell}</td>
      <td class="num">${pnlCell}</td>
      <td class="num actual-vs-expected">${lotCell}</td>
      <td class="num actual-vs-expected">${spCell}</td>
      <td>${okCell}</td>
    </tr>`;
  }).join("");

  const colCount = TC_COLUMNS.length;
  const truncateHTML = rows.length > cap
    ? `<tr><td colspan="${colCount}" class="muted" style="padding:8px;text-align:center">${rows.length - cap} more rows hidden — narrow with "Issues only" filter or use search</td></tr>`
    : "";

  // ── Totals row ─────────────────────────────────────────────────────
  // Aggregates over ALL filtered rows (not just the visible cap):
  //   - sum lots
  //   - sum P&L for closed trades only (open trades show as "—")
  //   - lot-weighted average entry price (uses every row)
  //   - lot-weighted average exit price (uses only closed rows)
  // Buy and sell get separate totals + a combined row, since avg entry/exit
  // for a mixed set of buys and sells doesn't have a coherent meaning.
  const aggBy = (filterFn) => {
    let sumLots = 0, sumPnL = 0, hasPnL = false;
    let weightedEntry = 0, sumLotsEntry = 0;
    let weightedExit = 0, sumLotsExit = 0;
    for (const r of rows.filter(filterFn)) {
      const lots = r.actual_lot || 0;
      sumLots += lots;
      if (r.price != null) {
        weightedEntry += r.price * lots;
        sumLotsEntry += lots;
      }
      if (r.exit_price != null) {
        weightedExit += r.exit_price * lots;
        sumLotsExit += lots;
      }
      if (r.pnl != null) {
        sumPnL += r.pnl;
        hasPnL = true;
      }
    }
    return {
      lots: sumLots,
      pnl: hasPnL ? sumPnL : null,
      avgEntry: sumLotsEntry > 0 ? weightedEntry / sumLotsEntry : null,
      avgExit:  sumLotsExit  > 0 ? weightedExit  / sumLotsExit  : null,
      count: rows.filter(filterFn).length,
    };
  };
  const tBuy  = aggBy(r => r.side === "BUY");
  const tSell = aggBy(r => r.side === "SELL");
  const tAll  = aggBy(() => true);

  const renderTotalsRow = (label, t, accent) => {
    const pnlCell = (t.pnl == null)
      ? `<span class="muted">—</span>`
      : `<span class="${t.pnl >= 0 ? 'ok' : 'bad'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>`;
    const entryCell = t.avgEntry == null ? `<span class="muted">—</span>` : fmtPrice(t.avgEntry);
    const exitCell  = t.avgExit  == null ? `<span class="muted">—</span>` : fmtPrice(t.avgExit);
    return `<tr class="totals ${accent}">
      <td class="totals-label" colspan="5">${label} <span class="muted">(${t.count} trades)</span></td>
      <td class="num">${entryCell}</td>
      <td class="num">${exitCell}</td>
      <td class="num">${pnlCell}</td>
      <td class="num">${t.lots.toFixed(2)} lots</td>
      <td></td>
      <td></td>
    </tr>`;
  };

  let totalsHTML = "";
  if (tAll.count > 0) {
    totalsHTML += renderTotalsRow("Σ BUY (lot-wtd avgs)",  tBuy,  "buy");
    totalsHTML += renderTotalsRow("Σ SELL (lot-wtd avgs)", tSell, "sell");
    totalsHTML += renderTotalsRow("Σ ALL (lot-wtd avgs)",  tAll,  "all");
  }

  scrollEl.innerHTML = `
    <table class="tc-table">
      <thead><tr>${headerHTML}</tr></thead>
      <tbody>${bodyHTML}${truncateHTML}</tbody>
      <tfoot>${totalsHTML}</tfoot>
    </table>
  `;

  // Wire header sort
  scrollEl.querySelectorAll("thead th").forEach(th => {
    th.onclick = () => {
      const newKey = th.dataset.key;
      if (_complianceState.sortKey === newKey) {
        _complianceState.sortDir = -_complianceState.sortDir;
      } else {
        _complianceState.sortKey = newKey;
        _complianceState.sortDir = 1;
      }
      redrawComplianceBody();
    };
  });
}

// ----- investor economics -----

/**
 * Compute investor economics from account records.
 *
 * Model: investor commits capital, funds accounts on demand ($stake each).
 * Withdrawals return to operating cash. Excess above next stake is
 * distributed back to investor. Final account returns all cash.
 *
 * Returns { accounts: [...enriched], totals: {...} }
 */
function computeInvestorEconomics(accounts, startingCapital, stakePerAccount) {
  const ordered = [...accounts].sort((a, b) => (a.deploy_time || 0) - (b.deploy_time || 0));
  const stake = stakePerAccount || (ordered[0]?.stake || 1000);

  let operatingCash = 0;
  let totalCalled = 0;
  let totalDistributed = 0;
  let remainingCommitment = startingCapital;

  const enriched = ordered.map((a, i) => {
    const acctStake = a.stake || stake;
    const extracted = a.withdrawn || 0;
    const net = a.net || 0;
    const residual = net - extracted + acctStake; // net = extracted - stake + residual

    // Capital call: how much new investor money needed?
    const shortfall = Math.max(0, acctStake - operatingCash);
    const capitalCall = Math.min(shortfall, remainingCommitment);
    totalCalled += capitalCall;
    remainingCommitment -= capitalCall;

    // Deploy
    operatingCash = operatingCash + capitalCall - acctStake;

    // During life: extractions return to operating cash
    operatingCash += extracted;

    // On close: residual returns
    operatingCash += Math.max(0, residual);

    // Distribution: excess above next stake, or all if last account
    const isLast = (i === ordered.length - 1);
    const distribution = isLast ? operatingCash : Math.max(0, operatingCash - acctStake);
    totalDistributed += distribution;
    operatingCash -= distribution;

    return {
      ...a,
      capitalCall: Math.round(capitalCall * 100) / 100,
      distribution: Math.round(distribution * 100) / 100,
      cashAfter: Math.round(operatingCash * 100) / 100,
    };
  });

  return {
    accounts: enriched,
    totals: {
      committed: startingCapital,
      totalCalled: Math.round(totalCalled * 100) / 100,
      totalDistributed: Math.round(totalDistributed * 100) / 100,
      investorProfit: Math.round((totalDistributed - totalCalled) * 100) / 100,
      returnOnCalled: totalCalled > 0 ? totalDistributed / totalCalled : 0,
      capitalEfficiency: startingCapital > 0 ? totalCalled / startingCapital : 0,
      unusedCommitment: Math.round(remainingCommitment * 100) / 100,
    },
  };
}

// ----- accounts table -----
state._tableSortCol = "num";
state._tableSortAsc = true;

function renderAccountsTable(accounts) {
  const b = state.currentBundle;
  const m = b ? (b.metrics || {}) : {};
  const startCap = b ? (b.starting_capital || m.bank_start || 5000) : 5000;
  const stakePerAcct = m.stake_per_account || (accounts[0]?.stake || 1000);

  // Use cached investor economics (computed in renderBundle), or compute now if missing
  const econ = state._investorEcon || computeInvestorEconomics(accounts, startCap, stakePerAcct);
  state._investorEcon = econ;

  const colDefs = {
    num:         { label: "#",            tip: "Account number (deploy order)" },
    outcome:     { label: "Outcome",      tip: "How the account ended — blowup (margin stop-out) or survived to end of evaluation period" },
    stake:       { label: "Stake",        tip: "Capital deployed into this account" },
    net:         { label: "Net P&L",      tip: "Extracted + residual − stake. Positive = account paid for itself" },
    capitalCall: { label: "Cap. Call",     tip: "New money requested from investor for this deployment. Zero when operating cash covers the stake (self-funding)" },
    distribution:{ label: "Distribution", tip: "Cash returned to investor after account closes. Excess above next stake is distributed; final account returns all remaining cash" },
    cashAfter:   { label: "Cash",         tip: "Operating cash available after this account closes. Must cover next stake or a capital call is needed" },
    lifetime_days:{ label: "Life",        tip: "Account lifetime in days from deploy to close" },
  };
  const pnlFmt = v => `<span style="color:var(--${v >= 0 ? "green" : "red"})">${v >= 0 ? "+" : ""}${fmtMoney(v)}</span>`;
  const cols = [
    { key: "num",          fmt: v => v },
    { key: "outcome",      fmt: v => `<span class="outcome-badge ${v}">${(v||"").replace("_"," ")}</span>` },
    { key: "stake",        fmt: fmtMoney },
    { key: "net",          fmt: pnlFmt },
    { key: "capitalCall",  fmt: v => v > 0 ? `<span style="color:var(--red)">${fmtMoney(v)}</span>` : `<span style="color:var(--text-muted)">—</span>` },
    { key: "distribution", fmt: v => v > 0 ? `<span style="color:var(--green)">${fmtMoney(v)}</span>` : `<span style="color:var(--text-muted)">—</span>` },
    { key: "cashAfter",    fmt: fmtMoney },
    { key: "lifetime_days",fmt: v => fmtNum(v, 1) + "d" },
  ];

  // Use enriched accounts from investor economics (already in deploy order)
  const rows = [...econ.accounts];

  // Sort
  const sortKey = state._tableSortCol;
  const asc = state._tableSortAsc;
  rows.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === "string") return asc ? (va||"").localeCompare(vb||"") : (vb||"").localeCompare(va||"");
    return asc ? (va||0) - (vb||0) : (vb||0) - (va||0);
  });

  const table = document.getElementById("accounts-table");
  const thead = table.querySelector("thead tr");
  const tbody = table.querySelector("tbody");

  // Header with tooltip descriptions
  thead.innerHTML = cols.map(c => {
    const def = colDefs[c.key] || {};
    const label = def.label || c.key;
    const tip = def.tip ? ` title="${def.tip}"` : "";
    const isSorted = state._tableSortCol === c.key;
    const arrow = isSorted ? (state._tableSortAsc ? " \u25B2" : " \u25BC") : "";
    return `<th data-col="${c.key}" class="${isSorted ? "sorted" : ""}"${tip} style="cursor:help">${label}<span class="sort-arrow">${arrow}</span></th>`;
  }).join("");

  // Body
  tbody.innerHTML = rows.map(a => {
    const tds = cols.map(c => `<td>${c.fmt(a[c.key])}</td>`).join("");
    return `<tr data-num="${a.num}">${tds}</tr>`;
  }).join("");

  // Fleet summary row — investor-level totals
  const t = econ.totals;
  const profitable = accounts.filter(a => (a.net || 0) >= 0).length;
  const calendarDays = m.total_calendar_days || 730;
  tbody.innerHTML += `<tr class="totals-row">
    <td>FLEET</td>
    <td>${profitable}/${accounts.length} profit</td>
    <td title="Investor committed ${fmtMoney(t.committed)}">\u2014</td>
    <td>${pnlFmt(t.investorProfit)}</td>
    <td title="Total new capital called from investor"><span style="color:var(--red)">${fmtMoney(t.totalCalled)}</span></td>
    <td title="Total cash returned to investor"><span style="color:var(--green)">${fmtMoney(t.totalDistributed)}</span></td>
    <td title="Return on called capital: ${fmtNum(t.returnOnCalled, 2)}x">\u2014</td>
    <td>${calendarDays}d</td>
  </tr>`;

  // Click handlers — sort
  thead.querySelectorAll("th").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state._tableSortCol === col) {
        state._tableSortAsc = !state._tableSortAsc;
      } else {
        state._tableSortCol = col;
        state._tableSortAsc = col === "num"; // default asc for #, desc for values
      }
      renderAccountsTable(accounts);
    });
  });

  // Click handlers — row select
  tbody.querySelectorAll("tr:not(.totals-row)").forEach(tr => {
    tr.addEventListener("click", () => {
      const num = parseInt(tr.dataset.num);
      const acct = state.accountsById[num];
      if (acct) {
        // highlight row
        tbody.querySelectorAll("tr.selected").forEach(r => r.classList.remove("selected"));
        tr.classList.add("selected");
        showAccountDetail(acct);
      }
    });
  });
}

// ----- charts -----
function clearCharts() {
  // Cancel any active RAF loops before tearing down DOM
  if (state._bandsAnimFrame) {
    cancelAnimationFrame(state._bandsAnimFrame);
    state._bandsAnimFrame = null;
  }
  state._bandsCanvas = null;

  const pc = document.getElementById("price-chart");
  const bc = document.getElementById("bank-chart");
  pc.innerHTML = ""; bc.innerHTML = "";
  state.priceChart = null; state.bankChart = null;
  state.candleSeries = null; state.bankSeries = null;
  state.hwmSeries = null;
  state.markerIndex = {};
  state.fullPriceRange = null;
}

function commonChartOpts(height) {
  return {
    height,
    layout: { background: { type: "solid", color: COLORS.surface }, textColor: COLORS.text },
    grid: { vertLines: { color: COLORS.border }, horzLines: { color: COLORS.border } },
    // minBarSpacing default (0.5) caps visible bars at chartWidth/0.5 ≈ 3000,
    // but the longest fold (fold1, 4 years) has ~100k M15 candles. Without
    // lowering this the chart refuses to zoom out past the last ~3000 bars,
    // pinning the view to the final days of the fold. 0.005 gives headroom
    // for ~300k bars at 1500px, which covers every fold.
    timeScale: {
      borderColor: COLORS.border,
      timeVisible: true,
      secondsVisible: false,
      // minBarSpacing tunes how far a user can zoom OUT — 0.005 allows
      // ~3000 bars per 15px (covers fold1 ~100k bars comfortably).
      minBarSpacing: 0.005,
      rightOffset: 0,
      // Prevents the chart from "scrolling past the right edge when new
      // bars arrive"; also keeps fitContent stable.
      shiftVisibleRangeOnNewBar: false,
    },
    rightPriceScale: { borderColor: COLORS.border, visible: true },
    leftPriceScale:  { borderColor: COLORS.border, visible: true },
    crosshair: { mode: 1 },
  };
}

function setupCharts() {
  const pcEl = document.getElementById("price-chart");
  const bcEl = document.getElementById("bank-chart");
  state.priceChart = LightweightCharts.createChart(pcEl, {
    ...commonChartOpts(pcEl.clientHeight || 480),
    width: pcEl.clientWidth,
  });
  state.bankChart = LightweightCharts.createChart(bcEl, {
    ...commonChartOpts(bcEl.clientHeight || 360),
    width: bcEl.clientWidth,
  });

  state.candleSeries = state.priceChart.addCandlestickSeries({
    upColor: "#5a6a80", downColor: "#353f50",
    borderUpColor: "#6a7a90", borderDownColor: "#5a6578",
    wickUpColor: "#6a7a90", wickDownColor: "#5a6578",
    // EURGBP prices move in fractions of a pip — 5-decimal format is required
    // to read grid levels, spreads, and TP targets. The default 2-decimal
    // "stock" format hides everything below 0.01 which is useless for forex.
    priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
  });
  // Bank chart — single Investor Net P&L line (green above 0, red below).
  // BaselineSeries auto-fills above/below the baseline value with different colors.
  state.bankSeries = state.bankChart.addBaselineSeries({
    baseValue: { type: "price", price: 0 },
    topLineColor: COLORS.green,
    topFillColor1: "rgba(63, 185, 80, 0.28)",
    topFillColor2: "rgba(63, 185, 80, 0.05)",
    bottomLineColor: COLORS.red,
    bottomFillColor1: "rgba(248, 81, 73, 0.05)",
    bottomFillColor2: "rgba(248, 81, 73, 0.28)",
    lineWidth: 2,
    title: "Investor Net P&L",
  });
  // Break-even reference line at $0
  state.capitalLine = state.bankChart.addLineSeries({
    color: COLORS.gray, lineWidth: 1, lineStyle: 2,
    title: "Break-even",
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
  });
  // Peak-exposure reference (horizontal dashed line at min(net P&L) — the deepest underwater point)
  state.hwmSeries = state.bankChart.addLineSeries({
    color: COLORS.gray, lineWidth: 1, lineStyle: 1,
    title: "Peak Loss",
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
  });
  state.savingsSeries = state.bankSeries;
  state.totalSeries = null;
  state.bankChart.priceScale("right").applyOptions({
    scaleMargins: { top: 0.05, bottom: 0.05 },
  });

  // resize handling
  const ro = new ResizeObserver(() => {
    if (state.priceChart) state.priceChart.resize(pcEl.clientWidth, pcEl.clientHeight);
    if (state.bankChart) state.bankChart.resize(bcEl.clientWidth, bcEl.clientHeight);
  });
  ro.observe(pcEl);
  ro.observe(bcEl);

  // Sync bank chart to the price chart by WALL-CLOCK time (not logical index).
  // Logical sync fails because the charts have very different point counts
  // (~71k M15 candles vs ~160 bank points).
  //
  // One-way: price -> bank. Bidirectional sync caused a feedback loop because
  // the bank chart clamps to its own data bounds and emits back, snapping the
  // price chart. The capital reference line is extended in populateBankChart
  // to span the full eval period so bank's "follow" rarely needs to clamp.
  //
  // Guarded: populatePriceChart's fitContent() fires this handler BEFORE
  // populateBankChart has set any data. Trying to setVisibleRange on an empty
  // bank chart throws and aborts the rest of the render, leaving both charts
  // in a corrupt state. Skip the sync until the bank chart actually has data.
  // Bidirectional TIME-based sync. We use wall-clock time because the two
  // charts have different data schedules in M1 detail mode (price chart
  // gets M1 candles while bank chart keeps M15), so logical-index mapping
  // would diverge. Time aligns both regardless of sampling rate.
  // The _syncing flag breaks the feedback loop.
  state._syncing = false;
  state.priceChart.timeScale().subscribeVisibleTimeRangeChange(r => {
    if (!r) return;
    applyMarkersForVisibleRange(r);
    if (state._syncing) return;
    if (!state.bankChart || !state.bankSeries) return;
    const data = state.bankSeries.data();
    if (!data || data.length === 0) return;
    state._syncing = true;
    try { state.bankChart.timeScale().setVisibleRange({ from: r.from, to: r.to }); }
    catch (e) { /* ignore */ }
    state._syncing = false;
  });
  state.bankChart.timeScale().subscribeVisibleTimeRangeChange(r => {
    if (!r || state._syncing) return;
    if (!state.priceChart || !state.candleSeries) return;
    state._syncing = true;
    try { state.priceChart.timeScale().setVisibleRange({ from: r.from, to: r.to }); }
    catch (e) { /* ignore */ }
    state._syncing = false;
  });

  // click handler for markers
  state.priceChart.subscribeCrosshairMove(param => {
    if (!param || !param.time) return;
    // hover tooltip could go here; for now click handles selection
  });
  state.priceChart.subscribeClick(param => {
    if (!param || !param.time) return;
    // Find the account whose [deploy, close] range contains the clicked time.
    // With single-account-per-instrument enforced, ranges don't overlap, but
    // pick the deploy closest to the click for safety.
    const t = param.time;
    const b = state.currentBundle;
    if (!b) return;
    let containing = null, containingDist = Infinity;
    for (const a of b.accounts) {
      const dT = toUnix(a.deploy_time);
      const cT = accountEndTime(a);
      if (dT == null || cT == null) continue;
      if (t >= dT && t <= cT) {
        const d = t - dT;
        if (d < containingDist) { containingDist = d; containing = a; }
      }
    }
    if (containing) {
      showAccountDetail(containing);
    }
  });
}

function buildMarkers(accounts) {
  // Account periods are now shown as colored diagonal lines (drawAccountBands)
  // with the account number labelled at the midpoint, so deploy and blowup
  // arrow markers are intentionally omitted to reduce visual noise. Only
  // recovery events remain as inline markers.
  const markers = [];
  for (const a of accounts) {
    for (const ev of (a.recovery_events || [])) {
      const tm = toUnix(ev.time);
      if (tm != null) {
        markers.push({
          time: tm, position: "aboveBar", color: COLORS.orange,
          shape: "circle", text: `r${a.num}`,
          _kind: "recovery", _acct: a.num,
        });
      }
    }
  }
  markers.sort((a, b) => a.time - b.time);
  return markers;
}

// Strip internal _kind/_acct fields before passing to lightweight-charts.
function stripInternal(m) {
  return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
}

// Priority-tiered LOD cull. Keeps deploy+blowup first (one pair per account —
// the most informative), then close events, then recovery events, subsampling
// the final tier if needed to hit the target visible-count budget.
function cullPriceMarkers(markers, target) {
  if (markers.length <= target) return markers;
  const priorities = ["deploy", "blowup", "close", "recovery"];
  const result = [];
  for (const kind of priorities) {
    const group = markers.filter(m => m._kind === kind);
    if (result.length + group.length <= target) {
      result.push(...group);
      continue;
    }
    const budget = target - result.length;
    if (budget > 0 && group.length > 0) {
      // Uniform subsample so the surviving markers are spread across time,
      // not clustered at the start.
      const step = group.length / budget;
      for (let i = 0; i < budget; i++) result.push(group[Math.floor(i * step)]);
    }
    continue;
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

// Bank markers are all one type (per-account). Simple uniform subsample.
function cullBankMarkers(markers, target) {
  if (markers.length <= target) return markers;
  const step = markers.length / target;
  const result = [];
  for (let i = 0; i < target; i++) result.push(markers[Math.floor(i * step)]);
  return result;
}

// Re-apply markers based on the currently visible time range. Called on every
// visible-range change so the LOD updates as the user pans/zooms.
function applyMarkersForVisibleRange(range) {
  if (!state.fullPriceMarkers || !state.candleSeries) return;
  const r = range || (state.priceChart && state.priceChart.timeScale().getVisibleRange());
  if (!r) return;
  const from = r.from, to = r.to;
  const visible = state.fullPriceMarkers.filter(m => m.time >= from && m.time <= to);
  let culled = cullPriceMarkers(visible, 150);
  // When trace overlay is active:
  // 1. Remove the LOD markers for the traced account (deploy arrow, blowup,
  //    close, recovery markers like c1, ×1, r1) — the trace provides more
  //    detailed versions of these.
  // 2. Merge in the trace entry/close/withdrawal markers.
  let finalPriceMarkers = culled;
  if (state.traceActive) {
    const tracedAcct = state._tracedAccountNum;
    if (tracedAcct != null) {
      culled = culled.filter(m => m._acct !== tracedAcct || m._kind === "deploy" || m._kind === "blowup");
    }
    // Merge in trace candle markers (withdrawals etc) from traceEntryMarkers
    if (state.traceEntryMarkers && state.traceEntryMarkers.length) {
      const traceVisible = state.traceEntryMarkers.filter(m => m.time >= from && m.time <= to);
      finalPriceMarkers = [...culled, ...traceVisible];
    } else {
      finalPriceMarkers = culled;
    }
    finalPriceMarkers.sort((a, b) => a.time - b.time);
  }
  state.candleSeries.setMarkers(finalPriceMarkers.map(stripInternal));
  // Bank chart markers (account outcomes on the pool balance line).
  if (state.fullBankMarkers && state.bankSeries) {
    const vbank = state.fullBankMarkers.filter(m => m.time >= from && m.time <= to);
    const cbank = cullBankMarkers(vbank, 80);
    state.bankSeries.setMarkers(cbank.map(stripInternal));
  }
}

function populatePriceChart(b) {
  const candles = b.candles_m15.map(c => ({
    time: c.t, open: c.o, high: c.h, low: c.l, close: c.c,
  }));
  state.candleSeries.setData(candles);
  if (candles.length) {
    state.fullPriceRange = [candles[0].time, candles[candles.length - 1].time];
  }

  // Account period highlight bands (translucent colored backgrounds).
  drawAccountBands(b);

  // Store the FULL marker set (with _kind preserved) so the LOD culler can
  // re-filter on every zoom change. The initial setMarkers call is replaced
  // by applyMarkersForVisibleRange once the bank chart is also ready.
  const raw = buildMarkers(b.accounts);
  raw.sort((a, b) => a.time - b.time);
  state.fullPriceMarkers = raw;
  state.candleSeries.setMarkers(cullPriceMarkers(raw, 150).map(stripInternal));
  // Set barSpacing so the full dataset fits the chart width on first paint.
  // LWC's default is 6 px/bar which only shows ~200 of our 49k bars. We
  // compute the ratio from the real rendered width so every fold (2-4 yr
  // M15 data) fits without manual zoom.
  if (candles.length > 0) {
    const pcEl = document.getElementById("price-chart");
    const usableW = Math.max(100, (pcEl?.clientWidth || 1280) - 140); // minus price scales
    const fitSpacing = Math.max(0.005, usableW / candles.length);
    state.priceChart.applyOptions({ timeScale: { barSpacing: fitSpacing } });
    state.bankChart?.applyOptions({ timeScale: { barSpacing: fitSpacing } });
    state.priceChart.timeScale().setVisibleLogicalRange({
      from: 0, to: candles.length - 1,
    });
  }
}

/**
 * Draw translucent colored bands behind candles for each account's lifetime.
 * Green = profit (survived or blowup_profit), Red = loss (blowup_loss),
 * Gray = total loss. Updates on every animation frame to track pan/zoom.
 * Hidden in M1 detail mode via state._isM1Active check.
 */
function drawAccountBands(b) {
  const chartEl = document.getElementById("price-chart");

  // Remove any prior bands canvas + RAF
  if (state._bandsAnimFrame) {
    cancelAnimationFrame(state._bandsAnimFrame);
    state._bandsAnimFrame = null;
  }
  let canvas = document.getElementById("account-bands-canvas");
  if (canvas) canvas.remove();
  canvas = document.createElement("canvas");
  canvas.id = "account-bands-canvas";
  canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;";
  chartEl.style.position = "relative";
  chartEl.appendChild(canvas);
  state._bandsCanvas = canvas;

  // Binary-search M15 candles by time. Returns the candle index whose
  // timestamp is closest to t (used to look up high/low/close at a moment).
  const candles = b.candles_m15 || [];
  function findCandleIdx(t) {
    if (!candles.length) return -1;
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(candles[lo - 1].t - t) < Math.abs(candles[lo].t - t)) {
      return lo - 1;
    }
    return lo;
  }

  // Pre-compute one band per account.
  // Geometry mirrors where the deploy/blowup arrow markers used to sit:
  //   - start: (deploy_time, candle.low at deploy)   — was "belowBar"
  //   - end:   (close_time,  candle.high at close)   — was "aboveBar"
  // For survivors (no blowup), end is the last candle's close price.
  const bands = (b.accounts || []).map(a => {
    const deployT = toUnix(a.deploy_time);
    const closeT = accountEndTime(a);
    const fromIdx = findCandleIdx(deployT);
    const toIdx = findCandleIdx(closeT);
    if (fromIdx < 0 || toIdx < 0) return null;
    const fromCandle = candles[fromIdx];
    const toCandle = candles[toIdx];
    const fromT = fromCandle.t;
    const toT = toCandle.t;
    const fromPrice = fromCandle.l;  // deploy marker sits at candle low
    const toPrice = a.blowup ? toCandle.h : toCandle.c;  // blowup at high, survivor at last close
    let color;
    if (a.outcome === "survived" || a.outcome === "blowup_profit") {
      color = "rgba(63, 185, 80, 0.45)";  // green
    } else if (a.outcome === "total_loss") {
      color = "rgba(110, 118, 129, 0.50)"; // gray
    } else {
      color = "rgba(248, 81, 73, 0.45)";   // red
    }
    return { fromT, toT, fromPrice, toPrice, color, num: a.num };
  }).filter(b => b && b.toT > b.fromT);

  function drawFrame() {
    if (!state._bandsCanvas) return;
    const cvs = state._bandsCanvas;
    const parent = cvs.parentElement;
    if (!parent) return;

    // Skip drawing if M1 detail mode is active (one account view — bands obscure)
    if (state._isM1Active) {
      const ctx = cvs.getContext("2d");
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      state._bandsAnimFrame = requestAnimationFrame(drawFrame);
      return;
    }

    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
    }

    const ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!state.priceChart || !state.candleSeries) {
      state._bandsAnimFrame = requestAnimationFrame(drawFrame);
      return;
    }
    const ts = state.priceChart.timeScale();

    // Find the chart pane offset (LWC content area)
    const chartDiv = document.getElementById("price-chart");
    const allCanvases = chartDiv.querySelectorAll("canvas");
    let lwcCanvas = null, maxArea = 0;
    for (const c of allCanvases) {
      if (c.id === "account-bands-canvas" || c.id === "trade-overlay-canvas") continue;
      const area = c.clientWidth * c.clientHeight;
      if (area > maxArea) { maxArea = area; lwcCanvas = c; }
    }
    let offsetX = 0, offsetY = 0, paneW = w, paneH = h;
    if (lwcCanvas) {
      const chartRect = chartDiv.getBoundingClientRect();
      const paneRect = lwcCanvas.getBoundingClientRect();
      offsetX = paneRect.left - chartRect.left;
      offsetY = paneRect.top - chartRect.top;
      paneW = paneRect.width;
      paneH = paneRect.height;
    }

    // Clip to chart pane bounds
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, paneW, paneH);
    ctx.clip();

    // Draw each band as a thick translucent diagonal line connecting
    // the deploy point to the close point. Account number label sits
    // at the line's midpoint for identification.
    const BAND_THICKNESS = 3; // CSS px
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const band of bands) {
      const x1 = ts.timeToCoordinate(band.fromT);
      const x2 = ts.timeToCoordinate(band.toT);
      const y1 = state.candleSeries.priceToCoordinate(band.fromPrice);
      const y2 = state.candleSeries.priceToCoordinate(band.toPrice);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const px1 = x1 + offsetX, py1 = y1 + offsetY;
      const px2 = x2 + offsetX, py2 = y2 + offsetY;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = BAND_THICKNESS;
      ctx.beginPath();
      ctx.moveTo(px1, py1);
      ctx.lineTo(px2, py2);
      ctx.stroke();

      // Account number label at the midpoint
      const midX = (px1 + px2) / 2;
      const midY = (py1 + py2) / 2;
      const label = "#" + band.num;
      ctx.font = "bold 11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Subtle dark shadow for legibility against any candle background
      ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      ctx.fillText(label, midX + 1, midY + 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fillText(label, midX, midY);
    }

    ctx.restore();
    state._bandsAnimFrame = requestAnimationFrame(drawFrame);
  }

  drawFrame();
}

function populateBankChart(b) {
  const firstCandle = b.candles_m15?.[0]?.t;
  const econ = state._investorEcon;
  if (!econ) return;

  // Build investor net P&L timeline: cumulative_distributed − cumulative_called
  // Step function — jumps down on capital calls (more $ owed to investor),
  // jumps up on distributions (investor gets paid back).
  const netPnlPoints = [];
  let cumulCalled = 0;
  let cumulDistributed = 0;

  const startT = firstCandle || toUnix(econ.accounts[0]?.deploy_time);
  if (startT) {
    netPnlPoints.push({ time: startT, value: 0 });
  }

  for (const a of econ.accounts) {
    const deployT = toUnix(a.deploy_time);
    // For blowups: blowup_time. For survivors: accountEndTime (last trace
    // event / eval_end) so the distribution lands at end of test, not at
    // deploy time.
    const closeT = accountEndTime(a);

    // At deploy: capital call (if any) deepens the underwater position
    if (deployT && a.capitalCall > 0) {
      cumulCalled += a.capitalCall;
      netPnlPoints.push({
        time: deployT,
        value: Math.round((cumulDistributed - cumulCalled) * 100) / 100,
      });
    }
    // At close: distribution (if any) brings investor back toward break-even
    if (closeT && a.distribution > 0) {
      cumulDistributed += a.distribution;
      netPnlPoints.push({
        time: closeT,
        value: Math.round((cumulDistributed - cumulCalled) * 100) / 100,
      });
    }
  }

  // Extend flat line to end of eval
  const candles = b.candles_m15 || [];
  const rangeEnd = candles.length ? candles[candles.length - 1].t : null;
  if (rangeEnd && netPnlPoints.length > 0) {
    const last = netPnlPoints[netPnlPoints.length - 1];
    if (rangeEnd > last.time) {
      netPnlPoints.push({ time: rangeEnd, value: last.value });
    }
  }

  // Dedupe same-time points (keep last — the resulting state)
  const seen = new Map();
  for (const p of netPnlPoints) seen.set(p.time, p.value);
  const sparsePnl = [...seen.entries()].sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));

  // Densify: forward-fill the step function at every M15 candle so the bank
  // chart can be panned/zoomed precisely (LWC's setVisibleRange snaps to
  // existing data points; with only ~10 sparse points, sync was drifting).
  const cleanPnl = [];
  let cursor = 0;
  let currentVal = sparsePnl[0]?.value ?? 0;
  for (const c of candles) {
    while (cursor < sparsePnl.length && sparsePnl[cursor].time <= c.t) {
      currentVal = sparsePnl[cursor].value;
      cursor++;
    }
    cleanPnl.push({ time: c.t, value: currentVal });
  }
  // Make sure final point is the true last value
  if (cleanPnl.length && sparsePnl.length) {
    const lastVal = sparsePnl[sparsePnl.length - 1].value;
    cleanPnl[cleanPnl.length - 1] = { time: cleanPnl[cleanPnl.length - 1].time, value: lastVal };
  }

  state.bankSeries.setData(cleanPnl);

  // Break-even reference at $0
  const rangeStart = candles.length ? candles[0].t : (cleanPnl[0]?.time);
  if (rangeStart != null && rangeEnd != null && rangeStart < rangeEnd) {
    state.capitalLine.setData([
      { time: rangeStart, value: 0 },
      { time: rangeEnd,   value: 0 },
    ]);
  }

  // Peak-loss reference: horizontal line at the deepest underwater point
  const minPnl = Math.min(...cleanPnl.map(p => p.value));
  if (state.hwmSeries && minPnl < 0 && rangeStart != null && rangeEnd != null) {
    state.hwmSeries.setData([
      { time: rangeStart, value: minPnl },
      { time: rangeEnd,   value: minPnl },
    ]);
  }

  // Event markers: capital calls (red ▼) and distributions (green ▲)
  const bankMarkers = [];
  for (const a of econ.accounts) {
    const deployT = toUnix(a.deploy_time);
    // For survivors, close time falls back to accountEndTime so the
    // distribution marker lands at end of test, not at deploy time.
    const distT = accountEndTime(a);

    if (deployT && a.capitalCall > 0) {
      bankMarkers.push({
        time: deployT, position: "aboveBar", color: COLORS.red,
        shape: "arrowDown", text: `call $${Math.round(a.capitalCall)}`,
        _kind: "deploy",
      });
    }
    if (a.distribution > 0 && distT) {
      bankMarkers.push({
        time: distT, position: "belowBar", color: COLORS.green,
        shape: "arrowUp", text: `dist $${Math.round(a.distribution)}`,
        _kind: "blowup",
      });
    }
  }
  bankMarkers.sort((x, y) => x.time - y.time);
  state.fullBankMarkers = bankMarkers;
  state.bankSeries.setMarkers(cullBankMarkers(bankMarkers, 80).map(stripInternal));

  // Sync bank chart's time range to the price chart's current range so
  // they start aligned.
  const priceRange = state.priceChart && state.priceChart.timeScale().getVisibleRange();
  if (priceRange) {
    state._syncing = true;
    try {
      state.bankChart.timeScale().setVisibleRange({ from: priceRange.from, to: priceRange.to });
    } catch (e) { /* ignore */ }
    state._syncing = false;
  }
}

// ----- trace overlay -----
// When the user drills into an account that has trace data, we overlay
// grid entry markers on the price chart and an equity curve on the bank chart.
// These are stored in state.traceOverlay and cleaned up on close/navigate.

// ---- Trade-marker hover tooltip ----
//
// The trade ticks are painted onto a custom canvas overlay (not LightweightCharts
// markers), so they can't carry native hover handlers. Instead we listen for
// mousemove on the chart container, project each tick's (time, price) to screen
// coordinates using the LWC API, and find the nearest tick to the cursor.
// If within HOVER_RADIUS_PX, we show a small absolute-positioned div with the
// trade's metadata: side, lot size, depth, tier (entries) or pnl (closes).

const TRACE_HOVER_RADIUS_PX = 6;

function installTraceHoverTooltip(chartEl) {
  // Clean up any previous instance
  removeTraceHoverTooltip();

  const tip = document.createElement("div");
  tip.id = "trade-hover-tooltip";
  tip.style.cssText = (
    "position:absolute;display:none;pointer-events:none;z-index:200;" +
    "background:rgba(13,17,23,0.95);border:1px solid #30363d;border-radius:4px;" +
    "color:#e6edf3;font:11px/1.4 'IBM Plex Mono',monospace;" +
    "padding:6px 8px;white-space:nowrap;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.4);"
  );
  chartEl.appendChild(tip);

  const onMove = (ev) => {
    const ticks = state._traceTicks;
    if (!ticks || !ticks.length || !state.priceChart) {
      tip.style.display = "none";
      return;
    }
    const rect = chartEl.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    // Pane offset (matches drawFrame()): the LWC pane is inset from the
    // chart container by the price-scale + time-scale gutters.
    const allCanvases = chartEl.querySelectorAll("canvas");
    let lwcCanvas = null, maxArea = 0;
    for (const c of allCanvases) {
      if (c.id === "trade-overlay-canvas") continue;
      if (c.id === "account-bands-canvas") continue;
      const area = c.clientWidth * c.clientHeight;
      if (area > maxArea) { maxArea = area; lwcCanvas = c; }
    }
    let offsetX = 0, offsetY = 0;
    if (lwcCanvas) {
      const paneRect = lwcCanvas.getBoundingClientRect();
      offsetX = paneRect.left - rect.left;
      offsetY = paneRect.top - rect.top;
    }

    const ts = state.priceChart.timeScale();
    let nearest = null;
    let nearestDist = TRACE_HOVER_RADIUS_PX;
    for (const tk of ticks) {
      const tx = ts.timeToCoordinate(tk.t);
      if (tx === null) continue;
      const ty = state.candleSeries.priceToCoordinate(tk.v);
      if (ty === null) continue;
      const sx = tx + offsetX;
      const sy = ty + offsetY;
      const d = Math.max(Math.abs(sx - mx), Math.abs(sy - my));
      if (d <= nearestDist) { nearestDist = d; nearest = tk; }
    }

    if (!nearest || !nearest.meta) {
      tip.style.display = "none";
      return;
    }
    tip.innerHTML = formatTradeTooltip(nearest);
    tip.style.display = "block";
    // Position above and slightly right of the cursor; flip if near edges
    const tipW = tip.offsetWidth || 160;
    const tipH = tip.offsetHeight || 60;
    let left = mx + 12;
    let top  = my - tipH - 8;
    if (left + tipW > rect.width)  left = mx - tipW - 12;
    if (top < 0)                    top  = my + 14;
    tip.style.left = left + "px";
    tip.style.top  = top  + "px";
  };

  const onLeave = () => { tip.style.display = "none"; };

  chartEl.addEventListener("mousemove", onMove);
  chartEl.addEventListener("mouseleave", onLeave);

  state._traceHoverTooltip = tip;
  state._traceHoverHandlers = { chartEl, onMove, onLeave };
}

function removeTraceHoverTooltip() {
  const h = state._traceHoverHandlers;
  if (h && h.chartEl) {
    h.chartEl.removeEventListener("mousemove", h.onMove);
    h.chartEl.removeEventListener("mouseleave", h.onLeave);
  }
  state._traceHoverHandlers = null;
  const existing = document.getElementById("trade-hover-tooltip");
  if (existing) existing.remove();
  state._traceHoverTooltip = null;
}

function formatTradeTooltip(tick) {
  const m = tick.meta || {};
  const TIER_LABELS = ["base", "flex 1", "flex 2", "flex 3"];
  const fmtPrice = (p) => (typeof p === "number") ? p.toFixed(5) : "—";
  const fmtLots  = (l) => (typeof l === "number") ? l.toFixed(2)   : "—";
  if (m.kind === "entry") {
    const tierLabel = TIER_LABELS[m.tier] || "?";
    const sideColor = (m.side === "BUY") ? COLORS.green : COLORS.red;
    const idLine = m.id
      ? `<div style="color:${COLORS.cyan};font-family:var(--font-mono),monospace;font-size:10px;margin-bottom:2px">${m.id}</div>`
      : "";
    return (
      idLine +
      `<div style="color:${sideColor};font-weight:600">` +
        `${m.side} entry · ${fmtLots(m.lots)} lots</div>` +
      `<div style="color:${COLORS.textMuted};margin-top:2px">` +
        `price ${fmtPrice(m.price)} · depth ${m.depth} · tier ${tierLabel}</div>`
    );
  }
  if (m.kind === "close") {
    const pnlColor = (m.pnl >= 0) ? COLORS.green : COLORS.red;
    const pnlSign  = (m.pnl >= 0) ? "+" : "";
    return (
      `<div style="color:${COLORS.text};font-weight:600">` +
        `${m.side} basket close · ${m.reason || "—"}</div>` +
      `<div style="color:${COLORS.textMuted};margin-top:2px">` +
        `price ${fmtPrice(m.price)} · ${m.positions} positions · ` +
        `<span style="color:${pnlColor}">${pnlSign}$${(m.pnl || 0).toFixed(2)}</span></div>`
    );
  }
  return `<div style="color:${COLORS.textMuted}">${JSON.stringify(m)}</div>`;
}

function clearTraceOverlay() {
  if (state.traceEquitySeries) {
    state.bankChart.removeSeries(state.traceEquitySeries);
    state.traceEquitySeries = null;
  }
  if (state.traceWithdrawnSeries) {
    state.bankChart.removeSeries(state.traceWithdrawnSeries);
    state.traceWithdrawnSeries = null;
  }
  const wdBtn = document.getElementById("toggle-withdrawn-line-btn");
  if (wdBtn) {
    wdBtn.style.display = "none";
    wdBtn.onclick = null;
    wdBtn.textContent = "Show cumulative withdrawn";
  }
  // Restore Investor P&L lines that were hidden in detail mode
  if (state.bankSeries) state.bankSeries.applyOptions({ visible: true });
  if (state.capitalLine) state.capitalLine.applyOptions({ visible: true });
  if (state.hwmSeries) state.hwmSeries.applyOptions({ visible: true });
  for (const s of (state.tracePositionLines || [])) {
    try { state.priceChart.removeSeries(s); } catch (e) {}
  }
  state.tracePositionLines = [];
  // Clean up canvas overlay
  if (state._traceAnimFrame) {
    cancelAnimationFrame(state._traceAnimFrame);
    state._traceAnimFrame = null;
  }
  const cvs = document.getElementById("trade-overlay-canvas");
  if (cvs) cvs.remove();
  state._traceCanvas = null;
  state._traceTicks = null;
  removeTraceHoverTooltip();
  state.traceActive = false;
  state.traceEntryMarkers = null;
  state._tracedAccountNum = null;
  applyMarkersForVisibleRange();
}

function showTraceOverlay(a) {
  clearTraceOverlay();
  const trace = a.trace;
  if (!trace) return;
  state.traceActive = true;
  state._tracedAccountNum = a.num;

  // Tier thresholds for shading entry markers by FlexGrid tier
  // (depth_at_entry on each event). Legacy bundles return all-null
  // thresholds → all entries render in the base shade.
  const tierThresholds = getTierThresholds(state.currentBundle);

  const entries = trace.grid_entry_events || [];
  const blowupT = toUnix(a.blowup_time);
  state.tracePositionLines = [];

  // Build candle time lookup: timeToCoordinate only works for times
  // that exist in the candle data. Use M1 times if M1 is active.
  const b = state.currentBundle;
  const candleTimes = state._m1CandleTimes
    || ((b && b.candles_m15) ? b.candles_m15.map(c => c.t) : []);

  function nearestCandleTime(unix) {
    if (!candleTimes.length) return unix;
    // Binary search for closest candle time
    let lo = 0, hi = candleTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candleTimes[mid] < unix) lo = mid + 1;
      else hi = mid;
    }
    // Check lo and lo-1 for closest
    if (lo > 0 && Math.abs(candleTimes[lo - 1] - unix) < Math.abs(candleTimes[lo] - unix)) {
      return candleTimes[lo - 1];
    }
    return candleTimes[lo];
  }

  // Collect entry ticks and TP close ticks, mapped to nearest candle time.
  // Also build basket cycles: group entries by side between consecutive closes,
  // so we can draw dashed lines from entries to their TP close.
  const allTicks = [];
  const basketLines = []; // {fromT, fromV, toT, toV, color} for dashed lines

  // Group entries by side, tracking current basket cycle
  const pendingBuy = [];  // entries in current buy basket cycle
  const pendingSell = []; // entries in current sell basket cycle

  // Merge entries and closes chronologically
  const allEvents = [];
  for (const e of entries) {
    allEvents.push({ type: "entry", time: e.time_unix, data: e });
  }
  for (const ev of (a.basket_close_events || [])) {
    const t = toUnix(ev.time);
    if (t) allEvents.push({ type: "close", time: t, data: ev });
  }
  allEvents.sort((a, b) => a.time - b.time);

  for (const ev of allEvents) {
    if (ev.type === "entry") {
      const e = ev.data;
      const isBuy = (e.dir || "").toLowerCase() === "buy";
      // Tier-shaded entry: lighter for base tier, darker for deeper flex
      // tiers. Falls back to base shade when depth_at_entry is missing
      // (legacy bundles) or thresholds are unset.
      const color = tierColorFor(isBuy ? "buy" : "sell", e.depth_at_entry, tierThresholds);
      const tier = tierIndexForDepth(e.depth_at_entry, tierThresholds);
      const tick = {
        t: nearestCandleTime(e.time_unix),
        v: e.price,
        color,
        meta: {
          kind: "entry",
          id: e.id || "",
          side: isBuy ? "BUY" : "SELL",
          lots: e.lots,
          price: e.price,
          depth: e.depth_at_entry,
          tier,
          time_unix: e.time_unix,
        },
      };
      allTicks.push(tick);
      (isBuy ? pendingBuy : pendingSell).push(tick);
    } else {
      const c = ev.data;
      const cp = c.close_price || 0;
      const side = (c.closed_basket || "").toLowerCase();
      const closeT = nearestCandleTime(ev.time);
      if (cp > 0) {
        const closeColor = side === "buy" ? COLORS.blue : COLORS.purple;
        allTicks.push({
          t: closeT,
          v: cp,
          color: closeColor,
          meta: {
            kind: "close",
            side: side.toUpperCase(),
            price: cp,
            pnl: c.pnl,
            positions: c.positions,
            reason: c.reason,
            time_unix: ev.time,
          },
        });
        // Draw dashed lines from each pending entry to this close
        const pending = side === "buy" ? pendingBuy : pendingSell;
        const lineColor = side === "buy" ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)";
        for (const entry of pending) {
          basketLines.push({ fromT: entry.t, fromV: entry.v, toT: closeT, toV: cp, color: lineColor });
        }
        // Clear the pending basket for this side
        if (side === "buy") pendingBuy.length = 0;
        else pendingSell.length = 0;
      }
    }
  }

  // Entries still pending after all closes = the basket(s) that caused the blowup.
  // Draw dashed lines from these entries to the blowup time in orange.
  if (a.blowup && blowupT) {
    const blowupCandleT = nearestCandleTime(blowupT);
    for (const entry of pendingBuy) {
      basketLines.push({ fromT: entry.t, fromV: entry.v, toT: blowupCandleT, toV: entry.v, color: "rgba(219,109,40,0.5)" });
    }
    for (const entry of pendingSell) {
      basketLines.push({ fromT: entry.t, fromV: entry.v, toT: blowupCandleT, toV: entry.v, color: "rgba(219,109,40,0.5)" });
    }
  }

  allTicks.sort((a, b) => a.t - b.t);

  // Canvas overlay drawn via requestAnimationFrame.
  // Renders all ticks as 8x2px rectangles at exact prices using
  // LightweightCharts coordinate API. Canvas redraws every frame
  // so it tracks zoom/scroll perfectly with zero lag.
  const chartEl = document.getElementById("price-chart");

  let canvas = document.getElementById("trade-overlay-canvas");
  if (canvas) canvas.remove();
  canvas = document.createElement("canvas");
  canvas.id = "trade-overlay-canvas";
  canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;";
  chartEl.style.position = "relative";
  chartEl.appendChild(canvas);

  state._traceCanvas = canvas;
  state._traceAnimFrame = null;
  state._traceTicks = allTicks;
  installTraceHoverTooltip(chartEl);

  function drawFrame() {
    if (!state._traceCanvas) return;
    const cvs = state._traceCanvas;
    const parent = cvs.parentElement;
    if (!parent) return;

    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    // Only resize canvas when dimensions change (avoids flicker)
    if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
    }

    const ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ts = state.priceChart.timeScale();

    // Find pane offset: LWC coordinates are relative to the chart pane.
    // Our canvas covers the full #price-chart div (including price scales).
    const chartDiv = document.getElementById("price-chart");
    const allCanvases = chartDiv.querySelectorAll("canvas");
    let lwcCanvas = null, maxArea = 0;
    for (const c of allCanvases) {
      if (c.id === "trade-overlay-canvas") continue;
      if (c.id === "account-bands-canvas") continue;
      const area = c.clientWidth * c.clientHeight;
      if (area > maxArea) { maxArea = area; lwcCanvas = c; }
    }
    let offsetX = 0, offsetY = 0;
    let paneW = w, paneH = h;
    if (lwcCanvas) {
      const chartRect = chartDiv.getBoundingClientRect();
      const paneRect = lwcCanvas.getBoundingClientRect();
      offsetX = paneRect.left - chartRect.left;
      offsetY = paneRect.top - chartRect.top;
      paneW = paneRect.width;
      paneH = paneRect.height;
    }

    // Clip to chart pane so ticks/lines don't bleed into price scale.
    // (The earlier alignment issue was a timezone bug, not clip-related.)
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, paneW, paneH);
    ctx.clip();

    // Draw dashed lines from entries to their TP close
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const ln of basketLines) {
      const x1 = ts.timeToCoordinate(ln.fromT);
      const y1 = state.candleSeries.priceToCoordinate(ln.fromV);
      const x2 = ts.timeToCoordinate(ln.toT);
      const y2 = state.candleSeries.priceToCoordinate(ln.toV);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
      ctx.strokeStyle = ln.color;
      ctx.beginPath();
      ctx.moveTo(x1 + offsetX, y1 + offsetY);
      ctx.lineTo(x2 + offsetX, y2 + offsetY);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Draw entry and close ticks
    for (const tk of allTicks) {
      const x = ts.timeToCoordinate(tk.t);
      if (x === null) continue;
      const y = state.candleSeries.priceToCoordinate(tk.v);
      if (y === null) continue;
      ctx.fillStyle = tk.color;
      ctx.fillRect(x + offsetX - 4, y + offsetY - 1, 8, 2);
    }

    ctx.restore();

    state._traceAnimFrame = requestAnimationFrame(drawFrame);
  }

  drawFrame();

  // Markers: blowup + total withdrawn (default) or individual withdrawals (toggled)
  const wdEvents = trace.withdrawal_events || [];
  const totalWd = wdEvents.reduce((s, ev) => s + (ev.amount || 0), 0);
  state._traceWdEvents = wdEvents;
  state._traceAccount = a;
  state._traceShowAllWd = false;

  function buildTraceMarkers() {
    const markers = [];
    if (state._traceShowAllWd) {
      for (const ev of wdEvents) {
        const t15 = Math.floor(ev.time_unix / 900) * 900;
        markers.push({ time: t15, position: "aboveBar", color: COLORS.gold,
          shape: "arrowDown", text: `$${Math.round(ev.amount)}`, size: 0 });
      }
    } else if (totalWd > 0) {
      // Show total withdrawn near the end of the account's life
      const endT = blowupT || (toUnix(a.deploy_time) + 86400);
      const nearEnd = Math.floor((endT - 3600) / 900) * 900; // 1 hour before close
      markers.push({ time: nearEnd, position: "aboveBar", color: COLORS.gold,
        shape: "arrowDown", text: `wd $${Math.round(totalWd)}`, size: 0 });
    }
    if (a.blowup && blowupT) {
      const t15 = Math.floor(blowupT / 900) * 900;
      markers.push({ time: t15, position: "aboveBar", color: COLORS.red,
        shape: "square", text: "BLOWUP", size: 1 });
    }
    markers.sort((a, b) => a.time - b.time);
    return markers;
  }

  state.traceEntryMarkers = buildTraceMarkers();
  state._buildTraceMarkers = buildTraceMarkers;
  applyMarkersForVisibleRange();

  // Equity curve on the bank chart — hide Investor P&L lines so the
  // smaller-scale account equity gets full focus.
  const eqSnaps = trace.equity_snapshots || [];
  if (eqSnaps.length > 0) {
    if (state.bankSeries) state.bankSeries.applyOptions({ visible: false });
    if (state.capitalLine) state.capitalLine.applyOptions({ visible: false });
    if (state.hwmSeries) state.hwmSeries.applyOptions({ visible: false });

    state.traceEquitySeries = state.bankChart.addLineSeries({
      color: "#f0883e", lineWidth: 2, lineType: 0, title: `Equity #${a.num}`,
    });

    // Snap equity snapshot timestamps to the nearest M15 candle time so
    // the equity series uses the same logical schedule as the bank chart's
    // densified investor P&L series. Without snapping, ~5k off-grid event
    // timestamps extend the chart's logical index space and desync from
    // the price chart.
    const candleTimes = (state.currentBundle.candles_m15 || []).map(c => c.t);
    function snapToCandle(t) {
      if (!candleTimes.length) return t;
      let lo = 0, hi = candleTimes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candleTimes[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(candleTimes[lo - 1] - t) < Math.abs(candleTimes[lo] - t)) {
        return candleTimes[lo - 1];
      }
      return candleTimes[lo];
    }

    const dedup = (arr, key) => {
      const out = [];
      let lastT = null;
      for (const p of arr) {
        const rawT = p.time_unix;
        const v = p[key];
        if (rawT == null || v == null) continue;
        const t = snapToCandle(rawT);
        if (t === lastT) out[out.length - 1] = { time: t, value: v };
        else out.push({ time: t, value: v });
        lastT = t;
      }
      return out;
    };
    state.traceEquitySeries.setData(dedup(eqSnaps, "eq"));

    // Cumulative withdrawn line (light blue) — off by default, toggled
    // via the "Show cumulative withdrawn" button in the detail panel.
    // Monotonic step function showing total extracted at each moment.
    const wdEventsArr = trace.withdrawal_events || [];
    if (wdEventsArr.length > 0) {
      state.traceWithdrawnSeries = state.bankChart.addLineSeries({
        color: "#58a6ff",
        lineWidth: 2,
        lineStyle: 0,
        title: `Withdrawn #${a.num}`,
        visible: false,
        lineType: 1, // step-style, matches step-function nature
      });
      const sortedWd = [...wdEventsArr].sort((x, y) => (x.time_unix || 0) - (y.time_unix || 0));
      const cumPoints = [];
      let cum = 0;
      let lastT = null;
      for (const ev of sortedWd) {
        const rawT = ev.time_unix;
        const amt = ev.amount;
        if (rawT == null || amt == null) continue;
        cum += amt;
        const t = snapToCandle(rawT);
        if (t === lastT) cumPoints[cumPoints.length - 1] = { time: t, value: cum };
        else cumPoints.push({ time: t, value: cum });
        lastT = t;
      }
      state.traceWithdrawnSeries.setData(cumPoints);

      // Reveal the toggle button in the bank chart header and wire up its
      // click handler. Button stays off by default.
      const btn = document.getElementById("toggle-withdrawn-line-btn");
      if (btn) {
        btn.style.display = "";
        btn.textContent = "Show cumulative withdrawn";
        btn.onclick = () => {
          if (!state.traceWithdrawnSeries) return;
          const nextVisible = !state.traceWithdrawnSeries.options().visible;
          state.traceWithdrawnSeries.applyOptions({ visible: nextVisible });
          btn.textContent = nextVisible
            ? "Hide cumulative withdrawn"
            : "Show cumulative withdrawn";
        };
      }
    }

    // Re-sync bank chart's time range to the price chart's visible range
    // right after adding the equity series.
    const priceRange = state.priceChart.timeScale().getVisibleRange();
    if (priceRange) {
      state._syncing = true;
      try { state.bankChart.timeScale().setVisibleRange({ from: priceRange.from, to: priceRange.to }); }
      catch (e) { /* ignore */ }
      state._syncing = false;
    }
  }
}

// ----- basket metrics helper -----
function computeBasketMetrics(a) {
  const entries = (a.trace && a.trace.grid_entry_events) || [];
  const closes = (a.basket_close_events) || [];
  if (!entries.length && !closes.length) return null;

  // Merge all events chronologically
  const allEvents = [];
  for (const e of entries) {
    allEvents.push({ type: "entry", time: e.time_unix || toUnix(e.time), data: e });
  }
  for (const c of closes) {
    allEvents.push({ type: "close", time: toUnix(c.time), data: c });
  }
  allEvents.sort((a, b) => (a.time || 0) - (b.time || 0));

  let tpCount = 0;
  let buyTPs = 0;
  let sellTPs = 0;
  const depths = [];    // entries per basket cycle
  const timesToTP = []; // hours from earliest entry to close
  const maxDDs = [];    // max displacement per cycle in pips

  // Track pending baskets per side
  let pendingBuy = [];  // entry prices + times
  let pendingSell = [];

  for (const ev of allEvents) {
    if (ev.type === "entry") {
      const e = ev.data;
      const isBuy = (e.dir || "").toLowerCase() === "buy";
      const entry = { price: e.price, time: ev.time };
      (isBuy ? pendingBuy : pendingSell).push(entry);
    } else {
      const c = ev.data;
      const side = (c.closed_basket || "").toLowerCase();
      // v2 bundle uses `reason: "tp"` (lowercase); older builds used
      // `close_type: "TP"`. Accept either for compatibility.
      const closeType = (c.reason || c.close_type || "").toLowerCase();
      if (closeType === "tp") {
        tpCount++;
        if (side === "buy") buyTPs++;
        else sellTPs++;
      }
      const pending = side === "buy" ? pendingBuy : pendingSell;
      if (pending.length > 0) {
        depths.push(pending.length);
        // Time to close from earliest entry
        const earliest = Math.min(...pending.map(p => p.time).filter(t => t));
        if (earliest && ev.time) {
          timesToTP.push((ev.time - earliest) / 3600); // hours
        }
        // Max DD: max |entry_price - close_price| in pips
        const cp = c.close_price || 0;
        if (cp > 0) {
          const maxDisp = Math.max(...pending.map(p => Math.abs(p.price - cp)));
          maxDDs.push(maxDisp * 10000); // convert to pips (4-digit pairs like EURGBP)
        }
        // Clear basket for this side
        if (side === "buy") pendingBuy = [];
        else pendingSell = [];
      }
    }
  }

  // Median helper
  const median = arr => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  return {
    tpCount,
    avgDepth: depths.length ? depths.reduce((s, v) => s + v, 0) / depths.length : 0,
    medianDepth: median(depths),
    maxDepth: depths.length ? Math.max(...depths) : 0,
    avgTimeToTP: timesToTP.length ? timesToTP.reduce((s, v) => s + v, 0) / timesToTP.length : 0,
    medianTimeToTP: median(timesToTP),
    maxBasketDD: maxDDs.length ? Math.max(...maxDDs) : 0,
    avgBasketDD: maxDDs.length ? maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length : 0,
    buyTPs,
    sellTPs,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Basket panel (Phase 2) — reconstructs basket cycles from trade IDs and
// renders a clickable per-basket table left of the trade compliance panel.
// Click a basket row → chart zooms to its lifetime ± 30 min padding,
// metrics card below the table updates.
//
// Trade ID format from bundle.py: A{acct}.{B|S}{basket_num}.T{trade_num}
// Example: A8.S3.T1 = account 8, sell basket #3, trade #1.
// We parse basket_num + side from the ID, group entries, and match each
// basket to its close event by side + chronological order.
// ─────────────────────────────────────────────────────────────────────────

// In-memory state for the currently-displayed basket panel
const _basketState = {
  account: null,    // the account object whose baskets are shown
  baskets: [],      // reconstructed list, sorted by first-entry time
  selectedKey: null, // "B3" or "S5" — currently selected basket
};

// One-shot pass at bundle load time: rewrite every entry's trade `id` into
// the unified `A{acct}.B{N}.T{N}` format where N is the chronological
// per-account sequence number (side-agnostic). Two reasons:
//   1. Legacy bundles use per-side IDs (B1 + S1 collide on basket_num=1).
//   2. We want a single global numbering so the compliance table, chart
//      hover, and basket panel all show the same number for the same basket.
// After this runs, _parseBasketKey reads side from entry.dir/side rather
// than the ID letter (since the new IDs always start with "B").
function renumberTradeIDs(bundle) {
  for (const acct of bundle.accounts || []) {
    const entries = acct?.trace?.grid_entry_events || [];
    if (!entries.length) continue;
    // Group entries by their existing basket key (handles both legacy and
    // current ID formats).
    const groups = {};
    for (const e of entries) {
      const k = _parseBasketKey(e.id, e.dir || e.side);
      if (!k) continue;
      const key = `${k.side}_${k.basket_num}`;
      if (!groups[key]) groups[key] = { side: k.side, entries: [] };
      groups[key].entries.push(e);
    }
    // Sort each basket's entries by time so trade_num is in fill order.
    for (const g of Object.values(groups)) {
      g.entries.sort((x, y) => (x.time_unix || 0) - (y.time_unix || 0));
      g.firstTime = g.entries[0]?.time_unix || 0;
    }
    // Sort baskets chronologically by first-entry time, then by side as
    // tiebreaker (deterministic when buy + sell open on the same bar).
    const sorted = Object.values(groups).sort((a, b) =>
      a.firstTime - b.firstTime || (a.side === "buy" ? -1 : 1)
    );
    // Rewrite e.id with new basket_num + trade_num.
    sorted.forEach((g, basketIdx) => {
      const newBasketNum = basketIdx + 1;
      g.entries.forEach((e, tradeIdx) => {
        e.id = `A${acct.num}.B${newBasketNum}.T${tradeIdx + 1}`;
      });
    });
  }
}

function _parseBasketKey(tradeId, entrySide) {
  // Returns {side: 'buy'|'sell', basket_num: int} or null.
  // Two ID formats supported:
  //   Current  A{acct}.B{basket_num}.T{trade_num}  (side from entry.side)
  //   Legacy   A{acct}.{B|S}{basket_num}.T{trade_num}  (side from letter)
  // Distinguishing rule: in the legacy format basket_num was per-side, in
  // the current format it's unified per-account. Either way, the parser
  // returns the side from whichever signal is present.
  let m = /^A\d+\.B(\d+)\.T\d+$/.exec(tradeId || "");
  if (m) {
    // Current format — needs side from the entry record.
    const side = (entrySide || "").toLowerCase();
    if (side !== "buy" && side !== "sell") return null;
    return { side, basket_num: Number(m[1]) };
  }
  m = /^A\d+\.S(\d+)\.T\d+$/.exec(tradeId || "");
  if (m) {
    // Legacy: explicit "S" letter encodes sell-side.
    return { side: "sell", basket_num: Number(m[1]) };
  }
  return null;
}

function buildBasketsForAccount(acct) {
  const out = {};
  const entries = acct?.trace?.grid_entry_events || [];
  for (const e of entries) {
    const k = _parseBasketKey(e.id, e.dir || e.side);
    if (!k) continue;
    // Key includes side so legacy bundles (per-side basket numbering — could
    // collide on basket_num across BUY and SELL) stay distinct. Current-format
    // bundles never collide because basket_num is unified per account.
    const key = `${k.side}_${k.basket_num}`;
    if (!out[key]) {
      out[key] = {
        key,
        side: k.side,
        basket_num: k.basket_num,
        entries: [],
        close_event: null,
      };
    }
    out[key].entries.push(e);
  }
  // Match close events by side + chronological order. basket_close_events
  // are in time order; we shift the earliest unclaimed close into the
  // earliest basket of that side that doesn't yet have one.
  const list = Object.values(out).sort((a, b) =>
    (a.basket_num - b.basket_num)
  );
  const closesBySide = { buy: [], sell: [] };
  for (const c of (acct.basket_close_events || [])) {
    const s = (c.closed_basket || "").toLowerCase();
    if (closesBySide[s]) closesBySide[s].push(c);
  }
  for (const b of list) {
    const arr = closesBySide[b.side];
    if (arr && arr.length) b.close_event = arr.shift();
  }
  // Sort baskets by first-entry time so the table reads chronologically
  list.sort((a, b) => {
    const ta = a.entries[0]?.time_unix || 0;
    const tb = b.entries[0]?.time_unix || 0;
    return ta - tb;
  });
  // Assign display numbers strictly by chronological order, ignoring side.
  // For new bundles (unified per-account basket_num) this matches what the
  // ID parsing produced. For legacy bundles (per-side basket_num) this
  // RENUMBERS them so the table never shows duplicate numbers across sides.
  // We sort entries within each basket by time so trade_num display would
  // be consistent if surfaced — currently we show only basket_num.
  list.forEach((b, i) => {
    b.basket_num = i + 1;
    b.entries.sort((x, y) => (x.time_unix || 0) - (y.time_unix || 0));
  });
  return list;
}

function basketMetrics(basket) {
  if (!basket || !basket.entries.length) return null;
  const close = basket.close_event;
  const start = basket.entries[0].time_unix;
  const end   = close?.time || basket.entries[basket.entries.length - 1].time_unix;
  const lifetimeSec = Math.max(0, end - start);
  const maxDepth = Math.max(...basket.entries.map(e => e.depth_at_entry || 0)) + 1;
  const totalLots = basket.entries.reduce((s, e) => s + (e.lots || 0), 0);
  const avgLot = basket.entries.length ? totalLots / basket.entries.length : 0;
  // Sum of broker-exact pnl_net per entry (Σ for closed entries, null for
  // still-open). For a closed basket, Σ pnl_net should equal the basket's
  // close pnl minus its commission.
  let netPnl = 0;
  let allClosed = true;
  for (const e of basket.entries) {
    if (e.pnl_net == null) allClosed = false;
    else netPnl += e.pnl_net;
  }
  return {
    side: basket.side,
    basket_num: basket.basket_num,
    n_entries: basket.entries.length,
    max_depth: maxDepth,
    avg_lot: avgLot,
    total_lots: totalLots,
    close_reason: close?.reason || "(open)",
    net_pnl: allClosed ? netPnl : null,
    lifetime_sec: lifetimeSec,
    start_unix: start,
    end_unix: end,
  };
}

function _fmtBasketDuration(seconds) {
  if (seconds <= 0) return "—";
  const m = seconds / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function _fmtBasketTime(unix) {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  // Compact: MM-DD HH:MM (UTC)
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function renderBasketPanel(acct) {
  const body = document.getElementById("basket-panel-body");
  const titleEl = document.getElementById("basket-panel-title");
  if (!body) return;
  if (!acct) {
    if (titleEl) titleEl.textContent = "Basket Inspector";
    body.innerHTML = `<div class="placeholder">Select an account to see its baskets.</div>`;
    _basketState.account = null;
    _basketState.baskets = [];
    _basketState.selectedKey = null;
    hideBasketBreakEvenLine();
    return;
  }
  if (titleEl) titleEl.textContent = `Account #${acct.num} — Baskets`;
  const baskets = buildBasketsForAccount(acct);
  _basketState.account = acct;
  _basketState.baskets = baskets;
  _basketState.selectedKey = null;
  if (!baskets.length) {
    body.innerHTML = `<div class="placeholder">No basket data for this account.</div>`;
    return;
  }
  const rows = baskets.map(b => {
    const m = basketMetrics(b);
    const reason = m.close_reason;
    const reasonClass =
      reason === "tp" || reason === "recovery_tp" ? "reason-tp" :
      reason === "stopout"   ? "reason-stopout"   :
      reason === "surrender" ? "reason-surrender" :
                                "reason-open";
    const pnlClass =
      m.net_pnl == null ? "" : (m.net_pnl >= 0 ? "pnl-pos" : "pnl-neg");
    const pnlStr = m.net_pnl == null
      ? "—"
      : (m.net_pnl >= 0 ? "+" : "") + fmtMoney(m.net_pnl);
    return `<tr data-basket-key="${b.key}">
      <td class="num">${b.basket_num}</td>
      <td class="side-${b.side}">${b.side}</td>
      <td>${_fmtBasketTime(m.start_unix)}</td>
      <td>${_fmtBasketTime(m.end_unix)}</td>
      <td class="${reasonClass}">${reason}</td>
      <td class="num">${m.max_depth}</td>
      <td class="num ${pnlClass}">${pnlStr}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <table class="basket-table">
      <thead>
        <tr>
          <th>#</th><th>Side</th><th>Open</th><th>Close</th>
          <th>Reason</th><th>Depth</th><th>Net P&amp;L</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="basket-metrics-card" class="basket-metrics-card" style="display:none;"></div>
  `;
  // Wire row clicks
  body.querySelectorAll("tr[data-basket-key]").forEach(tr => {
    tr.addEventListener("click", () => {
      const key = tr.dataset.basketKey;
      const b = _basketState.baskets.find(x => x.key === key);
      if (b) selectBasket(b);
    });
  });
}

function selectBasket(basket) {
  _basketState.selectedKey = basket.key;
  // Highlight the selected row
  const body = document.getElementById("basket-panel-body");
  body?.querySelectorAll("tr[data-basket-key]").forEach(tr => {
    tr.classList.toggle("selected", tr.dataset.basketKey === basket.key);
  });
  // Render metrics card
  const m = basketMetrics(basket);
  const card = document.getElementById("basket-metrics-card");
  if (card && m) {
    card.style.display = "";
    card.innerHTML = `
      <div class="stat"><span class="label">Basket</span><span class="value">#${basket.basket_num} <span style="color:var(--text-muted);font-weight:400;">(${basket.side})</span></span></div>
      <div class="stat"><span class="label">Entries</span><span class="value">${m.n_entries}</span></div>
      <div class="stat"><span class="label">Max depth</span><span class="value">${m.max_depth}</span></div>
      <div class="stat"><span class="label">Total lots</span><span class="value">${fmtNum(m.total_lots, 2)}</span></div>
      <div class="stat"><span class="label">Lifetime</span><span class="value">${_fmtBasketDuration(m.lifetime_sec)}</span></div>
      <div class="stat"><span class="label">Close reason</span><span class="value">${m.close_reason}</span></div>
      <div class="stat"><span class="label">Net P&amp;L</span>
        <span class="value" style="color: var(--${m.net_pnl == null ? "text-muted" : (m.net_pnl >= 0 ? "green" : "red")})">
          ${m.net_pnl == null ? "—" : (m.net_pnl >= 0 ? "+" : "") + fmtMoney(m.net_pnl)}
        </span></div>
    `;
  }
  // Zoom chart to the basket's window with 30-min padding
  zoomToBasket(basket);
  // Filter the compliance table to this basket's trades
  filterComplianceToBasket(basket);
  // Plot the basket's break-even (WAPP) stair-step on the price chart
  showBasketBreakEvenLine(basket);
}

// Filter the trade-compliance spreadsheet to one basket's trades by
// driving the existing search box. Reuses the existing search machinery
// so showOnlyIssues + sort all keep working.
function filterComplianceToBasket(basket) {
  const inp = document.getElementById("tc-search");
  if (!inp) return;
  // Match every trade in this basket: account, basket. Trade IDs after
  // renumberTradeIDs are A{acct}.B{basket_num}.T{N}.
  const acct = _basketState.account;
  if (!acct) return;
  const term = `A${acct.num}.B${basket.basket_num}.`;
  inp.value = term;
  // Synthesize the input event so the existing debounce + redraw runs.
  inp.dispatchEvent(new Event("input", { bubbles: true }));
}

// Stair-step line series showing the basket's WAPP (weighted-average
// position price) — gross break-even. Each new fill recomputes the level.
// For BUY baskets, the basket goes profitable when price > WAPP; for SELL,
// when price < WAPP. The basket TP is WAPP ± tier.tp_pips.
//
// IMPORTANT: every WAPP point's `time` must already exist in the candle
// series. Lightweight Charts treats added-series timestamps as logical
// data — adding points outside the candle series' time domain extends the
// chart's implied range and breaks setVisibleRange/setVisibleLogicalRange
// silently. We snap each WAPP timestamp to the nearest candle time.
function showBasketBreakEvenLine(basket) {
  hideBasketBreakEvenLine();
  if (!state.priceChart || !basket?.entries?.length) return;
  // Sorted entries (renumberTradeIDs already sorts by time, but be safe).
  const entries = basket.entries.slice().sort((a, b) =>
    (a.time_unix || 0) - (b.time_unix || 0));
  // Build a sorted candle-time array we can snap against.
  let candleTimes = state._m1CandleTimes;
  if (!candleTimes?.length && state.candleSeries?.data) {
    try {
      candleTimes = state.candleSeries.data().map(c => c.time);
    } catch { candleTimes = []; }
  }
  if (!candleTimes?.length) return;
  // Snap a target time to the nearest candle time at or BEFORE it (so the
  // line "starts" at the candle the entry filled on).
  const snapTo = (t) => {
    let lo = 0, hi = candleTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candleTimes[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return candleTimes[Math.max(0, lo - 1)];
  };
  // Stair-step: WAPP holds constant from each entry until the next one,
  // then jumps. Lightweight Charts lineType=2 gives stepped rendering.
  let totalLots = 0;
  let weightedSum = 0;
  const seenTimes = new Set();
  const points = [];
  for (const e of entries) {
    const lots = e.lots || 0;
    if (lots <= 0) continue;
    totalLots  += lots;
    weightedSum += (e.price || 0) * lots;
    const wapp = totalLots > 0 ? weightedSum / totalLots : 0;
    let t = snapTo(e.time_unix);
    // Guarantee strict monotonic time — Lightweight Charts requires it.
    while (seenTimes.has(t)) {
      // Bump to the next candle if we collided with one already used
      const idx = candleTimes.indexOf(t);
      if (idx < 0 || idx >= candleTimes.length - 1) break;
      t = candleTimes[idx + 1];
    }
    seenTimes.add(t);
    points.push({ time: t, value: Number(wapp.toFixed(5)) });
  }
  if (!points.length) return;
  // Extend the line to the basket close so the level reads all the way
  // to the right edge of the zoom window.
  const lastEntryTime = points[points.length - 1].time;
  const closeRawTime = basket.close_event?.time;
  if (closeRawTime && closeRawTime > lastEntryTime) {
    let closeT = snapTo(closeRawTime);
    if (closeT > lastEntryTime && !seenTimes.has(closeT)) {
      points.push({ time: closeT, value: points[points.length - 1].value });
    }
  }
  // Lighter, more transparent color so it doesn't visually compete with
  // candles + entry markers. Green for buys, red for sells.
  const color = basket.side === "buy"
    ? "rgba(86, 211, 100, 0.55)"   // pale green
    : "rgba(248, 81,  73, 0.55)";  // pale red
  const series = state.priceChart.addLineSeries({
    color, lineWidth: 1, lineStyle: 0,
    priceLineVisible: false, lastValueVisible: true,
    title: `B${basket.basket_num} break-even (WAPP)`,
    crosshairMarkerVisible: false,
  });
  // lineType: 2 = WithSteps (stair-step). Falls back to plain line if
  // the LWC version doesn't support it.
  try { series.applyOptions({ lineType: 2 }); } catch {}
  series.setData(points);
  state._basketBreakEvenSeries = series;
}

function hideBasketBreakEvenLine() {
  if (state._basketBreakEvenSeries && state.priceChart) {
    try { state.priceChart.removeSeries(state._basketBreakEvenSeries); }
    catch {}
  }
  state._basketBreakEvenSeries = null;
}

function zoomToBasket(basket) {
  // Basket-window zoom is currently disabled. The price chart's
  // setVisibleRange / setVisibleLogicalRange / scrollToPosition / fitContent
  // calls all return without actually moving the chart's time scale —
  // verified by direct API calls in the browser console (the requested
  // range and the actual reported range are different, no errors thrown).
  // This affects the existing zoomToAccount too. The same snap-to-candle
  // safeguard for showBasketBreakEvenLine is in place; re-enabling this
  // function alone won't fix it. Tracking as a separate investigation.
  return;
}

// ----- account detail -----
function showAccountDetail(a) {

  // Phase 2: render the basket inspector for this account
  renderBasketPanel(a);

  // Computed fields for detail panel
  const xr = (a.stake || 0) > 0 ? (a.withdrawn || 0) / a.stake : 0;
  const netperday = (a.lifetime_days && a.lifetime_days > 0) ? (a.net || 0) / a.lifetime_days : 0;

  // Section B: Basket Metrics
  const bm = computeBasketMetrics(a);
  let basketHTML = "";
  if (bm) {
    basketHTML = `
      <div class="basket-metrics">
        <div class="basket-metrics-title">Basket Metrics</div>
        <div class="basket-metrics-grid">
          <div class="k">TP Cycles</div><div class="v">${bm.tpCount}</div>
          <div class="k">Buy / Sell TPs</div><div class="v">${bm.buyTPs} / ${bm.sellTPs}</div>
          <div class="k">Depth (avg / median / max)</div><div class="v">${fmtNum(bm.avgDepth, 1)} / ${fmtNum(bm.medianDepth, 0)} / ${bm.maxDepth}</div>
          <div class="k">Time to TP (avg / median)</div><div class="v">${fmtNum(bm.avgTimeToTP, 1)}h / ${fmtNum(bm.medianTimeToTP, 1)}h</div>
          <div class="k">Basket DD (avg / max)</div><div class="v">${fmtNum(bm.avgBasketDD, 1)} / ${fmtNum(bm.maxBasketDD, 1)} pips</div>
        </div>
      </div>`;
  }

  document.getElementById("close-detail-btn").style.display = "";
  document.getElementById("detail-body").innerHTML = `
    <div class="detail-header">
      <div class="title">Account #${a.num}</div>
      <div class="outcome ${a.outcome}">${a.outcome.replace("_", " ")}</div>
    </div>
    <div class="detail-meta">
      <div class="k">Stake</div><div class="v">${fmtMoney(a.stake)}</div>
      <div class="k">Withdrawn</div><div class="v">${fmtMoney(a.withdrawn)}</div>
      <div class="k">Net P&L</div><div class="v" style="color:var(--${(a.net || 0) >= 0 ? "green" : "red"})">${(a.net || 0) >= 0 ? "+" : ""}${fmtMoney(a.net)}</div>
      <div class="k">X Ratio</div><div class="v" style="color:var(--${xr >= 1.0 ? "green" : "red"})">${fmtNum(xr, 2)}x</div>
      <div class="k">Lifetime</div><div class="v">${fmtNum(a.lifetime_days, 1)}d</div>
      <div class="k">Net $/Day</div><div class="v" style="color:var(--${netperday >= 0 ? "green" : "red"})">${fmtMoney(netperday)}</div>
    </div>
    ${basketHTML}
    <div class="detail-actions">
      <button id="zoom-to-acct-btn">Zoom to account lifetime</button>
      ${a.trace ? '<button id="hide-trades-btn">Hide trades</button>' : '<span class="muted" style="font-size:11px;">No trace data (run with --trace)</span>'}
      ${a.trace ? '<button id="toggle-wd-btn">Show all withdrawals</button>' : ''}
      <button id="next-acct-btn">Next account &rarr;</button>
      <button id="prev-acct-btn">&larr; Prev account</button>
    </div>
  `;

  document.getElementById("zoom-to-acct-btn").onclick = () => zoomToAccount(a);
  // Auto-show trades: switch to M1 candles for this account's range, then overlay
  if (a.trace) {
    switchToM1(a).then(() => {
      showTraceOverlay(a);
      zoomToAccount(a);
    });
  }
  const hideTradesBtn = document.getElementById("hide-trades-btn");
  if (hideTradesBtn) {
    hideTradesBtn.onclick = () => {
      if (state.traceActive) {
        clearTraceOverlay();
        hideTradesBtn.textContent = "Show trades";
      } else {
        showTraceOverlay(a);
        zoomToAccount(a);
        hideTradesBtn.textContent = "Hide trades";
      }
    };
  }
  // Toggle individual withdrawals
  const toggleWdBtn = document.getElementById("toggle-wd-btn");
  if (toggleWdBtn) {
    toggleWdBtn.onclick = () => {
      state._traceShowAllWd = !state._traceShowAllWd;
      toggleWdBtn.textContent = state._traceShowAllWd ? "Hide withdrawals" : "Show all withdrawals";
      if (state._buildTraceMarkers) {
        state.traceEntryMarkers = state._buildTraceMarkers();
        applyMarkersForVisibleRange();
      }
    };
  }
  document.getElementById("next-acct-btn").onclick = () => navigateAccount(a.num, 1);
  document.getElementById("prev-acct-btn").onclick = () => navigateAccount(a.num, -1);

  // Notes auto-save
  const notesEl = document.getElementById("experiment-notes");
  if (notesEl) {
    notesEl.addEventListener("input", () => {
      localStorage.setItem(notesKey, notesEl.value);
    });
  }
}

// ----- M1 candle swap -----
// M1 data loaded on demand from a separate file. Cached after first load.
state._m1Data = null;       // cached M1 array: [[t,o,h,l,c], ...]
state._m1Loading = false;
state._isM1Active = false;

async function loadM1Data() {
  if (state._m1Data) return state._m1Data;
  if (state._m1Loading) {
    // Wait for in-progress load
    while (state._m1Loading) await new Promise(r => setTimeout(r, 50));
    return state._m1Data;
  }
  state._m1Loading = true;
  try {
    const b = state.currentBundle;
    const fold = b ? b.fold : "fold4";
    const resp = await fetch(`dashboard_data/${fold}_m1.json`);
    if (!resp.ok) throw new Error(`M1 data not found for ${fold}`);
    state._m1Data = await resp.json();
    return state._m1Data;
  } catch (e) {
    console.warn("M1 load failed:", e);
    return null;
  } finally {
    state._m1Loading = false;
  }
}

/**
 * Compute the effective end time for an account. For blowups, use blowup_time.
 * For survivors (blowup_time is null), use the last trace event time or eval_end.
 */
function accountEndTime(a) {
  const bt = toUnix(a.blowup_time);
  if (bt) return bt;

  // Survivor: find the last trace event. Bundle format uses different
  // field names per array (v2: time_unix in events, time in basket_close;
  // v3: time everywhere). Read whichever is present.
  if (a.trace) {
    const pluck = (arr, ...keys) => (arr || []).map(o => {
      for (const k of keys) if (o[k] != null) return o[k];
      return null;
    }).filter(t => t != null && !isNaN(t));
    const allTimes = [
      ...pluck(a.trace.orders, "time", "time_unix"),
      ...pluck(a.trace.grid_entry_events, "time_unix", "time"),
      ...pluck(a.trace.closes, "time", "time_unix"),
      ...pluck(a.basket_close_events, "time", "time_unix"),
      ...pluck(a.trace.equity_snapshots, "time", "time_unix"),
      ...pluck(a.trace.withdrawals, "time", "time_unix"),
      ...pluck(a.trace.withdrawal_events, "time_unix", "time"),
    ];
    if (allTimes.length) return Math.max(...allTimes);
  }

  // Fallback: eval_end from the bundle, or last candle time
  const b = state.currentBundle;
  if (b && b.eval_end) {
    const d = new Date(b.eval_end + "T23:59:00Z");
    if (!isNaN(d)) return Math.floor(d.getTime() / 1000);
  }
  if (b && b.candles_m15 && b.candles_m15.length) {
    return b.candles_m15[b.candles_m15.length - 1].t;
  }

  const deployT = toUnix(a.deploy_time) || 0;
  return deployT + 86400;
}

async function switchToM1(a) {
  const m1Raw = await loadM1Data();
  if (!m1Raw || !state.candleSeries) return;

  const deployT = toUnix(a.deploy_time) || 0;
  const endT = accountEndTime(a);
  const pad = Math.max(3600, (endT - deployT) * 0.1);
  const from = deployT - pad;
  const to = endT + pad;

  // Filter M1 bars to account range (with padding)
  const m1Candles = [];
  for (const bar of m1Raw) {
    const t = bar[0];
    if (t < from) continue;
    if (t > to) break;
    m1Candles.push({ time: t, open: bar[1], high: bar[2], low: bar[3], close: bar[4] });
  }

  if (m1Candles.length === 0) return;

  // Store M1 candle times for the trace overlay's nearestCandleTime
  state._m1CandleTimes = m1Candles.map(c => c.time);
  state._isM1Active = true;

  // Swap the candle series data
  state.candleSeries.setData(m1Candles);

  // Update the chart header
  const header = document.querySelector(".chart-title");
  if (header) header.textContent = "EURGBP (M1) · Account #" + a.num;
}

function switchToM15() {
  if (!state._isM1Active || !state.currentBundle) return;
  state._isM1Active = false;
  state._m1CandleTimes = null;

  // Restore M15 candles
  const candles = state.currentBundle.candles_m15.map(c => ({
    time: c.t, open: c.o, high: c.h, low: c.l, close: c.c,
  }));
  state.candleSeries.setData(candles);

  // Restore markers
  const raw = buildMarkers(state.currentBundle.accounts);
  raw.sort((a, b) => a.time - b.time);
  state.fullPriceMarkers = raw;
  applyMarkersForVisibleRange();

  // Restore header
  const header = document.querySelector(".chart-title");
  if (header) header.textContent = "EURGBP (M15) · Accounts overlay";

  state.priceChart.timeScale().fitContent();
}

function zoomToAccount(a) {
  const from = toUnix(a.deploy_time);
  const to = accountEndTime(a);
  if (!from || !to) return;
  const pad = Math.max(3600, (to - from) * 0.15);
  const range = { from: from - pad, to: to + pad };
  state._syncing = true;
  try { state.priceChart.timeScale().setVisibleRange(range); } catch (e) {}
  try { state.bankChart.timeScale().setVisibleRange(range); } catch (e) {}
  state._syncing = false;
}

function navigateAccount(currentNum, dir) {
  if (!state.currentBundle) return;
  clearTraceOverlay();
  switchToM15();  // Reset to M15 before loading next account
  const arr = state.currentBundle.accounts;
  const idx = arr.findIndex(a => a.num === currentNum);
  if (idx < 0) return;
  const next = arr[(idx + dir + arr.length) % arr.length];
  if (next) showAccountDetail(next);
}

function resetZoom() {
  if (state.priceChart) state.priceChart.timeScale().fitContent();
  if (state.bankChart) state.bankChart.timeScale().fitContent();
}

function closeDetail() {
  if (!state.currentBundle) return;
  clearTraceOverlay();
  switchToM15();  // Restore M15 candles
  document.getElementById("detail-body").innerHTML =
    `<div class="placeholder">Click a deploy marker on the chart or a table row to inspect an account. ${state.currentBundle.accounts.length} accounts loaded.</div>`;
  // Deselect table row
  document.querySelectorAll("#accounts-table tbody tr.selected").forEach(r => r.classList.remove("selected"));
  document.getElementById("close-detail-btn").style.display = "none";
  // Phase 2: clear basket panel when account is deselected
  renderBasketPanel(null);
}

// ----- multi-fold overview -----
const FOLD_REGIMES = {
  fold1: "GFC", fold2: "Calm", fold3: "Brexit", fold4: "COVID", fold5: "Rate hikes"
};

function renderMultifoldOverview(multifoldData) {
  const el = document.getElementById("multifold-overview");
  const cards = document.getElementById("multifold-cards");
  const meanEl = document.getElementById("multifold-mean");

  if (!multifoldData || !multifoldData.per_fold) {
    el.style.display = "none";
    return;
  }

  el.style.display = "";
  const perFold = multifoldData.per_fold;
  const meanTR = multifoldData.aggregate_metrics?.mean_total_return
              || multifoldData.metrics?.mean_total_return
              || (perFold.reduce((s, f) => s + (f.total_return || 0), 0) / perFold.length);

  const meanColor = meanTR >= 1 ? "green" : "red";
  meanEl.innerHTML = `Mean TR: <span style="color:var(--${meanColor})">${fmtNum(meanTR, 4)}x</span>`;

  cards.innerHTML = perFold.map(f => {
    const tr = f.total_return || 0;
    const color = tr >= 1 ? "green" : "red";
    const fid = f.fold_id || "fold?";
    const regime = FOLD_REGIMES[fid] || "";
    const blowups = f.blowup_count ?? "?";
    const accounts = f.total_accounts ?? "?";
    return `
      <div class="fold-card" data-fold="${fid}">
        <div class="fold-name">${fid}</div>
        <div class="fold-regime">${regime}</div>
        <div class="fold-tr ${color}">${fmtNum(tr, 4)}x</div>
        <div class="fold-detail">${accounts} accts / ${blowups} blowups</div>
      </div>`;
  }).join("");

  // Click a fold card to filter to that fold
  cards.querySelectorAll(".fold-card").forEach(card => {
    card.addEventListener("click", () => {
      const fold = card.dataset.fold;
      document.getElementById("fold-filter").value = fold;
      refreshSelector();
    });
  });
}

function hideMultifoldOverview() {
  document.getElementById("multifold-overview").style.display = "none";
}

// Try to load multifold data for an experiment
async function tryLoadMultifold(experimentId) {
  // The multifold result JSON is on the VPS, but we can include it in the manifest
  // For now, check if the manifest has per_fold data
  if (!state.manifest) return null;

  // Look for a multifold entry in the manifest
  const multifold = state.manifest.multifold_results?.[experimentId];
  if (multifold) return multifold;

  // Try to load from dashboard_data
  try {
    const resp = await fetch(`dashboard_data/${experimentId}_multifold.json`);
    if (resp.ok) return await resp.json();
  } catch {}
  return null;
}

// ----- comparison mode -----
state.compareBundle = null;
state.compareSavingsSeries = null;

function toggleCompareMode(enabled) {
  const sel = document.getElementById("compare-select");
  sel.style.display = enabled ? "" : "none";

  if (!enabled) {
    clearCompareOverlay();
    state.compareBundle = null;
    document.getElementById("comparison-table").style.display = "none";
  } else {
    populateCompareSelector();
    // Table visibility is controlled by renderComparison when data loads
  }
}

function populateCompareSelector() {
  const sel = document.getElementById("compare-select");
  const list = getFilteredSorted().filter(e => e.bundled);
  sel.innerHTML = '<option value="">Select experiment to compare...</option>';
  for (const e of list) {
    const tr = e.total_return != null ? e.total_return.toFixed(3) + "x" : "n/a";
    const opt = document.createElement("option");
    opt.textContent = `[${e.fold}] ${e.experiment_id} — TR ${tr}`;
    opt.value = e.experiment_id + "||" + e.fold;
    sel.appendChild(opt);
  }
}

async function loadCompareExperiment(entry) {
  if (!entry || !entry.bundled) return;
  try {
    const resp = await fetch(`dashboard_data/${entry.experiment_id}.json`);
    if (!resp.ok) return;
    state.compareBundle = await resp.json();
    renderComparison();
    overlayComparisonOnChart();
  } catch (e) { console.error("compare error:", e); }
}

function clearCompareOverlay() {
  if (state.compareSavingsSeries && state.bankChart) {
    try { state.bankChart.removeSeries(state.compareSavingsSeries); } catch {}
    state.compareSavingsSeries = null;
  }
  // Note: table visibility is managed by renderComparison/toggleCompareMode, not here
}

function overlayComparisonOnChart() {
  clearCompareOverlay();
  if (!state.compareBundle || !state.bankChart) return;

  const savPts = (state.compareBundle.savings_curve || []).map(p => ({
    time: p.time, value: p.savings,
  })).filter(p => p.time != null && p.value != null);

  if (savPts.length > 0) {
    state.compareSavingsSeries = state.bankChart.addLineSeries({
      color: "#f0883e", lineWidth: 2, lineType: 1,
      lineStyle: 2, // dashed
      title: `Compare: ${state.compareBundle.experiment_id}`,
    });
    state.compareSavingsSeries.setData(savPts);
  }
}

function renderComparison() {
  const table = document.getElementById("comparison-table");
  const body = document.getElementById("comparison-body");
  if (!state.compareBundle) {
    table.style.display = "none";
    return;
  }
  // Use currentBundle metrics if available, otherwise use the compareBundle's own fold entry from manifest
  const currentMetrics = state.currentBundle?.metrics;
  if (!currentMetrics) {
    table.style.display = "none";
    return;
  }
  table.style.display = "";

  const a = state.currentBundle.metrics || {};
  const b = state.compareBundle.metrics || {};

  const rows = [
    ["Total Return", a.total_return, b.total_return, "higher"],
    ["Accounts", a.total_accounts, b.total_accounts, null],
    ["Blowups", a.blowup_count, b.blowup_count, "lower"],
    ["Total Withdrawn", a.total_withdrawn, b.total_withdrawn, "higher"],
    ["Avg Lifetime (d)", a.avg_account_lifetime_days, b.avg_account_lifetime_days, null],
    ["Commission", a.total_commission, b.total_commission, null],
    ["Swap", a.total_swap, b.total_swap, null],
    ["Wd/day", a.withdrawal_per_day, b.withdrawal_per_day, "higher"],
  ];

  body.innerHTML = `
    <div class="comparison-grid">
      <div class="cg-header">Metric</div>
      <div class="cg-header">${state.currentBundle.experiment_id}</div>
      <div class="cg-header">${state.compareBundle.experiment_id}</div>
      ${rows.map(([label, va, vb, better]) => {
        let clsA = "", clsB = "";
        if (better && va != null && vb != null) {
          if (better === "higher") { clsA = va > vb ? "better" : va < vb ? "worse" : ""; clsB = vb > va ? "better" : vb < va ? "worse" : ""; }
          else { clsA = va < vb ? "better" : va > vb ? "worse" : ""; clsB = vb < va ? "better" : vb > va ? "worse" : ""; }
        }
        return `<div class="cg-label">${label}</div><div class="cg-val ${clsA}">${fmtNum(va, 4)}</div><div class="cg-val ${clsB}">${fmtNum(vb, 4)}</div>`;
      }).join("")}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// HARNESS MODULE — local-server experiment runner
//
// On page load, probe /api/health. If a local Flask server is reachable,
// reveal the Run Experiment panel (form + Run button + Discard/Share for
// scratch bundles). On the live URL the probe times out silently and the
// dashboard renders read-only as before.
// ─────────────────────────────────────────────────────────────────────────

// Detect local harness with a 500ms timeout. AbortSignal.timeout is supported
// in Chrome/Safari/Firefox 100+ — covers what we need for both Macs.
async function detectHarness() {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(500) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.ok;
  } catch { return false; }
}

let _harnessSchema = null;
let _activeJobId = null;
let _pollTimer = null;

async function initHarness() {
  if (!state.harness) return;
  // Reveal harness UI
  document.getElementById("experiment-runner").style.display = "";
  // Pull the form schema and render
  try {
    const r = await fetch("/api/schema");
    const j = await r.json();
    _harnessSchema = j.sections;
    renderHarnessForm(_harnessSchema);
  } catch (e) {
    setRunnerStatus("schema fetch failed: " + e.message);
    return;
  }
  // Wire buttons
  document.getElementById("runner-run-btn").addEventListener("click", onRunClick);
  document.getElementById("runner-reset-btn").addEventListener("click", () => {
    if (_harnessSchema) populateFormFromSchema(_harnessSchema);
  });
  document.getElementById("runner-clone-btn")?.addEventListener("click", onCloneFromLoaded);
  document.getElementById("bundle-discard-btn")?.addEventListener("click", onDiscardClick);
  document.getElementById("bundle-share-btn")?.addEventListener("click", onShareClick);
  document.getElementById("push-retry-btn")?.addEventListener("click", onPushRetryClick);
  // Initial state: defaults
  setFormState("default");
}

function renderHarnessForm(sections) {
  const form = document.getElementById("runner-form");
  form.innerHTML = "";
  for (const sec of sections) {
    const fs = document.createElement("fieldset");
    if (sec.readonly) fs.classList.add("readonly");
    const lg = document.createElement("legend");
    lg.textContent = sec.label;
    fs.appendChild(lg);
    if (sec.help) {
      const help = document.createElement("div");
      help.className = "field-help";
      help.textContent = sec.help;
      fs.appendChild(help);
    }
    for (const f of sec.fields) {
      const row = document.createElement("div");
      row.className = "field-row";
      const lbl = document.createElement("label");
      lbl.textContent = f.label;
      lbl.htmlFor = `f-${f.id}`;
      let inp;
      if (f.type === "select") {
        inp = document.createElement("select");
        for (const opt of (f.options || [])) {
          const o = document.createElement("option");
          if (typeof opt === "string") {
            o.value = opt; o.textContent = opt;
          } else {
            o.value = opt.value; o.textContent = opt.label || opt.value;
          }
          inp.appendChild(o);
        }
        inp.value = f.default;
      } else if (f.type === "checkbox") {
        inp = document.createElement("input");
        inp.type = "checkbox";
        inp.checked = !!f.default;
      } else if (f.type === "textarea") {
        inp = document.createElement("textarea");
        inp.rows = 2;
        inp.value = f.default || "";
      } else {
        inp = document.createElement("input");
        inp.type = (f.type === "number") ? "number" : "text";
        if (f.step != null) inp.step = f.step;
        if (f.min != null)  inp.min  = f.min;
        if (f.max != null)  inp.max  = f.max;
        inp.value = f.default ?? "";
      }
      // Per-field readonly support: if the section is readonly, the input is
      // disabled (still readable, never sent in /api/run because readHarnessForm
      // skips disabled inputs — see implementation note).
      if (sec.readonly || f.readonly) inp.disabled = true;
      inp.id = `f-${f.id}`;
      inp.dataset.fid = f.id;
      inp.dataset.ftype = f.type;
      // Hook for the viewing/modified state machine
      inp.addEventListener("input", _onFormFieldChanged);
      inp.addEventListener("change", _onFormFieldChanged);
      row.appendChild(lbl);
      row.appendChild(inp);
      if (f.help) {
        const fhelp = document.createElement("div");
        fhelp.className = "field-help";
        fhelp.textContent = f.help;
        row.appendChild(fhelp);
      }
      fs.appendChild(row);
    }
    form.appendChild(fs);
  }
}

function readHarnessForm() {
  const out = {};
  // Skip disabled inputs (readonly fields) — they're for display only and
  // sending them would let users override server-side hardcoded realism.
  const inputs = document.querySelectorAll("#runner-form [data-fid]:not(:disabled)");
  for (const el of inputs) {
    const k = el.dataset.fid;
    const t = el.dataset.ftype;
    if (t === "checkbox")      out[k] = el.checked;
    else if (t === "number")   out[k] = el.value === "" ? null : Number(el.value);
    else                        out[k] = el.value;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Form-as-viewer: populate the form from a loaded bundle's policy_config.
// Read direction only — write happens via readHarnessForm() at Run time.
//
// Form-state machine: on bundle load, form is in "viewing" state (tinted
// blue, chip = "Viewing: <experiment_id>"). Any user edit drops to "modified"
// state (tint cleared, chip = "Modified — Run will use these new params").
// "Reset to defaults" returns to schema defaults. "Clone from loaded" goes
// back to the loaded bundle's params and stays in "modified" so Run uses them.
// ─────────────────────────────────────────────────────────────────────────

// form-id → function(bundle) returning the value to set. Single source of
// truth for bidirectional mapping. Form-id missing from this map → field
// keeps schema default when populating from a bundle.
const BUNDLE_TO_FORM_MAP = {
  // identity
  name:        b => b.experiment_label || b.experiment_id || "",
  notes:       b => b.policy_config?.strategy?.notes || "",
  hypothesis:  b => b.policy_config?.strategy?.hypothesis || "",
  // fold
  fold:        b => b.fold,
  // base_tier
  grid_pips:        b => b.policy_config?.base_tier?.spacing_pips,
  tp_pips:          b => b.policy_config?.base_tier?.tp_pips,
  lot_size:         b => b.policy_config?.grid?.lot_size_base,
  lot_curve_type:   b => b.policy_config?.grid?.lot_curve_type,
  max_levels:       b => b.policy_config?.grid?.max_levels,
  direction:        b => b.policy_config?.grid?.direction,
  // flex tiers
  flex1_enabled:    b => !!b.policy_config?.flex_tier_1,
  flex1_after:      b => b.policy_config?.flex_tier_1?.activates_at_depth,
  flex1_spacing:    b => b.policy_config?.flex_tier_1?.spacing_pips,
  flex1_tp:         b => b.policy_config?.flex_tier_1?.tp_pips,
  flex1_mult:       b => b.policy_config?.flex_tier_1?.lot_multiplier,
  flex2_enabled:    b => !!b.policy_config?.flex_tier_2,
  flex2_after:      b => b.policy_config?.flex_tier_2?.activates_at_depth,
  flex2_spacing:    b => b.policy_config?.flex_tier_2?.spacing_pips,
  flex2_tp:         b => b.policy_config?.flex_tier_2?.tp_pips,
  flex2_mult:       b => b.policy_config?.flex_tier_2?.lot_multiplier,
  flex3_enabled:    b => !!b.policy_config?.flex_tier_3,
  flex3_after:      b => b.policy_config?.flex_tier_3?.activates_at_depth,
  flex3_spacing:    b => b.policy_config?.flex_tier_3?.spacing_pips,
  flex3_tp:         b => b.policy_config?.flex_tier_3?.tp_pips,
  flex3_mult:       b => b.policy_config?.flex_tier_3?.lot_multiplier,
  // risk
  starting_capital:        b => b.policy_config?.risk?.starting_capital,
  stake_per_account:       b => b.policy_config?.risk?.stake_per_account,
  min_deploy_pool:         b => b.policy_config?.risk?.min_deploy_pool,
  max_concurrent_accounts: b => b.policy_config?.risk?.max_concurrent_accounts,
  cooldown_days:           b => b.policy_config?.risk?.cooldown_days_after_blowup,
  // filters
  rollover_filter:         b => b.policy_config?.filters?.rollover_filter,
  // withdrawal — bundle doesn't carry target_balance directly; parse from
  // logic string ("Withdraw everything above $1000 ...") with a fallback.
  withdrawal_target_balance: b => {
    const logic = b.policy_config?.withdrawal?.logic || "";
    const m = /\$([\d,]+)/.exec(logic);
    return m ? Number(m[1].replace(/,/g, "")) : 1000;
  },
  // recovery
  recovery_d_pips:           b => b.policy_config?.recovery?.displacement_threshold_pips,
  recovery_tp_pips:          b => b.policy_config?.recovery?.recovery_tp_pips,
  recovery_risk_pct:         b => b.policy_config?.recovery?.recovery_risk_pct,
  recovery_max_adverse_pips: b => b.policy_config?.recovery?.recovery_max_adverse_pips,
  // adaptive
  phase1_model:       b => b.policy_config?.adaptive_tools?.phase1_model || "",
  prob_table_active:  b => !!b.policy_config?.adaptive_tools?.prob_table_active,
  regime_classifier:  b => b.policy_config?.adaptive_tools?.regime_classifier || "",
  // realism (display-only — no user-editable fields, but populated for visibility)
  leverage:                       b => b.policy_config?.risk?.leverage_implied,
  commission_per_lot_per_side_usd: b => b.policy_config?.realism?.commission_per_lot_per_side_usd,
};

let _formStateSuppressEvents = false;

function _setFormFieldValue(fid, val) {
  const el = document.getElementById(`f-${fid}`);
  if (!el) return;
  if (val == null) return;  // leave existing value alone
  if (el.type === "checkbox") el.checked = !!val;
  else el.value = val;
}

function populateFormFromBundle(bundle) {
  if (!bundle) return;
  _formStateSuppressEvents = true;
  try {
    for (const [fid, getter] of Object.entries(BUNDLE_TO_FORM_MAP)) {
      try {
        const v = getter(bundle);
        _setFormFieldValue(fid, v);
      } catch { /* skip missing paths */ }
    }
  } finally {
    _formStateSuppressEvents = false;
  }
  setFormState("viewing", bundle.experiment_label || bundle.experiment_id);
}

function _onFormFieldChanged() {
  if (_formStateSuppressEvents) return;
  if (state._formMode === "viewing") setFormState("modified");
}

// Populate the form from a JS schema dict (used by Reset).
function populateFormFromSchema(schema) {
  if (!schema) return;
  _formStateSuppressEvents = true;
  try {
    for (const sec of schema) {
      for (const f of sec.fields) {
        _setFormFieldValue(f.id, f.default);
      }
    }
  } finally {
    _formStateSuppressEvents = false;
  }
  setFormState("default");
}

function setFormState(mode, label) {
  const form = document.getElementById("runner-form");
  const chip = document.getElementById("form-state-chip");
  state._formMode = mode;
  if (!form) return;
  form.classList.remove("viewing", "modified");
  if (mode === "viewing") {
    form.classList.add("viewing");
    if (chip) {
      chip.textContent = `Viewing: ${label || "loaded experiment"}`;
      chip.dataset.state = "viewing";
    }
  } else if (mode === "modified") {
    form.classList.add("modified");
    if (chip) {
      chip.textContent = "Modified — Run will use these params";
      chip.dataset.state = "modified";
    }
  } else {
    if (chip) {
      chip.textContent = "Defaults — edit and Run";
      chip.dataset.state = "default";
    }
  }
}

function onCloneFromLoaded() {
  if (!state.currentBundle) {
    setStatus("No bundle loaded to clone from.");
    return;
  }
  populateFormFromBundle(state.currentBundle);
  // Switch to "modified" — user wants to edit, not just view
  setFormState("modified");
}

async function onRunClick() {
  const btn = document.getElementById("runner-run-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  setRunnerStatus("running");
  setRunnerProgress("submitting…");
  let resp;
  try {
    const payload = readHarnessForm();
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    resp = await r.json();
    if (!r.ok) throw new Error(resp.error || `HTTP ${r.status}`);
  } catch (e) {
    setRunnerStatus("error");
    setRunnerProgress(e.message);
    btn.disabled = false;
    return;
  }
  _activeJobId = resp.job_id;
  pollJob(resp.job_id);
}

function pollJob(jobId) {
  clearTimeout(_pollTimer);
  _pollTimer = setTimeout(async () => {
    let j;
    try {
      const r = await fetch(`/api/job/${jobId}`);
      j = await r.json();
    } catch {
      _pollTimer = setTimeout(() => pollJob(jobId), 2000);
      return;
    }
    setRunnerProgress(`${j.elapsed_seconds || 0}s — ${j.message || "…"}`);
    if (j.status === "done") {
      setRunnerStatus("done");
      document.getElementById("runner-run-btn").disabled = false;
      _activeJobId = null;
      // Refresh manifest, then auto-load the new bundle
      await loadManifest();
      const newEntry = (state.manifest.experiments || []).find(
        e => e.experiment_id === j.bundle_id
      );
      if (newEntry) {
        document.getElementById("experiment-select").value =
          newEntry.experiment_id + "||" + newEntry.fold;
        loadExperiment(newEntry);
      }
    } else if (j.status === "error") {
      setRunnerStatus("error");
      setRunnerProgress(j.error || "(no error message)");
      document.getElementById("runner-run-btn").disabled = false;
      _activeJobId = null;
    } else {
      pollJob(jobId);
    }
  }, 2000);
}

function setRunnerStatus(s) {
  const el = document.getElementById("runner-status");
  if (el) {
    el.textContent = s;
    el.dataset.state = s;
  }
}
function setRunnerProgress(s) {
  const el = document.getElementById("runner-progress");
  if (el) el.textContent = s;
}

// ----- Bundle action UI (Discard / Share / Push pending) -----
function updateBundleActions(entry) {
  const wrap = document.getElementById("bundle-actions");
  if (!wrap) return;
  if (state.harness && entry && entry.source === "scratch") {
    wrap.style.display = "";
  } else {
    wrap.style.display = "none";
  }
  // Push-pending badge is independent — always hidden until a share
  // returns committed=true, pushed=false. UI clears it on retry success.
  document.getElementById("push-pending-badge").style.display = "none";
}

async function onDiscardClick() {
  const entry = state.currentEntry;
  if (!entry || entry.source !== "scratch") return;
  if (!confirm(`Discard ${entry.experiment_id}? This cannot be undone.`)) return;
  try {
    const r = await fetch("/api/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle_id: entry.experiment_id }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  } catch (e) {
    setStatus("discard failed: " + e.message);
    return;
  }
  state.currentEntry = null;
  await loadManifest();
}

async function onShareClick() {
  const entry = state.currentEntry;
  if (!entry || entry.source !== "scratch" || !_activeJobId === null) {
    // _activeJobId is the LAST run's job_id; we need it to map back to scratch file.
  }
  // We use the job_id encoded in scratch_<job_id> to identify the bundle.
  // entry.experiment_id == 'scratch_<job_id>'.
  const jobId = entry.experiment_id.startsWith("scratch_")
    ? entry.experiment_id.slice("scratch_".length)
    : null;
  if (!jobId) {
    setStatus("share: cannot determine job_id");
    return;
  }
  const defaultName = (() => {
    const lab = state.currentBundle?.experiment_label || "";
    return lab && !lab.startsWith("scratch ") ? lab : "";
  })();
  const name = prompt("Name for shared experiment:", defaultName);
  if (!name) return;
  setStatus("sharing…");
  let r, j;
  try {
    r = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, name }),
    });
    j = await r.json();
  } catch (e) {
    setStatus("share failed: " + e.message);
    return;
  }
  if (!r.ok || !j.committed) {
    setStatus("share failed: " + (j.error || "unknown"));
    return;
  }
  if (!j.pushed) {
    document.getElementById("push-pending-badge").style.display = "";
    setStatus(`shared locally — push pending (${j.error || "auth?"})`);
  } else {
    setStatus(`shared: ${j.bundle_filename}`);
  }
  state.currentEntry = null;
  await loadManifest();
  // Try to auto-select the newly-shared bundle
  const newEntry = (state.manifest.experiments || []).find(
    e => e.filename === j.bundle_filename
  );
  if (newEntry) {
    document.getElementById("experiment-select").value =
      newEntry.experiment_id + "||" + newEntry.fold;
    loadExperiment(newEntry);
  }
}

async function onPushRetryClick() {
  setStatus("retrying push…");
  try {
    const r = await fetch("/api/share/push-pending", { method: "POST" });
    const j = await r.json();
    if (j.pushed) {
      document.getElementById("push-pending-badge").style.display = "none";
      setStatus("push successful");
    } else {
      setStatus("push still failing: " + (j.error || "?"));
    }
  } catch (e) {
    setStatus("retry failed: " + e.message);
  }
}

// ----- events -----
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("fold-filter").addEventListener("change", refreshSelector);
  document.getElementById("sort-select").addEventListener("change", refreshSelector);
  document.getElementById("only-bundled").addEventListener("change", refreshSelector);
  // Phase 2: source filter
  const srcFilter = document.getElementById("source-filter");
  const srcUserInp = document.getElementById("source-user-filter");
  if (srcFilter) {
    srcFilter.addEventListener("change", () => {
      if (srcUserInp) srcUserInp.style.display = srcFilter.value === "user" ? "" : "none";
      refreshSelector();
    });
  }
  if (srcUserInp) {
    srcUserInp.addEventListener("input", refreshSelector);
  }
  document.getElementById("experiment-select").addEventListener("change", (e) => {
    const [id, fold] = e.target.value.split("||");
    const entry = state.manifest.experiments.find(x => x.experiment_id === id && x.fold === fold);
    if (entry) loadExperiment(entry);
  });
  document.getElementById("reset-zoom-btn").addEventListener("click", resetZoom);
  document.getElementById("close-detail-btn").addEventListener("click", closeDetail);
  // Compare mode
  document.getElementById("compare-mode").addEventListener("change", (e) => {
    toggleCompareMode(e.target.checked);
  });
  document.getElementById("compare-select").addEventListener("change", (e) => {
    const [id, fold] = (e.target.value || "").split("||");
    if (!id) { clearCompareOverlay(); return; }
    const entry = state.manifest.experiments.find(x => x.experiment_id === id && x.fold === fold);
    if (entry) loadCompareExperiment(entry);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  // Detect local harness BEFORE loading manifest so loadManifest() picks
  // /api/manifest over the static dashboard_data/manifest.json.
  detectHarness().then(async (ok) => {
    state.harness = ok;
    if (ok) await initHarness();
    loadManifest().catch(err => {
      setStatus("error: " + err.message);
      console.error(err);
    });
  });
});
