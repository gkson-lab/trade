#!/usr/bin/env node
/* Headless run: node cli.js --mult 2 --gens 6 --days 10 --seed 42 --out out
 * Writes out/<run>/trade-run.xlsx plus one CSV per sheet. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");

var args = {};
process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1] && arr[i + 1].indexOf("--") !== 0 ? arr[i + 1] : true; });
if (args.help) {
  console.log("usage: node cli.js [--mult 1] [--gens 6] [--days 10] [--seed N] [--fitness return|risk] [--symbols N] [--out out]");
  process.exit(0);
}

global.window = global;
var root = __dirname;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/sim.js", "js/report.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
});
var XLSX = require(path.join(root, "vendor", "xlsx.full.min.js"));

var sim = new T.Sim({
  mult: +(args.mult || 1), generations: +(args.gens || 6), daysPerGen: +(args.days || 10),
  seed: +(args.seed || 20270104), fitness: args.fitness || "return", maxSymbols: +(args.symbols || 0)
});
console.log("Box: " + sim.bots.length + " bots, " + sim.market.n + " symbols, " + sim.cfg.generations + " generations x " + sim.cfg.daysPerGen + " days");
var t0 = Date.now();
sim.on(function (type, d) {
  if (type === "generation") {
    var s = d.summary;
    console.log("Gen " + s.gen + " (" + s.bots + " bots)  avg " + pct(s.avgReturn) + "  best " + pct(s.bestReturn) + " " + s.bestBot +
      "  worst " + pct(s.worstReturn) + "  SIM500 " + pct(s.indexReturn) + "  trades " + s.totalTrades);
  }
});
while (!sim.done) sim.step();
var rep = sim.report();
console.log("Done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s. Avg return " + pct(rep.avgReturn) + ", avg win rate " + pct(rep.avgWinRate) +
  ", SIM 500 " + pct(rep.indexReturn));

var outDir = path.join(args.out || "out", "run-" + sim.cfg.seed + "-x" + sim.cfg.mult);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "trade-run.xlsx"), XLSX.write(T.Report.workbook(sim, XLSX), { type: "buffer", bookType: "xlsx" }));
T.Report.sheets(sim).forEach(function (s) {
  fs.writeFileSync(path.join(outDir, s[0].toLowerCase().replace(/ /g, "-") + ".csv"), T.Report.toCSV(s[1]));
});
console.log("Sheets written to " + outDir);

function pct(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%"; }
