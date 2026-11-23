/* node tests/run.js - checks the breeding schedule, determinism and report output on a small universe. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/sim.js", "js/report.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
function run(cfg) { var s = new T.Sim(cfg); while (!s.done) s.step(); return s; }

[1, 2, 4].forEach(function (mult) {
  var s = run({ mult: mult, generations: 5, daysPerGen: 1, seed: 11, maxSymbols: 400 });
  var sizes = s.log.generations.map(function (g) { return g.bots; });
  assert.deepStrictEqual(sizes, [20, 10, 20, 20, 20].map(function (x) { return x * mult; }), "schedule x" + mult + ": " + sizes);
  // gen 3+: half the box are children (twins), half are carried-over parents
  var born3 = s.log.bots.filter(function (b) { return b.gen === 3 && b.born === 3; }).length;
  assert.strictEqual(born3, 10 * mult, "gen 3 children");
  var kids = s.log.genomes.filter(function (g) { return g.born === 4; });
  var byParents = {};
  kids.forEach(function (k) { byParents[k.parents] = (byParents[k.parents] || 0) + 1; });
  Object.keys(byParents).forEach(function (p) { assert.strictEqual(byParents[p], 2, "twins for " + p); });
  console.log("ok  schedule x" + mult + ": " + sizes.join(" -> "));
});

var a = run({ mult: 1, generations: 2, daysPerGen: 2, seed: 99, maxSymbols: 400 });
var b = run({ mult: 1, generations: 2, daysPerGen: 2, seed: 99, maxSymbols: 400 });
assert.strictEqual(a.log.trades.length, b.log.trades.length);
assert.strictEqual(a.market.index, b.market.index);
console.log("ok  same seed, same run");

var sheets = T.Report.sheets(a);
assert.deepStrictEqual(sheets.map(function (s) { return s[0]; }), ["Summary", "Generations", "Bots", "Trades", "Equity Daily", "Market Daily", "News", "Genomes"]);
sheets.forEach(function (s) { assert.ok(s[1].length > 0, s[0] + " has rows"); });
a.log.bots.forEach(function (r) { assert.ok(isFinite(r.returnPct) && isFinite(r.sharpe), "finite stats"); });
var XLSX = require(path.join(__dirname, "..", "vendor", "xlsx.full.min.js"));
var buf = XLSX.write(T.Report.workbook(a, XLSX), { type: "buffer", bookType: "xlsx" });
assert.ok(buf.length > 1000);
console.log("ok  8 sheets, xlsx " + (buf.length / 1024).toFixed(0) + " KB");
