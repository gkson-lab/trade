/* Trading agents. Each bot is a small neural network (11 market features -> 8 hidden -> 1 score)
 * plus a set of risk/behaviour genes. Bots trade the shared market with realistic frictions:
 * bid/ask spread, size-based price impact, per-share commission, SEC fee, short borrow cost, margin calls. */
(function (T) {
  "use strict";

  var NF = 11, H = 8;
  var NW = NF * H + H + H + 1;
  var PARAMS = ["buyTh", "sellTh", "maxPos", "posSize", "stopLoss", "takeProfit", "interval", "maxHold", "cashReserve", "shortOn", "trail", "conviction"];
  var FEATURE_NAMES = ["Short momentum", "Day momentum", "Week momentum", "Mean reversion", "News sentiment", "Volatility",
    "Volume surge", "Market trend", "Sector trend", "Beta", "Size"];
  var START_CASH = 100000;
  var COMMISSION_PER_SHARE = 0.005, COMMISSION_MIN = 1, SEC_FEE = 0.0000278;

  function Genome(w, p) { this.w = w; this.p = p; }
  Genome.random = function (r) {
    var w = new Float32Array(NW), p = new Float32Array(PARAMS.length);
    for (var i = 0; i < NW; i++) w[i] = r.normal() * (i < NF * H ? 0.6 : 0.5);
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

  var NAME_A = ["Ash", "Brine", "Cobalt", "Dune", "Ember", "Flint", "Gale", "Harbor", "Iris", "Jade", "Kestrel", "Lumen", "Mako", "Nova",
    "Onyx", "Pike", "Quill", "Rook", "Slate", "Talon", "Umber", "Vale", "Wren", "Xeno", "Yarrow", "Zephyr"];

  function Bot(id, gen, genome, parents, rng) {
    this.id = id;
    this.gen = gen;            // generation this bot was born in
    this.genome = genome;
    this.parents = parents || [];
    this.name = NAME_A[id % NAME_A.length] + "-" + String(id).padStart(3, "0");
    this.cfg = decode(genome.p);
    this.offset = rng.int(0, 11);
    this.style = styleOf(genome);
    this.age = 0;
    this.history = [];         // per-generation results
    this.reset();
  }

  Bot.prototype.reset = function () {
    this.cash = START_CASH;
    this.pos = Object.create(null);  // symbol index -> {q, avg, day, peak, trough}
    this.nPos = 0;
    this.trades = [];
    this.equityCurve = [START_CASH];
    this.intraCurve = [START_CASH];
    this.equity = START_CASH;
    this.peakEquity = START_CASH;
    this.maxDD = 0;
    this.fees = 0;
    this.closed = 0; this.wins = 0; this.grossWin = 0; this.grossLoss = 0; this.holdDays = 0;
    this.bestTrade = 0; this.worstTrade = 0;
    this.marginCalls = 0;
  };

  function styleOf(g) {
    var imp = new Float64Array(NF), i, h;
    for (i = 0; i < NF; i++) for (h = 0; h < H; h++) imp[i] += Math.abs(g.w[i * H + h] * g.w[NF * H + H + h]);
    var best = 0, sign = 0;
    for (i = 1; i < NF; i++) if (imp[i] > imp[best]) best = i;
    for (h = 0; h < H; h++) sign += g.w[best * H + h] * g.w[NF * H + H + h];
    var nm = FEATURE_NAMES[best];
    return (sign >= 0 ? "" : "Contra ") + nm;
  }

  Bot.prototype.score = function (m, i) {
    var base = m.featuresOf(i), f = m.features, w = this.genome.w, out = w[NW - 1];
    for (var h = 0; h < H; h++) {
      var a = w[NF * H + h];
      for (var k = 0; k < NF; k++) a += f[base + k] * w[k * H + h];
      out += Math.tanh(a) * w[NF * H + H + h];
    }
    return Math.tanh(out);
  };

  Bot.prototype.markEquity = function (m) {
    var e = this.cash, gross = 0;
    for (var k in this.pos) { var p = this.pos[k], v = p.q * m.price[k]; e += v; gross += Math.abs(v); }
    this.equity = e;
    this.gross = gross;
    if (e > this.peakEquity) this.peakEquity = e;
    var dd = 1 - e / this.peakEquity;
    if (dd > this.maxDD) this.maxDD = dd;
    return e;
  };

  Bot.prototype.fill = function (m, i, qty, reason) {   // qty > 0 buy, < 0 sell
    if (qty === 0 || m.isHalted(i)) return false;
    var q = m.quote(i), dv = Math.max(m.avgVol[i] / m.BARS_PER_DAY, 100);
    var impact = 0.1 * Math.sqrt(Math.abs(qty) / dv) * Math.sqrt(Math.max(m.ewVar[i], 1e-6));
    var px = qty > 0 ? q.ask * (1 + impact) : q.bid * (1 - impact);
    var notional = Math.abs(qty) * px;
    var fee = Math.max(COMMISSION_MIN, Math.abs(qty) * COMMISSION_PER_SHARE) + (qty < 0 ? notional * SEC_FEE : 0);
    if (qty > 0 && this.cash < notional + fee && !(this.pos[i] && this.pos[i].q < 0)) return false;
    this.cash -= qty * px + fee;
    this.fees += fee;
    var p = this.pos[i], realized = null;
    if (!p) {
      this.pos[i] = { q: qty, avg: px, day: m.day, peak: px, trough: px };
      this.nPos++;
    } else if ((p.q > 0) === (qty > 0)) {
      p.avg = (p.avg * p.q + px * qty) / (p.q + qty); p.q += qty;
    } else {
      var closeQ = Math.min(Math.abs(qty), Math.abs(p.q));
      realized = (px - p.avg) * closeQ * (p.q > 0 ? 1 : -1) - fee;
      var retPct = (px / p.avg - 1) * (p.q > 0 ? 1 : -1);
      this.closed++; if (realized > 0) { this.wins++; this.grossWin += realized; } else this.grossLoss -= realized;
      if (retPct > this.bestTrade) this.bestTrade = retPct;
      if (retPct < this.worstTrade) this.worstTrade = retPct;
      this.holdDays += m.day - p.day;
      p.q += qty;
      if (Math.abs(p.q) < 1e-9) { delete this.pos[i]; this.nPos--; }
      else if ((p.q > 0) !== (p.q - qty > 0)) { p.avg = px; p.day = m.day; p.peak = px; p.trough = px; }
    }
    this.trades.push({ day: m.day, bar: m.bar, sym: m.sym[i], side: qty > 0 ? (realized !== null ? "COVER" : "BUY") : (realized !== null ? "SELL" : "SHORT"),
      qty: Math.abs(qty), px: px, fee: fee, pnl: realized, reason: reason });
    return true;
  };

  Bot.prototype.closeAll = function (m, reason) {
    for (var k in this.pos) {
      var p = this.pos[k];
      if (!this.fill(m, +k, -p.q, reason)) {
        // halted at the bell: settle at last price so results are comparable across bots
        var px = m.price[k], pnl = (px - p.avg) * p.q;
        this.cash += p.q * px;
        this.closed++; if (pnl > 0) { this.wins++; this.grossWin += pnl; } else this.grossLoss -= pnl;
        this.trades.push({ day: m.day, bar: m.bar, sym: m.sym[k], side: p.q > 0 ? "SELL" : "COVER", qty: Math.abs(p.q), px: px, fee: 0, pnl: pnl, reason: reason + " (halted, marked)" });
        delete this.pos[k]; this.nPos--;
      }
    }
  };

  /* Called every bar. Returns true if the bot acted. */
  Bot.prototype.act = function (m) {
    var c = this.cfg;
    var e = this.markEquity(m);
    // margin: liquidate if equity falls below 30% of gross exposure
    if (this.gross > 0 && e < 0.3 * this.gross) { this.marginCalls++; this.closeAll(m, "margin call"); return true; }

    // risk exits run every bar
    for (var k in this.pos) {
      var p = this.pos[k], px = m.price[k], long = p.q > 0;
      if (long) { if (px > p.peak) p.peak = px; } else if (px < p.trough) p.trough = px;
      var ret = long ? px / p.avg - 1 : 1 - px / p.avg;
      var ref = long ? p.peak : p.trough;
      var fromRef = long ? px / ref - 1 : 1 - px / ref;
      var reason = null;
      if (ret <= -c.stopLoss) reason = "stop loss";
      else if (c.trail && ret > c.stopLoss && fromRef <= -c.stopLoss) reason = "trailing stop";
      else if (ret >= c.takeProfit) reason = "take profit";
      else if (m.day - p.day >= c.maxHold) reason = "max hold";
      if (reason) this.fill(m, +k, -p.q, reason);
    }

    if (m.gBar % 6 === 0) { this.intraCurve.push(e); if (this.intraCurve.length > 4000) this.intraCurve.splice(1, 1); }
    if ((m.gBar + this.offset) % c.interval !== 0) return false;

    // re-score holdings, exit if the signal turned
    for (k in this.pos) {
      var s = this.score(m, +k), q = this.pos[k].q;
      if ((q > 0 && s < c.sellTh) || (q < 0 && s > -c.sellTh)) this.fill(m, +k, -q, "signal");
    }
    if (m.bar >= m.BARS_PER_DAY - 1) return true;  // no new entries into the closing print

    var pool = m.pool(), best = [], worst = [], buyTh = c.buyTh;
    for (var j = 0; j < pool.length; j++) {
      var i = pool[j];
      if (this.pos[i]) continue;
      var sc = this.score(m, i);
      if (sc > buyTh) best.push([sc, i]);
      else if (c.shortOn && sc < -buyTh) worst.push([sc, i]);
    }
    best.sort(function (a, b) { return b[0] - a[0]; });
    worst.sort(function (a, b) { return a[0] - b[0]; });
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
      if (qty < 1 || alloc < 500) { if (!takeShort) break; else continue; }
      if (this.fill(m, pick[1], takeShort ? -qty : qty, takeShort ? "short signal" : "buy signal")) { slots--; this.gross += qty * price; }
    }
    return true;
  };

  Bot.prototype.endOfDay = function (m) {
    // borrow cost on shorts (2%/yr large caps, up to 25%/yr small caps)
    for (var k in this.pos) {
      var p = this.pos[k];
      if (p.q < 0) {
        var rate = 0.02 + 0.23 * Math.max(0, 1 - Math.log10(m.mcap0[k] + 1) / 4);
        var fee = -p.q * m.price[k] * rate / 252;
        this.cash -= fee; this.fees += fee;
      }
    }
    var e = this.markEquity(m);
    this.equityCurve.push(e);
  };

  Bot.prototype.stats = function () {
    // Sharpe from 30-minute equity samples (13 per session), annualized
    var ec = this.intraCurve.concat([this.equity]), rets = [], i;
    for (i = 1; i < ec.length; i++) rets.push(ec[i] / ec[i - 1] - 1);
    var mean = 0; for (i = 0; i < rets.length; i++) mean += rets[i]; mean /= Math.max(rets.length, 1);
    var v = 0; for (i = 0; i < rets.length; i++) v += (rets[i] - mean) * (rets[i] - mean); v /= Math.max(rets.length - 1, 1);
    var sd = Math.sqrt(v);
    return {
      ret: this.equity / START_CASH - 1,
      pnl: this.equity - START_CASH,
      equity: this.equity,
      maxDD: this.maxDD,
      sharpe: sd > 0 ? mean / sd * Math.sqrt(252 * 13) : 0,
      trades: this.trades.length,
      closed: this.closed,
      winRate: this.closed ? this.wins / this.closed : 0,
      profitFactor: this.grossLoss > 0 ? this.grossWin / this.grossLoss : (this.grossWin > 0 ? 99 : 0),
      avgHold: this.closed ? this.holdDays / this.closed : 0,
      fees: this.fees,
      bestTrade: this.bestTrade,
      worstTrade: this.worstTrade,
      marginCalls: this.marginCalls
    };
  };

  T.Genome = Genome;
  T.Bot = Bot;
  T.decodeGenes = decode;
  T.BOT_CONST = { NF: NF, H: H, NW: NW, PARAMS: PARAMS, FEATURE_NAMES: FEATURE_NAMES, START_CASH: START_CASH };
})(window.T = window.T || {});
