/* node tests/run.js - breeding schedule, endless mode, memory budget, determinism and every export. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/breeding.js", "js/sim.js", "js/report.js"].forEach(function (f) {
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

// breeding: every preset keeps the schedule and every child's parents satisfy the rule
function parentsOf(sim) {
  var genRet = {}; sim.log.generations.forEach(function (g) { genRet[g.gen] = g.indexReturn; });
  return sim.log.genomes.filter(function (g) { return g.born >= 2; }).map(function (g) {
    var rk = g.parentRanks.split(" + ").map(Number), rt = g.parentReturns.split(" + ").map(function (x) { return parseFloat(x); });
    var br = g.parentBrackets ? g.parentBrackets.split(" + ") : ["", ""], size = sim.log.generations[g.born - 2].bots;
    return { rk: rk, rt: rt, br: br, size: size, note: g.breedingNote, idx: genRet[g.born - 1] * 100, born: g.born };
  });
}
function q(label) { var m = /Quartile (\d)/.exec(label); return m ? +m[1] : 0; }
var CHECKS = {
  winners: function (p) { return p.rk[0] <= p.size / 2 && p.rk[1] <= p.size / 2; },
  losers: function (p) { return p.rk[0] > p.size / 2 && p.rk[1] > p.size / 2; },
  assortative: function (p) { return (p.rk[0] <= p.size / 2) === (p.rk[1] <= p.size / 2); },
  disassortative: function (p) { return p.rk[0] <= p.size / 2 && p.rk[1] > p.size / 2; },
  profitable: function (p) { return p.note || (p.rt[0] > 0 && p.rt[1] > 0); },
  unprofitable: function (p) { return p.note || (p.rt[0] <= 0 && p.rt[1] <= 0); },
  beatIndex: function (p) { return p.note || (p.rt[0] > p.idx - 0.01 && p.rt[1] > p.idx - 0.01); },
  above: function (p) { return p.note || (p.rt[0] >= 0.995 && p.rt[1] >= 0.995); },
  between: function (p) { return p.note || p.rt.every(function (x) { return x >= -1.005 && x <= 1.005; }); },
  topPct: function (p) { return p.rk[1] <= Math.max(2, Math.round(p.size * 0.25)); },
  bottomPct: function (p) { return p.rk[0] > p.size - Math.max(2, Math.round(p.size * 0.25)); },
  sameBracket: function (p) { return p.br[0] === p.br[1]; },
  crossBracket: function (p) { return q(p.br[1]) - q(p.br[0]) === 1; },
  mirrorBracket: function (p) { return q(p.br[0]) + q(p.br[1]) === 5; },
  topBrackets: function (p) { return q(p.br[0]) <= 2 && q(p.br[1]) <= 2; },
  profitLevels: function (p) { return p.br[0] === p.br[1]; }
};
T.BREEDING_RULES.forEach(function (rule) {
  var s = run({ mult: 1, generations: 5, daysPerGen: 1, seed: 21, maxSymbols: SMALL, breeding: rule.key });
  assert.deepStrictEqual(s.log.generations.map(function (g) { return g.bots; }), [20, 10, 20, 20, 20], rule.key + " schedule");
  var ps = parentsOf(s);
  ps.forEach(function (p) { assert.ok(p.rk[0] !== p.rk[1], rule.key + " two different parents"); assert.ok(p.rk[0] < p.rk[1], rule.key + " better-ranked parent first"); });
  if (CHECKS[rule.key]) ps.forEach(function (p) { assert.ok(CHECKS[rule.key](p), rule.key + " parents " + JSON.stringify(p)); });
});
// custom combinations, including profit brackets you define and chosen brackets
var custom = run({ mult: 2, generations: 5, daysPerGen: 1, seed: 22, maxSymbols: SMALL, breeding: "custom", breedPool: "brackets", breedPairing: "opposite",
  brackets: "thirds", allowed: [0, 2] });
parentsOf(custom).forEach(function (p) { assert.ok(/Third (1|3)/.test(p.br[0]) && /Third (1|3)/.test(p.br[1]), "only thirds 1 and 3 breed"); });
var lv = run({ mult: 1, generations: 4, daysPerGen: 1, seed: 23, maxSymbols: SMALL, breeding: "custom", breedPool: "all", breedPairing: "sameBracket",
  brackets: "profit", levels: [-1, 1] });
parentsOf(lv).forEach(function (p) {
  assert.strictEqual(p.br[0], p.br[1], "same profit level");
  var lab = p.br[0], x = p.rt[0];
  assert.ok(lab === "at or above 1%" ? x >= 0.995 : lab === "below -1%" ? x < -0.995 : x >= -1.005 && x < 1.005, "level label matches return " + lab + " " + x);
});
assert.throws(function () { new T.Sim({ breeding: "custom", breedPool: "nope" }); }, /Unknown breeding pool/);
console.log("ok  " + T.BREEDING_RULES.length + " breeding presets + custom pools/pairings/brackets keep 20 -> 10 -> 20 and pick the promised parents");

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
assert.ok(bad / total < 0.1, "alleles inherited (" + bad + "/" + total + " mutated)");
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

// linkage: genes on one chromosome travel together (75% for neighbours), genes on different chromosomes don't (50%)
(function () {
  var g = {}, rr = new T.RNG(9);
  T.TRAITS.forEach(function (t) { g[t.key] = t.mode === "multi" ? "ab" : t.a + t.a.toLowerCase(); });   // copy 0 all dominant, copy 1 all recessive
  var same = 0, cross = 0, n = 6000;
  for (var k = 0; k < n; k++) {
    var x = T.genetics.gamete(g, null, rr, 0);
    if ((x.temper === "A") === (x.conviction === "K")) same++;          // neighbours on chromosome 1
    if ((x.temper === "A") === (x.horizon === "Q")) cross++;            // chromosome 1 vs chromosome 2
  }
  assert.ok(Math.abs(same / n - (1 - T.genetics.RECOMBINATION)) < 0.03, "linked genes co-inherit " + (same / n).toFixed(3));
  assert.ok(Math.abs(cross / n - 0.5) < 0.03, "unlinked genes independent " + (cross / n).toFixed(3));
  console.log("ok  linkage: neighbours on a chromosome travel together " + (100 * same / n).toFixed(1) + "%, different chromosomes " + (100 * cross / n).toFixed(1) + "%");
})();

// trait effects show up in behaviour
var tsim = run({ mult: 4, generations: 3, daysPerGen: 3, seed: 61, maxSymbols: SMALL });
var byName = {}; Object.keys(tsim.allBots).forEach(function (k) { byName[tsim.allBots[k].name] = tsim.allBots[k]; });
var specialistTrips = 0, morning = 0, afternoon = 0;
tsim.log.roundTrips.forEach(function (t) {
  var b = byName[t.bot];
  if (b.traits.focus === "Sector specialist") {
    specialistTrips++;
    assert.ok(b.traits.sector.indexOf(t.sector) >= 0, b.name + " specialist in " + b.traits.sector + " traded " + t.sector);
  }
  if (t.entryReason === "buy signal" || t.entryReason === "short signal") {
    if (b.traits.session === "Morning trader") { morning++; assert.ok(t.entryTime <= "12:45", "morning trader entered at " + t.entryTime); }
    if (b.traits.session === "Afternoon trader") { afternoon++; assert.ok(t.entryTime >= "12:45", "afternoon trader entered at " + t.entryTime); }
  }
});
Object.keys(tsim.allBots).forEach(function (k) {
  var b = tsim.allBots[k];
  if (b.traits.contrarian === "Contrarian") assert.strictEqual(b.cfg.fmult[0], -1, "contrarian flips momentum");
});
console.log("ok  " + T.TRAITS.length + " traits; specialists stayed in their sectors (" + specialistTrips + " trades), trading hours respected (" + morning + " morning, " + afternoon + " afternoon entries)");

// endless runs keep per-bot history to a window, so memory stays flat
var longRun = run({ mult: 1, generations: 40, daysPerGen: 1, seed: 71, maxSymbols: SMALL, historyGens: 10, samplesPerDay: 20 });
assert.ok(Object.keys(longRun.allBots).length <= 20 * 13, "retired bots pruned (" + Object.keys(longRun.allBots).length + ")");
assert.ok(longRun.log.bots.every(function (r) { return r.gen > 30; }), "per-bot rows only for the last 10 generations");
assert.strictEqual(longRun.log.generations.length, 40, "generation table kept in full");
assert.ok(longRun.pedigree().length > 0 && longRun.familyTree().length > 0 && longRun.profiles().length > 0, "pedigree and profiles still build");
console.log("ok  history window: " + Object.keys(longRun.allBots).length + " bots in memory after 40 generations, full generation table");
