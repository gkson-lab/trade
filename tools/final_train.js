#!/usr/bin/env node
/* Final training mode from the command line: train the trading bot on real daily prices and write the results.
 *
 *   node tools/final_train.js --data prices.csv                       one CSV with date,symbol,open,high,low,close,volume
 *   node tools/final_train.js --data folder-of-csvs/ --benchmark SPY   one CSV per symbol (Yahoo Finance layout works)
 *   node tools/final_train.js --sample                                 try it on simulated prices
 *   node tools/final_train.js --data new-prices/ --model final/model.json   predict with a saved model, no training
 *
 * Settings: --horizon 5 --threshold 2 --model gbm|logistic --trees 250 --top 5 --short --cost 10
 *           --no-stops --stop 8 --target 15 --amount 10000 --buy-at 0.55 --max-rows 250000 --no-refit
 * Output (--out final): results.xlsx, predictions.csv, backtest.csv, trades.csv, model.json, and with
 *           --save-training, training-data.csv.gz (x_ inputs, y_ targets).
 *           --push-docs sends everything to gk-research-group/internal-documents- as a pull request (Trading data bot;
 *           --docs-repo to change; token from DOCS_TOKEN / GH_TOKEN / GITHUB_TOKEN or the GitHub CLI login).
 * Nothing here places orders. Results are estimates from past prices, not investment advice. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), zlib = require("zlib");
var args = {};
process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1] && arr[i + 1].indexOf("--") !== 0 ? arr[i + 1] : true; });
if (args.help || (!args.data && !args.sample)) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*/, "").replace(/^ \* ?/gm, ""));
  process.exit(args.help ? 0 : 1);
}
global.window = global;
var root = path.join(__dirname, "..");
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/report.js", "js/final.js", "js/docs-push.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
});
var XLSX = require(path.join(root, "vendor", "xlsx.full.min.js"));
var F = T.Final, out = args.out || "final";
fs.mkdirSync(out, { recursive: true });

function readInputs(p) {
  var files = [];
  String(p).split(",").forEach(function (one) {
    if (!fs.existsSync(one)) { console.error("Not found: " + one); process.exit(2); }
    if (fs.statSync(one).isDirectory()) fs.readdirSync(one).filter(function (f) { return /\.(csv|txt)(\.gz)?$/i.test(f); }).sort()
      .forEach(function (f) { files.push(readOne(path.join(one, f))); });
    else files.push(readOne(one));
  });
  return files;
}
function readOne(f) { var b = fs.readFileSync(f); return { name: path.basename(f).replace(/\.gz$/i, ""), text: (/\.gz$/i.test(f) ? zlib.gunzipSync(b) : b).toString("utf8") }; }

var files = args.sample ? [{ name: "simulated.csv", text: F.simulatedCSV({ symbols: +(args.symbols || 40), days: +(args.days || 600), seed: +(args.seed || 777) }) }] : readInputs(args.data);
var ds = F.loadPrices(files);
console.log("FINAL TRAINING MODE" + (args.sample ? " (simulated prices, for trying it out)" : "") + ": " + ds.list.length + " symbols, " + ds.first + " to " + ds.last);
ds.warnings.forEach(function (w) { console.log("  note: " + w); });
if (!ds.list.length) { console.error("No usable price data."); process.exit(2); }

function pct(x) { return isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%" : "n/a"; }
function writeBook(sheets, file) {
  var wb = XLSX.utils.book_new();
  sheets.forEach(function (s) { T.Report.appendSheet(XLSX, wb, s[0], s[1]); });
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));
}

