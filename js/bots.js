/* Trading agents. Each bot is a small neural network (15 market features -> 8 hidden -> 1 score)
 * plus a set of risk/behaviour genes. Bots trade the shared market with realistic frictions:
 * bid/ask spread, size-based price impact, per-share commission, SEC fee, short borrow cost, margin calls,
 * dividends (paid to longs, charged to shorts) and stock splits.
 *
 * Every bot keeps a full ledger: fills, round trips (entry to exit with excursions), 30-minute equity
 * samples aligned with the SIM 500, daily exposure, P/L by sector, side and symbol. */
(function (T) {
  "use strict";

  var NF = 15, H = 8;
  var NW = NF * H + H + H + 1;
  var PARAMS = ["buyTh", "sellTh", "maxPos", "posSize", "stopLoss", "takeProfit", "interval", "maxHold", "cashReserve", "shortOn", "trail", "conviction"];
  var FEATURE_NAMES = ["Short momentum", "Day momentum", "Week momentum", "Mean reversion", "News sentiment", "Volatility",
    "Volume surge", "Market trend", "Sector trend", "Beta", "Size", "RSI", "VWAP distance", "Earnings yield", "Short interest"];
  var START_CASH = 100000;
  var COMMISSION_PER_SHARE = 0.005, COMMISSION_MIN = 1, SEC_FEE = 0.0000278;
  var SAMPLES_PER_DAY = 13;      // one equity sample every 6 bars (30 minutes)

  function Genome(w, p) { this.w = w; this.p = p; }
  Genome.random = function (r) {
    var w = new Float32Array(NW), p = new Float32Array(PARAMS.length);
    for (var i = 0; i < NW; i++) w[i] = r.normal() * (i < NF * H ? 0.55 : 0.5);
    for (i = 0; i < p.length; i++) p[i] = r.next();
    return new Genome(w, p);
  };
  Genome.cross = function (a, b, r, sigma) {
    var w = new Float32Array(NW), p = new Float32Array(PARAMS.length), i;
    // hidden-unit-level crossover keeps feature detectors intact
    for (var h = 0; h < H; h++) {
      var src = r.next() < 0.5 ? a : b;
      for (var f = 0; f < NF; f++) w[f * H + h] = src.w[f * H + h];
      w[NF * H + h] = src.w[NF * H + h];
      w[NF * H + H + h] = src.w[NF * H + H + h];
    }
    w[NW - 1] = r.next() < 0.5 ? a.w[NW - 1] : b.w[NW - 1];
    for (i = 0; i < NW; i++) if (r.next() < 0.15) w[i] += r.normal() * sigma;
    for (i = 0; i < p.length; i++) {
      var t = r.next();
      var v = r.next() < 0.5 ? (t * a.p[i] + (1 - t) * b.p[i]) : (r.next() < 0.5 ? a.p[i] : b.p[i]);
      if (r.next() < 0.2) v += r.normal() * sigma * 0.5;
      p[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return new Genome(w, p);
  };
  Genome.prototype.toJSON = function () {
    return { w: Array.prototype.map.call(this.w, function (x) { return +x.toFixed(4); }), p: Array.prototype.map.call(this.p, function (x) { return +x.toFixed(4); }) };
  };
  Genome.distance = function (a, b) {
    var s = 0; for (var i = 0; i < NW; i++) { var d = a.w[i] - b.w[i]; s += d * d; }
    return Math.sqrt(s / NW);
  };
  /* Relative weight the network puts on each input feature (sums to 1). */
  Genome.prototype.importance = function () {
    var imp = new Float64Array(NF), tot = 0, i, h;
    for (i = 0; i < NF; i++) for (h = 0; h < H; h++) imp[i] += Math.abs(this.w[i * H + h] * this.w[NF * H + H + h]);
    for (i = 0; i < NF; i++) tot += imp[i];
    for (i = 0; i < NF; i++) imp[i] = tot > 0 ? imp[i] / tot : 0;
    return imp;
  };

  /* Apply trait phenotypes on top of the decoded continuous genes. */
  function express(c, tr, geno) {
    if (tr.temper === "Aggressive") { c.posSize = Math.min(0.36, c.posSize * 1.3); c.stopLoss *= 1.25; }
    else { c.posSize *= 0.75; c.cashReserve = Math.min(0.6, c.cashReserve + 0.1); }
    if (tr.horizon === "Scalper") { c.interval = Math.max(1, Math.round(c.interval / 2)); c.maxHold = Math.min(c.maxHold, 3); }
    else { c.maxHold = Math.min(30, Math.round(c.maxHold * 1.5) + 1); c.takeProfit *= 1.2; }
    c.newsMult = tr.news === "Newshound" ? 2 : 0.5;
    c.herdBias = tr.herd === "Herd follower" ? 0.15 : tr.herd === "Mixed" ? 0.075 : 0;
    c.sizeBias = tr.size === "Big caps" ? 0.12 : tr.size === "Small caps" ? -0.12 : 0;
    c.shortOn = tr.short === "Short seller";
    c.trail = tr.trail === "Trailing stops";
    if (tr.conviction === "Bold") c.conviction = Math.min(1, c.conviction + 0.3); else c.conviction *= 0.5;
    if (tr.greed === "Greedy") c.takeProfit *= 1.5; else if (tr.greed === "Quick to bank") c.takeProfit *= 0.6;
    if (tr.loss === "Loss averse") c.stopLoss *= 0.6; else c.stopLoss *= 1.1;
    c.entryFrom = tr.session === "Afternoon trader" ? 39 : 1;
    c.entryTo = tr.session === "Morning trader" ? 39 : 77;
    if (tr.spread === "Diversifier") { c.maxPos = Math.min(30, Math.round(c.maxPos * 1.5)); c.posSize *= 0.75; }
    else { c.maxPos = Math.max(2, Math.round(c.maxPos * 0.6)); c.posSize = Math.min(0.36, c.posSize * 1.25); }
    c.volBias = tr.vol === "Volatility seeker" ? 0.1 : tr.vol === "Calm seeker" ? -0.1 : 0;
    c.fmult = new Float32Array(NF); for (var k = 0; k < NF; k++) c.fmult[k] = 1;
    c.fmult[4] = c.newsMult;
    if (tr.contrarian === "Contrarian") { c.fmult[0] = -1; c.fmult[1] = -1; c.fmult[2] = -1; }
    c.sectors = null;
    if (tr.focus === "Sector specialist" && geno) {
      c.sectors = {};
      c.sectors[SECTOR_ALLELES.indexOf(geno.sector[0])] = 1; c.sectors[SECTOR_ALLELES.indexOf(geno.sector[1])] = 1;
    }
    return c;
  }

  function decode(p) {
    return {
      buyTh: 0.05 + 0.8 * p[0],
      sellTh: -0.7 + 0.9 * p[1],
      maxPos: 2 + Math.round(p[2] * 18),
      posSize: 0.03 + 0.25 * p[3],
      stopLoss: 0.015 + 0.2 * p[4],
      takeProfit: 0.025 + 0.5 * p[5],
      interval: 1 + Math.round(p[6] * 11),
      maxHold: 1 + Math.round(p[7] * 29),
      cashReserve: 0.4 * p[8],
      shortOn: p[9] > 0.62,
      trail: p[10] > 0.5,
      conviction: p[11]              // scales size with score strength
    };
  }

  /* Mendelian traits on 4 chromosomes. Each bot carries two copies of every gene (one from each parent).
   * Uppercase = dominant allele. "dominant": one uppercase copy shows the dominant look; the recessive look needs
   * two lowercase copies. "codominant": 2, 1 or 0 uppercase copies each look different. "multi": one of 12 sector
   * alleles per copy. Genes on the same chromosome are linked: a parent passes on one copy of each chromosome,
   * switching copies between neighbouring genes with probability RECOMBINATION (crossing over). */
  var TRAITS = [
    // chromosome 1: risk
    { key: "temper", chr: 1, name: "Temperament", a: "A", mode: "dominant", dom: "Aggressive", rec: "Cautious", pDom: 0.5,
      effect: "Aggressive: 30% bigger positions, 25% wider stops. Cautious: 25% smaller positions, 10% more cash held back." },
    { key: "conviction", chr: 1, name: "Conviction", a: "K", mode: "dominant", dom: "Bold", rec: "Measured", pDom: 0.5,
      effect: "Bold: sizes up hard on its strongest signals. Measured: keeps position sizes even." },
    { key: "greed", chr: 1, name: "Greed", a: "G", mode: "codominant", looks: ["Quick to bank", "Balanced", "Greedy"], pDom: 0.5,
      effect: "Greedy: profit target 50% higher. Quick to bank: profit target 40% lower." },
    { key: "loss", chr: 1, name: "Loss handling", a: "L", mode: "dominant", dom: "Loss tolerant", rec: "Loss averse", pDom: 0.6,
      effect: "Loss averse (ll): stop loss 40% tighter. Loss tolerant: stop loss 10% wider." },
    // chromosome 2: style
    { key: "horizon", chr: 2, name: "Horizon", a: "Q", mode: "dominant", dom: "Scalper", rec: "Swing trader", pDom: 0.45,
      effect: "Scalper: decides twice as often, holds 3 days at most. Swing trader: holds 50% longer, 20% higher profit target." },
    { key: "session", chr: 2, name: "Trading hours", a: "E", mode: "codominant", looks: ["Afternoon trader", "All-day trader", "Morning trader"], pDom: 0.5,
      effect: "Morning traders only open new positions before 12:45, afternoon traders only after 12:45. Exits happen any time." },
    { key: "trail", chr: 2, name: "Stops", a: "T", mode: "dominant", dom: "Trailing stops", rec: "Fixed stops", pDom: 0.5,
      effect: "Trailing stops follow the best price reached; fixed stops stay at the entry level." },
    { key: "spread", chr: 2, name: "Portfolio spread", a: "D", mode: "dominant", dom: "Diversifier", rec: "Concentrated", pDom: 0.5,
      effect: "Diversifier: 50% more positions, each 25% smaller. Concentrated (dd): 40% fewer positions, each 25% bigger." },
    // chromosome 3: signals
    { key: "news", chr: 3, name: "News sense", a: "N", mode: "dominant", dom: "Newshound", rec: "Skeptic", pDom: 0.5,
      effect: "Newshound: news sentiment counts double. Skeptic: counts half." },
    { key: "herd", chr: 3, name: "Herding", a: "H", mode: "codominant", looks: ["Independent", "Mixed", "Herd follower"], pDom: 0.5,
      effect: "Herd follower adds the market trend to every score (Mixed adds half)." },
    { key: "contrarian", chr: 3, name: "Momentum view", a: "C", mode: "dominant", dom: "Trend reader", rec: "Contrarian", pDom: 0.7,
      effect: "Contrarian (cc): reads every momentum signal backwards, buying what fell and selling what rose." },
    { key: "vol", chr: 3, name: "Volatility appetite", a: "V", mode: "codominant", looks: ["Calm seeker", "Neutral on volatility", "Volatility seeker"], pDom: 0.5,
      effect: "Volatility seekers tilt toward jumpy stocks, calm seekers away from them." },
    // chromosome 4: focus
    { key: "size", chr: 4, name: "Size taste", a: "B", mode: "codominant", looks: ["Small caps", "Any size", "Big caps"], pDom: 0.5,
      effect: "Big caps tilts scores toward large companies, Small caps toward small ones." },
    { key: "short", chr: 4, name: "Short selling", a: "R", mode: "dominant", dom: "Long only", rec: "Short seller", pDom: 0.62,
      effect: "Only bots with two recessive r alleles (rr) sell short." },
    { key: "focus", chr: 4, name: "Focus", a: "S", mode: "dominant", dom: "Generalist", rec: "Sector specialist", pDom: 0.65,
      effect: "Sector specialists (ss) only open positions in their two favourite sectors." },
    { key: "sector", chr: 4, name: "Favourite sectors", a: null, mode: "multi",
      effect: "Two sector alleles, one from each parent. They only change trading for sector specialists." },
    { key: "mutator", chr: 4, name: "Genome stability", a: "M", mode: "dominant", dom: "Stable genome", rec: "Mutator", pDom: 0.7,
      effect: "Mutators (mm) pass on genes with three times the usual mutation rate." }
  ];
  var CHROMOSOMES = [1, 2, 3, 4].map(function (c) { return TRAITS.filter(function (t) { return t.chr === c; }); });
  var CHR_NAMES = { 1: "Risk", 2: "Style", 3: "Signals", 4: "Focus" };
  var ALLELE_MUTATION = 0.02, RECOMBINATION = 0.25;
  var SECTOR_ALLELES = "abcdefghijkl";

  function randomGenotype(r) {
    var g = {};
    TRAITS.forEach(function (t) {
      g[t.key] = t.mode === "multi" ? SECTOR_ALLELES[r.int(0, 11)] + SECTOR_ALLELES[r.int(0, 11)]
        : (r.next() < t.pDom ? t.a : t.a.toLowerCase()) + (r.next() < t.pDom ? t.a : t.a.toLowerCase());
    });
    return g;
  }
  function mutate(t, al, r) {
    if (t.mode === "multi") { var k; do { k = SECTOR_ALLELES[r.int(0, 11)]; } while (k === al); return k; }
    return al === t.a ? t.a.toLowerCase() : t.a;
  }
  /* One parent's contribution: a copy of each chromosome, with crossing over and mutation. */
  function gamete(g, traits, r, mut) {
    var out = {}, rate = ALLELE_MUTATION * mut * (traits && traits.mutator === "Mutator" ? 3 : 1);
    CHROMOSOMES.forEach(function (chr) {
      var h = r.next() < 0.5 ? 0 : 1;
      chr.forEach(function (t, k) {
        if (k > 0 && r.next() < RECOMBINATION) h = 1 - h;
        var al = g[t.key][h];
        if (r.next() < rate) al = mutate(t, al, r);
        out[t.key] = al;
      });
    });
    return out;
  }
  /* Child genotype: first copy from parent A, second from parent B (phase is kept, so linkage carries on). */
  function inheritGenotype(ga, gb, r, mut, ta, tb) {
    var x = gamete(ga, ta, r, mut), y = gamete(gb, tb, r, mut), g = {};
    TRAITS.forEach(function (t) { g[t.key] = x[t.key] + y[t.key]; });
    return g;
  }
  function sectorName(al) { return T.SECTORS ? T.SECTORS[SECTOR_ALLELES.indexOf(al)] : al; }
  function phenotype(t, gt) {
    if (t.mode === "multi") return gt[0] === gt[1] ? sectorName(gt[0]) : sectorName(gt[0]) + " & " + sectorName(gt[1]);
    var up = (gt[0] === t.a ? 1 : 0) + (gt[1] === t.a ? 1 : 0);
    if (t.mode === "codominant") return t.looks[up];
    return up > 0 ? t.dom : t.rec;
  }
  function phenotypes(g) { var o = {}; TRAITS.forEach(function (t) { o[t.key] = phenotype(t, g[t.key]); }); return o; }
  /* Genotype as people write it: dominant allele first; sectors by name. */
  function showGenotype(t, gt) {
    if (t.mode === "multi") return sectorName(gt[0]) + " / " + sectorName(gt[1]);
    return gt[0] === t.a ? gt : gt[1] + gt[0];
  }

  var NAME_A = ["Ash", "Brine", "Cobalt", "Dune", "Ember", "Flint", "Gale", "Harbor", "Iris", "Jade", "Kestrel", "Lumen", "Mako", "Nova",
    "Onyx", "Pike", "Quill", "Rook", "Slate", "Talon", "Umber", "Vale", "Wren", "Xeno", "Yarrow", "Zephyr"];

  function Bot(id, gen, genome, parents, rng, startCash, genotype) {
    this.id = id;
    this.genotype = genotype || randomGenotype(rng);
    this.traits = phenotypes(this.genotype);
    this.startCash = startCash > 0 ? startCash : START_CASH;
    this.gen = gen;            // generation this bot was born in
    this.genome = genome;
    this.parents = parents || [];
    this.name = NAME_A[id % NAME_A.length] + "-" + String(id).padStart(3, "0");
    this.cfg = express(decode(genome.p), this.traits, this.genotype);
    this.offset = rng.int(0, 11);
    this.style = styleOf(genome);
    this.age = 0;
    this.history = [];         // per-generation results
    this.reset();
  }

  Bot.prototype.reset = function () {
    this.cash = this.startCash;
    this.pos = Object.create(null);  // symbol index -> position
    this.plist = [];                 // the same positions' symbol indices, for fast per-bar loops
    this.nPos = 0;
    this.trades = [];
    this.roundTrips = [];
    this.equityCurve = [this.startCash];
    this.intraCurve = [this.startCash];
    this.idxCurve = [];
    this.expCurve = [];               // [gross/equity, net/equity] per sample
    this.equity = this.startCash;
    this.peakEquity = this.startCash;
    this.maxDD = 0;
    this.fees = 0; this.borrowCost = 0; this.divIncome = 0; this.turnover = 0;
    this.closed = 0; this.wins = 0; this.grossWin = 0; this.grossLoss = 0; this.holdDays = 0;
    this.bestTrade = 0; this.worstTrade = 0;
    this.marginCalls = 0;
    this.secPnl = Object.create(null); this.symPnl = Object.create(null); this.symTrades = Object.create(null);
    this.day0 = { trades: 0, realized: 0, fees: 0, div: 0, buys: 0, sells: 0, notional: 0 };
  };

  function styleOf(g) {
    var imp = g.importance(), best = 0, sign = 0, h;
    for (var i = 1; i < NF; i++) if (imp[i] > imp[best]) best = i;
    for (h = 0; h < H; h++) sign += g.w[best * H + h] * g.w[NF * H + H + h];
    return (sign >= 0 ? "" : "Contra ") + FEATURE_NAMES[best];
  }

  /* tanh to within 1e-6 for |x| < 4.9 (Pade approximant), much cheaper than Math.tanh in the hot loop. */
  function ftanh(x) {
    if (x > 4.9) return 1; if (x < -4.9) return -1;
    var x2 = x * x;
    return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
  }

  /* Input weights with the bot's trait multipliers folded in (they never change for a bot). */
  Bot.prototype.weights = function () {
    if (this._weff) return this._weff;
    var w = this.genome.w, fm = this.cfg.fmult, W = new Float32Array(NF * H);
    for (var k = 0; k < NF; k++) for (var h = 0; h < H; h++) W[k * H + h] = w[k * H + h] * fm[k];
    return (this._weff = W);
  };

  /* Score row j of the shared pool matrix. Same network as score(), unrolled for H = 8 hidden units. */
  Bot.prototype.scoreRow = function (X, o) {
    var W = this._weff || this.weights(), w = this.genome.w, c = this.cfg, b = NF * H, v = b + H;
    var a0 = w[b], a1 = w[b + 1], a2 = w[b + 2], a3 = w[b + 3], a4 = w[b + 4], a5 = w[b + 5], a6 = w[b + 6], a7 = w[b + 7];
    for (var k = 0, q = 0; k < NF; k++, q += 8) {
      var x = X[o + k];
      a0 += x * W[q]; a1 += x * W[q + 1]; a2 += x * W[q + 2]; a3 += x * W[q + 3];
      a4 += x * W[q + 4]; a5 += x * W[q + 5]; a6 += x * W[q + 6]; a7 += x * W[q + 7];
    }
    var out = w[NW - 1] + ftanh(a0) * w[v] + ftanh(a1) * w[v + 1] + ftanh(a2) * w[v + 2] + ftanh(a3) * w[v + 3] +
      ftanh(a4) * w[v + 4] + ftanh(a5) * w[v + 5] + ftanh(a6) * w[v + 6] + ftanh(a7) * w[v + 7];
    return ftanh(out + c.herdBias * X[o + 7] + c.sizeBias * X[o + 10] + c.volBias * X[o + 5]);
  };

  Bot.prototype.score = function (m, i) {
    return this.scoreRow(m.features, m.featuresOf(i));
  };

  Bot.prototype.markEquity = function (m) {
    var e = this.cash, gross = 0, net = 0;
    for (var j = 0, L = this.plist; j < L.length; j++) { var k = L[j], p = this.pos[k], v = p.q * m.price[k]; e += v; gross += v < 0 ? -v : v; net += v; }
    this.equity = e;
    this.gross = gross; this.net = net;
    if (e > this.peakEquity) this.peakEquity = e;
    var dd = 1 - e / this.peakEquity;
    if (dd > this.maxDD) this.maxDD = dd;
    return e;
  };

  Bot.prototype.bookTrip = function (m, i, p, px, qty, pnl, reason) {
    var long = p.q > 0, ret = (px / p.avg - 1) * (long ? 1 : -1);
    var mfe = long ? p.peak / p.avg - 1 : 1 - p.trough / p.avg;
    var mae = long ? p.trough / p.avg - 1 : 1 - p.peak / p.avg;
    this.closed++; if (pnl > 0) { this.wins++; this.grossWin += pnl; } else this.grossLoss -= pnl;
    if (ret > this.bestTrade) this.bestTrade = ret;
    if (ret < this.worstTrade) this.worstTrade = ret;
    this.holdDays += m.day - p.day;
    var sec = T.SECTORS[m.sector[i]], sym = m.sym[i];
    this.secPnl[sec] = (this.secPnl[sec] || 0) + pnl;
    this.symPnl[sym] = (this.symPnl[sym] || 0) + pnl;
    this.day0.realized += pnl;
    this.roundTrips.push({ sym: sym, sector: sec, side: long ? "LONG" : "SHORT", qty: qty, entryDay: p.day, entryBar: p.bar, entryPx: p.avg,
      exitDay: m.day, exitBar: m.bar, exitPx: px, pnl: pnl, ret: ret, holdBars: m.gBar - p.gBar, mfe: mfe, mae: mae,
      entryScore: p.score, entryReason: p.why, exitReason: reason, regimeIn: p.regime, regimeOut: m.REGIMES[m.regime].name,
      fees: p.fees, entryRsi: p.rsi, snap: p.snap });
  };

  Bot.prototype.fill = function (m, i, qty, reason, score) {   // qty > 0 buy, < 0 sell
    if (qty === 0 || m.isHalted(i)) return false;
    var q = m.quote(i), dv = Math.max(m.avgVol[i] / m.BARS_PER_DAY, 100);
    var impact = 0.1 * Math.sqrt(Math.abs(qty) / dv) * Math.sqrt(Math.max(m.ewVar[i], 1e-6));
    var px = qty > 0 ? q.ask * (1 + impact) : q.bid * (1 - impact);
    var notional = Math.abs(qty) * px;
    var fee = Math.max(COMMISSION_MIN, Math.abs(qty) * COMMISSION_PER_SHARE) + (qty < 0 ? notional * SEC_FEE : 0);
    if (qty > 0 && this.cash < notional + fee && !(this.pos[i] && this.pos[i].q < 0)) return false;
    this.cash -= qty * px + fee;
    this.fees += fee; this.turnover += notional;
    this.day0.trades++; this.day0.fees += fee; this.day0.notional += notional;
    if (qty > 0) this.day0.buys++; else this.day0.sells++;
    var sym = m.sym[i];
    this.symTrades[sym] = (this.symTrades[sym] || 0) + 1;
    var p = this.pos[i], realized = null;
    if (!p) {
      this.pos[i] = { q: qty, avg: px, day: m.day, bar: m.bar, gBar: m.gBar, peak: px, trough: px, score: score === undefined ? null : score,
        why: reason, regime: m.REGIMES[m.regime].name, fees: fee, rsi: Math.round(m.rsi(i) * 10) / 10, snap: m.snapshot(i) };
      this.nPos++; this.plist.push(i);
    } else if ((p.q > 0) === (qty > 0)) {
      p.avg = (p.avg * p.q + px * qty) / (p.q + qty); p.q += qty; p.fees += fee;
    } else {
      var closeQ = Math.min(Math.abs(qty), Math.abs(p.q));
      realized = (px - p.avg) * closeQ * (p.q > 0 ? 1 : -1) - fee;
      p.fees += fee;
      this.bookTrip(m, i, p, px, closeQ, realized, reason);
      p.q += qty;
      if (Math.abs(p.q) < 1e-9) this.dropPos(i);
    }
    this.trades.push({ day: m.day, bar: m.bar, sym: sym, sector: T.SECTORS[m.sector[i]],
      side: qty > 0 ? (realized !== null ? "COVER" : "BUY") : (realized !== null ? "SELL" : "SHORT"),
      qty: Math.abs(qty), px: px, mid: m.price[i], spreadBps: q.spread * 1e4, impactBps: impact * 1e4, notional: notional,
      fee: fee, pnl: realized, reason: reason, score: score === undefined ? null : score, cashAfter: this.cash });
    return true;
  };

  var CB = { s: new Float64Array(0), i: new Int32Array(0) }, CW = { s: new Float64Array(0), i: new Int32Array(0) };
  /* The k highest-scoring candidates, best first, as [score, symbol] pairs. */
  function topK(buf, n, k) {
    var out = [];
    if (k <= 0 || n === 0) return out;
    if (n <= k) { for (var a = 0; a < n; a++) out.push([buf.s[a], buf.i[a]]); return out.sort(function (x, y) { return y[0] - x[0]; }); }
    var used = new Uint8Array(n);
    for (var r = 0; r < k; r++) {
      var bi = -1, bs = -Infinity;
      for (var t = 0; t < n; t++) if (!used[t] && buf.s[t] > bs) { bs = buf.s[t]; bi = t; }
      used[bi] = 1; out.push([bs, buf.i[bi]]);
    }
    return out;
  }

  Bot.prototype.dropPos = function (i) {
    delete this.pos[i]; this.nPos--;
    var k = this.plist.indexOf(i); if (k >= 0) this.plist.splice(k, 1);
  };

  Bot.prototype.closeAll = function (m, reason) {
    for (var k in this.pos) {
      var p = this.pos[k];
      if (!this.fill(m, +k, -p.q, reason)) {
        // halted at the bell: settle at last price so results are comparable across bots
        var px = m.price[k], pnl = (px - p.avg) * p.q;
        this.cash += p.q * px;
        this.bookTrip(m, +k, p, px, Math.abs(p.q), pnl, reason + " (halted, marked)");
        this.trades.push({ day: m.day, bar: m.bar, sym: m.sym[k], sector: T.SECTORS[m.sector[k]], side: p.q > 0 ? "SELL" : "COVER", qty: Math.abs(p.q),
          px: px, mid: px, spreadBps: 0, impactBps: 0, notional: Math.abs(p.q) * px, fee: 0, pnl: pnl, reason: reason + " (halted, marked)", score: null, cashAfter: this.cash });
        this.dropPos(+k);
      }
    }
  };

  Bot.prototype.onDividend = function (i, amount) {
    var p = this.pos[i];
    if (!p) return;
    var cash = p.q * amount;               // shorts pay the dividend to the lender
    this.cash += cash; this.divIncome += cash; this.day0.div += cash;
  };

  Bot.prototype.onSplit = function (m, i, f) {
    var p = this.pos[i];
    if (!p) return;
    var newQ = p.q / f, whole = newQ > 0 ? Math.floor(newQ) : Math.ceil(newQ);
    this.cash += (newQ - whole) * m.price[i];  // cash in lieu of fractional shares
    p.avg *= f; p.peak *= f; p.trough *= f; p.q = whole;
    if (whole === 0) this.dropPos(i);
  };

  /* Called every bar. Returns true if the bot acted. */
  Bot.prototype.act = function (m) {
    var c = this.cfg;
    var e = this.markEquity(m);
    // margin: liquidate if equity falls below 30% of gross exposure
    if (this.gross > 0 && e < 0.3 * this.gross) { this.marginCalls++; this.closeAll(m, "margin call"); return true; }

    // track excursions and run risk exits every bar (backwards: an exit removes the entry)
    for (var j = this.plist.length - 1; j >= 0; j--) {
      var k = this.plist[j], p = this.pos[k], px = m.price[k], long = p.q > 0;
      if (px > p.peak) p.peak = px;
      if (px < p.trough) p.trough = px;
      var ret = long ? px / p.avg - 1 : 1 - px / p.avg;
      var fromRef = long ? px / p.peak - 1 : 1 - px / p.trough;
      var reason = null;
      if (ret <= -c.stopLoss) reason = "stop loss";
      else if (c.trail && ret > c.stopLoss && fromRef <= -c.stopLoss) reason = "trailing stop";
      else if (ret >= c.takeProfit) reason = "take profit";
      else if (m.day - p.day >= c.maxHold) reason = "max hold";
      if (reason) this.fill(m, k, -p.q, reason);
    }

    if (m.gBar % 6 === 0) {
      this.intraCurve.push(e); this.idxCurve.push(m.index);
      this.expCurve.push(e > 0 ? this.gross / e : 0, e > 0 ? this.net / e : 0);
    }
    if ((m.gBar + this.offset) % c.interval !== 0) return false;

    // re-score holdings, exit if the signal turned
    for (j = this.plist.length - 1; j >= 0; j--) {
      var h = this.plist[j], s = this.score(m, h), q = this.pos[h].q;
      if ((q > 0 && s < c.sellTh) || (q < 0 && s > -c.sellTh)) this.fill(m, h, -q, "signal");
    }
    if (m.bar >= m.BARS_PER_DAY - 1) return true;  // no new entries into the closing print
    if (m.bar < c.entryFrom || m.bar > c.entryTo) return true;   // outside this bot's trading hours (a trait)

    if (this.nPos >= c.maxPos) return true;   // full: nothing to buy, so don't score the market
    // candidates go into shared buffers (no per-stock allocations), then the best few are picked in order
    var pm = m.poolMatrix(), pool = pm.idx, X = pm.X, buyTh = c.buyTh, secs = c.sectors, sector = m.sector, nb = 0, nw = 0;
    if (CB.s.length < pm.n) { CB.s = new Float64Array(pm.n * 2); CB.i = new Int32Array(pm.n * 2); CW.s = new Float64Array(pm.n * 2); CW.i = new Int32Array(pm.n * 2); }
    for (j = 0; j < pm.n; j++) {
      var i = pool[j];
      if (this.pos[i] || (secs && !secs[sector[i]])) continue;
      var sc = this.scoreRow(X, j * NF);
      if (sc > buyTh) { CB.s[nb] = sc; CB.i[nb++] = i; }
      else if (c.shortOn && sc < -buyTh) { CW.s[nw] = -sc; CW.i[nw++] = i; }
    }
    var best = topK(CB, nb, c.maxPos - this.nPos), worst = topK(CW, nw, c.maxPos - this.nPos);
    worst.forEach(function (x) { x[0] = -x[0]; });
    var slots = c.maxPos - this.nPos;
    var reserve = e * c.cashReserve;
    var ib = 0, iw = 0;
    while (slots > 0 && (ib < best.length || iw < worst.length)) {
      var takeShort = iw < worst.length && (ib >= best.length || -worst[iw][0] > best[ib][0]);
      var pick = takeShort ? worst[iw++] : best[ib++];
      var strength = Math.min(1, (Math.abs(pick[0]) - buyTh) / Math.max(1 - buyTh, 0.05));
      var alloc = e * c.posSize * (1 - c.conviction + c.conviction * (0.4 + 0.6 * strength));
      var avail = takeShort ? Math.max(0, e * 1.5 - this.gross) : this.cash - reserve;
      alloc = Math.min(alloc, avail);
      var price = m.price[pick[1]];
      var qty = Math.floor(alloc / price);
      // never take more than 5% of a bar's typical volume
      qty = Math.min(qty, Math.floor(m.avgVol[pick[1]] / m.BARS_PER_DAY * 0.05));
      if (qty < 1 || alloc < Math.min(500, this.startCash * 0.005)) { if (!takeShort) break; else continue; }
      if (this.fill(m, pick[1], takeShort ? -qty : qty, takeShort ? "short signal" : "buy signal", Math.round(pick[0] * 1000) / 1000)) { slots--; this.gross += qty * price; }
    }
    return true;
  };

  /* Close of a session: charge borrow, mark, and hand back that day's ledger. */
  Bot.prototype.endOfDay = function (m) {
    var borrow = 0;
    for (var k in this.pos) {
      var p = this.pos[k];
      if (p.q < 0) {
        var rate = 0.02 + 0.23 * Math.max(0, 1 - Math.log10(m.mcap0[k] + 1) / 4);
        var fee = -p.q * m.price[k] * rate / 252;
        this.cash -= fee; this.fees += fee; borrow += fee;
      }
    }
    this.borrowCost += borrow;
    var prev = this.equityCurve[this.equityCurve.length - 1];
    var e = this.markEquity(m);
    this.equityCurve.push(e);
    var d = this.day0;
    var ledger = { equity: e, cash: this.cash, dailyPnl: e - prev, dailyReturn: prev ? e / prev - 1 : 0, positions: this.nPos,
      grossExposure: e > 0 ? this.gross / e : 0, netExposure: e > 0 ? this.net / e : 0, trades: d.trades, buys: d.buys, sells: d.sells,
      notional: d.notional, realizedPnl: d.realized, fees: d.fees + borrow, borrowCost: borrow, dividends: d.div,
      drawdown: 1 - e / this.peakEquity };
    this.day0 = { trades: 0, realized: 0, fees: 0, div: 0, buys: 0, sells: 0, notional: 0 };
    return ledger;
  };

  function moments(a) {
    var n = a.length, mu = 0, i;
    for (i = 0; i < n; i++) mu += a[i];
    mu /= Math.max(n, 1);
    var v = 0, s3 = 0, s4 = 0;
    for (i = 0; i < n; i++) { var d = a[i] - mu; v += d * d; s3 += d * d * d; s4 += d * d * d * d; }
    var varr = v / Math.max(n - 1, 1), sd = Math.sqrt(varr);
    return { mean: mu, sd: sd, skew: sd > 0 && n > 2 ? (s3 / n) / Math.pow(sd, 3) : 0, kurt: sd > 0 && n > 3 ? (s4 / n) / (varr * varr) - 3 : 0 };
  }

  Bot.prototype.stats = function () {
    var ec = this.intraCurve.concat([this.equity]), ic = this.idxCurve, r = [], x = [], i;
    for (i = 1; i < ec.length; i++) {
      r.push(ec[i] / ec[i - 1] - 1);
      if (i < ic.length) x.push(ic[i] / ic[i - 1] - 1);
    }
    var mr = moments(r), ann = Math.sqrt(252 * SAMPLES_PER_DAY);
    var down = r.filter(function (v) { return v < 0; });
    var dd = Math.sqrt(down.reduce(function (a, v) { return a + v * v; }, 0) / Math.max(r.length, 1));
    // regression on the index (alpha / beta)
    var nx = Math.min(r.length, x.length), mx = 0, my = 0;
    for (i = 0; i < nx; i++) { mx += x[i]; my += r[i]; }
    mx /= Math.max(nx, 1); my /= Math.max(nx, 1);
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < nx; i++) { sxy += (x[i] - mx) * (r[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (r[i] - my) * (r[i] - my); }
    var beta = sxx > 0 ? sxy / sxx : 0, corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    var te = []; for (i = 0; i < nx; i++) te.push(r[i] - x[i]);
    var mte = moments(te);
    // drawdown duration (in samples)
    var peak = ec[0], ddRun = 0, ddMax = 0;
    for (i = 0; i < ec.length; i++) { if (ec[i] >= peak) { peak = ec[i]; ddRun = 0; } else { ddRun++; if (ddRun > ddMax) ddMax = ddRun; } }
    // VaR / CVaR from 30-minute returns, scaled to one day
    var sorted = r.slice().sort(function (a, b) { return a - b; }), k5 = Math.max(0, Math.floor(sorted.length * 0.05) - 1);
    var var95 = sorted.length ? -sorted[k5] * Math.sqrt(SAMPLES_PER_DAY) : 0;
    var tail = sorted.slice(0, k5 + 1), cvar95 = tail.length ? -tail.reduce(function (a, v) { return a + v; }, 0) / tail.length * Math.sqrt(SAMPLES_PER_DAY) : 0;
    // round trips
    var rt = this.roundTrips, wins = rt.filter(function (t) { return t.pnl > 0; }), losses = rt.filter(function (t) { return t.pnl <= 0; });
    var longs = rt.filter(function (t) { return t.side === "LONG"; }), shorts = rt.filter(function (t) { return t.side === "SHORT"; });
    var sum = function (a, f) { return a.reduce(function (s, t) { return s + f(t); }, 0); };
    var avg = function (a, f) { return a.length ? sum(a, f) / a.length : 0; };
    var cw = 0, cl = 0, mcw = 0, mcl = 0;
    rt.forEach(function (t) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } if (cw > mcw) mcw = cw; if (cl > mcl) mcl = cl; });
    var gExp = 0, nExp = 0, ne = this.expCurve.length / 2;
    for (i = 0; i < this.expCurve.length; i += 2) { gExp += this.expCurve[i]; nExp += this.expCurve[i + 1]; }
    var days = Math.max(1, this.equityCurve.length - 1), ret = this.equity / this.startCash - 1;
    var annRet = Math.pow(Math.max(1e-9, 1 + ret), 252 / days) - 1;
    var best = function (obj, dir) { var bk = "", bv = dir > 0 ? -Infinity : Infinity; for (var k in obj) if ((dir > 0 && obj[k] > bv) || (dir < 0 && obj[k] < bv)) { bv = obj[k]; bk = k; } return bk ? bk + " (" + (bv >= 0 ? "+" : "") + bv.toFixed(0) + ")" : ""; };
    var avgWin = avg(wins, function (t) { return t.pnl; }), avgLoss = avg(losses, function (t) { return t.pnl; });
    var mfe = avg(rt, function (t) { return t.mfe; }), mae = avg(rt, function (t) { return t.mae; });
    var idxRet = ic.length > 1 ? ic[ic.length - 1] / ic[0] - 1 : 0;
    return {
      ret: ret, pnl: this.equity - this.startCash, equity: this.equity, annReturn: annRet, days: days,
      volatility: mr.sd * ann, sharpe: mr.sd > 0 ? mr.mean / mr.sd * ann : 0, sortino: dd > 0 ? mr.mean / dd * ann : 0,
      calmar: this.maxDD > 0 ? annRet / this.maxDD : 0, maxDD: this.maxDD, ddDurationDays: ddMax / SAMPLES_PER_DAY,
      beta: beta, alpha: (my - beta * mx) * 252 * SAMPLES_PER_DAY, correlation: corr, rSquared: corr * corr,
      trackingError: mte.sd * ann, infoRatio: mte.sd > 0 ? mte.mean / mte.sd * ann : 0, excessVsIndex: ret - idxRet,
      var95: var95, cvar95: cvar95, skew: mr.skew, kurtosis: mr.kurt,
      trades: this.trades.length, closed: rt.length, winRate: rt.length ? wins.length / rt.length : 0,
      profitFactor: this.grossLoss > 0 ? this.grossWin / this.grossLoss : (this.grossWin > 0 ? 99 : 0),
      expectancy: avg(rt, function (t) { return t.pnl; }), avgWin: avgWin, avgLoss: avgLoss, payoff: avgLoss < 0 ? avgWin / -avgLoss : 0,
      largestWin: rt.length ? Math.max.apply(null, rt.map(function (t) { return t.pnl; })) : 0,
      largestLoss: rt.length ? Math.min.apply(null, rt.map(function (t) { return t.pnl; })) : 0,
      avgTripReturn: avg(rt, function (t) { return t.ret; }), avgHold: this.closed ? this.holdDays / this.closed : 0,
      avgHoldBars: avg(rt, function (t) { return t.holdBars; }), avgMFE: mfe, avgMAE: mae, edgeRatio: mae < 0 ? mfe / -mae : 0,
      maxConsecWins: mcw, maxConsecLosses: mcl,
      longTrips: longs.length, shortTrips: shorts.length, longPnl: sum(longs, function (t) { return t.pnl; }), shortPnl: sum(shorts, function (t) { return t.pnl; }),
      longWinRate: longs.length ? longs.filter(function (t) { return t.pnl > 0; }).length / longs.length : 0,
      shortWinRate: shorts.length ? shorts.filter(function (t) { return t.pnl > 0; }).length / shorts.length : 0,
      avgGrossExposure: ne ? gExp / ne : 0, avgNetExposure: ne ? nExp / ne : 0, turnover: this.turnover / this.startCash,
      fees: this.fees, borrowCost: this.borrowCost, dividends: this.divIncome,
      feeDrag: this.turnover > 0 ? this.fees / this.startCash : 0,
      bestTrade: this.bestTrade, worstTrade: this.worstTrade, marginCalls: this.marginCalls,
      symbolsTraded: Object.keys(this.symTrades).length, bestSector: best(this.secPnl, 1), worstSector: best(this.secPnl, -1),
      bestSymbol: best(this.symPnl, 1), worstSymbol: best(this.symPnl, -1)
    };
  };

  T.TRAITS = TRAITS;
  T.genetics = { random: randomGenotype, inherit: inheritGenotype, phenotypes: phenotypes, phenotype: phenotype, show: showGenotype,
    gamete: gamete, CHROMOSOMES: CHROMOSOMES, CHR_NAMES: CHR_NAMES, RECOMBINATION: RECOMBINATION, ALLELE_MUTATION: ALLELE_MUTATION };
  T.Genome = Genome;
  T.Bot = Bot;
  T.decodeGenes = decode;
  T.BOT_CONST = { NF: NF, H: H, NW: NW, PARAMS: PARAMS, FEATURE_NAMES: FEATURE_NAMES, START_CASH: START_CASH, SAMPLES_PER_DAY: SAMPLES_PER_DAY };
})(window.T = window.T || {});
