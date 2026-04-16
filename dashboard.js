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
async function loadManifest() {
  setStatus("loading manifest…");
  const resp = await fetch("dashboard_data/manifest.json");
  if (!resp.ok) throw new Error("manifest.json not found");
  const m = await resp.json();
  state.manifest = m;
  setStatus(`${m.count} experiments (${m.bundled_count} with rich data)`);
  refreshSelector();
}

function getFilteredSorted() {
  const fold = document.getElementById("fold-filter").value;
  const sort = document.getElementById("sort-select").value;
  const onlyBundled = document.getElementById("only-bundled").checked;
  let list = state.manifest.experiments.slice();
  if (fold !== "all") list = list.filter(e => e.fold === fold);
  if (onlyBundled) list = list.filter(e => e.bundled);
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
    const tag = e.bundled ? "● " : "  ";
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
    return;
  }
  const resp = await fetch(`dashboard_data/${entry.experiment_id}.json`);
  if (!resp.ok) {
    setStatus(`failed to load ${entry.experiment_id}.json`);
    return;
  }
  const b = await resp.json();
  state.currentBundle = b;
  state.accountsById = {};
  for (const a of b.accounts) state.accountsById[a.num] = a;
  renderBundle(b);
  setStatus(`loaded: ${b.accounts.length} accounts, ${b.candles_m15.length} candles`);
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

  // experiment config panel
  renderConfigPanel(b);

  // reset detail panel
  document.getElementById("detail-body").innerHTML = `<div class="placeholder">Click a deploy marker on the chart or a table row to inspect an account. ${accounts.length} accounts loaded.</div>`;
  document.getElementById("close-detail-btn").style.display = "none";
}

function renderConfigPanel(b) {
  const policySource = b.policy_source || "";
  const configEl = document.getElementById("config-params");
  if (policySource) {
    configEl.innerHTML = `<pre>${policySource}</pre>`;
  } else {
    configEl.innerHTML = `<div class="placeholder">No configuration data embedded in this experiment.</div>`;
  }

  // Notes: load from localStorage
  const expId = b.experiment_id || "";
  const notesKey = `kalgo_notes_${expId}`;
  const savedNotes = localStorage.getItem(notesKey) || "";
  const notesEl = document.getElementById("experiment-notes");
  notesEl.value = savedNotes;
  // Auto-save on input
  notesEl.oninput = () => {
    localStorage.setItem(notesKey, notesEl.value);
  };
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
      minBarSpacing: 0.005,
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
  state.priceChart.timeScale().subscribeVisibleTimeRangeChange(r => {
    if (!r) return;
    // Level-of-detail marker culling: re-filter the stored full marker sets
    // to only those in the visible range, then cull by priority tier so the
    // chart isn't swamped with hundreds of labels at wide zoom.
    applyMarkersForVisibleRange(r);
    // Bank chart follow.
    if (!state.bankChart || !state.bankSeries) return;
    const data = state.bankSeries.data();
    if (!data || data.length === 0) return;
    try {
      state.bankChart.timeScale().setVisibleRange({ from: r.from, to: r.to });
    } catch (e) {
      /* out-of-range sync; ignore */
    }
  });

  // click handler for markers
  state.priceChart.subscribeCrosshairMove(param => {
    if (!param || !param.time) return;
    // hover tooltip could go here; for now click handles selection
  });
  state.priceChart.subscribeClick(param => {
    if (!param || !param.time) return;
    // find closest deploy marker to clicked time
    const t = param.time;
    const b = state.currentBundle;
    if (!b) return;
    let best = null, bestDist = Infinity;
    for (const a of b.accounts) {
      const at = toUnix(a.deploy_time);
      if (at == null) continue;
      const d = Math.abs(at - t);
      if (d < bestDist) { bestDist = d; best = a; }
    }
    // only select if click is reasonably close (< 1 day)
    if (best && bestDist < 86400) {
      showAccountDetail(best);
    }
  });
}

