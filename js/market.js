/* Market engine.
 *
 * Price model per 5-minute bar, for every listed symbol:
 *   r_i = beta_i * M + s_i * S_sector + sigma_i * v_i * u(bar) * e_i + jump_i + news_i + drift_i
 *
 *   M        market factor: regime-switching drift (bull / neutral / bear / crash) with GARCH(1,1) volatility
 *   S        sector factor with its own volatility and news
 *   e_i      fat-tailed idiosyncratic noise (normal scale mixture)
 *   v_i      per-stock volatility state (clusters after big moves and news, decays back to 1)
 *   u(bar)   intraday U-shaped volatility/volume profile (busy open and close, quiet lunch)
 *   jump_i   Poisson jumps
 *   news_i   news shocks, absorbed over several bars (price discovery) plus overnight gaps
 *   drift_i  post-news drift that decays
 * Also: bid/ask spreads by liquidity, LULD-style single-stock halts, market-wide circuit breaker,
 * cap-weighted SIM 500 index and cap-weighted sector indices.
 */
(function (T) {
  "use strict";

  var BPD = 78;           // 5-minute bars per 6.5h session
  var INTRA = 120;        // intraday bars kept per symbol
  var DAILY = 140;        // daily bars kept per symbol
  var BACKFILL = 120;     // days of history generated before the run starts

  var REGIMES = [
    { name: "Bull",    drift: 0.22,  vol: 0.085 },
    { name: "Neutral", drift: 0.04,  vol: 0.11 },
    { name: "Bear",    drift: -0.34, vol: 0.22 },
    { name: "Crash",   drift: -3.2,  vol: 0.50 }
  ];
  var TRANS = [
    [0.986, 0.011, 0.002, 0.001],
    [0.013, 0.975, 0.011, 0.001],
    [0.005, 0.018, 0.972, 0.005],
    [0.04, 0.16, 0.42, 0.38]
  ];
  var SECTOR_BETA = [1.25, 0.9, 1.1, 1.15, 0.6, 1.05, 1.0, 0.45, 0.85, 1.05, 0.7, 1.0];
  var SECTOR_VOL = [0.11, 0.10, 0.09, 0.10, 0.06, 0.07, 0.18, 0.08, 0.10, 0.12, 0.08, 0.10];

  // intraday profile: volatility multiplier per bar (U-shape), normalized to RMS 1
  var UVOL = new Float64Array(BPD), UVOLUME = new Float64Array(BPD);
  (function () {
    var ss = 0, sv = 0;
    for (var b = 0; b < BPD; b++) {
      var x = b / (BPD - 1);
      UVOL[b] = 0.75 + 1.1 * Math.exp(-x * 9) + 0.45 * Math.exp(-(1 - x) * 10);
      UVOLUME[b] = 0.55 + 1.9 * Math.exp(-x * 7) + 1.3 * Math.exp(-(1 - x) * 8);
      ss += UVOL[b] * UVOL[b]; sv += UVOLUME[b];
    }
    var k = Math.sqrt(ss / BPD), kv = sv / BPD;
    for (b = 0; b < BPD; b++) { UVOL[b] /= k; UVOLUME[b] /= kv; }
  })();

  function Market(opts) {
    opts = opts || {};
    var seed = opts.seed || 12345;
    this.rng = new T.RNG(seed);
    var r = this.rng;
    var src = T.SYMBOLS;
    var n = opts.maxSymbols ? Math.min(opts.maxSymbols, src.length) : src.length;
    this.n = n;
    this.BARS_PER_DAY = BPD;
    this.INTRA = INTRA;
    this.DAILY = DAILY;
    this.REGIMES = REGIMES;

    this.sym = new Array(n); this.name = new Array(n);
    this.exch = new Uint8Array(n); this.sector = new Uint8Array(n); this.sp = new Uint8Array(n);
    this.price0 = new Float64Array(n); this.mcap0 = new Float64Array(n); this.avgVol = new Float64Array(n);
    this.shares = new Float64Array(n);
    this.beta = new Float32Array(n); this.sload = new Float32Array(n); this.idioVol = new Float32Array(n);
    this.jumpRate = new Float32Array(n); this.earningsBias = new Float32Array(n);
    this.price = new Float64Array(n); this.prevClose = new Float64Array(n);
    this.dOpen = new Float64Array(n); this.dHigh = new Float64Array(n); this.dLow = new Float64Array(n); this.dVolume = new Float64Array(n);
    this.volState = new Float32Array(n); this.pending = new Float32Array(n); this.drift = new Float32Array(n);
    this.sentiment = new Float32Array(n); this.haltUntil = new Int32Array(n); this.ewVar = new Float32Array(n);
    this.lastNewsDay = new Int32Array(n).fill(-999);
    this.symIndex = Object.create(null);
    this.earningsByOffset = {};

    var nS = T.SECTORS.length;
    this.sectorPending = new Float64Array(nS); this.sectorDrift = new Float64Array(nS); this.sectorVar = new Float64Array(nS);
    this.sectorIdx = new Float64Array(nS); this.sectorPrev = new Float64Array(nS); this.sectorBase = new Float64Array(nS);
    for (var s = 0; s < nS; s++) this.sectorVar[s] = 1;

    var cum = new Float64Array(n), tot = 0;
    for (var i = 0; i < n; i++) {
      var row = src[i];
      this.sym[i] = row[0]; this.name[i] = row[1]; this.exch[i] = row[2]; this.sector[i] = row[3];
      this.price0[i] = row[4]; this.mcap0[i] = row[5]; this.avgVol[i] = row[6]; this.sp[i] = row[7];
      this.symIndex[row[0]] = i;
      this.shares[i] = row[5] * 1e6 / row[4];
      var rr = new T.RNG(T.hashStr(row[0]) ^ seed);
      var mcapB = Math.max(row[5] / 1000, 0.005);
      var smallness = Math.max(0, Math.log10(2500 / mcapB));
      var iv = (0.16 + 0.095 * smallness) * Math.exp(0.2 * rr.normal());
      if (row[3] === 1 && mcapB < 5) iv *= 1.35;             // small biotech
      if (row[4] < 3) iv *= 1.15;                            // low-priced names
      this.idioVol[i] = Math.min(1.2, Math.max(0.1, iv));
      this.beta[i] = Math.max(0.1, SECTOR_BETA[row[3]] * Math.exp(0.22 * rr.normal()) * (1 + 0.04 * smallness));
      this.sload[i] = Math.max(0.2, 1 + 0.25 * rr.normal());
      this.jumpRate[i] = (0.6 + smallness * 0.5) / 252;      // jumps per day
      this.earningsBias[i] = 0.25 * rr.normal();
      var off = T.hashStr("e" + row[0]) % 63;
      (this.earningsByOffset[off] = this.earningsByOffset[off] || []).push(i);
      this.volState[i] = 1;
      this.ewVar[i] = this.idioVol[i] * this.idioVol[i] / 252;
      tot += Math.pow(row[5], 0.35); cum[i] = tot;
    }
    this.pickCum = cum; this.pickTot = tot;

    // ring buffers (stock-major)
    this.iO = new Float32Array(n * INTRA); this.iH = new Float32Array(n * INTRA); this.iL = new Float32Array(n * INTRA);
    this.iC = new Float32Array(n * INTRA); this.iV = new Float32Array(n * INTRA);
    this.dO = new Float32Array(n * DAILY); this.dH = new Float32Array(n * DAILY); this.dL = new Float32Array(n * DAILY);
    this.dC = new Float32Array(n * DAILY); this.dV = new Float32Array(n * DAILY);
    this.idx = { iO: new Float64Array(INTRA), iH: new Float64Array(INTRA), iL: new Float64Array(INTRA), iC: new Float64Array(INTRA), iV: new Float64Array(INTRA),
                 dO: new Float64Array(DAILY), dH: new Float64Array(DAILY), dL: new Float64Array(DAILY), dC: new Float64Array(DAILY), dV: new Float64Array(DAILY) };

    this.regime = 1;
    this.regimeDays = 0;
    this.mVar = Math.pow(REGIMES[1].vol, 2) / 252 / BPD;
    this.mPending = 0; this.mDrift = 0;
    this.gBar = 0;            // global bar counter (since run start)
    this.dayIdx = BACKFILL;   // global daily slot counter (includes backfill)
    this.day = 0;             // trading day since run start
    this.bar = 0;             // bar within day
    this.haltMarketUntil = -1;
    this.cbLevel = 0;
    this.news = new T.News(r.fork("news"), this);
    this.newsLog = [];
    this.recentNews = [];
    this.listeners = [];
    this.startDate = new Date(Date.UTC(2027, 0, 4));
    this.date = new Date(this.startDate.getTime());
    this._poolBar = -1; this._pool = null;
    this.featureStamp = new Int32Array(n).fill(-1);
    this.NF = 11;
    this.features = new Float32Array(n * this.NF);

    // static liquidity rank for the candidate pool
    var order = []; for (i = 0; i < n; i++) order.push(i);
    var self = this;
    order.sort(function (a, b) { return self.avgVol[b] * self.price0[b] - self.avgVol[a] * self.price0[a]; });
    this.liquid = order.slice(0, Math.min(n, 300));

    this.backfill();
    this.updateCalendar();
  }

  Market.prototype.updateCalendar = function () {
    var d = this.date;
    this.dayOfWeek = d.getUTCDay();
    this.dayOfMonth = d.getUTCDate();
  };

  Market.prototype.advanceDate = function () {
    var d = this.date;
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    this.updateCalendar();
  };

  Market.prototype.dateStr = function (dayOffset) {
    var d = new Date(this.startDate.getTime()), k = dayOffset || 0;
    if (k > 0) { while (k > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) k--; } }
    else { while (k < 0) { d.setUTCDate(d.getUTCDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) k++; } }
    return d.toISOString().slice(0, 10);
  };

  Market.prototype.clockStr = function () {
    var mins = 9 * 60 + 30 + this.bar * 5;
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h > 12 ? h - 12 : h) + ":" + (m < 10 ? "0" : "") + m + (h >= 12 ? " PM" : " AM");
  };

  function tickRound(p) { return p >= 1 ? Math.round(p * 100) / 100 : Math.max(0.0001, Math.round(p * 10000) / 10000); }

  /* History before the run: daily candles ending exactly at the listing price. */
  Market.prototype.backfill = function () {
    var n = this.n, r = this.rng.fork("backfill"), D = DAILY;
    var mk = new Float64Array(BACKFILL), sk = [];
    for (var t = 0; t < BACKFILL; t++) mk[t] = 0.0004 + 0.01 * r.normal();
    for (var s = 0; s < T.SECTORS.length; s++) {
      var a = new Float64Array(BACKFILL);
      for (t = 0; t < BACKFILL; t++) a[t] = SECTOR_VOL[s] / Math.sqrt(252) * r.normal();
      sk.push(a);
    }
    var lr = new Float64Array(BACKFILL);
    for (var i = 0; i < n; i++) {
      var dv = this.idioVol[i] / Math.sqrt(252), L = 0;
      for (t = 0; t < BACKFILL; t++) {
        var e = r.normal(); if (r.chance(0.05)) e *= 2.6;
        L += this.beta[i] * mk[t] + this.sload[i] * sk[this.sector[i]][t] + dv * e * 0.86;
        lr[t] = L;
      }
      var base = i * D, p0 = this.price0[i];
      var prev = p0 * Math.exp(lr[0] - L - (lr[1] - lr[0]));
      for (t = 0; t < BACKFILL; t++) {
        var c = tickRound(p0 * Math.exp(lr[t] - L));
        var o = tickRound(prev * Math.exp(0.25 * dv * r.normal()));
        var hi = Math.max(o, c) * Math.exp(Math.abs(r.normal()) * dv * 0.45);
        var lo = Math.min(o, c) * Math.exp(-Math.abs(r.normal()) * dv * 0.45);
        var slot = base + (t % D);
        this.dO[slot] = o; this.dH[slot] = tickRound(hi); this.dL[slot] = tickRound(lo); this.dC[slot] = c;
        this.dV[slot] = this.avgVol[i] * Math.exp(0.35 * r.normal()) * (1 + 8 * Math.abs(Math.log(c / prev)) / dv * 0.1);
        prev = c;
      }
      this.price[i] = p0; this.prevClose[i] = p0;
      this.dOpen[i] = p0; this.dHigh[i] = p0; this.dLow[i] = p0; this.dVolume[i] = 0;
    }
    // index & sector index histories from constituents
    var divisor = 0, capNow = 0;
    for (i = 0; i < n; i++) if (this.sp[i]) capNow += this.shares[i] * this.price0[i];
    this.divisor = capNow / 5000;
    var secCap = new Float64Array(T.SECTORS.length);
    for (i = 0; i < n; i++) secCap[this.sector[i]] += this.shares[i] * this.price0[i];
    for (s = 0; s < secCap.length; s++) { this.sectorBase[s] = secCap[s] / 100 || 1; this.sectorIdx[s] = 100; this.sectorPrev[s] = 100; }
    for (t = 0; t < BACKFILL; t++) {
      var so = 0, sh = 0, sl = 0, sc = 0, sv = 0;
      for (i = 0; i < n; i++) {
        if (!this.sp[i]) continue;
        var k = i * D + (t % D), w = this.shares[i];
        so += this.dO[k] * w; sh += this.dH[k] * w; sl += this.dL[k] * w; sc += this.dC[k] * w; sv += this.dV[k] * this.dC[k];
      }
      var q = t % D;
      this.idx.dO[q] = so / this.divisor; this.idx.dH[q] = sh / this.divisor; this.idx.dL[q] = sl / this.divisor;
      this.idx.dC[q] = sc / this.divisor; this.idx.dV[q] = sv;
    }
    this.index = 5000; this.indexPrevClose = 5000; this.indexOpen = 5000; this.indexHigh = 5000; this.indexLow = 5000; this.indexVol = 0;
    this.indexDayStart = 5000;
  };

  Market.prototype.randomStock = function (r) {
    var x = r.next() * this.pickTot, lo = 0, hi = this.n - 1, c = this.pickCum;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (c[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };

  Market.prototype.applyNews = function (it) {
    if (it.scope === "stock") {
      var i = it.target;
      this.pending[i] += it.impact;
      this.drift[i] += (it.drift || 0) / 10;
      this.volState[i] = Math.min(6, this.volState[i] * (it.vol || 1.3));
      this.sentiment[i] = Math.max(-1, Math.min(1, this.sentiment[i] + it.sentiment));
      this.lastNewsDay[i] = this.day;
    } else if (it.scope === "sector") {
      this.sectorPending[it.target] += it.impact;
      this.sectorDrift[it.target] += (it.drift || 0) / 10;
      this.sectorVar[it.target] *= 1 + ((it.vol || 1.2) - 1) * 0.5;
    } else {
      this.mPending += it.impact;
      this.mDrift += (it.drift || 0) / 10;
      this.mVar *= 1 + ((it.vol || 1.3) - 1) * 0.5;
      if (it.regimePush) this.pushRegime(it.regimePush);
    }
    it.date = this.dateStr(this.day);
    it.time = this.clockStr();
    this.newsLog.push(it);
    this.recentNews.push(it);
    if (this.recentNews.length > 200) this.recentNews.shift();
  };

  Market.prototype.pushRegime = function (dir) {
    var r = this.rng;
    if (dir < 0 && this.regime < 2 && r.chance(0.12)) this.setRegime(this.regime + 1);
    else if (dir > 0 && this.regime >= 1 && r.chance(0.12)) this.setRegime(Math.max(0, this.regime - 1));
  };

  Market.prototype.setRegime = function (k) {
    if (k === this.regime) return;
    this.regime = k; this.regimeDays = 0;
    this.emit("regime", REGIMES[k].name);
  };

  Market.prototype.emit = function (type, data) {
    for (var k = 0; k < this.listeners.length; k++) this.listeners[k](type, data);
  };
  Market.prototype.on = function (fn) { this.listeners.push(fn); };

  /* Advance one 5-minute bar. */
  Market.prototype.step = function () {
    var r = this.rng, n = this.n, b = this.bar, reg = REGIMES[this.regime];
    var g = this.gBar, pos = g % INTRA, opening = b === 0;

    if (opening) this.openDay();

    // news for this bar
    var items = this.news.tick();
    for (var k = 0; k < items.length; k++) this.applyNews(items[k]);

    var marketHalted = this.haltMarketUntil > g;

    // market factor (GARCH(1,1) toward regime target variance)
    var target = reg.vol * reg.vol / 252 / BPD;
    var e = r.normal(); if (r.chance(0.04)) e *= 2.4;
    var M = 0;
    if (!marketHalted) {
      var mAbs = opening ? this.mPending * 0.85 : this.mPending * 0.4;
      this.mPending -= mAbs;
      M = reg.drift / 252 / BPD - 0.5 * this.mVar + Math.sqrt(this.mVar) * UVOL[b] * e * 0.9 + mAbs + this.mDrift;
      if (opening) M += Math.sqrt(target * BPD) * 0.3 * r.normal();        // overnight gap
      this.mVar = target * 0.03 + 0.06 * (M - reg.drift / 252 / BPD) * (M - reg.drift / 252 / BPD) / (UVOL[b] * UVOL[b]) + 0.91 * this.mVar;
      this.mVar = Math.min(this.mVar, target * 12);
      this.mDrift *= 0.96;
    }

    // sector factors
    var nS = T.SECTORS.length, S = this._S || (this._S = new Float64Array(nS));
    for (var s = 0; s < nS; s++) {
      if (marketHalted) { S[s] = 0; continue; }
      var sv = SECTOR_VOL[s] / Math.sqrt(252 * BPD);
      var sAbs = this.sectorPending[s] * (opening ? 0.85 : 0.4);
      this.sectorPending[s] -= sAbs;
      S[s] = sv * Math.sqrt(this.sectorVar[s]) * UVOL[b] * r.normal() + sAbs + this.sectorDrift[s];
      this.sectorVar[s] = 1 + (this.sectorVar[s] - 1) * 0.97;
      this.sectorDrift[s] *= 0.96;
    }

    var sqrtBar = Math.sqrt(1 / (252 * BPD)), u = UVOL[b], uv = UVOLUME[b];
    var iO = this.iO, iH = this.iH, iL = this.iL, iC = this.iC, iV = this.iV;
    var sentDecay = Math.exp(-1 / (BPD * 2));
    var cbCheck = false;

    for (var i = 0; i < n; i++) {
      var p = this.price[i], slot = i * INTRA + pos;
      var halted = marketHalted || this.haltUntil[i] > g;
      this.sentiment[i] *= sentDecay;
      if (halted) {
        iO[slot] = p; iH[slot] = p; iL[slot] = p; iC[slot] = p; iV[slot] = 0;
        continue;
      }
      var sig = this.idioVol[i] * sqrtBar * this.volState[i] * u;
      var z = r.normal(); if (r.next() < 0.06) z *= 2.6;
      z *= 0.862;                                        // unit-variance fat-tailed shock
      var ret = this.beta[i] * M + this.sload[i] * S[this.sector[i]] + sig * z - 0.5 * sig * sig + this.drift[i];
      if (opening) ret += this.idioVol[i] / Math.sqrt(252) * 0.3 * r.normal();
      // news absorption: most of an overnight item gaps at the open, intraday items over a few bars
      var pend = this.pending[i];
      if (pend !== 0) {
        var a = pend * (opening ? 0.8 : 0.45);
        a *= 1 + 0.25 * r.normal();                    // over/under-shoot
        ret += a; pend -= a;
        this.pending[i] = Math.abs(pend) < 1e-5 ? 0 : pend;
      }
      // jumps
      if (r.next() < this.jumpRate[i] / BPD) {
        var jsz = this.idioVol[i] / Math.sqrt(252) * (2 + 2 * Math.abs(r.normal())) * (r.next() < 0.5 ? -1 : 1);
        ret += jsz; this.volState[i] = Math.min(6, this.volState[i] * 1.8);
      }
      this.drift[i] *= 0.97;
      if (ret > 1.5) ret = 1.5; else if (ret < -0.9) ret = -0.9;

      var o = p, c = tickRound(p * Math.exp(ret));
      if (c <= 0.0001) c = 0.0001;
      var wig = Math.abs(sig) * 0.55;
      var hi = tickRound(Math.max(o, c) * Math.exp(Math.abs(r.normal()) * wig));
      var lo = tickRound(Math.min(o, c) * Math.exp(-Math.abs(r.normal()) * wig));
      var zz = sig > 0 ? Math.abs(ret) / (sig + 1e-9) : 0;
      var vol = this.avgVol[i] / BPD * uv * Math.exp(0.35 * r.normal()) * (0.7 + 0.3 * Math.min(zz, 8)) * Math.sqrt(this.volState[i]);
      iO[slot] = o; iH[slot] = hi; iL[slot] = lo; iC[slot] = c; iV[slot] = vol;
      this.price[i] = c;
      if (hi > this.dHigh[i]) this.dHigh[i] = hi;
      if (lo < this.dLow[i]) this.dLow[i] = lo;
      this.dVolume[i] += vol;

      // volatility clustering
      var vs = this.volState[i];
      vs = 1 + (vs - 1) * 0.985 + 0.025 * (z * z - 1);
      this.volState[i] = vs < 0.5 ? 0.5 : vs > 6 ? 6 : vs;

      // LULD-style halt: >10% in one bar (20% under $3) pauses the name for 2 bars
      if (!opening && Math.abs(ret) > (p < 3 ? 0.2 : 0.1)) {
        this.haltUntil[i] = g + 3;
        if (this.mcap0[i] >= 1000) {
          this.newsLog.push({ id: 0, day: this.day, bar: b, scope: "stock", target: i, sym: this.sym[i], kind: "halt",
            headline: "Trading halted in " + this.sym[i] + " (volatility pause, LULD)", impact: 0, sentiment: 0,
            date: this.dateStr(this.day), time: this.clockStr() });
          this.recentNews.push(this.newsLog[this.newsLog.length - 1]);
        }
      }
    }

    this.updateIndex(pos);
    // market-wide circuit breaker on SIM 500: -7% (L1) / -13% (L2) halts trading 3 bars, -20% ends the day
    var dd = this.index / this.indexPrevClose - 1;
    if (!marketHalted && b < BPD - 3) {
      var lvl = dd <= -0.2 ? 3 : dd <= -0.13 ? 2 : dd <= -0.07 ? 1 : 0;
      if (lvl > this.cbLevel) {
        this.cbLevel = lvl;
        this.haltMarketUntil = lvl === 3 ? g + (BPD - b) : g + 3;
        var it = { id: 0, day: this.day, bar: b, scope: "market", target: -1, sym: null, kind: "halt", impact: 0, sentiment: -1,
          headline: "Market-wide circuit breaker Level " + lvl + " triggered: SIM 500 down " + (-dd * 100).toFixed(1) + "%",
          date: this.dateStr(this.day), time: this.clockStr() };
        this.newsLog.push(it); this.recentNews.push(it);
      }
    }

    this.gBar++;
    this.bar++;
    var closed = false;
    if (this.bar >= BPD) { this.closeDay(); closed = true; }
    return closed;
  };

  Market.prototype.updateIndex = function (pos) {
    var n = this.n, cap = 0, vol = 0, nS = T.SECTORS.length;
    var sc = this._sc || (this._sc = new Float64Array(nS));
    sc.fill(0);
    for (var i = 0; i < n; i++) {
      var c = this.shares[i] * this.price[i];
      sc[this.sector[i]] += c;
      if (this.sp[i]) { cap += c; vol += this.iV[i * INTRA + pos] * this.price[i]; }
    }
    for (var s = 0; s < nS; s++) this.sectorIdx[s] = sc[s] / this.sectorBase[s];
    var prev = this.index, v = cap / this.divisor;
    this.idx.iO[pos] = prev; this.idx.iC[pos] = v;
    this.idx.iH[pos] = Math.max(prev, v) * (1 + Math.abs(v / prev - 1) * 0.3);
    this.idx.iL[pos] = Math.min(prev, v) * (1 - Math.abs(v / prev - 1) * 0.3);
    this.idx.iV[pos] = vol;
    this.index = v;
    if (v > this.indexHigh) this.indexHigh = v;
    if (v < this.indexLow) this.indexLow = v;
    this.indexVol += vol;
  };

  Market.prototype.openDay = function () {
    var row = TRANS[this.regime], x = this.rng.next(), k = 0;
    while (k < 3 && x > row[k]) { x -= row[k]; k++; }
    this.regimeDays++;
    if (k !== this.regime) this.setRegime(k);
    for (var i = 0; i < this.n; i++) {
      this.dOpen[i] = this.price[i]; this.dHigh[i] = this.price[i]; this.dLow[i] = this.price[i]; this.dVolume[i] = 0;
    }
    this.indexOpen = this.index; this.indexHigh = this.index; this.indexLow = this.index; this.indexVol = 0;
    this.cbLevel = 0;
  };

  Market.prototype.closeDay = function () {
    var D = DAILY, q = this.dayIdx % D;
    for (var i = 0; i < this.n; i++) {
      var k = i * D + q, c = this.price[i];
      this.dO[k] = this.dOpen[i]; this.dH[k] = this.dHigh[i]; this.dL[k] = this.dLow[i]; this.dC[k] = c; this.dV[k] = this.dVolume[i];
      var lr = Math.log(c / this.prevClose[i]);
      this.ewVar[i] = 0.94 * this.ewVar[i] + 0.06 * lr * lr;
      this.prevClose[i] = c;
      // occasional daily-volatility fade of huge pending moves
    }
    this.idx.dO[q] = this.indexOpen; this.idx.dH[q] = this.indexHigh; this.idx.dL[q] = this.indexLow;
    this.idx.dC[q] = this.index; this.idx.dV[q] = this.indexVol;
    this.indexPrevClose = this.index;
    for (var s = 0; s < this.sectorPrev.length; s++) this.sectorPrev[s] = this.sectorIdx[s];
    this.dayIdx++;
    this.day++;
    this.bar = 0;
    this.advanceDate();
    this.emit("close", this.day - 1);
  };

  /* ---- read side ---- */

  Market.prototype.quote = function (i) {
    var p = this.price[i], dvM = this.avgVol[i] * p / 1e6;
    var spr = Math.max((p >= 1 ? 0.01 : 0.0001) / p, 0.00008 + 0.0025 / Math.sqrt(Math.max(dvM, 0.01)));
    spr *= Math.sqrt(this.volState[i]);
    return { bid: p * (1 - spr / 2), ask: p * (1 + spr / 2), spread: spr };
  };

  Market.prototype.isHalted = function (i) { return this.haltMarketUntil > this.gBar || this.haltUntil[i] > this.gBar; };

  Market.prototype.dailyClose = function (i, back) {   // back=1 -> yesterday's close
    var k = this.dayIdx - back; if (k < 0) k = 0;
    return this.dC[i * DAILY + (k % DAILY)];
  };
  Market.prototype.intraClose = function (i, back) {
    var k = this.gBar - back;
    if (k < 0) return this.prevClose[i];
    return this.iC[i * INTRA + (k % INTRA)];
  };
  Market.prototype.changePct = function (i) { return this.price[i] / this.prevClose[i] - 1; };
  Market.prototype.indexChangePct = function () { return this.index / this.indexPrevClose - 1; };

  /* Feature vector for bot brains, cached per bar. All values roughly in [-3, 3]. */
  Market.prototype.featuresOf = function (i) {
    var F = this.NF, base = i * F, f = this.features;
    if (this.featureStamp[i] === this.gBar) return base;
    var p = this.price[i];
    var dvol = Math.sqrt(Math.max(this.ewVar[i], 1e-6));
    var r6 = Math.log(p / this.intraClose(i, 6));
    var r1d = Math.log(p / this.prevClose[i]);
    var r5 = Math.log(p / this.dailyClose(i, 5));
    var sum = 0, sum2 = 0;
    for (var k = 1; k <= 20; k++) { var c = this.dailyClose(i, k); sum += c; sum2 += c * c; }
    var mean = sum / 20, sd = Math.sqrt(Math.max(sum2 / 20 - mean * mean, 1e-9));
    var frac = Math.max(this.bar, 1) / BPD;
    var vsurge = this.dVolume[i] / (this.avgVol[i] * frac + 1);
    var idx5 = Math.log(this.index / this.idx.dC[(this.dayIdx - 5) % DAILY]);
    var s = this.sector[i];
    f[base] = Math.tanh(r6 / (dvol * 0.4));
    f[base + 1] = Math.tanh(r1d / dvol);
    f[base + 2] = Math.tanh(r5 / (dvol * 2.2));
    f[base + 3] = Math.tanh((p - mean) / sd / 2);
    f[base + 4] = this.sentiment[i];
    f[base + 5] = Math.tanh((dvol * Math.sqrt(252) - 0.35) * 2);
    f[base + 6] = Math.tanh(Math.log(vsurge + 0.05));
    f[base + 7] = Math.tanh(idx5 / 0.03);
    f[base + 8] = Math.tanh(Math.log(this.sectorIdx[s] / this.sectorPrev[s]) / 0.012);
    f[base + 9] = Math.tanh(this.beta[i] - 1);
    f[base + 10] = Math.tanh((Math.log10(this.mcap0[i] + 1) - 3.5) / 1.5);
    this.featureStamp[i] = this.gBar;
    return base;
  };

  /* Shared candidate pool for this bar: liquid names + today's movers + names with fresh news. */
  Market.prototype.pool = function () {
    if (this._poolBar === this.gBar) return this._pool;
    var set = Object.create(null), out = [], i, k;
    for (k = 0; k < this.liquid.length; k++) { i = this.liquid[k]; set[i] = 1; out.push(i); }
    var movers = this.topMovers(40, true).concat(this.topMovers(40, false));
    for (k = 0; k < movers.length; k++) { i = movers[k]; if (!set[i]) { set[i] = 1; out.push(i); } }
    var added = 0;
    for (k = this.recentNews.length - 1; k >= 0 && added < 60; k--) {
      var it = this.recentNews[k];
      if (it.scope === "stock" && !set[it.target]) { set[it.target] = 1; out.push(it.target); added++; }
    }
    var self = this;
    out = out.filter(function (j) { return self.price[j] >= 1 && !self.isHalted(j); });
    this._pool = out; this._poolBar = this.gBar;
    return out;
  };
  Market.prototype.topMovers = function (count, up) {
    var n = this.n, best = [], i;
    for (i = 0; i < n; i++) {
      if (this.price[i] < 1 || this.avgVol[i] * this.price[i] < 2e6) continue;
      var c = this.price[i] / this.prevClose[i] - 1;
      if (!up) c = -c;
      if (best.length < count) { best.push([c, i]); if (best.length === count) best.sort(function (a, b) { return a[0] - b[0]; }); }
      else if (c > best[0][0]) {
        best[0] = [c, i];
        for (var j = 0; j < best.length - 1 && best[j][0] > best[j + 1][0]; j++) { var t = best[j]; best[j] = best[j + 1]; best[j + 1] = t; }
      }
    }
    best.sort(function (a, b) { return b[0] - a[0]; });
    return best.map(function (x) { return x[1]; });
  };

  /* Candles for charts. tf: "5m" or "1D". Returns {t,o,h,l,c,v} arrays oldest-first. */
  Market.prototype.candles = function (i, tf, count) {
    var out = { o: [], h: [], l: [], c: [], v: [], t: [] }, k, j, s;
    if (tf === "5m") {
      var have = Math.min(this.gBar, INTRA, count || INTRA);
      for (k = this.gBar - have; k < this.gBar; k++) {
        j = k % INTRA;
        if (i < 0) { s = this.idx; out.o.push(s.iO[j]); out.h.push(s.iH[j]); out.l.push(s.iL[j]); out.c.push(s.iC[j]); out.v.push(s.iV[j]); }
        else { s = i * INTRA + j; out.o.push(this.iO[s]); out.h.push(this.iH[s]); out.l.push(this.iL[s]); out.c.push(this.iC[s]); out.v.push(this.iV[s]); }
        out.t.push(k);
      }
      return out;
    }
    var haveD = Math.min(this.dayIdx, DAILY - 1, count || DAILY);
    for (k = this.dayIdx - haveD; k < this.dayIdx; k++) {
      j = k % DAILY;
      if (i < 0) { s = this.idx; out.o.push(s.dO[j]); out.h.push(s.dH[j]); out.l.push(s.dL[j]); out.c.push(s.dC[j]); out.v.push(s.dV[j]); }
      else { s = i * DAILY + j; out.o.push(this.dO[s]); out.h.push(this.dH[s]); out.l.push(this.dL[s]); out.c.push(this.dC[s]); out.v.push(this.dV[s]); }
      out.t.push(k - BACKFILL);
    }
    if (this.bar > 0) {   // the session in progress
      if (i < 0) { out.o.push(this.indexOpen); out.h.push(this.indexHigh); out.l.push(this.indexLow); out.c.push(this.index); out.v.push(this.indexVol); }
      else { out.o.push(this.dOpen[i]); out.h.push(this.dHigh[i]); out.l.push(this.dLow[i]); out.c.push(this.price[i]); out.v.push(this.dVolume[i]); }
      out.t.push(this.day);
    }
    return out;
  };

  T.Market = Market;
  T.MARKET_CONST = { BPD: BPD, INTRA: INTRA, DAILY: DAILY, BACKFILL: BACKFILL };
})(window.T = window.T || {});