if (args.model) {
  var model = F.validateModel(JSON.parse(fs.readFileSync(args.model, "utf8")));
  var pr = F.predictWithModel(model, ds);
  var rows = F.predictionRows(pr.predictions, ds);
  fs.writeFileSync(path.join(out, "predictions.csv"), T.Report.toCSV(rows));
  console.log("Predictions from the saved model (trained " + model.createdAt.slice(0, 10) + "):");
  rows.slice(0, 10).forEach(function (r) { console.log("  " + r.symbol.padEnd(8) + r.signal.padEnd(7) + " chance up " + (r.chanceUp * 100).toFixed(1) + "%  expected " + pct(r.expectedReturn)); });
  if (pr.check) console.log(pr.check.note + " AUC " + pr.check.auc.toFixed(3));
  console.log("Wrote " + path.join(out, "predictions.csv"));
  process.exit(0);
}

var cfg = {
  horizon: args.horizon, threshold: args.threshold, model: args["model-type"] || (args.logistic ? "logistic" : undefined), trees: args.trees, topK: args.top,
  allowShort: !!args.short, costBps: args.cost, useStops: !args["no-stops"], stopLoss: args.stop, takeProfit: args.target, amount: args.amount,
  buyAt: args["buy-at"], maxTrainRows: args["max-rows"], refit: !args["no-refit"], benchmark: args.benchmark ? String(args.benchmark).toUpperCase() : ""
};
var t0 = Date.now(), lastMsg = "";
F.run(ds, cfg, function (stage, frac, text) { if (text !== lastMsg && (stage !== "train" || /tree \d*0\b|Fitted/.test(text))) { lastMsg = text; process.stdout.write("\r  " + text + "                 "); } })
  .then(function (res) {
    process.stdout.write("\n");
    var ev = res.eval, bt = res.backtest;
    console.log("Test period " + res.split.testStart + " to " + res.split.lastDate + " (" + res.split.test + " rows the model never saw):");
    console.log("  AUC " + ev.auc.toFixed(3) + " (0.5 = chance), accuracy " + pct(ev.accuracy) + ", rank correlation " + ev.ic.toFixed(4) + ", top-minus-bottom decile " + pct(ev.spread));
    console.log("  Backtest " + pct(bt.totalReturn) + " vs equal-weight " + pct(bt.equalWeightReturn) + ", Sharpe " + (bt.sharpe || 0).toFixed(2) + ", max drawdown " + pct(-bt.maxDrawdown) + ", " + bt.nTrades + " trades");
    console.log("  Verdict: " + res.verdict.text);
    console.log("Latest predictions (" + res.cfg.horizon + "-day horizon, $" + res.cfg.amount + " each):");
    res.predictions.slice(0, 10).forEach(function (p) {
      console.log("  " + p.symbol.padEnd(8) + p.signal.padEnd(7) + " chance up " + (p.pUp * 100).toFixed(1) + "%, expected " + pct(p.expectedReturn) +
        ", likely " + pct(p.p10) + " to " + pct(p.p90) + ", expected P/L $" + p.expectedPnl.toFixed(0));
    });
    writeBook(F.resultSheets(res), path.join(out, "results.xlsx"));
    fs.writeFileSync(path.join(out, "predictions.csv"), T.Report.toCSV(F.predictionRows(res.predictions, ds)));
    fs.writeFileSync(path.join(out, "backtest.csv"), T.Report.toCSV(bt.periods));
    fs.writeFileSync(path.join(out, "trades.csv"), T.Report.toCSV(bt.trades));
    fs.writeFileSync(path.join(out, "model.json"), JSON.stringify(res.model));
    if (args["save-training"]) fs.writeFileSync(path.join(out, "training-data.csv.gz"), zlib.gzipSync(T.Report.toCSV(F.trainingRows(res.features))));
    console.log("Wrote results.xlsx, predictions.csv, backtest.csv, trades.csv, model.json" + (args["save-training"] ? ", training-data.csv.gz" : "") + " to " + out + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s.");
    if (args["push-docs"]) return require("./docs_node.js").send(T.DocsPush.finalBundle(res, !!args.sample), { repo: args["docs-repo"], base: args["docs-base"], git: args["docs-git"] })
      .then(function (r) { console.log("  Trading data bot: opened " + r.url + " (" + r.files + " files)"); });
  })
  .catch(function (e) { process.stdout.write("\n"); console.error(e.message); process.exit(1); });
