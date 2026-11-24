/* node tests/final.js - the final-training engine finds real signal, refuses noise, never looks ahead, and round-trips models. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/report.js", "js/final.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
var F = T.Final;

/* Synthetic prices. signal > 0 plants persistent momentum (a hidden drift that lasts); 0 is a pure random walk. */
function synth(signal, seed, nSym, nDays) {
  var r = new T.RNG(seed), lines = ["date,symbol,open,high,low,close,volume"], d0 = Date.UTC(2015, 0, 5);
  for (var s = 0; s < nSym; s++) {
    var p = 50 + 50 * r.next(), state = r.normal(), day = 0;
    for (var t = 0; t < nDays; t++) {
      state = 0.985 * state + 0.17 * r.normal();
      var ret = signal * 0.003 * state + 0.016 * r.normal();
      var open = p * (1 + 0.003 * r.normal()), close = open * Math.exp(ret);
      var hi = Math.max(open, close) * (1 + Math.abs(0.006 * r.normal())), lo = Math.min(open, close) * (1 - Math.abs(0.006 * r.normal()));
      var dt = new Date(d0 + day * 864e5); while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) { day++; dt = new Date(d0 + day * 864e5); }
      lines.push(dt.toISOString().slice(0, 10) + ",S" + s + "," + open.toFixed(4) + "," + hi.toFixed(4) + "," + lo.toFixed(4) + "," + close.toFixed(4) + "," + Math.round(1e6 * (1 + r.next())));
      p = close; day++;
    }
  }
  return lines.join("\n");
}

(async function () {
  // CSV reading: per-symbol files (Yahoo layout, adjusted close), messy dates, bad rows
  var yahoo = "Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-02,10,11,9,10,5,100\n01/03/2024,10,12,9,11,5.5,100\nbad,1,1,1,1,1,1\n";
  var ds0 = F.loadPrices([{ name: "abc.csv", text: yahoo }]);
  assert.ok(ds0.warnings.some(function (w) { return /skipped 1 row/.test(w); }), "bad rows reported");
  assert.ok(ds0.warnings.some(function (w) { return /only 2 days/.test(w); }), "short history reported");
  console.log("ok  CSV input: Yahoo layout, adjusted prices, US dates, bad rows and short histories reported");

  var good = F.loadPrices([{ name: "synthetic.csv", text: synth(1, 11, 30, 900) }]);
  var res = await F.run(good, { horizon: 5, trees: 200 });
  assert.ok(res.eval.auc > 0.56, "finds planted momentum: AUC " + res.eval.auc);
  assert.ok(res.eval.ic > 0.04, "ranks stocks within a day: IC " + res.eval.ic);
  assert.ok(res.eval.spread > 0, "top decile beats bottom decile");
  assert.notStrictEqual(res.verdict.level, "poor", "verdict recognizes real signal");
  assert.ok(res.split.trainEnd < res.split.valStart && res.split.valStart < res.split.testStart, "train, tuning and test periods are in time order");
  assert.ok(res.predictions.length === 30 && res.predictions.every(function (p) { return p.pUp >= 0 && p.pUp <= 1 && isFinite(p.expectedPnl); }), "a prediction per symbol");
  console.log("ok  planted signal found on unseen dates: AUC " + res.eval.auc.toFixed(3) + ", rank correlation " + res.eval.ic.toFixed(3) +
    ", backtest " + (100 * res.backtest.totalReturn).toFixed(1) + "% vs " + (100 * res.backtest.equalWeightReturn).toFixed(1) + "% (verdict: " + res.verdict.level + ")");

  var noise = F.loadPrices([{ name: "noise.csv", text: synth(0, 12, 30, 900) }]);
  var nres = await F.run(noise, { horizon: 5, trees: 200 });
  assert.ok(Math.abs(nres.eval.ic) < 0.04, "no stock-picking skill on noise: IC " + nres.eval.ic);
  assert.notStrictEqual(nres.verdict.level, "good", "noise must not get a good verdict");
  console.log("ok  random walk: AUC " + nres.eval.auc.toFixed(3) + ", rank correlation " + nres.eval.ic.toFixed(3) + " -> verdict " + nres.verdict.level);

  // no look-ahead: change every price after a date; features up to that date must not move
  var text = synth(1, 13, 5, 400), cut = "2016-01-04";
  var changed = text.split("\n").map(function (l, k) { if (!k) return l; var c = l.split(","); if (c[0] > cut) { for (var j = 2; j <= 5; j++) c[j] = (+c[j] * 1.7).toFixed(4); } return c.join(","); }).join("\n");
  var cfg = F.settings({ horizon: 5 });
  var a = F.buildFeatures(F.loadPrices([{ name: "a.csv", text: text }]), cfg), b = F.buildFeatures(F.loadPrices([{ name: "b.csv", text: changed }]), cfg);
  var checked = 0;
  a.rows.forEach(function (r, k) {
    if (r.date > cut) return;
    var q = b.rows[k]; assert.strictEqual(q.date + q.symbol, r.date + r.symbol);
    for (var f = 0; f < r.x.length; f++) assert.ok(Math.abs(r.x[f] - q.x[f]) < 1e-6, "feature " + F.FEATURES[f][0] + " looked ahead on " + r.date);
    checked++;
  });
  assert.ok(checked > 500);
  console.log("ok  no look-ahead: " + checked + " rows' inputs unchanged when every later price changes");

  // labels start at the next day's open
  var s0 = good.symbols.S0, row = res.features.rows.filter(function (r) { return r.symbol === "S0" && r.labels; })[100];
  assert.ok(Math.abs(row.y - (s0.close[row.i + 5] / s0.open[row.i + 1] - 1)) < 1e-9, "label = next open to close 5 days later");

  // save and reload the model: identical predictions
  var json = JSON.parse(JSON.stringify(res.model));
  var again = F.predictWithModel(F.validateModel(json), good);
  res.predictions.forEach(function (p) { var q = again.predictions.filter(function (x) { return x.symbol === p.symbol; })[0]; assert.ok(Math.abs(p.rawUp - q.rawUp) < 1e-12 && p.pUp === q.pUp, "same prediction after reload"); });
  assert.throws(function () { F.validateModel({ kind: "something else" }); }, /not a Trade Box model/);
  console.log("ok  model file round-trips (" + (JSON.stringify(res.model).length / 1024).toFixed(0) + " KB) and gives identical predictions");

  var sheets = F.resultSheets(res);
  assert.deepStrictEqual(sheets.map(function (s) { return s[0]; }), ["Summary", "Predictions", "Calibration", "Outcome Ranges", "Backtest", "Backtest Trades", "Feature Importance", "Test Predictions", "Data Quality"]);
  assert.ok(F.trainingRows(res.features).length > 1000);
  console.log("ok  results workbook has 9 sheets; training table exported with x_ inputs and y_ targets");
})().catch(function (e) { console.error(e); process.exit(1); });
