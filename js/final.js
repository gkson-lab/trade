/* Final training mode: the trading bot for real price data.
 *
 *   input   daily OHLCV CSVs (one file per symbol like a Yahoo Finance download, or one file with a symbol column)
 *   train   features from prices and volume only, computed with data up to each day's close (no look-ahead);
 *           labels = return from the NEXT day's open to the close H trading days later;
 *           gradient-boosted trees (or logistic regression) for P(up), P(up more than X%), P(down more than X%),
 *           and a regression tree model for the expected return
 *   test    walk-forward: train on the oldest dates, tune on the next slice, score on the newest dates it never saw;
 *           calibration, decile spread, daily rank correlation, and a backtest with costs and stop/target rules
 *   output  for every symbol's latest day: probabilities, expected return, the historical range of outcomes for
 *           similar predictions, expected P/L in dollars, and a Buy / Hold / Avoid / Short signal
 *
 * Works in the browser and in Node (tools/final_train.js). Nothing here places orders. */
(function (T) {
  "use strict";

  var VERSION = 1;
  var LOOKBACK = 60;

  /* ---------------- input ---------------- */

  function parseCSV(text) {
    var rows = [], row = [], cell = "", q = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function normDate(s) {
    s = String(s).trim();
    var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) return m[3] + "-" + pad(m[1]) + "-" + pad(m[2]);
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return m[1] + "-" + m[2] + "-" + m[3];
    if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s))) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
    return null;
  }
  function pad(x) { return x.length === 1 ? "0" + x : x; }
  function num(s) { if (s === undefined || s === null) return NaN; var v = parseFloat(String(s).replace(/[$,\s]/g, "")); return isFinite(v) ? v : NaN; }

  /* files: [{name, text}] -> dataset {symbols: {SYM: {date[], open[], high[], low[], close[], volume[]}}, warnings[]} */
  function loadPrices(files) {
    var bySym = {}, warnings = [], used = 0;
    files.forEach(function (f) {
      var rows = parseCSV(f.text);
      if (rows.length < 2) { warnings.push(f.name + ": no data rows."); return; }
      var head = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""); });
      var col = function (names) { for (var k = 0; k < names.length; k++) { var j = head.indexOf(names[k]); if (j >= 0) return j; } return -1; };
      var cDate = col(["date", "datetime", "timestamp", "time", "day"]), cSym = col(["symbol", "ticker", "code", "name", "instrument"]);
      var cOpen = col(["open"]), cHigh = col(["high"]), cLow = col(["low"]), cClose = col(["close", "last", "price"]), cAdj = col(["adjclose", "adjustedclose"]);
      var cVol = col(["volume", "vol"]);
      if (cDate < 0 || (cClose < 0 && cAdj < 0)) { warnings.push(f.name + ": needs a date column and a close column; found " + rows[0].join(", ") + "."); return; }
      var fileSym = f.name.replace(/^.*[\\/]/, "").replace(/\.(csv|txt)$/i, "").replace(/[^A-Za-z0-9.^-]/g, "").toUpperCase() || "DATA";
      var bad = 0;
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r], d = normDate(row[cDate] || "");
        var close = num(row[cClose >= 0 ? cClose : cAdj]);
        if (!d || !(close > 0)) { bad++; continue; }
        var adj = cAdj >= 0 ? num(row[cAdj]) : NaN, k = adj > 0 && cClose >= 0 ? adj / close : 1;   // use adjusted prices when given
        var sym = cSym >= 0 ? String(row[cSym]).trim().toUpperCase() : fileSym;
        if (!sym) { bad++; continue; }
        var o = num(row[cOpen]), h = num(row[cHigh]), l = num(row[cLow]), v = num(row[cVol]);
        var s = bySym[sym] || (bySym[sym] = {});
        s[d] = [(o > 0 ? o : close) * k, (h > 0 ? h : close) * k, (l > 0 ? l : close) * k, close * k, v >= 0 ? v : NaN];
        used++;
      }
      if (bad) warnings.push(f.name + ": skipped " + bad + " row" + (bad > 1 ? "s" : "") + " without a readable date or a positive close.");
    });
    var symbols = {};
    Object.keys(bySym).sort().forEach(function (sym) {
      var m = bySym[sym], dates = Object.keys(m).sort();
      var s = { date: dates, open: [], high: [], low: [], close: [], volume: [] };
      dates.forEach(function (d) { var x = m[d]; s.open.push(x[0]); s.high.push(Math.max(x[0], x[1], x[3])); s.low.push(Math.min(x[0], x[2], x[3])); s.close.push(x[3]); s.volume.push(x[4]); });
      if (dates.length < LOOKBACK + 25) { warnings.push(sym + ": only " + dates.length + " days; at least " + (LOOKBACK + 25) + " are needed, so it was left out."); return; }
      var jumps = 0;
      for (var i = 1; i < dates.length; i++) if (Math.abs(Math.log(s.close[i] / s.close[i - 1])) > 0.7) jumps++;
      if (jumps) warnings.push(sym + ": " + jumps + " one-day move" + (jumps > 1 ? "s" : "") + " over 50%. If these are unadjusted stock splits, use adjusted prices.");
      symbols[sym] = s;
    });
    var all = Object.keys(symbols), first = "9999", last = "0000", rows = 0;
    all.forEach(function (k) { var s = symbols[k]; rows += s.date.length; if (s.date[0] < first) first = s.date[0]; if (s.date[s.date.length - 1] > last) last = s.date[s.date.length - 1]; });
    return { symbols: symbols, list: all, rows: rows, first: all.length ? first : "", last: all.length ? last : "", warnings: warnings, parsedRows: used };
  }

  /* Sample data from the simulator, in the same CSV layout, so the mode can be tried without real files. */
  function simulatedCSV(opts) {
    opts = opts || {};
    var m = new T.Market({ seed: opts.seed || 777, maxSymbols: opts.symbols || 40 }), days = opts.days || 600, n = m.n, out = ["date,symbol,open,high,low,close,volume"];
    for (var d = 0; d < days; d++) {
      for (var b = 0; b < m.BARS_PER_DAY; b++) m.step();
      var date = m.dateStr(d), q = (m.dayIdx - 1) % m.DAILY;
      for (var i = 0; i < n; i++) {
        var k = i * m.DAILY + q;
        out.push(date + "," + m.sym[i] + "," + r4(m.dO[k]) + "," + r4(m.dH[k]) + "," + r4(m.dL[k]) + "," + r4(m.dC[k]) + "," + Math.round(m.dV[k]));
      }
    }
    return out.join("\n") + "\n";
  }

  /* ---------------- features ---------------- */

  var FEATURES = [
    ["ret1", "1-day return"], ["ret5", "5-day return"], ["ret20", "20-day return"], ["ret60", "60-day return"],
    ["vol20", "20-day volatility (annualized)"], ["z20", "Distance from 20-day average (std devs)"], ["ma50", "Distance from 50-day average"],
    ["rsi14", "RSI 14"], ["atr14", "ATR 14 as % of price"], ["volSurge", "Volume vs 20-day average (log)"], ["gap", "Opening gap"],
    ["range", "Day's high-low range"], ["closeLoc", "Where the close sits in the day's range"], ["rangePos", "Position in the 1-year range"],
    ["drawdown", "Drop from the 1-year high"], ["mkt1", "Market 1-day return"], ["mkt5", "Market 5-day return"], ["mkt20", "Market 20-day return"],
    ["mktVol20", "Market 20-day volatility"], ["beta60", "60-day beta to the market"], ["rs20", "20-day return vs market"],
    ["rank5", "Rank of 5-day return across symbols"], ["rank20", "Rank of 20-day return across symbols"], ["rank60", "Rank of 60-day return across symbols"],
    ["rankVol", "Rank of volatility across symbols"], ["dow", "Day of week"]
  ];
  var FKEYS = FEATURES.map(function (f) { return f[0]; });
  var NF = FKEYS.length;

  /* Market proxy: the benchmark symbol if given, else the equal-weight average daily return of all symbols. */
  function marketSeries(ds, bench) {
    var map = {};
    if (bench && ds.symbols[bench]) {
      var b = ds.symbols[bench];
      for (var i = 1; i < b.date.length; i++) map[b.date[i]] = b.close[i] / b.close[i - 1] - 1;
    } else {
      var sum = {}, cnt = {};
      ds.list.forEach(function (k) {
        var s = ds.symbols[k];
        for (var i = 1; i < s.date.length; i++) { var r = s.close[i] / s.close[i - 1] - 1; if (Math.abs(r) < 0.5) { sum[s.date[i]] = (sum[s.date[i]] || 0) + r; cnt[s.date[i]] = (cnt[s.date[i]] || 0) + 1; } }
      });
      for (var d in sum) map[d] = sum[d] / cnt[d];
    }
    var dates = Object.keys(map).sort(), level = 1, lv = {}, ret = {};
    dates.forEach(function (d) { level *= 1 + map[d]; lv[d] = level; ret[d] = map[d]; });
    return { dates: dates, level: lv, ret: ret, name: bench && ds.symbols[bench] ? bench : "equal-weight average of your symbols" };
  }

  /* Build the feature matrix. One row per symbol-day with enough history. Labels need H future days. */
  function buildFeatures(ds, cfg) {
    var H = cfg.horizon, th = cfg.threshold / 100, mkt = marketSeries(ds, cfg.benchmark);
    var mIdx = {}; mkt.dates.forEach(function (d, k) { mIdx[d] = k; });
    var mLevel = mkt.dates.map(function (d) { return mkt.level[d]; }), mRet = mkt.dates.map(function (d) { return mkt.ret[d]; });
    var rows = [], symList = ds.list.filter(function (s) { return !cfg.excludeBenchmark || s !== cfg.benchmark; });
    symList.forEach(function (sym, si) {
      var s = ds.symbols[sym], n = s.date.length, c = s.close, o = s.open, h = s.high, l = s.low, v = s.volume;
      var lr = new Float64Array(n); for (var i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1]);
      var gain = 0, loss = 0, atr = 0;
      for (i = 1; i < n; i++) {
        var ch = c[i] - c[i - 1];
        if (i <= 14) { gain += Math.max(ch, 0) / 14; loss += Math.max(-ch, 0) / 14; }
        else { gain = (gain * 13 + Math.max(ch, 0)) / 14; loss = (loss * 13 + Math.max(-ch, 0)) / 14; }
        var tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) / c[i];
        atr = i <= 14 ? atr + tr / 14 : atr * 13 / 14 + tr / 14;
        if (i < LOOKBACK) continue;
        var mk = mIdx[s.date[i]];
        if (mk === undefined || mk < 20) continue;
        var x = new Float32Array(NF);
        var mean20 = 0, sd20 = 0, k;
        for (k = 0; k < 20; k++) mean20 += c[i - k]; mean20 /= 20;
        for (k = 0; k < 20; k++) sd20 += (c[i - k] - mean20) * (c[i - k] - mean20); sd20 = Math.sqrt(sd20 / 20);
        var ma50 = 0; for (k = 0; k < 50; k++) ma50 += c[i - k]; ma50 /= 50;
        var lrm = 0, lrv = 0; for (k = 0; k < 20; k++) lrm += lr[i - k]; lrm /= 20; for (k = 0; k < 20; k++) lrv += (lr[i - k] - lrm) * (lr[i - k] - lrm);
        var vavg = 0, vn = 0; for (k = 1; k <= 20; k++) if (v[i - k] >= 0) { vavg += v[i - k]; vn++; }
        var lo = Infinity, hi = 0; for (k = Math.max(0, i - 251); k <= i; k++) { if (l[k] < lo) lo = l[k]; if (h[k] > hi) hi = h[k]; }
        var maxC = 0; for (k = Math.max(0, i - 251); k <= i; k++) if (c[k] > maxC) maxC = c[k];
        // beta over 60 days against the market proxy
        var sx = 0, sy = 0, sxx = 0, sxy = 0, nb = 0;
        for (k = 0; k < 60; k++) {
          var mj = mIdx[s.date[i - k]]; if (mj === undefined) continue;
          var xr = mRet[mj], yr = c[i - k] / c[i - k - 1] - 1; sx += xr; sy += yr; sxx += xr * xr; sxy += xr * yr; nb++;
        }
        var beta = nb > 20 && (sxx - sx * sx / nb) > 0 ? (sxy - sx * sy / nb) / (sxx - sx * sx / nb) : 1;
        var mv = 0, mm = 0; for (k = 0; k < 20; k++) mm += mRet[mk - k]; mm /= 20; for (k = 0; k < 20; k++) mv += (mRet[mk - k] - mm) * (mRet[mk - k] - mm);
        x[0] = c[i] / c[i - 1] - 1; x[1] = c[i] / c[i - 5] - 1; x[2] = c[i] / c[i - 20] - 1; x[3] = c[i] / c[i - 60] - 1;
        x[4] = Math.sqrt(lrv / 19 * 252); x[5] = sd20 > 0 ? (c[i] - mean20) / sd20 : 0; x[6] = c[i] / ma50 - 1;
        x[7] = loss > 0 ? 100 - 100 / (1 + gain / loss) : 100; x[8] = atr; x[9] = vn && vavg > 0 && v[i] >= 0 ? Math.log((v[i] + 1) / (vavg / vn + 1)) : 0;
        x[10] = o[i] / c[i - 1] - 1; x[11] = (h[i] - l[i]) / c[i]; x[12] = h[i] > l[i] ? (c[i] - l[i]) / (h[i] - l[i]) : 0.5;
        x[13] = hi > lo ? (c[i] - lo) / (hi - lo) : 0.5; x[14] = c[i] / maxC - 1;
        x[15] = mRet[mk]; x[16] = mLevel[mk] / mLevel[mk - 5] - 1; x[17] = mLevel[mk] / mLevel[mk - 20] - 1; x[18] = Math.sqrt(mv / 19 * 252);
        x[19] = beta; x[20] = x[2] - x[17];
        x[25] = new Date(s.date[i] + "T00:00:00Z").getUTCDay();
        var y = NaN;
        if (i + H < n) y = c[i + H] / o[i + 1] - 1;      // enter at the next open, exit at the close H days later
        rows.push({ sym: si, symbol: sym, i: i, date: s.date[i], x: x, y: y });
      }
    });
    // cross-sectional ranks per date (0 = lowest, 1 = highest)
    var byDate = {};
    rows.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
    Object.keys(byDate).forEach(function (d) {
      var g = byDate[d];
      [[1, 21], [2, 22], [3, 23], [4, 24]].forEach(function (p) {
        var srt = g.slice().sort(function (a, b) { return a.x[p[0]] - b.x[p[0]]; });
        srt.forEach(function (r, k) { r.x[p[1]] = g.length > 1 ? k / (g.length - 1) : 0.5; });
      });
    });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.sym - b.sym; });
    var dates = Object.keys(byDate).sort();
    rows.forEach(function (r) { r.labels = isFinite(r.y) ? [r.y > 0 ? 1 : 0, r.y > th ? 1 : 0, r.y < -th ? 1 : 0] : null; });
    return { rows: rows, dates: dates, symbols: symList, market: mkt, horizon: H, threshold: th };
  }

  /* ---------------- models ---------------- */

  function sigmoid(z) { return z > 30 ? 1 : z < -30 ? 0 : 1 / (1 + Math.exp(-z)); }

  function binEdges(rows, nb) {
    var edges = [], sample = rows.length > 50000 ? rows.filter(function (_, k) { return k % Math.ceil(rows.length / 50000) === 0; }) : rows;
    for (var f = 0; f < NF; f++) {
      var vals = sample.map(function (r) { return r.x[f]; }).filter(isFinite).sort(function (a, b) { return a - b; }), e = [];
      for (var q = 1; q < nb; q++) { var v = vals[Math.floor(q * vals.length / nb)]; if (v !== undefined && (e.length === 0 || v > e[e.length - 1])) e.push(v); }
      edges.push(e);
    }
    return edges;
  }
  function binOf(edges, v) { var lo = 0, hi = edges.length; if (!isFinite(v)) return 0; while (lo < hi) { var mid = (lo + hi) >> 1; if (v > edges[mid]) lo = mid + 1; else hi = mid; } return lo; }
  function binRows(rows, edges) { return rows.map(function (r) { var b = new Uint8Array(NF); for (var f = 0; f < NF; f++) b[f] = binOf(edges[f], r.x[f]); return b; }); }

  /* Histogram gradient boosting. loss: "logloss" (target 0/1) or "l2" (target real). Returns {trees, base, importance}. */
  function trainGBM(Xb, y, vXb, vy, opt, progress) {
    var n = Xb.length, depth = opt.depth || 3, lr = opt.lr || 0.08, nTrees = opt.trees || 200, minLeaf = opt.minLeaf || 40, lambda = 1;
    var loss = opt.loss || "logloss", NB = 33, rng = new T.RNG(opt.seed || 1);
    var mean = 0; for (var i = 0; i < n; i++) mean += y[i]; mean /= Math.max(n, 1);
    var base = loss === "logloss" ? Math.log(Math.max(1e-4, mean) / Math.max(1e-4, 1 - mean)) : mean;
    var F = new Float64Array(n).fill(base), vF = new Float64Array(vXb.length).fill(base);
    var trees = [], imp = new Float64Array(NF), best = -Infinity, bestN = 0, patience = opt.patience || 40, minTrees = opt.minTrees || 30;
    var g = new Float64Array(n), h = new Float64Array(n);
    // tuning score: ranking quality on the tuning dates (AUC for yes/no targets, rank correlation for returns).
    // Market data has a weak signal, so log-loss would stop after a handful of trees; ranking is what the bot trades on.
    var vArr = Array.prototype.slice.call(vy);
    function vscore() { var pv = Array.prototype.slice.call(vF); return loss === "logloss" ? auc(pv, vArr) : spearman(pv, vArr); }
    for (var t = 0; t < nTrees; t++) {
      for (i = 0; i < n; i++) {
        if (loss === "logloss") { var p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = Math.max(p * (1 - p), 1e-6); }
        else { g[i] = F[i] - y[i]; h[i] = 1; }
      }
      var idx = []; for (i = 0; i < n; i++) if (rng.next() < 0.8) idx.push(i);
      var nodes = [];
      (function grow(rowsIdx, d) {
        var G = 0, Hs = 0, k;
        for (k = 0; k < rowsIdx.length; k++) { G += g[rowsIdx[k]]; Hs += h[rowsIdx[k]]; }
        var me = nodes.length; nodes.push(null);
        var leafVal = -G / (Hs + lambda) * lr;
        if (d >= depth || rowsIdx.length < 2 * minLeaf) { nodes[me] = { v: leafVal }; return me; }
        var bestGain = 0, bf = -1, bb = -1, parent = G * G / (Hs + lambda);
        var hg = new Float64Array(NB), hh = new Float64Array(NB), hc = new Int32Array(NB);
        for (var f = 0; f < NF; f++) {
          hg.fill(0); hh.fill(0); hc.fill(0);
          for (k = 0; k < rowsIdx.length; k++) { var r = rowsIdx[k], b = Xb[r][f]; hg[b] += g[r]; hh[b] += h[r]; hc[b]++; }
          var GL = 0, HL = 0, CL = 0;
          for (var bin = 0; bin < NB - 1; bin++) {
            GL += hg[bin]; HL += hh[bin]; CL += hc[bin];
            var CR = rowsIdx.length - CL; if (CL < minLeaf || CR < minLeaf) continue;
            var GR = G - GL, HR = Hs - HL;
            var gain = GL * GL / (HL + lambda) + GR * GR / (HR + lambda) - parent;
            if (gain > bestGain) { bestGain = gain; bf = f; bb = bin; }
          }
        }
        if (bf < 0) { nodes[me] = { v: leafVal }; return me; }
        imp[bf] += bestGain;
        var L = [], R = [];
        for (k = 0; k < rowsIdx.length; k++) (Xb[rowsIdx[k]][bf] <= bb ? L : R).push(rowsIdx[k]);
        var node = { f: bf, b: bb, l: 0, r: 0 }; nodes[me] = node;
        node.l = grow(L, d + 1); node.r = grow(R, d + 1);
        return me;
      })(idx, 0);
      trees.push(nodes);
      for (i = 0; i < n; i++) F[i] += treeValue(nodes, Xb[i]);
      for (i = 0; i < vXb.length; i++) vF[i] += treeValue(nodes, vXb[i]);
      if (progress) progress(t + 1, nTrees);
      if (!vXb.length || ((t + 1) % 5 && t + 1 !== nTrees)) continue;
      var sc = vscore();
      if (sc > best + 1e-5) { best = sc; bestN = t + 1; }
      if (t + 1 >= minTrees && t + 1 - bestN >= patience) break;
    }
    if (vXb.length && bestN) trees = trees.slice(0, Math.max(bestN, minTrees));
    return { kind: "gbm", loss: loss, base: base, trees: trees, importance: Array.prototype.slice.call(imp) };
  }
  function treeValue(nodes, xb) { var k = 0; for (;;) { var nd = nodes[k]; if (nd.v !== undefined) return nd.v; k = xb[nd.f] <= nd.b ? nd.l : nd.r; } }
  function scoreGBM(m, xb) { var s = m.base; for (var t = 0; t < m.trees.length; t++) s += treeValue(m.trees[t], xb); return m.loss === "logloss" ? sigmoid(s) : s; }

  /* L2-regularized logistic regression on standardized features (the simple model). */
  function trainLogistic(rows, y, opt) {
    var n = rows.length, mu = new Float64Array(NF), sd = new Float64Array(NF), f, i;
    for (i = 0; i < n; i++) for (f = 0; f < NF; f++) mu[f] += rows[i].x[f] / n;
    for (i = 0; i < n; i++) for (f = 0; f < NF; f++) sd[f] += Math.pow(rows[i].x[f] - mu[f], 2) / n;
    for (f = 0; f < NF; f++) sd[f] = Math.sqrt(sd[f]) || 1;
    var w = new Float64Array(NF), b = 0, lr = 0.05, l2 = 1e-3, rng = new T.RNG(3);
    var order = []; for (i = 0; i < n; i++) order.push(i);
    for (var ep = 0; ep < (opt.epochs || 8); ep++) {
      for (i = n - 1; i > 0; i--) { var j = Math.floor(rng.next() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
      for (var k = 0; k < n; k++) {
        var r = rows[order[k]], z = b;
        for (f = 0; f < NF; f++) z += w[f] * clip((r.x[f] - mu[f]) / sd[f]);
        var gr = sigmoid(z) - y[order[k]];
        for (f = 0; f < NF; f++) w[f] -= lr * (gr * clip((r.x[f] - mu[f]) / sd[f]) + l2 * w[f]);
        b -= lr * gr;
      }
      lr *= 0.7;
    }
    return { kind: "logistic", mu: Array.from(mu), sd: Array.from(sd), w: Array.from(w), b: b, importance: Array.from(w).map(Math.abs) };
  }
  function clip(z) { return z > 5 ? 5 : z < -5 ? -5 : (isFinite(z) ? z : 0); }
  function scoreLogistic(m, x) { var z = m.b; for (var f = 0; f < NF; f++) z += m.w[f] * clip((x[f] - m.mu[f]) / m.sd[f]); return sigmoid(z); }

  /* ---------------- evaluation ---------------- */

  function auc(p, y) {
    var idx = p.map(function (_, k) { return k; }).sort(function (a, b) { return p[a] - p[b]; });
    var pos = 0, neg = 0, rankSum = 0, k = 0;
    while (k < idx.length) {
      var j = k; while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[k]]) j++;
      var avg = (k + j) / 2 + 1;
      for (var q = k; q <= j; q++) if (y[idx[q]]) { rankSum += avg; pos++; } else neg++;
      k = j + 1;
    }
    return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : 0.5;
  }
  function quantile(sorted, q) { if (!sorted.length) return NaN; var k = (sorted.length - 1) * q, lo = Math.floor(k), hi = Math.ceil(k); return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo); }
  function spearman(a, b) {
    var n = a.length; if (n < 3) return NaN;
    var ra = ranks(a), rb = ranks(b), ma = (n - 1) / 2, s = 0, sa = 0, sb = 0;
    for (var i = 0; i < n; i++) { s += (ra[i] - ma) * (rb[i] - ma); sa += (ra[i] - ma) * (ra[i] - ma); sb += (rb[i] - ma) * (rb[i] - ma); }
    return sa && sb ? s / Math.sqrt(sa * sb) : NaN;
  }
  function ranks(a) { var idx = a.map(function (_, k) { return k; }).sort(function (x, y) { return a[x] - a[y]; }), r = new Array(a.length); idx.forEach(function (k, j) { r[k] = j; }); return r; }

  /* Outcome buckets: for 10 slices of P(up), what actually happened. Used to give every prediction a range. */
  function buckets(p, y) {
    // ten equal-sized groups by rank, so tied predictions can't leave a group empty
    var order = p.map(function (_, k) { return k; }).sort(function (a, b) { return p[a] - p[b]; }), groups = [], edges = [], q;
    for (q = 0; q < 10; q++) groups.push([]);
    order.forEach(function (k, j) { groups[Math.min(9, Math.floor(j * 10 / order.length))].push(y[k]); });
    for (q = 0; q < 9; q++) { var lastIdx = Math.floor((q + 1) * order.length / 10) - 1; edges.push(p[order[Math.max(0, lastIdx)]]); }
    return { edges: edges, stats: groups.map(function (g, k) {
      var s = g.slice().sort(function (a, b) { return a - b; }), wins = g.filter(function (v) { return v > 0; });
      var losses = g.filter(function (v) { return v <= 0; });
      return { bucket: k + 1, n: g.length, mean: mean(g), median: quantile(s, 0.5), p10: quantile(s, 0.1), p25: quantile(s, 0.25), p75: quantile(s, 0.75), p90: quantile(s, 0.9),
        winRate: g.length ? wins.length / g.length : NaN, avgWin: mean(wins), avgLoss: mean(losses) };
    }) };
  }
  /* Calibration: ten rank groups of a score on held-out rows, with how often the event really happened in each. */
  function calibrator(p, y) {
    var order = p.map(function (_, k) { return k; }).sort(function (a, b) { return p[a] - p[b]; }), n = order.length, edges = [], rates = [], q;
    for (q = 0; q < 10; q++) {
      var lo = Math.floor(q * n / 10), hi = Math.floor((q + 1) * n / 10), hits = 0;
      for (var j = lo; j < hi; j++) hits += y[order[j]];
      rates.push(hi > lo ? (hits + 1) / (hi - lo + 2) : 0.5);           // small-sample smoothing
      if (q < 9) edges.push(p[order[Math.max(0, hi - 1)]]);
    }
    return { edges: edges, rates: rates };
  }
  function calibrated(c, v) { return c ? c.rates[bucketOf(c.edges, v)] : v; }

  function bucketOf(edges, v) { var k = 0; while (k < edges.length && v > edges[k]) k++; return k; }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : NaN; }

  function evaluate(rows, P, cfg) {
    var y = rows.map(function (r) { return r.labels[0]; }), ret = rows.map(function (r) { return r.y; });
    var pu = P.map(function (p) { return p.up; });
    var brier = mean(pu.map(function (p, k) { return (p - y[k]) * (p - y[k]); }));
    var ll = mean(pu.map(function (p, k) { p = Math.min(1 - 1e-7, Math.max(1e-7, p)); return y[k] ? -Math.log(p) : -Math.log(1 - p); }));
    var base = mean(y), acc = mean(pu.map(function (p, k) { return (p >= 0.5 ? 1 : 0) === y[k] ? 1 : 0; }));
    var cal = []; for (var q = 0; q < 10; q++) cal.push({ from: q / 10, to: (q + 1) / 10, n: 0, sumP: 0, sumY: 0 });
    pu.forEach(function (p, k) { var c = cal[Math.min(9, Math.floor(p * 10))]; c.n++; c.sumP += p; c.sumY += y[k]; });
    var byDate = {}; rows.forEach(function (r, k) { (byDate[r.date] = byDate[r.date] || []).push(k); });
    var ics = Object.keys(byDate).map(function (d) { var ks = byDate[d]; return spearman(ks.map(function (k) { return pu[k]; }), ks.map(function (k) { return ret[k]; })); }).filter(isFinite);
    var bk = buckets(pu, ret);
    var top = bk.stats[9], bottom = bk.stats[0];
    return {
      rows: rows.length, baseRate: base, auc: auc(pu, y), accuracy: acc, brier: brier, brierBaseline: base * (1 - base), logloss: ll,
      aucBigUp: auc(P.map(function (p) { return p.bigUp; }), rows.map(function (r) { return r.labels[1]; })),
      aucBigDown: auc(P.map(function (p) { return p.bigDown; }), rows.map(function (r) { return r.labels[2]; })),
      ic: mean(ics), icDays: ics.length, icPositiveShare: ics.length ? ics.filter(function (v) { return v > 0; }).length / ics.length : NaN,
      spread: top.mean - bottom.mean, topMean: top.mean, bottomMean: bottom.mean, allMean: mean(ret),
      calibration: cal.filter(function (c) { return c.n; }).map(function (c) { return { predicted: c.sumP / c.n, actual: c.sumY / c.n, n: c.n, range: pct0(c.from) + "-" + pct0(c.to) }; }),
      buckets: bk
    };
  }
  function pct0(x) { return Math.round(x * 100) + "%"; }

  /* Out-of-sample backtest on the test dates: every H days, buy the top K by P(up) at the next open, optionally short
   * the bottom K, hold H days or until the stop / target is hit (daily highs and lows), pay costs on both sides. */
  function backtest(ds, fb, rows, P, cfg) {
    var H = cfg.horizon, K = cfg.topK, cost = cfg.costBps / 1e4, stop = cfg.stopLoss / 100, target = cfg.takeProfit / 100;
    var byDate = {}; rows.forEach(function (r, k) { (byDate[r.date] = byDate[r.date] || []).push({ r: r, p: P[k] }); });
    var dates = Object.keys(byDate).sort(), periods = [], trades = [], equity = 1, bEquity = 1, peak = 1, maxDD = 0;
    for (var di = 0; di < dates.length; di += H) {
      var cands = byDate[dates[di]].filter(function (c) { return isFinite(c.r.y); });
      if (cands.length < 2) continue;
      cands.sort(function (a, b) { return b.p.up - a.p.up; });
      var longs = cands.slice(0, Math.min(K, Math.floor(cands.length / (cfg.allowShort ? 2 : 1)))), shorts = cfg.allowShort ? cands.slice(-Math.min(K, Math.floor(cands.length / 2))) : [];
      var legs = [];
      longs.forEach(function (c) { legs.push(trade(ds, fb, c, 1)); });
      shorts.forEach(function (c) { legs.push(trade(ds, fb, c, -1)); });
      legs = legs.filter(Boolean);
      if (!legs.length) continue;
      var pr = mean(legs.map(function (t) { return t.ret; }));
      var bm = mean(cands.map(function (c) { return c.r.y; }));       // equal-weight: buy every symbol for the same period
      equity *= 1 + pr; bEquity *= 1 + bm;
      if (equity > peak) peak = equity; maxDD = Math.max(maxDD, 1 - equity / peak);
      periods.push({ date: dates[di], positions: legs.length, periodReturn: pr, equalWeightReturn: bm, equity: equity, equalWeightEquity: bEquity, drawdown: 1 - equity / peak });
      legs.forEach(function (t) { trades.push(t); });
    }
    var rs = periods.map(function (p) { return p.periodReturn; }), per = 252 / H, m = mean(rs), sd = Math.sqrt(mean(rs.map(function (v) { return (v - m) * (v - m); })));
    var years = periods.length / per;
    return {
      periods: periods, trades: trades, totalReturn: equity - 1, equalWeightReturn: bEquity - 1,
      cagr: years > 0 ? Math.pow(Math.max(equity, 1e-9), 1 / years) - 1 : NaN, equalWeightCagr: years > 0 ? Math.pow(Math.max(bEquity, 1e-9), 1 / years) - 1 : NaN,
      sharpe: sd > 0 ? m / sd * Math.sqrt(per) : NaN, maxDrawdown: maxDD, hitRate: rs.length ? rs.filter(function (v) { return v > 0; }).length / rs.length : NaN,
      tradeWinRate: trades.length ? trades.filter(function (t) { return t.ret > 0; }).length / trades.length : NaN, avgTrade: mean(trades.map(function (t) { return t.ret; })),
      nTrades: trades.length, years: years
    };
    function trade(ds, fb, c, side) {
      var s = ds.symbols[c.r.symbol], i = c.r.i, entry = s.open[i + 1];
      if (!(entry > 0)) return null;
      var exit = s.close[i + H], why = "held " + H + " days", exitDate = s.date[i + H];
      if (cfg.useStops) for (var k = i + 1; k <= i + H; k++) {
        var lossPx = side > 0 ? entry * (1 - stop) : entry * (1 + stop), winPx = side > 0 ? entry * (1 + target) : entry * (1 - target);
        var hitLoss = side > 0 ? s.low[k] <= lossPx : s.high[k] >= lossPx, hitWin = side > 0 ? s.high[k] >= winPx : s.low[k] <= winPx;
        if (hitLoss) { exit = lossPx; why = "stop loss"; exitDate = s.date[k]; break; }       // stop is checked first: the cautious assumption
        if (hitWin) { exit = winPx; why = "take profit"; exitDate = s.date[k]; break; }
      }
      var ret = side * (exit / entry - 1) - 2 * cost;
      return { symbol: c.r.symbol, side: side > 0 ? "LONG" : "SHORT", signalDate: c.r.date, entryDate: s.date[i + 1], entry: entry, exitDate: exitDate, exit: exit,
        pUp: c.p.up, ret: ret, exitReason: why };
    }
  }

  /* ---------------- the whole pipeline ---------------- */

  var DEFAULTS = { horizon: 5, threshold: 2, model: "gbm", trees: 250, depth: 3, maxTrainRows: 250000, valShare: 0.15, testShare: 0.15,
    refit: true, topK: 5, allowShort: false, costBps: 10, useStops: true, stopLoss: 8, takeProfit: 15, amount: 10000, benchmark: "",
    excludeBenchmark: true, buyAt: 0.55, seed: 1 };

  function settings(c) { var s = {}; for (var k in DEFAULTS) s[k] = c && c[k] !== undefined && c[k] !== "" ? c[k] : DEFAULTS[k]; ["horizon", "threshold", "trees", "depth", "topK", "costBps", "stopLoss", "takeProfit", "amount", "buyAt", "maxTrainRows"].forEach(function (k) { s[k] = +s[k]; }); return s; }

  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

  /* Train, test, refit and predict. Async so the page stays responsive; progress(stage, fraction, text). */
  async function run(ds, cfgIn, progress) {
    var cfg = settings(cfgIn), say = progress || function () {};
    if (!ds || !ds.list.length) throw new Error("Load price data first.");
    say("features", 0, "Building features");
    await tick();
    var fb = buildFeatures(ds, cfg);
    var labelled = fb.rows.filter(function (r) { return r.labels; }), live = latestRows(fb);
    if (labelled.length < 500) throw new Error("Only " + labelled.length + " labelled rows. Load more history (at least a year of daily prices for several symbols) or use a shorter horizon.");
    var dates = Array.from(new Set(labelled.map(function (r) { return r.date; }))).sort();
    var nTest = Math.max(10, Math.floor(dates.length * cfg.testShare)), nVal = Math.max(10, Math.floor(dates.length * cfg.valShare));
    // gap of H days between slices so a training label never overlaps the test period
    var testStart = dates[dates.length - nTest], valStart = dates[dates.length - nTest - nVal - cfg.horizon];
    var trainEnd = dates[Math.max(0, dates.length - nTest - nVal - 2 * cfg.horizon)], valEnd = dates[dates.length - nTest - cfg.horizon];
    var train = labelled.filter(function (r) { return r.date < trainEnd; }), val = labelled.filter(function (r) { return r.date >= valStart && r.date < valEnd; });
    var test = labelled.filter(function (r) { return r.date >= testStart; });
    if (train.length < 300 || !val.length || !test.length) throw new Error("Not enough dates to split into training, tuning and test periods. Load a longer history.");
    var sampleTrain = subsample(train, cfg.maxTrainRows, cfg.seed);
    var edges = binEdges(sampleTrain, 32);
    var models = await fitAll(sampleTrain, val, edges, cfg, function (k, frac, text) { say("train", frac, text); });
    var P = predictRows(models, edges, test);
    var ev = evaluate(test, P, cfg), bt = backtest(ds, fb, test, P, cfg);
    // outcome ranges for live predictions: from validation + test (data the model did not train on)
    var oos = val.concat(test), Poos = predictRows(models, edges, oos);
    var ranges = buckets(Poos.map(function (p) { return p.up; }), oos.map(function (r) { return r.y; }));
    ranges.cal = {
      bigUp: calibrator(Poos.map(function (p) { return p.bigUp; }), oos.map(function (r) { return r.labels[1]; })),
      bigDown: calibrator(Poos.map(function (p) { return p.bigDown; }), oos.map(function (r) { return r.labels[2]; }))
    };
    var finalModels = models, finalEdges = edges;
    if (cfg.refit) {
      say("refit", 0, "Refitting on all labelled data");
      var allRows = subsample(labelled, cfg.maxTrainRows, cfg.seed + 1);
      finalEdges = binEdges(allRows, 32);
      finalModels = await fitAll(allRows, [], finalEdges, settingsWithTrees(cfg, models), function (k, frac, text) { say("refit", frac, text); });
    }
    var Plive = predictRows(finalModels, finalEdges, live);
    var preds = live.map(function (r, k) { return prediction(r, Plive[k], ranges, cfg, ev); }).sort(function (a, b) { return b.pUp - a.pUp || b.rawUp - a.rawUp; });
    var model = { version: VERSION, kind: "trade-box-final-model", createdAt: new Date().toISOString(), settings: cfg, features: FEATURES, edges: finalEdges,
      models: finalModels, ranges: ranges, test: summary(ev, bt), data: { symbols: fb.symbols.length, first: ds.first, last: ds.last, market: fb.market.name } };
    say("done", 1, "Done");
    return { cfg: cfg, data: ds, features: fb, split: { train: train.length, trainUsed: sampleTrain.length, val: val.length, test: test.length, trainEnd: trainEnd, valStart: valStart, testStart: testStart, lastDate: dates[dates.length - 1] },
      eval: ev, backtest: bt, testRows: test, testP: P, predictions: preds, importance: importance(models), model: model, verdict: verdict(ev, bt) };
  }

  function settingsWithTrees(cfg, models) {
    var c = {}; for (var k in cfg) c[k] = cfg[k];
    c.fixedTrees = {}; for (var key in models) if (models[key].trees) c.fixedTrees[key] = Math.max(10, models[key].trees.length);
    return c;
  }

  async function fitAll(rows, val, edges, cfg, say) {
    var Xb = binRows(rows, edges), vXb = binRows(val, edges), out = {};
    var targets = [["up", 0, "logloss"], ["bigUp", 1, "logloss"], ["bigDown", 2, "logloss"], ["ret", -1, "l2"]];
    var lo = -Infinity, hi = Infinity;
    if (rows.length) { var rs = rows.map(function (r) { return r.y; }).sort(function (a, b) { return a - b; }); lo = quantile(rs, 0.01); hi = quantile(rs, 0.99); }
    for (var t = 0; t < targets.length; t++) {
      var tg = targets[t], ys = rows.map(function (r) { return tg[1] >= 0 ? r.labels[tg[1]] : Math.min(hi, Math.max(lo, r.y)); });
      var vy = val.map(function (r) { return tg[1] >= 0 ? r.labels[tg[1]] : Math.min(hi, Math.max(lo, r.y)); });
      if (cfg.model === "logistic" && tg[2] === "logloss") { out[tg[0]] = trainLogistic(rows, ys, {}); say(t, (t + 1) / targets.length, "Fitted " + tg[0]); await tick(); continue; }
      var nT = cfg.fixedTrees && cfg.fixedTrees[tg[0]] ? cfg.fixedTrees[tg[0]] : cfg.trees, last = 0;
      out[tg[0]] = trainGBM(Xb, ys, vXb, vy, { loss: tg[2], trees: nT, depth: cfg.depth, lr: tg[2] === "l2" ? 0.05 : 0.08, seed: cfg.seed + t, patience: cfg.fixedTrees ? 1e9 : 30 },
        function (k, nTrees) { if (k - last >= 10) { last = k; say(t, (t + k / nTrees) / targets.length, "Model " + (t + 1) + " of 4 (" + tg[0] + "): tree " + k); } });
      await tick();
    }
    return out;
  }

  function predictRows(models, edges, rows) {
    return rows.map(function (r) {
      var xb = new Uint8Array(NF); for (var f = 0; f < NF; f++) xb[f] = binOf(edges[f], r.x[f]);
      var o = {};
      ["up", "bigUp", "bigDown", "ret"].forEach(function (k) { var m = models[k]; o[k] = m.kind === "logistic" ? scoreLogistic(m, r.x) : scoreGBM(m, xb); });
      return o;
    });
  }

  function latestRows(fb) {
    var last = {}; fb.rows.forEach(function (r) { last[r.symbol] = r; });
    return Object.keys(last).map(function (k) { return last[k]; });
  }

  function prediction(r, p, ranges, cfg, ev) {
    var b = ranges.stats[bucketOf(ranges.edges, p.up)], amt = cfg.amount;
    var payoff = b.avgLoss < 0 ? b.avgWin / -b.avgLoss : NaN, wr = b.winRate;
    var kelly = isFinite(payoff) && payoff > 0 ? wr - (1 - wr) / payoff : NaN;
    // expected return = what actually happened, on dates the model never trained on, when it gave a similar chance of rising
    // chances shown are calibrated: how often the event really happened on held-out dates for similar scores
    var cost = 2 * cfg.costBps / 1e4, signal = "Hold", exp = b.mean, up = b.winRate;
    var bigUp = calibrated(ranges.cal && ranges.cal.bigUp, p.bigUp), bigDown = calibrated(ranges.cal && ranges.cal.bigDown, p.bigDown);
    if (up >= cfg.buyAt && exp > cost) signal = "Buy";
    else if (up <= 1 - cfg.buyAt && exp < -cost) signal = cfg.allowShort ? "Short" : "Avoid";
    var edge = Math.abs(up - ev.baseRate);
    return { symbol: r.symbol, asOf: r.date, horizonDays: cfg.horizon, lastClose: null, pUp: up, pBigUp: bigUp, pBigDown: bigDown, expectedReturn: exp, modelReturn: p.ret,
      rawUp: p.up, rawBigUp: p.bigUp, rawBigDown: p.bigDown,
      historicalWinRate: b.winRate, historicalMean: b.mean, p10: b.p10, p90: b.p90, bucket: b.bucket, bucketSize: b.n,
      expectedPnl: amt * exp, pnlP10: amt * b.p10, pnlP90: amt * b.p90, chanceOfProfit: up,
      quarterKelly: isFinite(kelly) ? Math.max(0, Math.min(0.25, kelly / 4)) : 0, signal: signal,
      confidence: edge > 0.08 ? "Higher" : edge > 0.03 ? "Some" : "Low", x: r.x };
  }

  function importance(models) {
    var tot = new Float64Array(NF);
    ["up", "bigUp", "bigDown", "ret"].forEach(function (k) { var im = models[k].importance, s = im.reduce(function (a, v) { return a + v; }, 0) || 1; for (var f = 0; f < NF; f++) tot[f] += im[f] / s / 4; });
    return FEATURES.map(function (f, k) { return { feature: f[1], key: f[0], importance: tot[k] }; }).sort(function (a, b) { return b.importance - a.importance; });
  }

  function summary(ev, bt) {
    return { auc: ev.auc, accuracy: ev.accuracy, baseRate: ev.baseRate, brier: ev.brier, ic: ev.ic, spread: ev.spread, backtestCagr: bt.cagr, equalWeightCagr: bt.equalWeightCagr, sharpe: bt.sharpe, maxDrawdown: bt.maxDrawdown };
  }

  /* Plain-language verdict. Deliberately strict: most price-only models are close to chance. */
  function verdict(ev, bt) {
    var skill = ev.auc >= 0.53 && ev.ic > 0.01 && ev.spread > 0 && ev.icPositiveShare > 0.52;
    var beats = bt.totalReturn > bt.equalWeightReturn && bt.sharpe > 0.5;
    var timing = !skill && ev.auc >= 0.55 && !(ev.ic > 0.01);
    if (skill && beats) return { level: "good", text: "On dates it never saw, the bot ranked stocks better than chance and its backtest beat buying everything equally. That is encouraging, not proof: test it on more history and paper-trade before risking money." };
    if (skill) return { level: "mixed", text: "The bot ranked stocks a little better than chance on unseen dates, but after costs its backtest did not beat buying everything equally. Treat the signals as weak." };
    if (timing) return { level: "mixed", text: "The bot's chances were right more often than chance overall (AUC " + ev.auc.toFixed(2) + "), but within each day it could not tell which stocks would do better (rank correlation " + ev.ic.toFixed(3) + "). It is mostly guessing whether the whole market rises, so its stock picks add little. Treat the signals as weak." };
    return { level: "poor", text: "On unseen dates the bot did no better than chance. Don't trade on these signals; try more symbols, more history, or a different horizon." };
  }

  /* ---------------- model files and exports ---------------- */

  function predictWithModel(model, ds) {
    var cfg = settings(model.settings), fb = buildFeatures(ds, cfg), live = latestRows(fb);
    var P = predictRows(model.models, model.edges, live);
    var labelled = fb.rows.filter(function (r) { return r.labels; }), check = null;
    if (labelled.length > 200) {
      var recent = labelled.filter(function (r) { return r.date > model.data.last; });
      if (recent.length > 50) { var Pr = predictRows(model.models, model.edges, recent); check = evaluate(recent, Pr, cfg); check.note = "Scored on " + recent.length + " rows dated after the model was trained (" + model.data.last + ")."; }
    }
    var ev = { baseRate: model.test ? model.test.baseRate : 0.5 };
    return { cfg: cfg, predictions: live.map(function (r, k) { return prediction(r, P[k], model.ranges, cfg, ev); }).sort(function (a, b) { return b.pUp - a.pUp || b.rawUp - a.rawUp; }), check: check, features: fb };
  }

  function validateModel(obj) {
    if (!obj || obj.kind !== "trade-box-final-model") throw new Error("That file is not a Trade Box model.");
    if (obj.version > VERSION) throw new Error("This model was made by a newer version of Trade Box.");
    if (!obj.models || !obj.edges || !obj.ranges) throw new Error("The model file is incomplete.");
    return obj;
  }

  function r4(x) { return Math.round(x * 10000) / 10000; }
  function r6(x) { return isFinite(x) ? Math.round(x * 1e6) / 1e6 : ""; }

  function predictionRows(preds, ds) {
    return preds.map(function (p) {
      var s = ds && ds.symbols[p.symbol], last = s ? s.close[s.close.length - 1] : "";
      var o = { symbol: p.symbol, asOf: p.asOf, horizonDays: p.horizonDays, lastClose: r4(last), signal: p.signal, confidence: p.confidence,
        chanceUp: r6(p.pUp), chanceUpMoreThanThreshold: r6(p.pBigUp), chanceDownMoreThanThreshold: r6(p.pBigDown), expectedReturn: r6(p.expectedReturn), returnModelEstimate: r6(p.modelReturn),
        rawScoreUp: r6(p.rawUp), rawScoreBigUp: r6(p.rawBigUp), rawScoreBigDown: r6(p.rawBigDown),
        historicalWinRate: r6(p.historicalWinRate), historicalMeanReturn: r6(p.historicalMean), likelyLow10: r6(p.p10), likelyHigh90: r6(p.p90),
        expectedPnl: r6(p.expectedPnl), pnlLow10: r6(p.pnlP10), pnlHigh90: r6(p.pnlP90), quarterKellySize: r6(p.quarterKelly), similarPastCases: p.bucketSize };
      FKEYS.forEach(function (k, f) { o["x_" + k] = r6(p.x[f]); });
      return o;
    });
  }

  function resultSheets(res) {
    var cfg = res.cfg, ev = res.eval, bt = res.backtest, sp = res.split;
    var summaryRows = [
      ["Mode", "Final training (real data)"], ["Verdict", res.verdict.text], ["Data", res.data.list.length + " symbols, " + res.data.first + " to " + res.data.last],
      ["Market proxy", res.features.market.name], ["Horizon", cfg.horizon + " trading days (enter next open, exit at close)"], ["Big-move threshold", cfg.threshold + "%"],
      ["Model", cfg.model === "gbm" ? "Gradient-boosted trees" : "Logistic regression"], ["Training rows", sp.train + " (" + sp.trainUsed + " used)"],
      ["Training dates", "before " + sp.trainEnd], ["Tuning dates", sp.valStart + " on"], ["Test dates (never seen)", sp.testStart + " to " + sp.lastDate],
      ["Test rows", sp.test], ["Refit on all data for predictions", cfg.refit ? "yes" : "no"],
      ["Test AUC P(up) (0.5 = chance)", ev.auc], ["Test accuracy", ev.accuracy], ["Share of rows that went up", ev.baseRate], ["Brier score (lower is better)", ev.brier],
      ["Brier of always guessing the base rate", ev.brierBaseline], ["AUC P(up > threshold)", ev.aucBigUp], ["AUC P(down > threshold)", ev.aucBigDown],
      ["Mean daily rank correlation", ev.ic], ["Days with positive rank correlation", ev.icPositiveShare], ["Top 10% minus bottom 10% return", ev.spread],
      ["Backtest total return", bt.totalReturn], ["Equal-weight total return (same dates)", bt.equalWeightReturn], ["Backtest CAGR", bt.cagr], ["Equal-weight CAGR", bt.equalWeightCagr],
      ["Backtest Sharpe", bt.sharpe], ["Backtest max drawdown", bt.maxDrawdown], ["Periods in profit", bt.hitRate], ["Trades", bt.nTrades], ["Trade win rate", bt.tradeWinRate],
      ["Costs per side (bps)", cfg.costBps], ["Stops", cfg.useStops ? "stop " + cfg.stopLoss + "%, target " + cfg.takeProfit + "%" : "off"],
      ["Not investment advice", "Estimates from past prices. Markets change; past patterns can stop working."]
    ].map(function (r) { return { item: r[0], value: r[1] }; });
    return [
      ["Summary", summaryRows],
      ["Predictions", predictionRows(res.predictions, res.data)],
      ["Calibration", ev.calibration],
      ["Outcome Ranges", ev.buckets.stats],
      ["Backtest", bt.periods],
      ["Backtest Trades", bt.trades],
      ["Feature Importance", res.importance.map(function (f) { return { feature: f.feature, key: f.key, importance: r6(f.importance) }; })],
      ["Test Predictions", res.testRows.map(function (r, k) { return { date: r.date, symbol: r.symbol, chanceUp: r6(res.testP[k].up), expectedReturn: r6(res.testP[k].ret), actualReturn: r6(r.y), wentUp: r.labels[0] }; })],
      ["Data Quality", res.data.warnings.length ? res.data.warnings.map(function (w) { return { warning: w }; }) : [{ warning: "No problems found." }]]
    ];
  }

  /* Training table (inputs x_ and targets y_) for anyone who wants to train their own model on the same features. */
  function trainingRows(fb) {
    return fb.rows.filter(function (r) { return r.labels; }).map(function (r) {
      var o = { date: r.date, symbol: r.symbol };
      FKEYS.forEach(function (k, f) { o["x_" + k] = r6(r.x[f]); });
      o.y_return = r6(r.y); o.y_up = r.labels[0]; o.y_bigUp = r.labels[1]; o.y_bigDown = r.labels[2];
      return o;
    });
  }

  function subsample(rows, max, seed) {
    if (rows.length <= max) return rows;
    var r = new T.RNG(seed || 1), keep = max / rows.length;
    return rows.filter(function () { return r.next() < keep; });
  }

  T.Final = { VERSION: VERSION, DEFAULTS: DEFAULTS, FEATURES: FEATURES, parseCSV: parseCSV, loadPrices: loadPrices, simulatedCSV: simulatedCSV,
    buildFeatures: buildFeatures, run: run, evaluate: evaluate, backtest: backtest, auc: auc, predictWithModel: predictWithModel,
    validateModel: validateModel, predictionRows: predictionRows, resultSheets: resultSheets, trainingRows: trainingRows, settings: settings };
})(window.T = window.T || {});
