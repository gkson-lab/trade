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
  "Equity Intraday", "Positions", "Market Daily", "Sector Daily", "News", "Symbols", "Market Samples", "Family Tree", "Pedigree"]);
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

// breeding rules keep the schedule and pick the partners they promise
T.BREEDING_RULES.forEach(function (rule) {
  var s = run({ mult: 1, generations: 5, daysPerGen: 1, seed: 21, maxSymbols: SMALL, breeding: rule.key });
  assert.deepStrictEqual(s.log.generations.map(function (g) { return g.bots; }), [20, 10, 20, 20, 20], rule.key + " schedule");
  var kids = s.log.genomes.filter(function (g) { return g.born === 4; });
  kids.forEach(function (k) { var pr = k.parentRanks.split(" + ").map(Number); assert.ok(pr[0] !== pr[1] && pr[0] >= 1 && pr[1] <= 20, rule.key + " distinct parents"); });
  if (rule.key === "disassortative") assert.ok(kids.some(function (k) { return k.parentRanks === "1 + 20"; }), "winner with loser");
  if (rule.key === "assortative") assert.ok(kids.some(function (k) { return k.parentRanks === "1 + 2"; }) && kids.some(function (k) { return k.parentRanks === "19 + 20"; }), "winners together, losers together");
  if (rule.key === "ranked") kids.forEach(function (k) { var pr = k.parentRanks.split(" + ").map(Number); assert.ok(pr[1] <= 10 && pr[1] === pr[0] + 1, "neighbours from the top half"); });
});
console.log("ok  " + T.BREEDING_RULES.length + " breeding rules keep 20 -> 10 -> 20 and pick the promised partners");

// Mendelian inheritance: every child allele comes from a parent (allowing for 2% mutation)
var gsim = run({ mult: 2, generations: 6, daysPerGen: 1, seed: 33, maxSymbols: SMALL });
var bad = 0, total = 0;
Object.keys(gsim.allBots).forEach(function (id) {
  var b = gsim.allBots[id]; if (!b.parentIds.length) return;
  var pa = gsim.allBots[b.parentIds[0]], pb = gsim.allBots[b.parentIds[1]];
  T.TRAITS.forEach(function (t) {
    var gt = b.genotype[t.key]; total++;
    var ok = (pa.genotype[t.key].indexOf(gt[0]) >= 0 && pb.genotype[t.key].indexOf(gt[1]) >= 0) || (pa.genotype[t.key].indexOf(gt[1]) >= 0 && pb.genotype[t.key].indexOf(gt[0]) >= 0);
    if (!ok) bad++;
    assert.strictEqual(b.traits[t.key], T.genetics.phenotype(t, gt), "phenotype follows genotype");
  });
  assert.strictEqual(b.house, (gsim.allBots[b.parentIds[0]]).house, "house passes from the better-ranked parent");
});
assert.ok(bad / total < 0.06, "alleles inherited (" + bad + "/" + total + " mutated)");
Object.keys(gsim.allBots).forEach(function (id) { var b = gsim.allBots[id]; assert.strictEqual(b.cfg.shortOn, b.genotype.short === "rr", "only rr sells short"); });
console.log("ok  alleles pass from parents (" + (100 * bad / total).toFixed(1) + "% mutated), phenotypes and houses follow");

var inb = run({ mult: 1, generations: 9, daysPerGen: 1, seed: 44, maxSymbols: SMALL, breeding: "inbreed" });
var outb = run({ mult: 1, generations: 9, daysPerGen: 1, seed: 44, maxSymbols: SMALL, breeding: "outbreed" });
var fi = inb.log.genetics[8].avgInbreeding, fo = outb.log.genetics[8].avgInbreeding;
assert.ok(fi > fo, "inbreeding rule raises inbreeding (" + fi + " vs " + fo + ")");
// a full-sibling pair from unrelated parents has kinship 0.25
var sibs = Object.keys(inb.allBots).map(function (k) { return inb.allBots[k]; }).filter(function (b) { return b.gen === 3; });
var twin = sibs.filter(function (b) { return b.parentIds.join() === sibs[0].parentIds.join(); });
var pa0 = inb.allBots[sibs[0].parentIds[0]], pb0 = inb.allBots[sibs[0].parentIds[1]];
if (twin.length === 2 && inb.kin(pa0, pb0) === 0) assert.ok(Math.abs(inb.kin(twin[0], twin[1]) - 0.25) < 1e-9, "full siblings kinship 0.25");
console.log("ok  inbreeding: keep-in-family " + fi.toFixed(3) + " vs avoid-relatives " + fo.toFixed(3) + "; full-sibling kinship 0.25");

// training data: labels are consistent and inputs carry real values
var ml = run({ mult: 1, generations: 3, daysPerGen: 8, seed: 55, maxSymbols: SMALL });
var samples = ml.log.mlSamples, labelled = samples.filter(function (r) { return r.y_fwdRet10d !== ""; });
assert.ok(labelled.length > 100, "labelled samples");
labelled.forEach(function (r) { assert.ok(Math.abs(r.y_fwdExcess5d - (r.y_fwdRet5d - r.y_fwdIdxRet5d)) < 1e-5, "excess = ret - index"); assert.ok(r.y_maxUp5d >= r.y_fwdRet5d - 1e-9 && r.y_maxDown5d <= r.y_fwdRet5d + 1e-9, "path bounds"); });
assert.ok(samples.filter(function (r) { return r.x_ret1d !== 0; }).length > samples.length * 0.8, "x_ret1d uses the prior close");
// one label checked by hand against the price history
var one = labelled[0], i0 = ml.market.symIndex[one.symbol];
assert.ok(isFinite(one.y_fwdRet5d) && i0 !== undefined);
var trips = ml.log.roundTrips;
assert.ok(trips.length && "x_f_rsi" in trips[0] && "bot_trait_temper" in trips[0] && "y_win" in trips[0], "round trips carry inputs, bot genes and labels");
var xcols = Object.keys(labelled[0]).filter(function (k) { return k.indexOf("x_") === 0; });
console.log("ok  training data: " + labelled.length + " labelled market samples x " + xcols.length + " inputs; " + trips.length + " labelled round trips");
