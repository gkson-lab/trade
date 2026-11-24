/* Final training mode screen: the switch, the banner, data in, training, results, predictions, files out. */
(function (T) {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var U = T.ui, F = T.Final, el = U.el, clear = U.clear;
  var S = { on: false, ds: null, practice: false, res: null, predView: null, busy: false };

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function pct(x, d) { return isFinite(x) ? (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(d === undefined ? 2 : d) + "%" : "n/a"; }
  function chance(x) { return isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a"; }
  function dollars(x) { return isFinite(x) ? (x < 0 ? "−$" : "+$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a"; }
  function cls(x) { return x > 0 ? "up" : x < 0 ? "down" : ""; }

  /* ---------- the mode switch ---------- */
  function setMode(on) {
    S.on = on;
    document.body.classList.toggle("final-mode", on);
    $("modeSwitch").setAttribute("aria-checked", on ? "true" : "false");
    $("finalBanner").hidden = !on;
    $("finalView").hidden = !on;
    $("modeTag").textContent = on ? "Final training mode" : "Simulated market";
    document.title = on ? "Final training · Trade Box" : "Trade Box";
    if (on) { U.pauseSim(); U.setStatus("Final training mode: the simulation is paused. Load price data to train the bot."); }
    else { U.setStatus("Back in the simulated market. Press Resume or Start to continue."); requestAnimationFrame(U.redraw); }
    store("tb-mode", on ? "final" : "sim");
  }

  /* ---------- data in ---------- */
  function readFiles(list) {
    var files = Array.prototype.slice.call(list);
    if (!files.length) return;
    showErr("");
    Promise.all(files.map(function (f) {
      if (/\.zip$/i.test(f.name)) {
        if (!window.XLSX) return Promise.reject(new Error("The zip reader is still loading. Try again in a moment."));
        return f.arrayBuffer().then(function (b) { return T.Report.unzip(window.XLSX, new Uint8Array(b)); });
      }
      return f.text().then(function (t) { return [{ name: f.name, text: t }]; });
    })).then(function (lists) {
      var all = [].concat.apply([], lists);
      if (!all.length) throw new Error("No CSV files were found in that selection.");
      useData(F.loadPrices(all), false);
    }).catch(function (e) { showErr(e.message); });
  }

  function useData(ds, practice) {
    if (!ds.list.length && S.ds && S.ds.list.length) {
      // keep what was already loaded; just explain why the new files couldn't be used
      showErr("Those files had no usable daily prices, so your earlier data is still loaded. " + ds.warnings.slice(0, 3).join(" "));
      return;
    }
    S.ds = ds; S.practice = practice; S.res = null;
    $("fResults").hidden = true; $("fPredSec").hidden = true; outputs(false);
    var box = $("fDataSummary"); clear(box); box.hidden = false;
    if (practice) box.appendChild(el("span", "practice", "Practice data: simulated prices from the Trade Box market, not real stocks."));
    box.appendChild(el("span", null, ds.list.length + " symbol" + (ds.list.length === 1 ? "" : "s") + " with enough history, " +
      ds.rows.toLocaleString() + " daily rows, " + (ds.first ? ds.first + " to " + ds.last : "no dates") + "."));
    if (ds.warnings.length) {
      box.appendChild(el("span", "muted", ds.warnings.length + " note" + (ds.warnings.length > 1 ? "s" : "") + ":"));
      var ul = el("ul"); ds.warnings.slice(0, 40).forEach(function (w) { ul.appendChild(el("li", null, w)); });
      if (ds.warnings.length > 40) ul.appendChild(el("li", null, (ds.warnings.length - 40) + " more in the results file."));
      box.appendChild(ul);
    }
    var sel = $("fBench"); clear(sel);
    var o = el("option", null, "Average of all my symbols"); o.value = ""; sel.appendChild(o);
    ds.list.forEach(function (s) { var x = el("option", null, s); x.value = s; sel.appendChild(x); });
    ["SPY", "VOO", "IVV", "QQQ", "VTI", "DIA", "IWM"].some(function (s) { if (ds.symbols[s]) { sel.value = s; return true; } return false; });
    $("fBenchField").hidden = !ds.list.length;
    var ok = ds.list.length > 0;
    $("fTrain").disabled = !ok;
    $("fTrainHint").textContent = ok ? (practice ? "Ready. This is practice data, so the results only show how the bot works." : "Ready.") : "None of the files had usable daily prices. See the notes above.";
    U.setStatus("Final training mode: " + ds.list.length + " symbols loaded" + (practice ? " (practice data)." : "."));
  }

  /* ---------- settings ---------- */
  function readSettings() {
    var v = function (id) { return $(id).value; };
    var c = { horizon: +v("fHorizon"), threshold: +v("fThreshold"), model: v("fModel"), amount: +v("fAmount"), buyAt: +v("fBuyAt") / 100, topK: +v("fTopK"),
      costBps: +v("fCost"), stopLoss: +v("fStop"), takeProfit: +v("fTarget"), useStops: $("fStops").checked, allowShort: $("fShort").checked,
      refit: $("fRefit").checked, benchmark: v("fBench") };
    var bad = !(c.threshold > 0) ? "Enter a big-move size above 0%." : !(c.amount > 0) ? "Enter an amount per trade above $0." :
      !(c.buyAt >= 0.5 && c.buyAt < 1) ? "The buy level must be between 50% and 95%." : !(c.topK >= 1) ? "Buy at least 1 stock each period." :
      !(c.costBps >= 0) ? "Trading cost can't be negative." : c.useStops && !(c.stopLoss > 0 && c.takeProfit > 0) ? "Enter a stop loss and a take profit above 0%." : "";
    return { cfg: c, error: bad };
  }

  function fromBot() {
    var b = U.bestBot();
    if (!b) { $("fFromBotHint").textContent = "No finished generation in the simulation yet. Run the simulation for at least one generation first."; return; }
    $("fStop").value = (b.stopLoss * 100).toFixed(1); $("fTarget").value = (b.takeProfit * 100).toFixed(1);
    $("fTopK").value = Math.max(1, Math.min(100, b.maxPos)); $("fStops").checked = true;
    $("fFromBotHint").textContent = "Copied from " + b.name + ", the top bot of generation " + b.gen + " (" + pct(b.ret) + "): stop " + (b.stopLoss * 100).toFixed(1) +
      "%, target " + (b.takeProfit * 100).toFixed(1) + "%, " + b.maxPos + " positions.";
  }

  /* ---------- train ---------- */
  function train() {
    if (S.busy || !S.ds) return;
    var st = readSettings();
    if (st.error) { showErr(st.error); return; }
    showErr(""); S.busy = true;
    $("fTrain").disabled = true; $("fTrain").textContent = "Training…";
    $("fProgress").hidden = false; progress(0, "Starting");
    var stageW = { features: [0, 0.05], train: [0.05, 0.75], refit: [0.75, 0.98], done: [1, 1] };
    F.run(S.ds, st.cfg, function (stage, frac, text) { var w = stageW[stage] || [0, 1]; progress(w[0] + (w[1] - w[0]) * frac, text); })
      .then(function (res) { S.res = res; showResults(res); progress(1, "Done. Scroll down for the results."); U.setStatus("Final training mode: trained and tested. " + res.verdict.text);
        if (T.onFinalTrained) T.onFinalTrained(res, S.practice); })
      .catch(function (e) { showErr(e.message); progress(0, ""); $("fProgress").hidden = true; })
      .then(function () { S.busy = false; $("fTrain").disabled = false; $("fTrain").textContent = "Train the bot again"; });
  }
  function progress(f, text) { $("fProgressBar").style.width = Math.round(f * 100) + "%"; $("fProgressText").textContent = text; }
  function showErr(m) { var e = $("fErr"); e.textContent = m; e.hidden = !m; }

  /* ---------- results ---------- */
  function showResults(res) {
    var ev = res.eval, bt = res.backtest, cfg = res.cfg;
    $("fResults").hidden = false;
    var v = $("fVerdict"); clear(v); v.className = "verdict " + res.verdict.level;
    v.appendChild(el("strong", null, (res.verdict.level === "good" ? "Shows skill on unseen dates" : res.verdict.level === "mixed" ? "Weak skill" : "No skill found") +
      (S.practice ? " (practice data)" : "")));
    v.appendChild(el("span", null, res.verdict.text));
    var k = $("fKpis"); clear(k);
    [["Test AUC (0.5 = chance)", ev.auc.toFixed(3), ev.auc - 0.5], ["Daily rank correlation", ev.ic.toFixed(3), ev.ic],
      ["Top minus bottom 10%", pct(ev.spread), ev.spread], ["Accuracy", chance(ev.accuracy)],
      ["Backtest", pct(bt.totalReturn), bt.totalReturn], ["Buy everything equally", pct(bt.equalWeightReturn), bt.equalWeightReturn],
      ["Sharpe", isFinite(bt.sharpe) ? bt.sharpe.toFixed(2) : "n/a", bt.sharpe], ["Max drawdown", pct(-bt.maxDrawdown)],
      ["Trade win rate", chance(bt.tradeWinRate)], ["Trades", bt.nTrades.toLocaleString()]].forEach(function (x) {
      var d = el("div", "kpi"); d.appendChild(el("span", "k", x[0])); d.appendChild(el("span", "v num " + (x[2] !== undefined ? cls(x[2]) : ""), x[1])); k.appendChild(d);
    });
    $("fBtHint").textContent = "Test dates " + res.split.testStart + " to " + res.split.lastDate + ". Every " + cfg.horizon + " trading day" + (cfg.horizon > 1 ? "s" : "") +
      " the bot buys the " + cfg.topK + " stock" + (cfg.topK > 1 ? "s" : "") + " with the highest chance of rising" + (cfg.allowShort ? " and shorts the lowest" : "") +
      " at the next open, pays " + cfg.costBps + " bps each way" + (cfg.useStops ? ", and exits at a " + cfg.stopLoss + "% stop or " + cfg.takeProfit + "% target" : "") +
      ". Grey line: buying every symbol equally over the same periods.";
    drawEquity($("fEquity"), bt.periods);
    var c = $("fCal"); clear(c);
    c.appendChild(U.table(["Bot said", "Actually rose", "Cases"], ev.calibration.map(function (r) { return [chance(r.predicted), chance(r.actual), r.n.toLocaleString()]; }), -1));
    var im = $("fImp"); clear(im);
    im.appendChild(U.table(["Input", "Share of attention"], res.importance.slice(0, 10).map(function (f) { return [f.feature, chance(f.importance)]; }), -1));
    var rg = $("fRanges"); clear(rg);
    rg.appendChild(U.table(["Group", "Chance up from", "Average return", "Rose", "Worst 10% at", "Best 10% from", "Cases"], ev.buckets.stats.map(function (b, i) {
      return [String(i + 1) + (i === 0 ? " (least)" : i === 9 ? " (most)" : ""), i ? chance(ev.buckets.edges[i - 1]) : "0%", pct(b.mean), chance(b.winRate), pct(b.p10), pct(b.p90), b.n.toLocaleString(), b.mean];
    }), 2));
    showPredictions(res.predictions, res.cfg, res.split.lastDate, null);
    outputs(true);
  }

  function showPredictions(preds, cfg, asOf, check) {
    S.predView = { preds: preds, cfg: cfg };
    $("fPredSec").hidden = false;
    var warn = $("fPredWarn"), level = S.res ? S.res.verdict.level : (check ? (check.auc >= 0.53 ? "mixed" : "poor") : "mixed");
    clear(warn); warn.hidden = level === "good";
    warn.className = "verdict " + level;
    if (level !== "good") {
      warn.appendChild(el("strong", null, level === "poor" ? "Don't act on these signals" : "Weak signals"));
      warn.appendChild(el("span", null, S.res ? "The test in step 4 found " + (level === "poor" ? "no" : "only weak") + " skill on dates the bot never saw, so these chances are close to a coin flip with costs on top."
        : "This saved model's skill on your newer prices is " + (check ? "AUC " + check.auc.toFixed(3) + " (0.5 is chance)." : "unknown: load prices that run past its training dates to check it.")));
    }
    var buys = preds.filter(function (p) { return p.signal === "Buy"; }).length;
    $("fPredHint").textContent = (S.practice ? "Practice data: these are simulated symbols, so they say nothing about real stocks. " : "") +
      "Based on prices up to " + asOf + ". Each row is the bot's view of the next " + cfg.horizon + " trading day" + (cfg.horizon > 1 ? "s" : "") + " if you buy at the next open. " +
      "Expected return and the likely range come from what actually happened on test dates when the bot gave a similar chance. Dollar figures assume $" +
      cfg.amount.toLocaleString() + " per trade. " + buys + " Buy signal" + (buys === 1 ? "" : "s") + ". Sizing is a quarter of the Kelly fraction, capped at 25%." +
      (check ? " " + check.note + " AUC there: " + check.auc.toFixed(3) + "." : "");
    renderPreds();
  }

  function renderPreds() {
    var box = $("fPreds"), f = $("fSignalFilter").value, v = S.predView; clear(box);
    if (!v) return;
    var th = v.cfg.threshold;
    var heads = ["Symbol", "Signal", "Chance up", "Up > " + th + "%", "Down > " + th + "%", "Expected", "Likely range", "Expected P/L", "P/L range", "Confidence", "Max size"];
    var wrap = el("div", "tbl-wrap scroll-y"), t = el("table"), thead = el("thead"), tr = el("tr");
    heads.forEach(function (h) { var c = el("th", null, h); c.scope = "col"; tr.appendChild(c); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody"), rows = v.preds.filter(function (p) { return !f || p.signal === f; });
    if (!rows.length) { var r0 = el("tr"), td0 = el("td", "muted", "No symbols with that signal."); td0.colSpan = heads.length; r0.appendChild(td0); tb.appendChild(r0); }
    rows.forEach(function (p) {
      var row = el("tr");
      row.appendChild(el("td", null, p.symbol));
      var sc = el("td"); sc.appendChild(el("span", "sig " + p.signal, p.signal)); row.appendChild(sc);
      [[chance(p.pUp)], [chance(p.pBigUp)], [chance(p.pBigDown)], [pct(p.expectedReturn), p.expectedReturn], [pct(p.p10, 1) + " to " + pct(p.p90, 1)],
        [dollars(p.expectedPnl), p.expectedPnl], [dollars(p.pnlP10) + " to " + dollars(p.pnlP90)], [p.confidence], [chance(p.quarterKelly)]].forEach(function (c) {
        row.appendChild(el("td", "num " + (c.length > 1 ? cls(c[1]) : ""), c[0]));
      });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
  }

  function drawEquity(canvas, periods) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2), W = canvas.clientWidth, H = canvas.clientHeight, P = T.chartPalette();
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    if (!periods.length) return;
    var a = [1].concat(periods.map(function (p) { return p.equity; })), b = [1].concat(periods.map(function (p) { return p.equalWeightEquity; }));
    var hi = Math.max.apply(null, a.concat(b)), lo = Math.min.apply(null, a.concat(b)), pad = (hi - lo) * 0.08 || 0.01; hi += pad; lo -= pad;
    var left = 52, right = 8, top = 10, bottom = 22, pw = W - left - right, ph = H - top - bottom;
    var x = function (i) { return left + i / (a.length - 1) * pw; }, y = function (v) { return top + (hi - v) / (hi - lo) * ph; };
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = P.text;
    for (var g = 0; g <= 4; g++) {
      var val = lo + (hi - lo) * g / 4, yy = Math.round(y(val)) + 0.5;
      ctx.strokeStyle = Math.abs(val - 1) < (hi - lo) / 8 ? P.border : P.grid; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(W - right, yy); ctx.stroke();
      ctx.fillText(((val - 1) * 100).toFixed(0) + "%", 4, yy);
    }
    ctx.textBaseline = "alphabetic";
    ctx.fillText(periods[0].date, left, H - 4);
    var endLabel = periods[periods.length - 1].date; ctx.fillText(endLabel, W - right - ctx.measureText(endLabel).width, H - 4);
    [[b, P.text, 1.25], [a, P.accent, 2]].forEach(function (s) {
      ctx.strokeStyle = s[1]; ctx.lineWidth = s[2]; ctx.beginPath();
      s[0].forEach(function (v, i) { if (i) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(i), y(v)); }); ctx.stroke();
    });
    ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(x(a.length - 1), y(a[a.length - 1]), 3, 0, 2 * Math.PI); ctx.fill();
    canvas.setAttribute("aria-label", "Backtest equity: bot " + ((a[a.length - 1] - 1) * 100).toFixed(1) + "%, buying everything equally " + ((b[b.length - 1] - 1) * 100).toFixed(1) + "%");
  }

  /* ---------- files out, model in ---------- */
  function outputs(on) { ["fOutXlsx", "fOutCsv", "fOutModel", "fOutTrain"].forEach(function (id) { $(id).disabled = !on; }); }
  function name(ext) { return "trade-box-final" + (S.practice ? "-practice" : "") + "-" + (S.res ? S.res.split.lastDate : "model") + ext; }

  function wire() {
    $("modeSwitch").addEventListener("click", function () { setMode(!S.on); });
    $("btnLeaveFinal").addEventListener("click", function () { setMode(false); });
    $("fFiles").addEventListener("change", function () { readFiles(this.files); this.value = ""; });
    var drop = $("fDrop");
    ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
    drop.addEventListener("drop", function (e) { if (e.dataTransfer) readFiles(e.dataTransfer.files); });
    $("fSample").addEventListener("click", function () {
      var btn = this; btn.disabled = true; btn.textContent = "Building practice data…";
      setTimeout(function () {
        try { useData(F.loadPrices([{ name: "practice.csv", text: F.simulatedCSV({ symbols: 40, days: 500 }) }]), true); }
        catch (e) { showErr(e.message); }
        btn.disabled = false; btn.textContent = "Try it with simulated prices";
      }, 30);
    });
    $("fFromBot").addEventListener("click", fromBot);
    $("fTrain").addEventListener("click", train);
    $("fSignalFilter").addEventListener("change", renderPreds);
    $("fOutXlsx").addEventListener("click", function () {
      if (!S.res || !window.XLSX) return;
      var wb = window.XLSX.utils.book_new();
      F.resultSheets(S.res).forEach(function (s) { T.Report.appendSheet(window.XLSX, wb, s[0], s[1]); });
      U.download(name(".xlsx"), new Blob([window.XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    });
    $("fOutCsv").addEventListener("click", function () {
      if (S.predView) U.download(name("-predictions.csv"), new Blob([T.Report.toCSV(F.predictionRows(S.predView.preds, S.ds))], { type: "text/csv" }));
    });
    $("fOutModel").addEventListener("click", function () { if (S.res) U.download(name("-model.json"), new Blob([JSON.stringify(S.res.model)], { type: "application/json" })); });
    $("fOutTrain").addEventListener("click", function () { if (S.res) U.download(name("-training.csv"), new Blob([T.Report.toCSV(F.trainingRows(S.res.features))], { type: "text/csv" })); });
    $("fUseModel").addEventListener("click", function () {
      var f = $("fModelFile").files[0], err = $("fModelErr"); err.hidden = true;
      if (!f) { err.textContent = "Choose a model file first."; err.hidden = false; return; }
      if (!S.ds) { err.textContent = "Load price data in step 1 first; the model predicts on that data."; err.hidden = false; return; }
      f.text().then(function (t) {
        var m = F.validateModel(JSON.parse(t)), pr = F.predictWithModel(m, S.ds), last = S.ds.last;
        S.res = null; outputs(false); $("fOutCsv").disabled = false;
        showPredictions(pr.predictions, pr.cfg, last, pr.check);
        $("fPredSec").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        U.setStatus("Final training mode: predictions from the saved model trained " + m.createdAt.slice(0, 10) + ".");
      }).catch(function (e) { err.textContent = e instanceof SyntaxError ? "That file isn't valid JSON." : e.message; err.hidden = false; });
    });
    window.addEventListener("resize", function () { if (S.on && S.res) drawEquity($("fEquity"), S.res.backtest.periods); });
  }

  wire();
  if (store("tb-mode") === "final") setMode(true);
  T.finalUI = S;
})(window.T = window.T || {});
