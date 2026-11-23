/* node tests/run.js - breeding schedule, endless mode, memory budget, determinism and every export. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/sim.js", "js/report.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
var XLSX = require(path.join(__dirname, "..", "vendor", "xlsx.full.min.js"));
function run(cfg, hook) { var s = new T.Sim(cfg); if (hook) hook(s); while (!s.done) s.step(); return s; }
var SMALL = 400;

[1, 2, 4].forEach(function (mult) {
  var s = run({ mult: mult, generations: 5, daysPerGen: 1, seed: 11, maxSymbols: SMALL });
  var sizes = s.log.generations.map(function (g) { return g.bots; });
  assert.deepStrictEqual(sizes, [20, 10, 20, 20, 20].map(function (x) { return x * mult; }), "schedule x" + mult + ": " + sizes);
  var born3 = s.log.bots.filter(function (b) { return b.gen === 3 && b.born === 3; }).length;
  assert.strictEqual(born3, 10 * mult, "gen 3 children");
  var byParents = {};
  s.log.genomes.filter(function (g) { return g.born === 4; }).forEach(function (k) { byParents[k.parents] = (byParents[k.parents] || 0) + 1; });
  Object.keys(byParents).forEach(function (p) { assert.strictEqual(byParents[p], 2, "twins for " + p); });
  console.log("ok  schedule x" + mult + ": " + sizes.join(" -> "));
});

// endless run: keeps going until stopped
var endless = run({ mult: 1, generations: 0, daysPerGen: 1, seed: 5, maxSymbols: SMALL }, function (s) {
  s.on(function (t, d) { if (t === "generation" && d.summary.gen === 9) s.stop(); });
});
assert.ok(endless.forever);
assert.strictEqual(endless.log.generations.length, 9);
assert.deepStrictEqual(endless.log.generations.slice(3).map(function (g) { return g.bots; }), [20, 20, 20, 20, 20, 20]);
console.log("ok  endless run stopped on request after 9 generations");

// memory budget drops the oldest generations' detail but keeps summaries
var tight = run({ mult: 1, generations: 6, daysPerGen: 2, seed: 8, maxSymbols: SMALL, detailBudget: 3000 });
assert.ok(tight.trimmedThrough >= 1, "trimmed");
assert.strictEqual(tight.log.generations.length, 6);
assert.strictEqual(tight.log.bots.length, 20 + 10 + 20 * 4);
T.DETAIL_TABLES.forEach(function (k) { tight.log[k].forEach(function (r) { assert.ok(r.gen > tight.trimmedThrough, k + " row from trimmed gen"); }); });
console.log("ok  detail budget: dropped gens 1-" + tight.trimmedThrough + ", summaries intact");

// end now, mid-generation
var cut = new T.Sim({ mult: 1, generations: 0, daysPerGen: 5, seed: 3, maxSymbols: SMALL });
for (var i = 0; i < 78 * 7 + 20; i++) cut.step();
cut.endNow();
assert.ok(cut.done);
assert.strictEqual(cut.log.generations.length, 2);
cut.bots.forEach(function (b) { assert.strictEqual(b.nPos, 0, "flat after endNow"); });
console.log("ok  end-now scores the partial generation and flattens every bot");

[5000, 2500000].forEach(function (cash) {
  var c = run({ mult: 1, generations: 2, daysPerGen: 2, seed: 4, maxSymbols: SMALL, startCash: cash });
  c.log.botDaily.filter(function (r) { return r.day === 1; }).forEach(function (r) { assert.ok(Math.abs(r.equity / cash - 1) < 0.2, "equity near start cash"); });
  c.log.bots.forEach(function (r) { assert.ok(Math.abs(r.finalEquity - cash * (1 + r.returnPct)) < 0.05, "return measured on start cash"); });
  assert.ok(c.log.trades.length > 0, "bots trade with $" + cash);
  console.log("ok  starting cash $" + cash.toLocaleString() + ": " + c.log.trades.length + " trades");
});

var a = run({ mult: 1, generations: 3, daysPerGen: 2, seed: 99, maxSymbols: SMALL });
var b = run({ mult: 1, generations: 3, daysPerGen: 2, seed: 99, maxSymbols: SMALL });
assert.strictEqual(a.log.trades.length, b.log.trades.length);
assert.strictEqual(a.market.index, b.market.index);
console.log("ok  same seed, same run");

var names = T.Report.sheets(a).map(function (s) { return s[0]; });
assert.deepStrictEqual(names, ["Summary", "Generations", "Genetics", "Bots", "Bot Profiles", "Genomes", "Trades", "Round Trips", "Bot Daily",
  "Equity Intraday", "Positions", "Market Daily", "Sector Daily", "News", "Symbols"]);
T.Report.sheets(a).forEach(function (s) {
  assert.ok(s[1].length > 0, s[0] + " has rows");
  s[1].slice(0, 500).forEach(function (r) { for (var k in r) assert.ok(!(typeof r[k] === "number" && !isFinite(r[k])), s[0] + "." + k + " is finite"); });
});
var trips = a.log.roundTrips, closedPnl = trips.reduce(function (x, t) { return x + t.pnl; }, 0);
var realized = a.log.trades.reduce(function (x, t) { return x + (t.realizedPnl === "" ? 0 : t.realizedPnl); }, 0);
assert.ok(Math.abs(closedPnl - realized) < 1 + trips.length * 0.01, "round trips reconcile with fills");

var wb = T.Report.master(a, XLSX);
assert.deepStrictEqual(wb.SheetNames.slice(-3), ["Gen 1", "Gen 2", "Gen 3"]);
var buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
console.log("ok  master workbook: " + wb.SheetNames.length + " sheets, " + (buf.length / 1024).toFixed(0) + " KB");

var bw = T.Report.botWorkbook(a, a.log.bots[0].bot, XLSX);
assert.ok(bw.SheetNames.indexOf("Round Trips") >= 0 && bw.SheetNames.indexOf("Daily Ledger") >= 0);
var pb = T.Report.perBotWorkbook(a, XLSX);
assert.strictEqual(pb.SheetNames.length, 1 + a.log.genomes.length);
console.log("ok  per-bot workbooks (" + pb.SheetNames.length + " sheets)");

var gz = T.Report.generationsZip(a, XLSX, "buffer"), files = T.Report.unzip(XLSX, gz);
assert.ok(files.some(function (f) { return f.name === "gen-0003/round-trips.csv"; }), "gen folder in zip");
var bz = T.Report.unzip(XLSX, T.Report.botsZip(a, XLSX, "buffer"));
assert.ok(bz.some(function (f) { return /^bots\/[^/]+\/daily-ledger\.csv$/.test(f.name); }), "bot folder in zip");
var combined = T.Report.combine(files.filter(function (f) { return /^gen-/.test(f.name); }), XLSX);
var trades = XLSX.utils.sheet_to_json(combined.workbook.Sheets.Trades);
assert.strictEqual(trades.length, a.log.trades.length, "combined trades = all trades");
assert.ok(trades[0].source === "gen-0001" && typeof trades[0].qty === "number");
console.log("ok  zips + combine: " + files.length + " CSVs -> " + combined.sheets + " sheets, " + combined.rows + " rows");