function buildMarkers(accounts) {
  // Big picture: deploy markers (colored by outcome), blowup markers, recovery events.
  // No basket close markers — those only appear in trace view.
  const markers = [];
  for (const a of accounts) {
    const dt = toUnix(a.deploy_time);
    if (dt != null) {
      const color = (a.outcome === "survived" || a.outcome === "blowup_profit") ? COLORS.green
                  : a.outcome === "total_loss" ? COLORS.gray
                  : COLORS.red;
      markers.push({
        time: dt, position: "belowBar", color,
        shape: "arrowUp", text: `#${a.num}`,
        _kind: "deploy", _acct: a.num,
      });
    }
    const bt = toUnix(a.blowup_time);
    if (bt != null && a.blowup) {
      markers.push({
        time: bt, position: "aboveBar", color: COLORS.red,
        shape: "arrowDown", text: `×${a.num}`,
        _kind: "blowup", _acct: a.num,
      });
    }
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

  // Store the FULL marker set (with _kind preserved) so the LOD culler can
  // re-filter on every zoom change. The initial setMarkers call is replaced
  // by applyMarkersForVisibleRange once the bank chart is also ready.
  const raw = buildMarkers(b.accounts);
  raw.sort((a, b) => a.time - b.time);
  state.fullPriceMarkers = raw;
  // Apply an initial cull based on the full data extent (the subsequent
  // fitContent + visibleRangeChange event will re-apply on first zoom).
  state.candleSeries.setMarkers(cullPriceMarkers(raw, 150).map(stripInternal));
  state.priceChart.timeScale().fitContent();
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
    const closeT = toUnix(a.blowup_time) || (toUnix(a.deploy_time) + (a.lifetime_days || 1) * 86400);

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
  const cleanPnl = [...seen.entries()].sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));

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
    const closeT = toUnix(a.blowup_time);

    if (deployT && a.capitalCall > 0) {
      bankMarkers.push({
        time: deployT, position: "aboveBar", color: COLORS.red,
        shape: "arrowDown", text: `call $${Math.round(a.capitalCall)}`,
        _kind: "deploy",
      });
    }
    if (a.distribution > 0) {
      const distT = closeT || deployT;
      if (distT) {
        bankMarkers.push({
          time: distT, position: "belowBar", color: COLORS.green,
          shape: "arrowUp", text: `dist $${Math.round(a.distribution)}`,
          _kind: "blowup",
        });
      }
    }
  }
  bankMarkers.sort((x, y) => x.time - y.time);
  state.fullBankMarkers = bankMarkers;
  state.bankSeries.setMarkers(cullBankMarkers(bankMarkers, 80).map(stripInternal));

  state.bankChart.timeScale().fitContent();
}

// ----- trace overlay -----
// When the user drills into an account that has trace data, we overlay
// grid entry markers on the price chart and an equity curve on the bank chart.
// These are stored in state.traceOverlay and cleaned up on close/navigate.

function clearTraceOverlay() {
  if (state.traceEquitySeries) {
    state.bankChart.removeSeries(state.traceEquitySeries);
    state.traceEquitySeries = null;
  }
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
      const tick = { t: nearestCandleTime(e.time_unix), v: e.price, color: isBuy ? COLORS.green : COLORS.red };
      allTicks.push(tick);
      (isBuy ? pendingBuy : pendingSell).push(tick);
    } else {
      const c = ev.data;
      const cp = c.close_price || 0;
      const side = (c.closed_basket || "").toLowerCase();
      const closeT = nearestCandleTime(ev.time);
      if (cp > 0) {
        const closeColor = side === "buy" ? COLORS.blue : COLORS.purple;
        allTicks.push({ t: closeT, v: cp, color: closeColor });
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

  // Equity curve on the bank chart
  const eqSnaps = trace.equity_snapshots || [];
  if (eqSnaps.length > 0) {
    state.traceEquitySeries = state.bankChart.addLineSeries({
      color: "#f0883e", lineWidth: 2, lineType: 0, title: `Equity #${a.num}`,
    });
    const dedup = (arr, key) => {
      const out = [];
      let lastT = null;
      for (const p of arr) {
        const t = p.time_unix;
        const v = p[key];
        if (t == null || v == null) continue;
        if (t === lastT) out[out.length - 1] = { time: t, value: v };
        else out.push({ time: t, value: v });
        lastT = t;
      }
      return out;
    };
    state.traceEquitySeries.setData(dedup(eqSnaps, "eq"));
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
      const closeType = (c.close_type || "").toUpperCase();
      if (closeType === "TP") {
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

// ----- account detail -----
function showAccountDetail(a) {

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

  // Survivor: find the last trace event
  if (a.trace) {
    const allTimes = [
      ...(a.trace.orders || []).map(o => o.time),
      ...(a.trace.closes || []).map(c => c.time),
      ...(a.trace.equity_snapshots || []).map(s => s.time),
      ...(a.trace.withdrawals || []).map(w => w.time),
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
  // pad by 10% on each side
  const pad = Math.max(3600, (to - from) * 0.15);
  state.priceChart.timeScale().setVisibleRange({ from: from - pad, to: to + pad });
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

// ----- events -----
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("fold-filter").addEventListener("change", refreshSelector);
  document.getElementById("sort-select").addEventListener("change", refreshSelector);
  document.getElementById("only-bundled").addEventListener("change", refreshSelector);
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

  loadManifest().catch(err => {
    setStatus("error: " + err.message);
    console.error(err);
  });
});
