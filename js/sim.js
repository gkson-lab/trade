/* Run controller: the box the bots live in.
 *
 * Population schedule (mult = 1, 2, 4, 8 ... scales every number):
 *   Gen 1: 20 random bots.
 *   Gen 2: Gen 1 pairs up (ranked neighbours: 1+2, 3+4, ...), each pair breeds ONE child -> 10 bots.
 *   Gen 3: Gen 2's 10 pair up, each pair has TWINS -> 10 children + 10 parents = 20 bots.
 *   Gen 4+: the top 10 of the previous 20 survive, pair up, have twins -> 20 bots again.
 * Every bot starts each generation with $100,000 in a market that keeps running between generations.
 */
(function (T) {
  "use strict";

  var BASE = 20;

  function Sim(cfg) {
    this.cfg = {
      mult: cfg.mult || 1,
      generations: cfg.generations || 6,
      daysPerGen: cfg.daysPerGen || 10,
      seed: cfg.seed || 20270104,
      fitness: cfg.fitness || "return",
      maxSymbols: cfg.maxSymbols || 0
    };
    this.rng = new T.RNG(this.cfg.seed);
    this.market = new T.Market({ seed: this.cfg.seed, maxSymbols: this.cfg.maxSymbols });
    this.nextId = 1;
    this.gen = 1;
    this.genDay = 0;
    this.genStartDay = 0;
    this.genStartIndex = this.market.index;
    this.done = false;
    this.log = { generations: [], bots: [], trades: [], equity: [], market: [], news: [], genomes: [] };
    this.allBots = Object.create(null);
    this.bots = [];
    var n = BASE * this.cfg.mult;
    for (var i = 0; i < n; i++) this.bots.push(this.newBot(T.Genome.random(this.rng), []));
    this.regimeDays = [0, 0, 0, 0];
    this.listeners = [];
  }

  Sim.prototype.on = function (fn) { this.listeners.push(fn); };
  Sim.prototype.emit = function (t, d) { for (var k = 0; k < this.listeners.length; k++) this.listeners[k](t, d); };

  Sim.prototype.newBot = function (genome, parents) {
    var b = new T.Bot(this.nextId++, this.gen, genome, parents, this.rng);
    this.allBots[b.id] = b;
    this.log.genomes.push({ id: b.id, name: b.name, born: this.gen, parents: parents.join(" + "), style: b.style, genome: JSON.stringify(b.genome.toJSON()) });
    return b;
  };

  Sim.prototype.expectedSize = function (g) {
    var m = this.cfg.mult;
    return g === 2 ? BASE / 2 * m : BASE * m;
  };

  /* One 5-minute bar for the whole box. */
  Sim.prototype.step = function () {
    if (this.done) return;
    var m = this.market, bots = this.bots;
    var closed = m.step();
    if (m.bar === 0 && closed) {
      // the bar that just ran was the close; bots already acted on bars 0..77
    }
    for (var i = 0; i < bots.length; i++) bots[i].act(m);
    if (closed) this.onClose();
  };

  Sim.prototype.onClose = function () {
    var m = this.market, d = m.day - 1;
    this.regimeDays[m.regime]++;
    var adv = 0, dec = 0;
    for (var i = 0; i < m.n; i++) { var c = m.dailyClose(i, 1), p = m.dailyClose(i, 2); if (c > p) adv++; else if (c < p) dec++; }
    var q = (m.dayIdx - 1) % m.DAILY;
    this.log.market.push({ gen: this.gen, day: d + 1, date: m.dateStr(d), open: m.idx.dO[q], high: m.idx.dH[q], low: m.idx.dL[q], close: m.idx.dC[q],
      changePct: m.idx.dC[q] / m.idx.dC[(m.dayIdx - 2) % m.DAILY] - 1, regime: m.REGIMES[m.regime].name,
      fedFunds: m.news.macro.fed, cpi: m.news.macro.cpi, unemployment: m.news.macro.unemp, advancers: adv, decliners: dec });
    var last = this.genDay === this.cfg.daysPerGen - 1;
    for (i = 0; i < this.bots.length; i++) {
      var b = this.bots[i];
      if (last) b.closeAll(m, "generation end");
      b.endOfDay(m);
      this.log.equity.push({ gen: this.gen, day: d + 1, date: m.dateStr(d), bot: b.name, equity: +b.equity.toFixed(2), returnPct: b.equity / T.BOT_CONST.START_CASH - 1 });
    }
    this.genDay++;
    this.emit("day", d);
    if (this.genDay >= this.cfg.daysPerGen) this.endGeneration();
  };

  Sim.prototype.fitnessOf = function (s) {
    return this.cfg.fitness === "risk" ? s.ret - 0.5 * s.maxDD + 0.002 * s.sharpe : s.ret + 1e-6 * s.sharpe;
  };

  Sim.prototype.endGeneration = function () {
    var m = this.market, self = this, g = this.gen;
    var rows = this.bots.map(function (b) { var s = b.stats(); return { bot: b, s: s, fit: self.fitnessOf(s) }; });
    rows.sort(function (a, b) { return b.fit - a.fit; });
    var idxRet = m.index / this.genStartIndex - 1;
    rows.forEach(function (r, k) {
      var b = r.bot, s = r.s, c = b.cfg;
      b.history.push({ gen: g, ret: s.ret, rank: k + 1 });
      self.log.bots.push({
        gen: g, rank: k + 1, id: b.id, bot: b.name, born: b.gen, parents: b.parents.join(" + "), style: b.style,
        returnPct: s.ret, pnl: +s.pnl.toFixed(2), finalEquity: +s.equity.toFixed(2), vsIndex: s.ret - idxRet,
        maxDrawdown: s.maxDD, sharpe: +s.sharpe.toFixed(3), trades: s.trades, closedTrades: s.closed, winRate: s.winRate,
        profitFactor: +s.profitFactor.toFixed(3), avgHoldDays: +s.avgHold.toFixed(2), fees: +s.fees.toFixed(2),
        bestTradePct: s.bestTrade, worstTradePct: s.worstTrade, marginCalls: s.marginCalls,
        maxPositions: c.maxPos, positionSize: c.posSize, stopLoss: c.stopLoss, takeProfit: c.takeProfit,
        decisionEveryBars: c.interval, maxHoldDays: c.maxHold, shorts: c.shortOn ? "yes" : "no", trailingStop: c.trail ? "yes" : "no"
      });
      for (var t = 0; t < b.trades.length; t++) {
        var tr = b.trades[t];
        self.log.trades.push({ gen: g, bot: b.name, date: m.dateStr(tr.day), time: barTime(tr.bar), symbol: tr.sym, side: tr.side,
          qty: tr.qty, price: +tr.px.toFixed(4), fee: +tr.fee.toFixed(2), realizedPnl: tr.pnl === null ? "" : +tr.pnl.toFixed(2), reason: tr.reason });
      }
    });
    var rets = rows.map(function (r) { return r.s.ret; });
    var summary = {
      gen: g, bots: rows.length, startDate: m.dateStr(this.genStartDay), endDate: m.dateStr(m.day - 1),
      avgReturn: mean(rets), medianReturn: median(rets), bestReturn: rets[0], worstReturn: Math.min.apply(null, rets),
      stdevReturn: stdev(rets), profitableBots: rets.filter(function (x) { return x > 0; }).length,
      avgSharpe: mean(rows.map(function (r) { return r.s.sharpe; })), avgMaxDrawdown: mean(rows.map(function (r) { return r.s.maxDD; })),
      avgWinRate: mean(rows.map(function (r) { return r.s.winRate; })), totalTrades: rows.reduce(function (a, r) { return a + r.s.trades; }, 0),
      avgPnl: mean(rows.map(function (r) { return r.s.pnl; })), totalFees: rows.reduce(function (a, r) { return a + r.s.fees; }, 0),
      indexReturn: idxRet, beatIndex: rets.filter(function (x) { return x > idxRet; }).length,
      bestBot: rows[0].bot.name, bestStyle: rows[0].bot.style,
      bullDays: this.regimeDays[0], neutralDays: this.regimeDays[1], bearDays: this.regimeDays[2], crashDays: this.regimeDays[3]
    };
    this.log.generations.push(summary);
    this.regimeDays = [0, 0, 0, 0];
    this.emit("generation", { summary: summary, ranked: rows, final: g >= this.cfg.generations });

    if (g >= this.cfg.generations) { this.finish(); return; }
    this.breed(rows.map(function (r) { return r.bot; }));
    this.gen++;
    this.genDay = 0;
    this.genStartDay = m.day;
    this.genStartIndex = m.index;
  };

  Sim.prototype.breed = function (ranked) {
    var r = this.rng, next = [], i, sigma = 0.25 * Math.pow(0.9, this.gen - 1) + 0.06;
    this.gen++;  // children are born into the next generation
    if (this.gen === 2) {
      // every pair produces one child: 20 -> 10
      for (i = 0; i + 1 < ranked.length; i += 2) next.push(this.child(ranked[i], ranked[i + 1], r, sigma));
    } else {
      var parents = this.gen === 3 ? ranked : ranked.slice(0, ranked.length / 2);
      for (i = 0; i < parents.length; i++) { parents[i].age++; parents[i].reset(); next.push(parents[i]); }
      for (i = 0; i + 1 < parents.length; i += 2) {
        next.push(this.child(parents[i], parents[i + 1], r, sigma));
        next.push(this.child(parents[i], parents[i + 1], r, sigma));   // twin
      }
    }
    this.gen--;
    this.bots = next;
  };

  Sim.prototype.child = function (a, b, r, sigma) {
    return this.newBot(T.Genome.cross(a.genome, b.genome, r, sigma), [a.name, b.name]);
  };

  Sim.prototype.finish = function () {
    var m = this.market;
    for (var k = 0; k < m.newsLog.length; k++) {
      var it = m.newsLog[k];
      this.log.news.push({ date: it.date, time: it.time, scope: it.scope, symbol: it.sym || (it.scope === "sector" ? T.SECTORS[it.target] : "MARKET"),
        kind: it.kind, headline: it.headline, impactPct: +(it.impact * 100).toFixed(3) });
    }
    this.done = true;
    this.emit("done", this.report());
  };

  Sim.prototype.report = function () {
    var gens = this.log.generations, bots = this.log.bots;
    var allRet = bots.map(function (b) { return b.returnPct; });
    var lineage = {};
    bots.forEach(function (b) { (lineage[b.bot] = lineage[b.bot] || []).push(b.returnPct); });
    var best = bots.slice().sort(function (a, b) { return b.returnPct - a.returnPct; })[0];
    return {
      config: this.cfg,
      generations: gens.length,
      botRuns: bots.length,
      uniqueBots: Object.keys(lineage).length,
      avgReturn: mean(allRet),
      medianReturn: median(allRet),
      avgSharpe: mean(bots.map(function (b) { return b.sharpe; })),
      avgWinRate: mean(bots.map(function (b) { return b.winRate; })),
      avgMaxDrawdown: mean(bots.map(function (b) { return b.maxDrawdown; })),
      avgPnl: mean(bots.map(function (b) { return b.pnl; })),
      totalTrades: this.log.trades.length,
      best: best,
      firstGenAvg: gens.length ? gens[0].avgReturn : 0,
      lastGenAvg: gens.length ? gens[gens.length - 1].avgReturn : 0,
      indexReturn: this.log.market.length ? this.log.market[this.log.market.length - 1].close / 5000 - 1 : 0
    };
  };

  function barTime(b) { var mins = 570 + b * 5, h = Math.floor(mins / 60), mm = mins % 60; return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
  function stdev(a) { var mu = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - mu) * (x - mu); }))); }

  T.Sim = Sim;
  T.stat = { mean: mean, median: median, stdev: stdev };
})(window.T = window.T || {});
