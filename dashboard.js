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
  document.getElementById("hdr-total-return").textContent = (entry.total_return || 0).toFixed(3) + "x";
  document.getElementById("hdr-bank-range").textContent = `ends at ${fmtMoney(entry.bank_end)}`;
  document.getElementById("hdr-accounts").textContent = entry.total_accounts || "—";
  document.getElementById("hdr-blowups").textContent = `${entry.blowup_count || 0} blowups`;
  document.getElementById("hdr-lifetime").textContent = "—";
  document.getElementById("hdr-withdrawn").textContent = "—";
  document.getElementById("data-warning-card").style.display = "";
  document.getElementById("data-warning-text").textContent =
    "Legacy result — no per-account records. Only aggregate metrics are available. Re-run with patched harness to get interactive detail.";

  clearCharts();
  document.getElementById("stats-body").innerHTML = "<div class='placeholder'>Summary only — bundle this experiment to see the chart.</div>";
  document.getElementById("detail-body").innerHTML = "<div class='placeholder'>Bundle this experiment for interactive account inspection.</div>";
  document.getElementById("policy-source").textContent = "(not available for legacy experiments)";
}

function renderBundle(b) {
  // header cards
  const m = b.metrics || {};
  document.getElementById("hdr-experiment-id").textContent = b.experiment_id;
  document.getElementById("hdr-fold-period").textContent = `${b.fold} · ${b.eval_start}..${b.eval_end}`;
  const tr = m.total_return || 0;
  const trEl = document.getElementById("hdr-total-return");
  trEl.textContent = tr.toFixed(3) + "x";
  trEl.className = "card-value " + (tr >= 1 ? "green" : "red");
  document.getElementById("hdr-bank-range").textContent = `${fmtMoney(m.bank_start)} → ${fmtMoney(m.bank_end)}`;
  document.getElementById("hdr-accounts").textContent = m.total_accounts || b.accounts.length;
  document.getElementById("hdr-blowups").textContent = `${m.blowup_count || 0} blowups`;
  document.getElementById("hdr-lifetime").textContent = fmtNum(m.avg_account_lifetime_days, 1) + " d";
  document.getElementById("hdr-withdrawn").textContent = fmtMoney(m.total_withdrawn);
  document.getElementById("data-warning-card").style.display = "none";

  document.getElementById("policy-source").textContent = b.policy_source || "(not embedded)";

  // stats panel
  document.getElementById("stats-body").innerHTML = `
    <div class="stats-grid">
      <div class="k">Total return</div><div class="v">${fmtNum(m.total_return, 3)}x</div>
      <div class="k">Fleet ROI</div><div class="v">${fmtNum(m.fleet_roi, 3)}</div>
      <div class="k">Bank start</div><div class="v">${fmtMoney(m.bank_start)}</div>
      <div class="k">Bank end</div><div class="v">${fmtMoney(m.bank_end)}</div>
      <div class="k">Total withdrawn</div><div class="v">${fmtMoney(m.total_withdrawn)}</div>
      <div class="k">Total deployed</div><div class="v">${fmtMoney(m.total_deployed)}</div>
      <div class="k">Accounts</div><div class="v">${m.total_accounts || 0}</div>
      <div class="k">Blowups</div><div class="v">${m.blowup_count || 0}</div>
      <div class="k">Survival rate</div><div class="v">${fmtNum((m.survival_rate || 0) * 100, 1)}%</div>
      <div class="k">Avg lifetime</div><div class="v">${fmtNum(m.avg_account_lifetime_days, 1)} d</div>
      <div class="k">Wd / day</div><div class="v">${fmtMoney(m.withdrawal_per_day)}</div>
      <div class="k">Commission</div><div class="v">${fmtMoney(m.total_commission)}</div>
      <div class="k">Swap</div><div class="v">${fmtMoney(m.total_swap)}</div>
    </div>`;

  // charts
  clearCharts();
  setupCharts();
  populatePriceChart(b);
  populateBankChart(b);

  // reset detail panel
  document.getElementById("detail-body").innerHTML = `<div class="placeholder">Click a deploy marker on the chart to inspect an account. ${b.accounts.length} accounts loaded.</div>`;
  document.getElementById("close-detail-btn").style.display = "none";
}

