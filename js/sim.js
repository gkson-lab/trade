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
 * cfg.detailBudget cells (rows x columns, roughly 50 bytes each in memory); past that the oldest generations'
 * detail is dropped from memory. Per-bot summary tables (bots, genomes, market and sector days) and retired bots
 * are kept for the last cfg.historyGens generations. Generations and genetics are kept in full. Every generation's
 * rows are also handed to listeners ("generation" event, d.rows) so the CLI can write them to disk as it goes.
 */
(function (T) {
  "use strict";

  var BASE = 20;
  var DETAIL = ["trades", "roundTrips", "botDaily", "equityIntraday", "positions", "news", "mlSamples"];

  var HOUSES = ["Varga", "Okoro", "Lindqvist", "Moreau", "Tanaka", "Castell", "Adeyemi", "Kowal", "Ferreira", "Haldane", "Ivers", "Nakamura",
    "Rourke", "Sato", "Bellamy", "Quist", "Duarte", "Falk", "Gallo", "Mbeki", "Oyelaran", "Petrov", "Reyes", "Strand", "Thorne", "Vance",
    "Wexler", "Yilmaz", "Zoric", "Abara"];

  function Sim(cfg) {
    this.cfg = {
      mult: cfg.mult || 1,
      generations: cfg.generations === 0 || cfg.forever ? 0 : (cfg.generations || 6),
      daysPerGen: cfg.daysPerGen || 10,
      seed: cfg.seed || 20270104,
      fitness: cfg.fitness || "return",
      maxSymbols: cfg.maxSymbols || 0,
      detailBudget: cfg.detailBudget || 8000000,
      historyGens: cfg.historyGens > 0 ? cfg.historyGens : 300,
      startCash: cfg.startCash > 0 ? cfg.startCash : 100000,
      breeding: cfg.breeding || "ranked",
      breedPool: cfg.breedPool, breedPairing: cfg.breedPairing, brackets: cfg.brackets, levels: cfg.levels,
      threshold: cfg.threshold, threshold2: cfg.threshold2, pct: cfg.pct, allowed: cfg.allowed,
      mutation: cfg.mutation > 0 ? cfg.mutation : 1,
      samplesPerDay: cfg.samplesPerDay >= 0 ? cfg.samplesPerDay : 150
    };
    this.breedSettings = T.Breeding.normalize(this.cfg);
    this.ruleName = T.Breeding.describe(this.breedSettings);
    this.kinMemo = new Map();
    this.pending = [];
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
      trades: [], roundTrips: [], botDaily: [], equityIntraday: [], positions: [], news: [], mlSamples: [] };
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
    this.sampleRng = this.rng.fork("samples");
    var self = this;
    this.market.on(function (t, d) {
      if (t === "dividend") self.bots.forEach(function (b) { b.onDividend(d.i, d.amount); });
      else if (t === "split") self.bots.forEach(function (b) { b.onSplit(self.market, d.i, d.f); });
    });
  }

  Sim.prototype.emptyRows = function () { return { trades: [], roundTrips: [], botDaily: [], equityIntraday: [], positions: [], news: [], mlSamples: [], market: [], sectors: [] }; };
  Sim.prototype.on = function (fn) { this.listeners.push(fn); };
  Sim.prototype.emit = function (t, d) { for (var k = 0; k < this.listeners.length; k++) this.listeners[k](t, d); };
  Sim.prototype.markAlive = function () { var a = Object.create(null); this.bots.forEach(function (b) { a[b.id] = 1; }); this.alive = a; };

  Sim.prototype.newBot = function (genome, parents, meta) {
    var gt = parents.length ? T.genetics.inherit(parents[0].genotype, parents[1].genotype, this.rng, this.cfg.mutation, parents[0].traits, parents[1].traits) : null;
    var b = new T.Bot(this.nextId++, this.gen, genome, parents.map(function (p) { return p.name; }), this.rng, this.cfg.startCash, gt);
    b.parentIds = parents.map(function (p) { return p.id; });
    var founders = this.nextId - 2;
    b.house = parents.length ? parents[0].house : HOUSES[founders % HOUSES.length] + (founders >= HOUSES.length ? " " + (Math.floor(founders / HOUSES.length) + 1) : "");
    b.lineageDepth = parents.length ? 1 + Math.max(parents[0].lineageDepth, parents[1].lineageDepth) : 0;
    b.inbreeding = parents.length ? this.kin(parents[0], parents[1]) : 0;
    b.breedMeta = meta || { rule: "founder", label: "founder", rankA: "", rankB: "", retA: "", retB: "", bracketA: "", bracketB: "", note: "" };
    this.allBots[b.id] = b;
    var c = b.cfg, imp = genome.importance(), names = T.BOT_CONST.FEATURE_NAMES;
    var top = Array.prototype.map.call(imp, function (v, k) { return [v, k]; }).sort(function (a, z) { return z[0] - a[0]; }).slice(0, 3)
      .map(function (x) { return names[x[1]] + " " + (x[0] * 100).toFixed(0) + "%"; }).join(", ");
    this.log.genomes.push({ id: b.id, bot: b.name, born: this.gen, parents: b.parents.join(" + "), parentIds: b.parentIds.join(" "), style: b.style,
      topFeatures: top, buyThreshold: c.buyTh, sellThreshold: c.sellTh, maxPositions: c.maxPos, positionSize: c.posSize, stopLoss: c.stopLoss,
      takeProfit: c.takeProfit, decisionEveryBars: c.interval, maxHoldDays: c.maxHold, cashReserve: c.cashReserve, shorts: c.shortOn ? "yes" : "no",
      trailingStop: c.trail ? "yes" : "no", conviction: c.conviction, house: b.house, lineageDepth: b.lineageDepth, inbreeding: r4(b.inbreeding),
      genotype: this.genotypeString(b), traits: this.traitString(b), breedingRule: b.breedMeta.rule, breedingDetail: b.breedMeta.label,
      parentBrackets: b.breedMeta.bracketA ? b.breedMeta.bracketA + " + " + b.breedMeta.bracketB : "",
      parentReturns: b.breedMeta.retA === "" ? "" : pctStr(b.breedMeta.retA) + " + " + pctStr(b.breedMeta.retB), breedingNote: b.breedMeta.note,
      parentRanks: b.breedMeta.rankA === "" ? "" : b.breedMeta.rankA + " + " + b.breedMeta.rankB, genome: JSON.stringify(genome.toJSON()) });
    return b;
  };

  Sim.prototype.genotypeString = function (b) { return T.TRAITS.map(function (t) { return t.mode === "multi" ? b.genotype[t.key] : T.genetics.show(t, b.genotype[t.key]); }).join(" "); };
  Sim.prototype.traitString = function (b) { return T.TRAITS.map(function (t) { return b.traits[t.key]; }).join(", "); };
  /* Columns describing a bot's genetics, prefixed so they can be joined onto any table. */
  Sim.prototype.geneCols = function (b, prefix) {
    var o = {}, c = b.cfg;
    prefix = prefix || "";
    o[prefix + "house"] = b.house; o[prefix + "lineageDepth"] = b.lineageDepth; o[prefix + "inbreeding"] = r4(b.inbreeding);
    T.TRAITS.forEach(function (t) { o[prefix + "gt_" + t.key] = T.genetics.show(t, b.genotype[t.key]); o[prefix + "trait_" + t.key] = b.traits[t.key]; });
    o[prefix + "buyTh"] = r4(c.buyTh); o[prefix + "sellTh"] = r4(c.sellTh); o[prefix + "maxPos"] = c.maxPos; o[prefix + "posSize"] = r4(c.posSize);
    o[prefix + "stopLoss"] = r4(c.stopLoss); o[prefix + "takeProfit"] = r4(c.takeProfit); o[prefix + "interval"] = c.interval; o[prefix + "maxHold"] = c.maxHold;
    o[prefix + "cashReserve"] = r4(c.cashReserve); o[prefix + "conviction"] = r4(c.conviction);
    return o;
  };

  /* Wright's kinship coefficient (recursive, exact within the last 12 generations). The inbreeding
   * coefficient of a child equals the kinship of its parents. */
  Sim.prototype.kin = function (x, y) {
    if (!x || !y) return 0;
    if (x.id === y.id) return 0.5 * (1 + (x.inbreeding || 0));
    if (x.id > y.id) { var t = x; x = y; y = t; }
    if (!y.parentIds || !y.parentIds.length || y.gen < this.gen - 12) return 0;
    var key = x.id + "|" + y.id, v = this.kinMemo.get(key);
    if (v !== undefined) return v;
    v = 0.5 * (this.kin(x, this.allBots[y.parentIds[0]]) + this.kin(x, this.allBots[y.parentIds[1]]));
    if (this.kinMemo.size > 300000) this.kinMemo.clear();
    this.kinMemo.set(key, v);
    return v;
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
  function pctStr(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%"; }
  function r6(x) { return x === null || x === undefined || !isFinite(x) ? x : Math.round(x * 1e6) / 1e6; }
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
    this.labelSamples(cur);
    if (this.cfg.samplesPerDay > 0) this.sampleMarket(cur, d);
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
    this.lastIdxRet = idxRet;
    var botRows = [];
    rows.forEach(function (r, k) {
      var b = r.bot, s = r.s, c = b.cfg;
      b.history.push({ gen: g, ret: s.ret, rank: k + 1 });
      b.lastRank = k + 1;
      b.lastGen = g;
      b.lastReturn = s.ret;
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
        decisionEveryBars: c.interval, maxHoldDays: c.maxHold, shorts: c.shortOn ? "yes" : "no", trailingStop: c.trail ? "yes" : "no",
        house: b.house, lineageDepth: b.lineageDepth, inbreeding: r4(b.inbreeding), genotype: self.genotypeString(b), traits: self.traitString(b),
        breedingRule: b.breedMeta.rule, parentRanks: b.breedMeta.rankA === "" ? "" : b.breedMeta.rankA + " + " + b.breedMeta.rankB,
        parentReturns: b.breedMeta.retA === "" ? "" : pctStr(b.breedMeta.retA) + " + " + pctStr(b.breedMeta.retB),
        parentBrackets: b.breedMeta.bracketA ? b.breedMeta.bracketA + " + " + b.breedMeta.bracketB : "", breedingDetail: b.breedMeta.label,
        breedingNote: b.breedMeta.note
      });
      var tr = T.TRAITS, brow = botRows[botRows.length - 1];
      tr.forEach(function (t) { brow["trait_" + t.key] = b.traits[t.key]; });
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
        var last = cur.roundTrips[cur.roundTrips.length - 1], gc = self.geneCols(b, "bot_");
        for (var key in rt.snap) last[key] = rt.snap[key];
        for (key in gc) last[key] = gc[key];
        last.y_return = rt.ret; last.y_pnl = r2(rt.pnl); last.y_win = rt.pnl > 0 ? 1 : 0; last.y_holdDays = r2(rt.holdBars / m.BARS_PER_DAY);
        last.y_mfe = rt.mfe; last.y_mae = rt.mae;
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
    var born = this.log.genomes.filter(function (r) { return r.born === g; });
    var genRows = { generation: [summary], genetics: [this.log.genetics[this.log.genetics.length - 1]], bots: botRows, mlSamples: cur.mlSamples, births: born,
      trades: cur.trades, roundTrips: cur.roundTrips, botDaily: cur.botDaily, equityIntraday: cur.equityIntraday,
      positions: cur.positions, news: cur.news, market: cur.market, sectors: cur.sectors };
    push(this.log.bots, botRows); push(this.log.market, cur.market); push(this.log.sectors, cur.sectors);
    var cut = this.trimmedThrough;
    DETAIL.forEach(function (k) { push(self.log[k], cut ? cur[k].filter(function (r) { return r.gen > cut; }) : cur[k]); });
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
    var log = this.log, total = 0, self = this, cols = {};
    // count cells, not rows: a training row has ~90 columns, a bot-day row ~20
    DETAIL.forEach(function (k) { cols[k] = log[k].length ? Object.keys(log[k][log[k].length - 1]).length : 0; total += log[k].length * cols[k]; });
    while (total > this.cfg.detailBudget && this.trimmedThrough < this.gen - 1) {
      var g = this.trimmedThrough + 1;
      DETAIL.forEach(function (k) {
        var before = log[k].length;
        log[k] = log[k].filter(function (r) { return r.gen > g; });   // training samples can finish labelling a generation late
        total -= (before - log[k].length) * cols[k];
      });
      this.trimmedThrough = g;
    }
    if (this.trimmedThrough) this.emit("trimmed", this.trimmedThrough);
    // long runs: keep per-bot history and retired bots for the last historyGens generations only
    var cut = this.gen - this.cfg.historyGens;
    if (cut > (this.historyFrom || 0)) {
      this.historyFrom = cut;
      ["bots", "market", "sectors"].forEach(function (k) { if (log[k].length && log[k][0].gen <= cut) log[k] = log[k].filter(function (r) { return r.gen > cut; }); });
      if (log.genomes.length && log.genomes[0].born <= cut) log.genomes = log.genomes.filter(function (r) { return r.born > cut || self.alive[r.id]; });
      for (var id in this.allBots) { var b = this.allBots[id]; if (b.gen <= cut && !this.alive[id] && b.lastGen !== undefined && b.lastGen <= cut) delete this.allBots[id]; }
      this.kinMemo.clear();
    }
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
    row.breedingRule = this.ruleName;
    row.avgInbreeding = T.stat.mean(bots.map(function (b) { return b.inbreeding; }));
    row.maxInbreeding = Math.max.apply(null, bots.map(function (b) { return b.inbreeding; }));
    row.avgLineageDepth = T.stat.mean(bots.map(function (b) { return b.lineageDepth; }));
    var houses = {};
    bots.forEach(function (b) { houses[b.house] = (houses[b.house] || 0) + 1; });
    var hk = Object.keys(houses).sort(function (a, b) { return houses[b] - houses[a]; });
    row.housesAlive = hk.length; row.topHouse = hk[0] + " x" + houses[hk[0]]; row.houseShares = hk.map(function (h) { return h + " x" + houses[h]; }).join("; ");
    T.TRAITS.forEach(function (t) {
      if (t.mode === "multi") {
        var cnt = {};
        bots.forEach(function (b) { for (var q = 0; q < 2; q++) { var nm = T.genetics.show(t, b.genotype[t.key]).split(" / ")[q]; cnt[nm] = (cnt[nm] || 0) + 1; } });
        row["alleles_" + t.key] = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).map(function (k) { return k + " x" + cnt[k]; }).join("; ");
        return;
      }
      var dom = 0, looks = {};
      bots.forEach(function (b) { var gt = b.genotype[t.key]; dom += (gt[0] === t.a ? 1 : 0) + (gt[1] === t.a ? 1 : 0); looks[b.traits[t.key]] = (looks[b.traits[t.key]] || 0) + 1; });
      row["allele_" + t.a] = dom / (2 * n);
      row["looks_" + t.key] = Object.keys(looks).map(function (k) { return k + " x" + looks[k]; }).join("; ");
    });
    return row;
  };

  Sim.prototype.breed = function (ranked) {
    var r = this.rng, next = [], i, sigma = (0.25 * Math.pow(0.9, this.gen - 1) + 0.06) * this.cfg.mutation;
    var retired = ranked.slice(), self = this, pairs;
    this.gen++;  // children are born into the next generation
    if (this.gen === 2) {
      // everyone breeds: half as many pairs as bots, one child each
      pairs = T.Breeding.select(this, ranked, ranked.length / 2, ranked);
      pairs.forEach(function (p) { next.push(self.child(p, r, sigma)); });
    } else {
      var survivors = this.gen === 3 ? ranked : ranked.slice(0, ranked.length / 2);
      pairs = T.Breeding.select(this, ranked, survivors.length / 2, survivors);
      for (i = 0; i < survivors.length; i++) { survivors[i].age++; survivors[i].reset(); next.push(survivors[i]); }
      pairs.forEach(function (p) {
        next.push(self.child(p, r, sigma));
        next.push(self.child(p, r, sigma));   // twin
      });
    }
    this.gen--;
    retired.forEach(function (b) { if (next.indexOf(b) < 0) { b.trades = []; b.roundTrips = []; b.intraCurve = []; b.idxCurve = []; b.expCurve = []; b.pos = {}; b.plist = []; b.nPos = 0; } });
    this.bots = next;
    this.markAlive();
  };

  Sim.prototype.child = function (p, r, sigma) {
    return this.newBot(T.Genome.cross(p.a.genome, p.b.genome, r, sigma), [p.a, p.b], p.meta);
  };

  /* Training data: a labeled sample of stocks at each close. Labels are filled in as the future arrives. */
  Sim.prototype.sampleMarket = function (cur, d) {
    var m = this.market, r = this.sampleRng, seen = Object.create(null), list = [], why = {}, i, k;
    function add(j, reason) { if (!seen[j] && m.price[j] >= 1) { seen[j] = 1; list.push(j); why[j] = reason; } }
    this.bots.forEach(function (b) { for (var key in b.pos) add(+key, "held"); });
    var news = m.recentNews;
    for (k = news.length - 1; k >= 0 && news[k].day >= d; k--) if (news[k].scope === "stock" && news[k].day === d) add(news[k].target, "news");
    var want = list.length + this.cfg.samplesPerDay, tries = 0;
    while (list.length < want && tries++ < this.cfg.samplesPerDay * 20) {
      i = Math.floor(r.next() * m.n);
      if (m.avgVol[i] * m.price[i] > 1e6) add(i, "random");
    }
    var date = m.dateStr(d), regime = m.REGIMES[m.regime].name;
    for (k = 0; k < list.length; k++) {
      i = list[k];
      var row = { gen: this.gen, date: date, symbol: m.sym[i], sector: T.SECTORS[m.sector[i]], regime: regime, sampleReason: why[i],
        botsHolding: 0 };
      this.bots.forEach(function (b) { if (b.pos[i]) row.botsHolding++; });
      var snap = m.snapshot(i);
      for (var key in snap) row[key] = snap[key];
      row.y_fwdRet1d = ""; row.y_fwdRet5d = ""; row.y_fwdRet10d = ""; row.y_fwdIdxRet5d = ""; row.y_fwdExcess5d = ""; row.y_fwdExcess10d = "";
      row.y_up5d = ""; row.y_maxUp5d = ""; row.y_maxDown5d = "";
      this.pending.push({ row: row, i: i, p0: m.price[i], adj0: m.splitAdj[i], idx0: m.index, day0: m.day, hi: 0, lo: 0 });
    }
  };

  Sim.prototype.labelSamples = function (cur) {
    var m = this.market, keep = [];
    for (var k = 0; k < this.pending.length; k++) {
      var s = this.pending[k], el = m.day - s.day0, row = s.row;
      var p = m.price[s.i] / (m.splitAdj[s.i] / s.adj0), ret = p / s.p0 - 1, idx = m.index / s.idx0 - 1;
      if (el <= 5) { s.hi = Math.max(s.hi, ret); s.lo = Math.min(s.lo, ret); }
      if (el === 1) row.y_fwdRet1d = r6(ret);
      if (el === 5) {
        row.y_fwdRet5d = r6(ret); row.y_fwdIdxRet5d = r6(idx); row.y_fwdExcess5d = r6(ret - idx); row.y_up5d = ret > 0 ? 1 : 0;
        row.y_maxUp5d = r6(s.hi); row.y_maxDown5d = r6(s.lo);
      }
      if (el >= 10) { row.y_fwdRet10d = r6(ret); row.y_fwdExcess10d = r6(ret - idx); cur.mlSamples.push(row); }
      else keep.push(s);
    }
    this.pending = keep;
  };

  /* Every bot that ever lived, with parents, grandparents, genotype and how the line did. */
  Sim.prototype.familyTree = function () {
    var all = this.allBots, ids = Object.keys(all).map(Number).sort(function (a, b) { return a - b; }), kids = {}, self = this;
    var runs = {};
    this.log.bots.forEach(function (r) { (runs[r.id] = runs[r.id] || []).push(r.returnPct); });
    ids.forEach(function (id) { (all[id].parentIds || []).forEach(function (p) { (kids[p] = kids[p] || []).push(id); }); });
    return ids.map(function (id) {
      var b = all[id], pa = all[b.parentIds[0]], pb = all[b.parentIds[1]], gp = [];
      [pa, pb].forEach(function (p) { if (p) p.parentIds.forEach(function (q) { if (all[q]) gp.push(all[q].name); }); });
      var ch = kids[id] || [], grand = 0;
      ch.forEach(function (c) { grand += (kids[c] || []).length; });
      var rr = runs[id] || [];
      var row = { id: id, bot: b.name, house: b.house, born: b.gen, lineageDepth: b.lineageDepth, parentA: pa ? pa.name : "", parentB: pb ? pb.name : "",
        parentAHouse: pa ? pa.house : "", parentBHouse: pb ? pb.house : "", grandparents: gp.join(", "),
        breedingRule: b.breedMeta.rule, parentRanks: b.breedMeta.rankA === "" ? "" : b.breedMeta.rankA + " + " + b.breedMeta.rankB,
        parentReturns: b.breedMeta.retA === "" ? "" : pctStr(b.breedMeta.retA) + " + " + pctStr(b.breedMeta.retB),
        parentBrackets: b.breedMeta.bracketA ? b.breedMeta.bracketA + " + " + b.breedMeta.bracketB : "", breedingDetail: b.breedMeta.label,
        inbreeding: r4(b.inbreeding), children: ch.length, grandchildren: grand,
        status: self.alive[id] && !self.done ? "alive" : rr.length ? "retired" : "never traded", generationsTraded: rr.length,
        compoundedReturn: rr.length ? rr.reduce(function (a, x) { return a * (1 + x); }, 1) - 1 : "", genotype: self.genotypeString(b) };
      T.TRAITS.forEach(function (t) { row["gt_" + t.key] = T.genetics.show(t, b.genotype[t.key]); row["trait_" + t.key] = b.traits[t.key]; });
      return row;
    });
  };

  /* Parent -> child edges, for graph and family-tree tools. */
  Sim.prototype.pedigree = function () {
    var all = this.allBots, out = [];
    Object.keys(all).map(Number).sort(function (a, b) { return a - b; }).forEach(function (id) {
      var b = all[id];
      (b.parentIds || []).forEach(function (p, k) {
        var pp = all[p];
        out.push({ parentId: p, parent: pp ? pp.name : "(older than kept history)", parentHouse: pp ? pp.house : "", childId: id, child: b.name, childHouse: b.house, born: b.gen, role: k ? "B" : "A (house)" });
      });
    });
    return out;
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
    // samples still waiting for 10-day labels go in with the labels that are known so far
    var cut = this.trimmedThrough;
    this.unfinishedSamples = this.pending.map(function (s) { return s.row; });
    push(this.log.mlSamples, this.unfinishedSamples.filter(function (r) { return r.gen > cut; }));
    this.pending = [];
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
        takeProfit: gm.takeProfit, decisionEveryBars: gm.decisionEveryBars, maxHoldDays: gm.maxHoldDays, shorts: gm.shorts, trailingStop: gm.trailingStop,
        house: gm.house, lineageDepth: gm.lineageDepth, inbreeding: gm.inbreeding, genotype: gm.genotype, traits: gm.traits, breedingRule: gm.breedingRule
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
      tradingDays: this.market.day, startDate: this.market.dateStr(0), endDate: this.market.day ? this.market.dateStr(this.market.day - 1) : "",
      historyFrom: this.historyFrom || 0,
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
