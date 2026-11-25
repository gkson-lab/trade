/* Sanity statistics for the market model: node tests/market_stats.js [days] */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
var days = +(process.argv[2] || 250);
var m = new T.Market({ seed: +(process.argv[3] || 7) });
var idx = [m.index], reg = [], bigMoves = 0, n = m.n, dailyAbs = [];
var regCount = [0, 0, 0, 0], newsLog = [];
for (var d = 0; d < days; d++) {
  for (var b = 0; b < m.BARS_PER_DAY; b++) m.step();
  newsLog = newsLog.concat(m.drainNews());
  idx.push(m.index); regCount[m.regime]++;
  var big = 0;
  for (var i = 0; i < n; i++) { var r = m.dailyClose(i, 1) / m.dailyClose(i, 2) - 1; if (Math.abs(r) > 0.1) big++; }
  dailyAbs.push(big);
}
var rets = []; for (d = 1; d < idx.length; d++) rets.push(Math.log(idx[d] / idx[d - 1]));
var mu = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
var sd = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / rets.length);
var k = rets.reduce(function (a, b) { return a + Math.pow((b - mu) / sd, 4); }, 0) / rets.length;
var worst = Math.min.apply(null, rets), best = Math.max.apply(null, rets);
var ab = rets.map(function (x) { return Math.abs(x - mu); }), am = ab.reduce(function (a, b) { return a + b; }, 0) / ab.length;
var num = 0, den = 0; for (d = 0; d < ab.length; d++) { den += (ab[d] - am) * (ab[d] - am); if (d) num += (ab[d] - am) * (ab[d - 1] - am); }
var ac = num / den;
console.log("days", days, "SIM500", idx[0].toFixed(0), "->", m.index.toFixed(0));
console.log("ann drift", (mu * 252 * 100).toFixed(1) + "%", "ann vol", (sd * Math.sqrt(252) * 100).toFixed(1) + "%", "kurtosis", k.toFixed(2),
  "best day", (best * 100).toFixed(2) + "%", "worst day", (worst * 100).toFixed(2) + "%", "|r| autocorr", ac.toFixed(2));
console.log("regime days bull/neutral/bear/crash", regCount.join("/"));
console.log("avg stocks moving >10%/day", (dailyAbs.reduce(function (a, b) { return a + b; }, 0) / days).toFixed(1), "of", n);
var pr = []; for (i = 0; i < n; i++) pr.push(m.price[i] / m.price0[i]);
pr.sort(function (a, b) { return a - b; });
console.log("stock price ratio p5/p50/p95", pr[Math.floor(n * 0.05)].toFixed(2), pr[Math.floor(n * 0.5)].toFixed(2), pr[Math.floor(n * 0.95)].toFixed(2));
console.log("news items", newsLog.length, "per day", (newsLog.length / days).toFixed(1));
var kinds = {}; newsLog.forEach(function (x) { kinds[x.kind] = (kinds[x.kind] || 0) + 1; }); console.log(kinds);
var big = newsLog.filter(function (x) { return Math.abs(x.impact) > 0.15; }).slice(0, 8).map(function (x) { return x.sym + " " + (x.impact * 100).toFixed(1) + "% " + x.headline; });
console.log(big.join("\n"));