// ----- charts -----
function clearCharts() {
  const pc = document.getElementById("price-chart");
  const bc = document.getElementById("bank-chart");
  pc.innerHTML = ""; bc.innerHTML = "";
  state.priceChart = null; state.bankChart = null;
  state.candleSeries = null; state.bankSeries = null;
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
  // Bank chart — toggleable overlays. All step lines (lineType: 1) because
  // every value only changes at discrete events.
  //
  //   bankSeries     (blue)   Bank / checking account. In the current sim this
  //                           is the `bank` variable which includes phantom
  //                           revival money. After the sim is patched to
  //                           savings-separate accounting, this becomes the
  //                           honest trading reserve.
  //   savingsSeries  (teal)   Savings / profit pool. Cumulative withdrawals
  //                           minus revivals. Under the new sim this is a real
  //                           money ledger; currently it's derived from the
  //                           fleet_actual_withdrawn counter. Lives on the
  //                           LEFT price scale because it's typically 5-10x
  //                           larger than bank and would otherwise squash it.
  //   totalSeries    (gold)   Total position = bank + savings (minus phantom
  //                           revivals). The single line that answers "is the
  //                           strategy making money overall?" Default hidden.
  //   capitalLine    (dashed) Starting capital reference on the bank scale.
  // PRIMARY: savings line — the money the trader actually has at any moment.
  // Steps up on withdrawals (profit extracted), steps down on revivals
  // (money put back at risk). This is the line that tells the whole story.
  // Uses the RIGHT price scale so the account-outcome markers align.
  state.savingsSeries = state.bankChart.addLineSeries({
    color: COLORS.teal, lineWidth: 2,
    lineType: 1,
    title: "Savings",
  });
  // SECONDARY (default hidden): total = bank + savings. Shows the "honest
  // multiplier" value at any checkpoint. Useful for end-of-fold interpretation
  // but redundant during the run since bank ≈ 0 most of the time.
  state.totalSeries = state.bankChart.addLineSeries({
    color: COLORS.gold, lineWidth: 2,
    lineType: 1,
    title: "Total (bank+savings)",
    visible: false,
  });
  // DEBUGGING (default hidden): bank = trading reserve. Oscillates between
  // $0 and ~$5000. Not informative at strategy-assessment zoom.
  state.bankSeries = state.bankChart.addLineSeries({
    color: COLORS.blue, lineWidth: 1,
    lineType: 1,
    lineStyle: 2, // dashed
    title: "Bank",
    visible: false,
  });
  state.capitalLine = state.bankChart.addLineSeries({
    color: COLORS.gray, lineWidth: 1, lineStyle: 2, // dashed
    title: "Starting capital",
  });
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
  // Markers go on savingsSeries (the primary visible line), not bankSeries
  // (which is hidden by default). This ensures account outcomes and revival
  // arrows are always visible on the main savings curve.
  if (state.fullBankMarkers && state.savingsSeries) {
    const revivalsOn = state._revivalMarkersVisible !== false;
    let vbank = state.fullBankMarkers.filter(m => m.time >= from && m.time <= to);
    if (!revivalsOn) vbank = vbank.filter(m => m._kind !== "revival");
    const cbank = cullBankMarkers(vbank, 80);
    state.savingsSeries.setMarkers(cbank.map(stripInternal));
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
  // Shared transform: convert {time, <valueKey>} to {time, value}, clamp times
  // before the first candle, sort, and dedupe same-time points.
  function prep(series, key) {
    const list = (series || []).map(p => ({
      time: toUnix(p.time),
      value: p[key],
    })).filter(p => p.time != null && p.value != null).map(p => {
      if (firstCandle != null && p.time < firstCandle) p.time = firstCandle;
      return p;
    }).sort((a, b) => a.time - b.time);
    const out = [];
    let last = null;
    for (const p of list) {
      if (p.time === last) out[out.length - 1] = p;
      else out.push(p);
      last = p.time;
    }
    return out;
  }

  const deduped     = prep(b.bank_curve,    "bank");
  const totalData   = prep(b.total_curve,   "total");
  const savingsData = prep(b.savings_curve, "savings");
  state.bankSeries.setData(deduped);
  if (state.totalSeries) state.totalSeries.setData(totalData);
  if (state.savingsSeries) state.savingsSeries.setData(savingsData);

  // Account-number markers on the bank curve. One marker per account, placed
  // at its blowup_time (the moment the bank settles to `bank_after` because
  // of this account's outcome). Colored by outcome so the user can scan the
  // curve and immediately see which accounts drove each segment.
  // Uses the same outcome->color mapping as the price chart deploy arrows.
  const bankMarkers = [];
  for (const a of b.accounts) {
    const t = toUnix(a.blowup_time) || toUnix(a.deploy_time);
    if (t == null) continue;
    const color = (a.outcome === "survived" || a.outcome === "blowup_profit") ? COLORS.green
                : a.outcome === "total_loss" ? COLORS.gray
                : COLORS.red;
    bankMarkers.push({
      time: t,
      position: "aboveBar",
      color,
      shape: "circle",
      text: `#${a.num}`,
      _kind: "account",
    });
  }
  // Revival event markers: moments when the sim re-injected $starting_capital
  // into the bank from the accumulated withdrawal pool. Tagged with _kind so
  // the toggle-revivals checkbox can filter them out.
  for (const ev of (b.revival_events || [])) {
    bankMarkers.push({
      time: ev.time,
      position: "belowBar",
      color: COLORS.teal,
      shape: "arrowUp",
      text: `+$${Math.round(ev.amount/1000)}k`,
      _kind: "revival",
    });
  }
  bankMarkers.sort((x, y) => x.time - y.time);
  // Store the full bank marker set for LOD culling; apply initial cull,
  // stripping internal fields and respecting the revivals-visibility toggle.
  state.fullBankMarkers = bankMarkers;
  const revivalsOn = state._revivalMarkersVisible !== false;
  const initialBank = revivalsOn ? bankMarkers : bankMarkers.filter(m => m._kind !== "revival");
  state.savingsSeries.setMarkers(cullBankMarkers(initialBank, 80).map(stripInternal));

  // Starting-capital reference line. Extended to span the full price-chart
  // time range (first candle -> last candle) so that when the price chart is
  // panned to a time where no bank-curve points exist, the bank chart still
  // has data at that time and can follow the sync without clamping.
  const candles = b.candles_m15 || [];
  const rangeStart = candles.length ? candles[0].t : (deduped[0]?.time);
  const rangeEnd   = candles.length ? candles[candles.length - 1].t : (deduped[deduped.length - 1]?.time);
  if (rangeStart != null && rangeEnd != null && rangeStart < rangeEnd) {
    const cap = b.starting_capital || 5000;
    state.capitalLine.setData([
      { time: rangeStart, value: cap },
      { time: rangeEnd,   value: cap },
    ]);
  }
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
  if (state.traceBalanceSeries) {
    state.bankChart.removeSeries(state.traceBalanceSeries);
    state.traceBalanceSeries = null;
  }
  // Remove any legacy position line series from the price chart.
  for (const s of (state.tracePositionLines || [])) {
    try { state.priceChart.removeSeries(s); } catch (e) {}
  }
  state.tracePositionLines = [];
  // Clear markers from candle series
  if (state._traceMarkersActive && state.candleSeries) {
    state.candleSeries.setMarkers([]);
    state._traceMarkersActive = false;
  }
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

  // =====================================================================
  // PRICE-LEVEL TRACE — horizontal ticks at exact entry prices.
  //
  // Uses 4 line series total (buy entries, sell entries, TP closes, WAPP),
  // not one per entry. Each tick is a 30-min horizontal segment at the
  // exact fill price, showing the grid structure visually.
  //
  // Close-time lookup: each entry's tick extends from fill time to the
  // next basket close (TP) or blowup — showing the position's lifetime.
  // =====================================================================

  const entries = trace.grid_entry_events || [];
  const blowupT = toUnix(a.blowup_time);
  const accountEnd = blowupT || (toUnix(a.deploy_time) + 86400);
  state.tracePositionLines = [];

  // Build line data: each entry → a 2-bar horizontal tick at exact price
  const buyData = [];
  const sellData = [];

  for (const e of entries) {
    const t = Math.floor(e.time_unix / 900) * 900;
    const dir = (e.dir || "").toLowerCase();
    const arr = dir === "buy" ? buyData : sellData;
    // 2-bar tick + NaN gap
    arr.push({ time: t, value: e.price });
    arr.push({ time: t + 900, value: e.price });
    arr.push({ time: t + 901, value: NaN });
  }

  // Sort by time (required)
  buyData.sort((a, b) => a.time - b.time);
  sellData.sort((a, b) => a.time - b.time);

  // Deduplicate timestamps (LightweightCharts requires strictly increasing times)
  function dedupTime(arr) {
    const out = [];
    let lastT = -1;
    for (const p of arr) {
      if (p.time <= lastT) p.time = lastT + 1;
      out.push(p);
      lastT = p.time;
    }
    return out;
  }

  if (buyData.length > 0) {
    const s = state.priceChart.addLineSeries({
      color: COLORS.green, lineWidth: 2, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(dedupTime(buyData));
    state.tracePositionLines.push(s);
  }

  if (sellData.length > 0) {
    const s = state.priceChart.addLineSeries({
      color: COLORS.red, lineWidth: 2, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(dedupTime(sellData));
    state.tracePositionLines.push(s);
  }

  // TP close + withdrawal + blowup as markers (these are events, not positions)
  const markers = [];

  for (const ev of (a.basket_close_events || [])) {
    const t = toUnix(ev.time);
    if (!t) continue;
    const t15 = Math.floor(t / 900) * 900;
    markers.push({
      time: t15, position: "aboveBar", color: COLORS.cyan,
      shape: "circle", text: "", size: 0,
    });
  }

  for (const ev of (trace.withdrawal_events || [])) {
    const t15 = Math.floor(ev.time_unix / 900) * 900;
    markers.push({
      time: t15, position: "aboveBar", color: COLORS.gold,
      shape: "circle", text: `$${Math.round(ev.amount)}`, size: 0,
    });
  }

  if (a.blowup && blowupT) {
    const t15 = Math.floor(blowupT / 900) * 900;
    markers.push({
      time: t15, position: "aboveBar", color: COLORS.red,
      shape: "square", text: "BLOWUP", size: 1,
    });
  }

  markers.sort((a, b) => a.time - b.time);
  state.traceEntryMarkers = markers;
  applyMarkersForVisibleRange();

  // Equity + balance curves on the bank chart (only 2 series)
  const eqSnaps = trace.equity_snapshots || [];
  if (eqSnaps.length > 0) {
    state.traceEquitySeries = state.bankChart.addLineSeries({
      color: "#f0883e",
      lineWidth: 2,
      lineType: 0,
      title: `Equity #${a.num}`,
    });
    state.traceBalanceSeries = state.bankChart.addLineSeries({
      color: "#58a6ff",
      lineWidth: 1,
      lineType: 1,
      lineStyle: 2,
      title: `Balance #${a.num}`,
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
    state.traceBalanceSeries.setData(dedup(eqSnaps, "bal"));
  }
}

// ----- account detail -----
function showAccountDetail(a) {
  const deployT = toUnix(a.deploy_time);
  const blowT = toUnix(a.blowup_time);
  const events = [];
  events.push({ t: deployT, kind: "DEPLOY", cls: "deploy", desc: `stake $${a.stake} · bank $${fmtNum(a.deploy_bank_balance, 0)} · v20m ${fmtNum(a.deploy_v20m, 1)} · v24h ${fmtNum(a.deploy_v24h, 1)}` });
  for (const ev of (a.recovery_events || [])) {
    events.push({
      t: toUnix(ev.time), kind: ev.action || "RECOVERY", cls: "recovery",
      desc: `dd ${ev.drawdown_pips}p · depth ${ev.basket_depth} · lots ${fmtNum(ev.basket_lots, 2)} · wapp ${fmtNum(ev.basket_wapp, 5)} · eq ${fmtMoney(ev.account_equity)}`,
    });
  }
  for (const ev of (a.basket_close_events || [])) {
    events.push({
      t: toUnix(ev.time), kind: ev.close_type || "CLOSE",
      cls: "close " + ((ev.close_type || "").toLowerCase()),
      desc: `${ev.closed_basket || ""} · other_depth ${ev.other_basket_depth || 0} · bal ${fmtMoney(ev.balance)}`,
    });
  }
  if (a.blowup) events.push({ t: blowT, kind: "BLOWUP", cls: "blowup", desc: `lifetime ${fmtNum(a.lifetime_days, 1)}d · net ${fmtMoney(a.net)}` });
  // sort timeline by time
  events.sort((a, b) => (a.t || 0) - (b.t || 0));

  document.getElementById("close-detail-btn").style.display = "";
  document.getElementById("detail-body").innerHTML = `
    <div class="detail-header">
      <div class="title">Account #${a.num}</div>
      <div class="outcome ${a.outcome}">${a.outcome.replace("_", " ")}</div>
    </div>
    <div class="detail-meta">
      <div class="k">Deploy</div><div class="v">${fmtUnix(a.deploy_time)}</div>
      <div class="k">End</div><div class="v">${fmtUnix(a.blowup_time)}</div>
      <div class="k">Stake</div><div class="v">${fmtMoney(a.stake)}</div>
      <div class="k">Withdrawn</div><div class="v">${fmtMoney(a.withdrawn)}</div>
      <div class="k">Net</div><div class="v ${a.net >= 0 ? "green" : "red"}">${fmtMoney(a.net)}</div>
      <div class="k">Lifetime</div><div class="v">${fmtNum(a.lifetime_days, 1)}d</div>
      <div class="k">v20m @deploy</div><div class="v">${fmtNum(a.deploy_v20m, 1)}</div>
      <div class="k">v24h @deploy</div><div class="v">${fmtNum(a.deploy_v24h, 1)}</div>
      <div class="k">Hour @deploy</div><div class="v">${a.deploy_hour ?? "—"}</div>
      <div class="k">Alpha @deploy</div><div class="v">${fmtNum(a.deploy_account_alpha, 3)}</div>
      <div class="k">Bank @deploy</div><div class="v">${fmtMoney(a.deploy_bank_balance)}</div>
      <div class="k">Bank after</div><div class="v">${fmtMoney(a.bank_after)}</div>
    </div>
    <div class="detail-timeline" id="detail-timeline"></div>
    <div class="detail-actions">
      <button id="zoom-to-acct-btn">Zoom to account lifetime</button>
      ${a.trace ? '<button id="hide-trades-btn">Hide trades</button>' : '<span class="muted" style="font-size:11px;">No trace data (run with --trace)</span>'}
      <button id="next-acct-btn">Next account &rarr;</button>
      <button id="prev-acct-btn">&larr; Prev account</button>
    </div>
  `;
  const tl = document.getElementById("detail-timeline");
  tl.innerHTML = events.map(ev => `
    <div class="timeline-row ${ev.cls}">
      <div class="time">${fmtUnix(ev.t)}</div>
      <div class="kind">${ev.kind}</div>
      <div class="desc">${ev.desc}</div>
    </div>
  `).join("");

  document.getElementById("zoom-to-acct-btn").onclick = () => zoomToAccount(a);
  // Auto-show trades immediately when clicking an account.
  if (a.trace) {
    showTraceOverlay(a);
    zoomToAccount(a);
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
  document.getElementById("next-acct-btn").onclick = () => navigateAccount(a.num, 1);
  document.getElementById("prev-acct-btn").onclick = () => navigateAccount(a.num, -1);
}

function zoomToAccount(a) {
  const from = toUnix(a.deploy_time);
  const to = toUnix(a.blowup_time) || from + 86400;
  if (!from || !to) return;
  // pad by 10% on each side
  const pad = Math.max(3600, (to - from) * 0.15);
  state.priceChart.timeScale().setVisibleRange({ from: from - pad, to: to + pad });
}

function navigateAccount(currentNum, dir) {
  if (!state.currentBundle) return;
  clearTraceOverlay();
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
  document.getElementById("detail-body").innerHTML =
    `<div class="placeholder">Click a deploy marker on the chart to inspect an account. ${state.currentBundle.accounts.length} accounts loaded.</div>`;
  document.getElementById("close-detail-btn").style.display = "none";
}

// ----- bank chart toggles -----
// Track revival visibility separately because it's a marker set, not a series.
function applyBankToggleVisibility() {
  if (!state.bankChart) return;
  const get = id => document.getElementById(id);
  const bankOn     = get("toggle-bank")?.checked     ?? true;
  const savingsOn  = get("toggle-savings")?.checked  ?? true;
  const totalOn    = get("toggle-total")?.checked    ?? false;
  const startingOn = get("toggle-starting")?.checked ?? true;
  const revivalsOn = get("toggle-revivals")?.checked ?? true;
  try {
    if (state.bankSeries)    state.bankSeries.applyOptions({ visible: bankOn });
    if (state.savingsSeries) state.savingsSeries.applyOptions({ visible: savingsOn });
    if (state.totalSeries)   state.totalSeries.applyOptions({ visible: totalOn });
    if (state.capitalLine)   state.capitalLine.applyOptions({ visible: startingOn });
  } catch (e) { /* chart not ready */ }
  // Revivals are markers; re-apply the marker set with/without them.
  state._revivalMarkersVisible = revivalsOn;
  applyMarkersForVisibleRange();
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
  // Bank chart toggle checkboxes
  for (const id of ["toggle-bank","toggle-savings","toggle-total","toggle-revivals","toggle-starting"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", applyBankToggleVisibility);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  loadManifest().catch(err => {
    setStatus("error: " + err.message);
    console.error(err);
  });
});
