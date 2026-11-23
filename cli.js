#!/usr/bin/env node
/* Headless run.
 *   node cli.js --mult 2 --gens 6 --days 10 --seed 42 --out out
 *   node cli.js --forever                 run until Ctrl+C (or --max-gens N / --max-minutes M)
 *
 * Writes, as it goes:   out/run-<seed>-x<mult>/gen-0001/*.csv, gen-0002/*.csv, ...
 * At the end (or Ctrl+C): run-level CSVs, trade-run.xlsx (master workbook from memory),
 *                         all-generations.xlsx (every generation folder combined into one spreadsheet),
 *                         bots/<name>/*.csv individual bot data.
 * Flags: --no-master, --no-combine, --no-bots, --budget <rows kept in memory>. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");

var args = {};
process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1] && arr[i + 1].indexOf("--") !== 0 ? arr[i + 1] : true; });
if (args.help) {
  console.log("usage: node cli.js [--mult 1] [--gens 6 | --forever] [--days 10] [--cash 100000] [--seed N] [--fitness return|risk] [--symbols N]\n" +
    "                   [--max-gens N] [--max-minutes M] [--budget ROWS] [--out out] [--no-master] [--no-combine] [--no-bots]");
  process.exit(0);
}

global.window = global;
var root = __dirname;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/sim.js", "js/report.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
});
var XLSX = require(path.join(root, "vendor", "xlsx.full.min.js"));

var forever = !!args.forever || args.gens === "0";
var sim = new T.Sim({
  mult: +(args.mult || 1), generations: forever ? 0 : +(args.gens || 6), daysPerGen: +(args.days || 10),
  seed: +(args.seed || 20270104), fitness: args.fitness || "return", maxSymbols: +(args.symbols || 0),
  detailBudget: +(args.budget || 400000), startCash: +(args.cash || 100000)
});
var outDir = path.join(args.out || "out", "run-" + sim.cfg.seed + "-x" + sim.cfg.mult);
fs.mkdirSync(outDir, { recursive: true });
var maxGens = args["max-gens"] ? +args["max-gens"] : 0, deadline = args["max-minutes"] ? Date.now() + args["max-minutes"] * 60000 : 0;
console.log("Box: " + sim.bots.length + " bots with $" + sim.cfg.startCash.toLocaleString() + " each, " + sim.market.n + " symbols, " + (forever ? "endless" : sim.cfg.generations) +
  " generations x " + sim.cfg.daysPerGen + " days -> " + outDir);

var t0 = Date.now();
sim.on(function (type, d) {
  if (type !== "generation") return;
  var s = d.summary, dir = path.join(outDir, T.Report.genDir(s.gen));
  fs.mkdirSync(dir, { recursive: true });
  T.Report.generationFiles(d.rows).forEach(function (f) { fs.writeFileSync(path.join(dir, f.name), f.text); });
  console.log("Gen " + s.gen + " (" + s.bots + " bots)  avg " + pct(s.avgReturn) + "  best " + pct(s.bestReturn) + " " + s.bestBot +
    "  worst " + pct(s.worstReturn) + "  SIM500 " + pct(s.indexReturn) + "  Sharpe " + s.avgSharpe.toFixed(2) + "  trades " + s.totalTrades +
    "  heap " + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + "MB");
  if ((maxGens && s.gen >= maxGens) || (deadline && Date.now() > deadline)) sim.stop();
});

var stopping = false;
process.on("SIGINT", function () {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\nStopping: finishing the current generation (Ctrl+C again to quit without saving).");
  sim.stop();
});

// run in slices so Ctrl+C can be handled
(function loop() {
  var until = Date.now() + 200;
  while (!sim.done && Date.now() < until) sim.step();
  if (!sim.done) return setImmediate(loop);
  finish();
})();

function finish() {
  var rep = sim.report();
  console.log("Done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s. " + rep.generations + " generations, avg return " + pct(rep.avgReturn) +
    ", avg win rate " + pct(rep.avgWinRate) + ", SIM 500 " + pct(rep.indexReturn));
  T.Report.runLevelFiles(sim).forEach(function (f) { fs.writeFileSync(path.join(outDir, f.name), f.text); });
  if (!args["no-master"]) {
    fs.writeFileSync(path.join(outDir, "trade-run.xlsx"), XLSX.write(T.Report.master(sim, XLSX), { type: "buffer", bookType: "xlsx", compression: true }));
    console.log("Master workbook: " + path.join(outDir, "trade-run.xlsx") + (rep.trimmedThrough ? " (trade detail for gens 1-" + rep.trimmedThrough + " is in the gen folders)" : ""));
  }
  if (!args["no-bots"]) {
    var idx = null;
    sim.log.genomes.forEach(function (g) {
      var dir = path.join(outDir, "bots", g.bot);
      fs.mkdirSync(dir, { recursive: true });
      T.Report.botTables(sim, g.bot, idx || (idx = indexFor(sim))).forEach(function (s) {
        if (s[1].length) fs.writeFileSync(path.join(dir, s[0].toLowerCase().replace(/ /g, "-") + ".csv"), T.Report.toCSV(s[1]));
      });
    });
    console.log("Per-bot data: " + path.join(outDir, "bots"));
  }
  if (!args["no-combine"]) {
    var res = require("./tools/combine.js").combineDir(outDir, path.join(outDir, "all-generations.xlsx"));
    console.log("Combined " + res.files + " generation CSVs into " + path.join(outDir, "all-generations.xlsx") + " (" + res.sheets + " sheets, " + res.rows + " rows)");
  }
}

function indexFor(s) {
  var o = {};
  ["bots", "trades", "roundTrips", "botDaily", "equityIntraday", "positions"].forEach(function (k) {
    var g = {}; s.log[k].forEach(function (r) { (g[r.bot] = g[r.bot] || []).push(r); }); o[k] = g;
  });
  return o;
}
function pct(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%"; }
