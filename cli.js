#!/usr/bin/env node
/* Headless run.
 *   node cli.js --mult 2 --gens 6 --days 10 --seed 42 --out out
 *   node cli.js --forever                 run until Ctrl+C (or --max-gens N / --max-minutes M)
 *
 * Writes, as it goes:   out/run-<seed>-x<mult>/gen-0001/*.csv, gen-0002/*.csv, ...  (each row once)
 * At the end (or Ctrl+C): run-level CSVs (generations, bots, genetics, family tree, symbols ...).
 * Optional copies (they repeat the same rows, so they multiply disk use):
 *   --xlsx          trade-run.xlsx (master workbook) and all-generations.xlsx (every generation folder combined)
 *   --bot-folders   bots/<name>/*.csv, the same rows split per bot
 * Size: --gzip writes .csv.gz (about 3x smaller; pandas and tools/combine.js read it directly),
 *       --lean = --gzip plus 50 training samples a day instead of 150, --samples N sets that directly.
 * Memory: --budget <cells kept in memory, ~50 bytes each; default 6,000,000>, --history <generations of per-bot history
 *   kept in memory, default 300>. The gen folders on disk always hold everything, including births.csv (every bot born). */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");

var args = {};
process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1] && arr[i + 1].indexOf("--") !== 0 ? arr[i + 1] : true; });
if (args.help) {
  console.log("usage: node cli.js [--mult 1] [--gens 6 | --forever] [--days 10] [--cash 100000] [--breeding PRESET | --pool P --pairing Q --brackets B ...] [--list-breeding] [--mutation 1] [--samples 150] [--seed N] [--fitness return|risk] [--symbols N]\n" +
    "                   [--max-gens N] [--max-minutes M] [--budget CELLS] [--history GENS] [--out out] [--gzip] [--lean] [--xlsx] [--bot-folders]");
  process.exit(0);
}

global.window = global;
var root = __dirname;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/breeding.js", "js/sim.js", "js/report.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
});
var XLSX = require(path.join(root, "vendor", "xlsx.full.min.js"));

if (args.breeding && !T.Breeding.find(T.Breeding.PRESETS, args.breeding)) {
  console.error("Unknown --breeding " + args.breeding + ". Choose one of: " + T.Breeding.PRESETS.map(function (r) { return r.key; }).join(", "));
  process.exit(2);
}
if (args["list-breeding"]) {
  console.log("Presets (--breeding):");
  T.Breeding.PRESETS.forEach(function (p) { console.log("  " + p.key.padEnd(15) + p.name); });
  console.log("\nPools (--pool):"); T.Breeding.POOLS.forEach(function (p) { console.log("  " + p.key.padEnd(15) + p.desc); });
  console.log("\nPairings (--pairing):"); T.Breeding.PAIRINGS.forEach(function (p) { console.log("  " + p.key.padEnd(15) + p.desc); });
  console.log("\nBrackets (--brackets): " + T.Breeding.BRACKETS.map(function (b) { return b.key; }).join(", ") + "  (profit uses --levels -2,0,2)");
  console.log("Also: --threshold N --threshold2 N (percent), --pct N (top/bottom share), --allowed 1,2 (bracket numbers, 1 = top)");
  process.exit(0);
}
var forever = !!args.forever || args.gens === "0";
var sim;
try { sim = new T.Sim({
  mult: +(args.mult || 1), generations: forever ? 0 : +(args.gens || 6), daysPerGen: +(args.days || 10),
  seed: +(args.seed || 20270104), fitness: args.fitness || "return", maxSymbols: +(args.symbols || 0),
  detailBudget: +(args.budget || 6000000), historyGens: +(args.history || 300), startCash: +(args.cash || 100000),
  breeding: args.breeding || (args.pool || args.pairing ? "custom" : "ranked"), mutation: +(args.mutation || 1),
  breedPool: args.pool, breedPairing: args.pairing, brackets: args.brackets,
  levels: args.levels ? String(args.levels).split(",").map(Number) : undefined, threshold: args.threshold, threshold2: args.threshold2,
  pct: args.pct ? +args.pct : undefined, allowed: args.allowed ? String(args.allowed).split(",").map(function (x) { return +x - 1; }) : undefined, samplesPerDay: args.samples !== undefined ? +args.samples : (args.lean ? 50 : 150)
}); } catch (e) { console.error(e.message + ". Run with --list-breeding to see the choices."); process.exit(2); }
console.log("Breeding: " + sim.ruleName);
var outDir = path.join(args.out || "out", "run-" + sim.cfg.seed + "-x" + sim.cfg.mult);
var GZ = !!(args.gzip || args.lean), zlib = require("zlib");
// one writer for every CSV: plain, or gzip when asked
function writeCSV(file, text) {
  if (GZ) fs.writeFileSync(file + ".gz", zlib.gzipSync(text, { level: 6 }));
  else fs.writeFileSync(file, text);
}
fs.mkdirSync(outDir, { recursive: true });
var maxGens = args["max-gens"] ? +args["max-gens"] : 0, deadline = args["max-minutes"] ? Date.now() + args["max-minutes"] * 60000 : 0;
console.log("Box: " + sim.bots.length + " bots with $" + sim.cfg.startCash.toLocaleString() + " each, " + sim.market.n + " symbols, " + (forever ? "endless" : sim.cfg.generations) +
  " generations x " + sim.cfg.daysPerGen + " days -> " + outDir);

var t0 = Date.now();
sim.on(function (type, d) {
  if (type !== "generation") return;
  var s = d.summary, dir = path.join(outDir, T.Report.genDir(s.gen));
  fs.mkdirSync(dir, { recursive: true });
  T.Report.generationFiles(d.rows).forEach(function (f) { writeCSV(path.join(dir, f.name), f.text); });
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
  T.Report.runLevelFiles(sim).forEach(function (f) { writeCSV(path.join(outDir, f.name), f.text); });
  if (sim.unfinishedSamples && sim.unfinishedSamples.length) {
    // samples from the last 10 days: some forward labels are still blank because the run ended first
    writeCSV(path.join(outDir, T.Report.genDir(rep.generations), "market-samples-partial.csv"), T.Report.toCSV(sim.unfinishedSamples));
  }
  if (args.xlsx) {
    fs.writeFileSync(path.join(outDir, "trade-run.xlsx"), XLSX.write(T.Report.master(sim, XLSX), { type: "buffer", bookType: "xlsx", compression: true }));
    console.log("Master workbook: " + path.join(outDir, "trade-run.xlsx") + (rep.trimmedThrough ? " (trade detail for gens 1-" + rep.trimmedThrough + " is in the gen folders)" : ""));
  }
  if (args["bot-folders"]) {
    var idx = null;
    sim.log.genomes.forEach(function (g) {
      var dir = path.join(outDir, "bots", g.bot);
      fs.mkdirSync(dir, { recursive: true });
      T.Report.botTables(sim, g.bot, idx || (idx = indexFor(sim))).forEach(function (s) {
        if (s[1].length) writeCSV(path.join(dir, s[0].toLowerCase().replace(/ /g, "-") + ".csv"), T.Report.toCSV(s[1]));
      });
    });
    console.log("Per-bot data: " + path.join(outDir, "bots"));
  }
  if (args.xlsx) {
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
