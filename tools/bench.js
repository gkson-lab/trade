#!/usr/bin/env node
/* Speed check: simulated trading days per second, and how the time splits between the market and the bots.
 *   node tools/bench.js                 20, 80 and 320 bots on the full market
 *   node tools/bench.js --symbols 1500  a smaller market (what "Market size" does in the app) */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
global.window = global;
var root = path.join(__dirname, "..");
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/breeding.js", "js/sim.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
});
var args = {}; process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1]; });
var mults = (args.mult || "1,4,16").split(",").map(Number), days = +(args.days || 6), symbols = +(args.symbols || 0);
mults.forEach(function (mult) {
  var sim = new T.Sim({ mult: mult, generations: 0, daysPerGen: 1000, seed: 9, maxSymbols: symbols });
  var m = sim.market, tMarket = 0, tBots = 0, now = process.hrtime.bigint;
  for (var d = 0; d < days; d++) for (var b = 0; b < m.BARS_PER_DAY; b++) {
    var t0 = now(); var closed = m.step(); var t1 = now();
    for (var i = 0; i < sim.bots.length; i++) sim.bots[i].act(m);
    var t2 = now(); if (closed) sim.onClose();
    tMarket += Number(t1 - t0); tBots += Number(t2 - t1);
  }
  var total = (tMarket + tBots) / 1e9;
  console.log(("x" + mult + " (" + sim.bots.length + " bots, " + m.n + " symbols)").padEnd(30) + (days / total).toFixed(2).padStart(7) + " days/s   market " +
    (tMarket / 1e6 / days / m.BARS_PER_DAY).toFixed(2) + " ms/bar   bots " + (tBots / 1e6 / days / m.BARS_PER_DAY).toFixed(2) + " ms/bar");
});
