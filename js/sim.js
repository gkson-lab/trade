/* Run controller: the box the bots live in.
 *
 * Population schedule (mult = 1, 2, 4, 8 ... scales every number):
 *   Gen 1: 20 random bots.
 *   Gen 2: Gen 1 pairs up (ranked neighbours: 1+2, 3+4, ...), each pair breeds ONE child -> 10 bots.
 *   Gen 3: Gen 2's 10 pair up, each pair has TWINS -> 10 children + 10 parents = 20 bots.
 *   Gen 4+: the top 10 of the previous 20 survive, pair up, have twins -> 20 bots again.
 * generations = 0 runs forever (until stop() / endNow()).
 *
 * Data: summary tables (generations, genetics, bots, genomes, market/sector daily) are kept for the whole run.
 * Detail tables (trades, round trips, bot daily ledger, intraday equity, positions, news) are kept up to
 * cfg.detailBudget rows; past that the oldest generations' detail is dropped from memory. Every generation's
 * rows are also handed to listeners ("generation" event, d.rows) so the CLI can write them to disk as it goes.
 */
(function (T) {
  "use strict";

  var BASE = 20;
  var DETAIL = ["trades", "roundTrips", "botDaily", "equityIntraday", "positions", "news"];

  function Sim(cfg) {
    this.cfg = {
      mult: cfg.mult || 1,
      generations: cfg.generations === 0 || cfg.forever ? 0 : (cfg.generations || 6),
      daysPerGen: cfg.daysPerGen || 10,
      seed: cfg.seed || 20270104,
      fitness: cfg.fitness || "return",
      maxSymbols: cfg.maxSymbols || 0,
      detailBudget: cfg.detailBudget || 1500000,
      startCash: cfg.startCash > 0 ? cfg.startCash : 100000
    };
    this.forever = this.cfg.generations === 0;
    this.rng = new T.RNG(this.cfg.seed);
    this.market = new T.Market({ seed: this.cfg.seed, maxSymbols: this.cfg.maxSymbols });
    this.nextId = 1;
    this.gen = 1;
    this.genDay = 0;
    this.genStartDay = 0;
    this.genStartIndex = this.market.index;
    this.done = false;
    this.stopRequested = false;
    this.trimmedThrough = 0;
    this.fund = 1; this.idxFund = 1;
    this.log = { generations: [], genetics: [], bots: [], genomes: [], market: [], sectors: [],
      trades: [], roundTrips: [], botDaily: [], equityIntraday: [], positions: [], news: [] };
    this.cur = this.emptyRows();
    this.allBots = Object.create(null);
    this.alive = Object.create(null);
    this.symTrades = new Int32Array(this.market.n);
    this.symPnl = new Float64Array(this.market.n);
    this.bots = [];
    var n = BASE * this.cfg.mult;
    for (var i = 0; i < n; i++) this.bots.push(this.newBot(T.Genome.random(this.rng), []));
    this.markAlive();
    this.regimeDays = [0, 0, 0, 0];
    this.listeners = [];
    this.startedAt = Date.now();
    var self = this;
    this.market.on(function (t, d) {
      if (t === "dividend") self.bots.forEach(function (b) { b.onDividend(d.i, d.amount); });
      else if (t === "split") self.bots.forEach(function (b) { b.onSplit(self.market, d.i, d.f); });
    });
  }

  Sim.prototype.emptyRows = function () { return { trades: [], roundTrips: [], botDaily: [], equityIntraday: [], positions: [], news: [], market: [], sectors: [] }; };
  Sim.prototype.on = function (fn) { this.listeners.push(fn); };
  Sim.prototype.emit = function (t, d) { for (var k = 0; k < this.listeners.length; k++) this.listeners[k](t, d); };
  Sim.prototype.markAlive = function () { var a = Object.create(null); this.bots.forEach(function (b) { a[b.id] = 1; }); this.alive = a; };

  Sim.prototype.newBot = function (genome, parents) {
    var b = new T.Bot(this.nextId++, this.gen, genome, parents.map(function (p) { return p.name; }), this.rng, this.cfg.startCash);
    b.parentIds = parents.map(function (p) { return p.id; });
    this.allBots[b.id] = b;
    var c = b.cfg, imp = genome.importance(), names = T.BOT_CONST.FEATURE_NAMES;
    var top = Array.prototype.map.call(imp, function (v, k) { return [v, k]; }).sort(function (a, z) { return z[0] - a[0]; }).slice(0, 3)
      .map(function (x) { return names[x[1]] + " " + (x[0] * 100).toFixed(0) + "%"; }).join(", ");
    this.log.genomes.push({ id: b.id, bot: b.name, born: this.gen, parents: b.parents.join(" + "), parentIds: b.parentIds.join(" "), style: b.style,
      topFeatures: top, buyThreshold: c.buyTh, sellThreshold: c.sellTh, maxPositions: c.maxPos, positionSize: c.posSize, stopLoss: c.stopLoss,
      takeProfit: c.takeProfit, decisionEveryBars: c.interval, maxHoldDays: c.maxHold, cashReserve: c.cashReserve, shorts: c.shortOn ? "yes" : "no",
      trailingStop: c.trail ? "yes" : "no", conviction: c.conviction, genome: JSON.stringify(genome.toJSON()) });
    return b;
  };

  Sim.prototype.expectedSize = function (g) { var m = this.cfg.mult; return g === 2 ? BASE / 2 * m : BASE * m; };
  Sim.prototype.isFinalGen = function (g) { return !this.forever && g >= this.cfg.generations; };

  /* One 5-minute bar for the whole box. */
  Sim.prototype.step = function () {
    if (this.done) return;
    var m = this.market, bots = this.bots;
    var closed = m.step();
    for (var i = 0; i < bots.length; i++) bots[i].act(m);
    if (closed) this.onClose();
  };

  function barTime(b) { var mins = 570 + b * 5, h = Math.floor(mins / 60), mm = mins % 60; return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm; }
  function r4(x) { return x === null || x === undefined || !isFinite(x) ? x : Math.round(x * 10000) / 10000; }
  function r2(x) { return x === null || x === undefined || !isFinite(x) ? x : Math.round(x * 100) / 100; }

  Sim.prototype.onClose = function () {
    var m = this.market, d = m.day - 1, g = this.gen, date = m.dateStr(d), cur = this.cur, i;
    this.regimeDays[m.regime]++;
    var q = (m.dayIdx - 1) % m.DAILY, br = m.lastBreadth || {};
    var news = m.drainNews();
    cur.market.push({ gen: g, day: d + 1, date: date, open: r2(m.idx.dO[q]), high: r2(m.idx.dH[q]), low: r2(m.idx.dL[q]), close: r2(m.idx.dC[q]),
      changePct: m.idx.dC[q] / m.idx.dC[(m.dayIdx - 2) % m.DAILY] - 1, regime: m.REGIMES[m.regime].name, simVix: br.vix,
      fedFunds: m.news.macro.fed, cpi: r2(m.news.macro.cpi), unemployment: r2(m.news.macro.unemp), gdp: r2(m.news.macro.gdp),
      advancers: br.advancers, decliners: br.decliners, unchanged: br.unchanged, adRatio: br.decliners ? r4(br.advancers / br.decliners) : null,
      upVolume: Math.round(br.upVolume), downVolume: Math.round(br.downVolume), newHighs: br.newHighs, newLows: br.newLows,
      pctAbove20d: br.above20d / m.n, dollarVolumeB: r2(br.dollarVolume / 1e9), haltedNames: br.halted, newsItems: news.length });
    var srow = { gen: g, day: d + 1, date: date };
    T.SECTORS.forEach(function (s, k) { srow[s] = m.lastSectorRet[k]; srow[s + " level"] = r2(m.sectorIdx[k]); });
    cur.sectors.push(srow);
    for (i = 0; i < news.length; i++) {
      var it = news[i];
      cur.news.push({ gen: g, date: it.date, time: it.time, scope: it.scope, symbol: it.sym || (it.scope === "sector" ? T.SECTORS[it.target] : "MARKET"),
        kind: it.kind, headline: it.headline, impactPct: r4(it.impact), sentiment: r2(it.sentiment), simVix: it.vix,
        epsActual: it.epsActual === undefined ? "" : it.epsActual, epsEstimate: it.epsEstimate === undefined ? "" : it.epsEstimate,
        surprisePct: it.surprisePct === undefined ? "" : it.surprisePct });
    }
    var last = this.genDay === this.cfg.daysPerGen - 1;
    for (i = 0; i < this.bots.length; i++) {
      var b = this.bots[i];
      if (last) b.closeAll(m, "generation end");
      var L = b.endOfDay(m);
      cur.botDaily.push({ gen: g, day: d + 1, date: date, bot: b.name, equity: r2(L.equity), cash: r2(L.cash), dailyPnl: r2(L.dailyPnl),
        dailyReturn: L.dailyReturn, genReturn: L.equity / b.startCash - 1, drawdown: L.drawdown, positions: L.positions,
        grossExposure: r4(L.grossExposure), netExposure: r4(L.netExposure), trades: L.trades, buys: L.buys, sells: L.sells,
        notional: r2(L.notional), realizedPnl: r2(L.realizedPnl), fees: r2(L.fees), borrowCost: r2(L.borrowCost), dividends: r2(L.dividends),
        indexClose: r2(m.index) });
      for (var k in b.pos) {
        var p = b.pos[k], px = m.price[k];
        cur.positions.push({ gen: g, day: d + 1, date: date, bot: b.name, symbol: m.sym[k], sector: T.SECTORS[m.sector[k]], side: p.q > 0 ? "LONG" : "SHORT",
          qty: Math.abs(p.q), avgCost: r4(p.avg), close: r4(px), marketValue: r2(p.q * px), unrealizedPnl: r2((px - p.avg) * p.q),
          unrealizedPct: (px / p.avg - 1) * (p.q > 0 ? 1 : -1), daysHeld: m.day - p.day, entryScore: p.score });
      }
    }
    this.genDay++;
    this.emit("day", d);
    if (this.genDay >= this.cfg.daysPerGen) this.endGeneration();
  };

  Sim.prototype.fitnessOf = function (s) {
    return this.cfg.fitness === "risk" ? s.ret - 0.5 * s.maxDD + 0.002 * s.sharpe : s.ret + 1e-6 * s.sharpe;
  };

  Sim.prototype.endGeneration = function () {
    var m = this.market, self = this, g = this.gen, cur = this.cur;
    var rows = this.bots.map(function (b) { var s = b.stats(); return { bot: b, s: s, fit: self.fitnessOf(s) }; });
    rows.sort(function (a, b) { return b.fit - a.fit; });
    var idxRet = m.index / this.genStartIndex - 1;
    var botRows = [];
    rows.forEach(function (r, k) {
      var b = r.bot, s = r.s, c = b.cfg;
      b.history.push({ gen: g, ret: s.ret, rank: k + 1 });
      botRows.push({
        gen: g, rank: k + 1, id: b.id, bot: b.name, born: b.gen, age: b.age, parents: b.parents.join(" + "), style: b.style,
        returnPct: s.ret, pnl: r2(s.pnl), finalEquity: r2(s.equity), annualizedReturn: s.annReturn, vsIndex: s.ret - idxRet,
        volatility: s.volatility, sharpe: r4(s.sharpe), sortino: r4(s.sortino), calmar: r4(s.calmar), maxDrawdown: s.maxDD, ddDurationDays: r2(s.ddDurationDays),
        alphaAnn: s.alpha, beta: r4(s.beta), correlation: r4(s.correlation), rSquared: r4(s.rSquared), trackingError: s.trackingError, infoRatio: r4(s.infoRatio),
        var95Pct: s.var95, cvar95Pct: s.cvar95, skew: r4(s.skew), kurtosis: r4(s.kurtosis),
        trades: s.trades, roundTrips: s.closed, winRate: s.winRate, profitFactor: r4(s.profitFactor), expectancy: r2(s.expectancy),
        avgWin: r2(s.avgWin), avgLoss: r2(s.avgLoss), payoffRatio: r4(s.payoff), largestWin: r2(s.largestWin), largestLoss: r2(s.largestLoss),
        avgTripReturn: s.avgTripReturn, avgHoldDays: r2(s.avgHold), avgHoldBars: r2(s.avgHoldBars), avgMfePct: s.avgMFE, avgMaePct: s.avgMAE, edgeRatio: r4(s.edgeRatio),
        maxConsecWins: s.maxConsecWins, maxConsecLosses: s.maxConsecLosses,
        longTrips: s.longTrips, shortTrips: s.shortTrips, longPnl: r2(s.longPnl), shortPnl: r2(s.shortPnl), longWinRate: s.longWinRate, shortWinRate: s.shortWinRate,
        avgGrossExposure: r4(s.avgGrossExposure), avgNetExposure: r4(s.avgNetExposure), turnoverX: r2(s.turnover),
        fees: r2(s.fees), borrowCost: r2(s.borrowCost), dividends: r2(s.dividends), marginCalls: s.marginCalls,
        bestTradePct: s.bestTrade, worstTradePct: s.worstTrade, symbolsTraded: s.symbolsTraded,
        bestSector: s.bestSector, worstSector: s.worstSector, bestSymbol: s.bestSymbol, worstSymbol: s.worstSymbol,
        maxPositions: c.maxPos, positionSize: c.posSize, stopLoss: c.stopLoss, takeProfit: c.takeProfit,
        decisionEveryBars: c.interval, maxHoldDays: c.maxHold, shorts: c.shortOn ? "yes" : "no", trailingStop: c.trail ? "yes" : "no"
      });
      var start = b.intraCurve.length - b.idxCurve.length;
      for (var t = 0; t < b.idxCurve.length; t++) {
        var sample = t, day = self.genStartDay + Math.floor(sample / 13);
        cur.equityIntraday.push({ gen: g, date: m.dateStr(day), time: barTime((sample % 13) * 6 + 6), bot: b.name, equity: r2(b.intraCurve[t + start]), index: r2(b.idxCurve[t]) });
      }
      for (t = 0; t < b.trades.length; t++) {
        var tr = b.trades[t];
        cur.trades.push({ gen: g, bot: b.name, date: m.dateStr(tr.day), time: barTime(tr.bar), symbol: tr.sym, sector: tr.sector, side: tr.side,
          qty: tr.qty, price: r4(tr.px), mid: r4(tr.mid), spreadBps: r2(tr.spreadBps), impactBps: r2(tr.impactBps), notional: r2(tr.notional),
          fee: r2(tr.fee), realizedPnl: tr.pnl === null ? "" : r2(tr.pnl), reason: tr.reason, signal: tr.score === null ? "" : tr.score, cashAfter: r2(tr.cashAfter) });
      }
      for (t = 0; t < b.roundTrips.length; t++) {
        var rt = b.roundTrips[t], si = m.symIndex[rt.sym];
        if (si !== undefined) { self.symTrades[si]++; self.symPnl[si] += rt.pnl; }
        cur.roundTrips.push({ gen: g, bot: b.name, symbol: rt.sym, sector: rt.sector, side: rt.side, qty: rt.qty,
          entryDate: m.dateStr(rt.entryDay), entryTime: barTime(rt.entryBar), entryPrice: r4(rt.entryPx),
          exitDate: m.dateStr(rt.exitDay), exitTime: barTime(rt.exitBar), exitPrice: r4(rt.exitPx),
          holdBars: rt.holdBars, holdDays: r2(rt.holdBars / m.BARS_PER_DAY), pnl: r2(rt.pnl), returnPct: rt.ret, mfePct: rt.mfe, maePct: rt.mae,
          entrySignal: rt.entryScore === null ? "" : rt.entryScore, entryRsi: rt.entryRsi, entryReason: rt.entryReason, exitReason: rt.exitReason,
          regimeIn: rt.regimeIn, regimeOut: rt.regimeOut, fees: r2(rt.fees) });
      }
    });

    var rets = rows.map(function (r) { return r.s.ret; }), sorted = rets.slice().sort(function (a, b) { return a - b; });
    var mean = T.stat.mean, prev = this.log.generations[this.log.generations.length - 1];
    var survivors = rows.filter(function (r) { return r.bot.age > 0; }), kids = rows.filter(function (r) { return r.bot.age === 0 && r.bot.gen === g && g > 1; });
    var mk = cur.market, idxDaily = mk.map(function (x) { return Math.log(1 + x.changePct); });
    var avgRet = mean(rets);
    this.fund *= 1 + avgRet; this.idxFund *= 1 + idxRet;
    var summary = {
      gen: g, bots: rows.length, startDate: m.dateStr(this.genStartDay), endDate: m.dateStr(m.day - 1), days: this.genDay,
      avgReturn: avgRet, medianReturn: T.stat.median(rets), bestReturn: sorted[sorted.length - 1], worstReturn: sorted[0],
      q1Return: sorted[Math.floor((sorted.length - 1) * 0.25)], q3Return: sorted[Math.floor((sorted.length - 1) * 0.75)],
      stdevReturn: T.stat.stdev(rets), profitableBots: rets.filter(function (x) { return x > 0; }).length,
      beatIndex: rets.filter(function (x) { return x > idxRet; }).length, indexReturn: idxRet,
      indexVolAnn: T.stat.stdev(idxDaily) * Math.sqrt(252), avgSimVix: mean(mk.map(function (x) { return x.simVix || 0; })),
      avgSharpe: mean(rows.map(function (r) { return r.s.sharpe; })), avgSortino: mean(rows.map(function (r) { return r.s.sortino; })),
      avgAlphaAnn: mean(rows.map(function (r) { return r.s.alpha; })), avgBeta: mean(rows.map(function (r) { return r.s.beta; })),
      avgMaxDrawdown: mean(rows.map(function (r) { return r.s.maxDD; })), avgWinRate: mean(rows.map(function (r) { return r.s.winRate; })),
      avgProfitFactor: mean(rows.map(function (r) { return Math.min(r.s.profitFactor, 10); })),
      avgGrossExposure: mean(rows.map(function (r) { return r.s.avgGrossExposure; })), avgTurnoverX: mean(rows.map(function (r) { return r.s.turnover; })),
      totalTrades: rows.reduce(function (a, r) { return a + r.s.trades; }, 0), totalRoundTrips: rows.reduce(function (a, r) { return a + r.s.closed; }, 0),
      avgPnl: mean(rows.map(function (r) { return r.s.pnl; })), totalPnl: rows.reduce(function (a, r) { return a + r.s.pnl; }, 0),
      totalFees: rows.reduce(function (a, r) { return a + r.s.fees; }, 0), totalDividends: rows.reduce(function (a, r) { return a + r.s.dividends; }, 0),
      survivorsAvgReturn: survivors.length ? mean(survivors.map(function (r) { return r.s.ret; })) : "",
      childrenAvgReturn: kids.length ? mean(kids.map(function (r) { return r.s.ret; })) : "",
      changeVsPrevGen: prev ? avgRet - prev.avgReturn : "",
      cumulativeAvgBot: this.fund - 1, cumulativeIndex: this.idxFund - 1,
      bestBot: rows[0].bot.name, bestStyle: rows[0].bot.style,
      bullDays: this.regimeDays[0], neutralDays: this.regimeDays[1], bearDays: this.regimeDays[2], crashDays: this.regimeDays[3]
    };
    this.log.generations.push(summary);
    this.log.genetics.push(this.genetics(g, rows.map(function (r) { return r.bot; })));
    this.regimeDays = [0, 0, 0, 0];

    // move this generation's rows into the run log
    var genRows = { generation: [summary], genetics: [this.log.genetics[this.log.genetics.length - 1]], bots: botRows,
      trades: cur.trades, roundTrips: cur.roundTrips, botDaily: cur.botDaily, equityIntraday: cur.equityIntraday,
      positions: cur.positions, news: cur.news, market: cur.market, sectors: cur.sectors };
    push(this.log.bots, botRows); push(this.log.market, cur.market); push(this.log.sectors, cur.sectors);
    DETAIL.forEach(function (k) { push(self.log[k], cur[k]); });
    this.cur = this.emptyRows();
    this.trim();

    var final = this.isFinalGen(g) || this.stopRequested;
    this.emit("generation", { summary: summary, ranked: rows, final: final, rows: genRows });
    // retired bots drop their heavy per-generation data (genome and history stay)
    if (final || this.stopRequested) { this.finish(); return; }   // stop() may be called by a listener above
    this.breed(rows.map(function (r) { return r.bot; }));
    this.gen++;
    this.genDay = 0;
    this.genStartDay = m.day;
    this.genStartIndex = m.index;
  };

  function push(dst, src) { for (var i = 0; i < src.length; i++) dst.push(src[i]); }

  /* Keep detail tables under the row budget by dropping the oldest generations' detail. */
  Sim.prototype.trim = function () {
    var log = this.log, total = 0, self = this;
    DETAIL.forEach(function (k) { total += log[k].length; });
    while (total > this.cfg.detailBudget && this.trimmedThrough < this.gen - 1) {
      var g = this.trimmedThrough + 1;
      DETAIL.forEach(function (k) {
        var a = log[k], n = 0;
        while (n < a.length && a[n].gen <= g) n++;
        if (n) { a.splice(0, n); total -= n; }
      });
      this.trimmedThrough = g;
    }
    if (this.trimmedThrough) this.emit("trimmed", this.trimmedThrough);
    return self;
  };

  Sim.prototype.genetics = function (g, bots) {
    var row = { gen: g, bots: bots.length }, names = T.BOT_CONST.FEATURE_NAMES, n = bots.length, i, j;
    var dist = 0, pairs = 0;
    for (i = 0; i < n; i++) for (j = i + 1; j < n && j < i + 12; j++) { dist += T.Genome.distance(bots[i].genome, bots[j].genome); pairs++; }
    row.diversity = pairs ? dist / pairs : 0;
    var keys = ["buyTh", "sellTh", "maxPos", "posSize", "stopLoss", "takeProfit", "interval", "maxHold", "cashReserve", "conviction"];
    keys.forEach(function (k) { row["avg_" + k] = T.stat.mean(bots.map(function (b) { return +b.cfg[k]; })); });
    row.shortersPct = bots.filter(function (b) { return b.cfg.shortOn; }).length / n;
    row.trailersPct = bots.filter(function (b) { return b.cfg.trail; }).length / n;
    var imps = bots.map(function (b) { return b.genome.importance(); });
    names.forEach(function (nm, k) { row["weight_" + nm] = T.stat.mean(imps.map(function (x) { return x[k]; })); });
    var styles = {};
    bots.forEach(function (b) { styles[b.style] = (styles[b.style] || 0) + 1; });
    row.styles = Object.keys(styles).sort(function (a, b) { return styles[b] - styles[a]; }).map(function (s) { return s + " x" + styles[s]; }).join("; ");
    return row;
  };

  Sim.prototype.breed = function (ranked) {
    var r = this.rng, next = [], i, sigma = 0.25 * Math.pow(0.9, this.gen - 1) + 0.06;
    var retired = ranked.slice();
    this.gen++;  // children are born into the next generation
    if (this.gen === 2) {
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
    retired.forEach(function (b) { if (next.indexOf(b) < 0) { b.trades = []; b.roundTrips = []; b.intraCurve = []; b.idxCurve = []; b.expCurve = []; b.pos = {}; } });
    this.bots = next;
    this.markAlive();
  };

  Sim.prototype.child = function (a, b, r, sigma) {
    return this.newBot(T.Genome.cross(a.genome, b.genome, r, sigma), [a, b]);
  };

  /* Stop after the current generation finishes. */
  Sim.prototype.stop = function () { this.stopRequested = true; };

  /* End right now: close every position at market and score the partial generation. */
  Sim.prototype.endNow = function () {
    if (this.done) return;
    var m = this.market;
    this.stopRequested = true;
    if (this.genDay === 0 && m.bar === 0 && this.log.generations.length) { this.finish(); return; }
    var self = this;
    this.bots.forEach(function (b) { b.closeAll(m, "run stopped"); b.markEquity(m); });
    if (m.bar > 0 || this.genDay > 0) {
      this.cur.market.length || this.cur.market.push({ gen: this.gen, day: m.day + 1, date: m.dateStr(m.day), close: r2(m.index), changePct: m.indexChangePct(), regime: m.REGIMES[m.regime].name });
      self.genDay = Math.max(1, self.genDay);
      this.endGeneration();
    } else this.finish();
  };

  Sim.prototype.finish = function () {
    if (this.done) return;
    this.done = true;
    this.finishedAt = Date.now();
    this.emit("done", this.report());
  };

  /* One row per bot that ever lived, across all of its generations. */
  Sim.prototype.profiles = function () {
    var by = Object.create(null), kids = Object.create(null), self = this;
    this.log.bots.forEach(function (r) { (by[r.id] = by[r.id] || []).push(r); });
    this.log.genomes.forEach(function (gm) { gm.parentIds.split(" ").forEach(function (p) { if (p) kids[p] = (kids[p] || 0) + 1; }); });
    return this.log.genomes.map(function (gm) {
      var runs = by[gm.id] || [], mean = T.stat.mean;
      var comp = runs.reduce(function (a, r) { return a * (1 + r.returnPct); }, 1) - 1;
      var best = runs.slice().sort(function (a, b) { return b.returnPct - a.returnPct; })[0];
      var worst = runs.slice().sort(function (a, b) { return a.returnPct - b.returnPct; })[0];
      return {
        id: gm.id, bot: gm.bot, born: gm.born, parents: gm.parents, children: kids[gm.id] || 0, style: gm.style, topFeatures: gm.topFeatures,
        status: self.alive[gm.id] && !self.done ? "alive" : (runs.length ? "retired after gen " + runs[runs.length - 1].gen : "never traded"),
        generationsTraded: runs.length, firstGen: runs.length ? runs[0].gen : "", lastGen: runs.length ? runs[runs.length - 1].gen : "",
        avgReturn: runs.length ? mean(runs.map(function (r) { return r.returnPct; })) : "", compoundedReturn: runs.length ? comp : "",
        bestGenReturn: best ? best.returnPct : "", worstGenReturn: worst ? worst.returnPct : "",
        totalPnl: r2(runs.reduce(function (a, r) { return a + r.pnl; }, 0)), totalTrades: runs.reduce(function (a, r) { return a + r.trades; }, 0),
        avgSharpe: runs.length ? r4(mean(runs.map(function (r) { return r.sharpe; }))) : "", avgWinRate: runs.length ? mean(runs.map(function (r) { return r.winRate; })) : "",
        avgMaxDrawdown: runs.length ? mean(runs.map(function (r) { return r.maxDrawdown; })) : "", avgAlphaAnn: runs.length ? mean(runs.map(function (r) { return r.alphaAnn; })) : "",
        bestRank: runs.length ? Math.min.apply(null, runs.map(function (r) { return r.rank; })) : "", avgRank: runs.length ? r2(mean(runs.map(function (r) { return r.rank; }))) : "",
        buyThreshold: gm.buyThreshold, sellThreshold: gm.sellThreshold, maxPositions: gm.maxPositions, positionSize: gm.positionSize, stopLoss: gm.stopLoss,
        takeProfit: gm.takeProfit, decisionEveryBars: gm.decisionEveryBars, maxHoldDays: gm.maxHoldDays, shorts: gm.shorts, trailingStop: gm.trailingStop
      };
    });
  };

  /* Snapshot of every symbol: fundamentals, technicals, and how the bots did on it. */
  Sim.prototype.symbols = function () {
    var m = this.market, out = [];
    for (var i = 0; i < m.n; i++) {
      var adjStart = m.price0[i] * m.splitAdj[i];
      out.push({ symbol: m.sym[i], name: m.name[i], exchange: T.EXCHANGES[m.exch[i]], sector: T.SECTORS[m.sector[i]], sp500: m.sp[i] ? "yes" : "no",
        startPrice: m.price0[i], last: r4(m.price[i]), returnSinceStart: m.price[i] / adjStart - 1, marketCapM: r2(m.marketCap(i) / 1e6),
        epsTTM: r4(m.eps[i]), pe: m.pe(i) === null ? "" : r2(m.pe(i)), dividendYield: m.divYield[i], dividendsPaid: r4(m.divPaid[i]), shortInterest: m.shortInt[i],
        beta: r2(m.beta[i]), idioVol: r2(m.idioVol[i]), rsi14: r2(m.rsi(i)), atrPct: m.atrPct[i], rangeHigh: r4(m.hiRange[i]), rangeLow: r4(m.loRange[i]),
        avgVolume: Math.round(m.avgVol[i]), newsItems: m.newsCount[i], earningsReports: m.earnCount[i], splits: m.splitCount[i],
        botRoundTrips: this.symTrades[i], botPnl: r2(this.symPnl[i]) });
    }
    return out;
  };

  Sim.prototype.report = function () {
    var gens = this.log.generations, bots = this.log.bots, mean = T.stat.mean;
    var allRet = bots.map(function (b) { return b.returnPct; });
    var best = bots.slice().sort(function (a, b) { return b.returnPct - a.returnPct; })[0];
    var mkt = this.log.market;
    return {
      config: this.cfg, forever: this.forever,
      generations: gens.length, botRuns: bots.length, uniqueBots: this.log.genomes.length,
      tradingDays: mkt.length, startDate: mkt.length ? mkt[0].date : "", endDate: mkt.length ? mkt[mkt.length - 1].date : "",
      avgReturn: mean(allRet), medianReturn: T.stat.median(allRet),
      avgSharpe: mean(bots.map(function (b) { return b.sharpe; })), avgSortino: mean(bots.map(function (b) { return b.sortino; })),
      avgAlpha: mean(bots.map(function (b) { return b.alphaAnn; })), avgBeta: mean(bots.map(function (b) { return b.beta; })),
      avgWinRate: mean(bots.map(function (b) { return b.winRate; })), avgMaxDrawdown: mean(bots.map(function (b) { return b.maxDrawdown; })),
      avgPnl: mean(bots.map(function (b) { return b.pnl; })), avgProfitFactor: mean(bots.map(function (b) { return Math.min(b.profitFactor, 10); })),
      totalTrades: gens.reduce(function (a, g) { return a + g.totalTrades; }, 0), totalRoundTrips: gens.reduce(function (a, g) { return a + g.totalRoundTrips; }, 0),
      totalFees: gens.reduce(function (a, g) { return a + g.totalFees; }, 0),
      best: best,
      firstGenAvg: gens.length ? gens[0].avgReturn : 0, lastGenAvg: gens.length ? gens[gens.length - 1].avgReturn : 0,
      cumulativeAvgBot: this.fund - 1, cumulativeIndex: this.idxFund - 1,
      indexReturn: mkt.length ? mkt[mkt.length - 1].close / 5000 - 1 : 0,
      trimmedThrough: this.trimmedThrough,
      wallSeconds: ((this.finishedAt || Date.now()) - this.startedAt) / 1000
    };
  };

  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
  function stdev(a) { var mu = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - mu) * (x - mu); }))); }

  T.Sim = Sim;
  T.stat = { mean: mean, median: median, stdev: stdev };
  T.DETAIL_TABLES = DETAIL;
})(window.T = window.T || {});
