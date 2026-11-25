/* Canvas charts: candlestick + volume with crosshair, mini candles, sparklines, report bars. No dependencies. */
(function (T) {
  "use strict";

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  var palCache = null, palTheme = null;
  function palette() {
    var th = document.documentElement.dataset.theme;
    if (palCache && palTheme === th) return palCache;
    palTheme = th;
    return (palCache = { up: css("--up"), down: css("--down"), grid: css("--grid"), text: css("--muted"), strong: css("--text"),
      cross: css("--cross"), accent: css("--accent"), warn: css("--warn"), violet: css("--violet"), card: css("--card"), elev: css("--elev2"), border: css("--border-strong") });
  }
  T.chartPalette = palette;

  function fit(canvas) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function fmtPrice(p) {
    if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  }
  function fmtVol(v) {
    if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(0);
  }
  T.fmtPrice = fmtPrice; T.fmtVol = fmtVol;

  function niceStep(range, ticks) {
    var raw = range / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  /* Main chart: candles, line or area, with volume, indicators, bot trade markers, crosshair,
   * zoom (wheel, trackpad pinch, Safari gestures, two-finger touch, + / - keys) and pan (drag, horizontal scroll). */
  function CandleChart(canvas) {
    this.c = canvas; this.data = null; this.labelFn = null; this.mx = -1; this.my = -1;
    this.span = 0;      // bars in view; 0 = fit to the width
    this.off = 0;       // bars hidden on the right; 0 = following the live bar
    this.type = "candle"; this.ind = { sma20: true, sma50: false, bb: false, vwap: false }; this.markers = null;
    this.onView = null; this._raf = 0; this._sig = "";
    var self = this, drag = null, pts = {}, pinch = null;
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener("pointermove", function (e) {
      var p = pos(e); self.mx = p.x; self.my = p.y;
      if (pts[e.pointerId]) pts[e.pointerId] = p;
      var ids = Object.keys(pts);
      if (ids.length === 2 && pinch) {
        var a = pts[ids[0]], b = pts[ids[1]], d = Math.abs(a.x - b.x) + 1;
        self.zoomBy(pinch.d / d, (a.x + b.x) / 2); pinch.d = d;
      } else if (drag && e.buttons) {
        var dx = p.x - drag.x; drag.x = p.x;
        self.panBy(dx / self.barW());
      }
      self.req();
    });
    canvas.addEventListener("pointerdown", function (e) {
      var p = pos(e); self.mx = p.x; self.my = p.y; pts[e.pointerId] = p;
      var ids = Object.keys(pts);
      if (ids.length === 2) { pinch = { d: Math.abs(pts[ids[0]].x - pts[ids[1]].x) + 1 }; drag = null; }
      else drag = { x: p.x };
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* older Safari */ }
      self.req();
    });
    function up(e) { delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pinch = null; if (!Object.keys(pts).length) drag = null; }
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") { self.mx = -1; self.req(); } });
    canvas.addEventListener("dblclick", function () { self.reset(); });
    // Mac trackpads: pinch arrives as ctrl+wheel (Chrome, Firefox, Edge) or gesture events (Safari); two-finger sideways scroll pans
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var p = pos(e), unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) self.zoomBy(Math.exp(e.deltaY * unit * 0.01), p.x);
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) self.panBy(-e.deltaX * unit / self.barW());
      else self.zoomBy(Math.exp(e.deltaY * unit * 0.0025), p.x);
    }, { passive: false });
    var g0 = 1;
    canvas.addEventListener("gesturestart", function (e) { e.preventDefault(); g0 = 1; });
    canvas.addEventListener("gesturechange", function (e) { e.preventDefault(); self.zoomBy(g0 / e.scale, self.mx >= 0 ? self.mx : null); g0 = e.scale; });
    canvas.addEventListener("gestureend", function (e) { e.preventDefault(); });
  }
  CandleChart.prototype.req = function () {
    var self = this;
    if (!this._raf) this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(); });
  };
  CandleChart.prototype.layout = function () {
    var W = this.c.clientWidth, plotW = Math.max(40, W - 64), n = this.data ? this.data.c.length : 0;
    var fitBars = Math.max(10, Math.floor(plotW / 5));
    var span = this.span ? Math.max(12, Math.min(this.span, Math.max(n, 12))) : Math.min(fitBars, Math.max(n, 30));
    return { plotW: plotW, span: span, n: n };
  };
  CandleChart.prototype.barW = function () { var L = this.layout(); return L.plotW / Math.max(L.span, 1); };
  CandleChart.prototype.zoomBy = function (f, atX) {
    if (!this.data) return;
    var L = this.layout(), old = L.span, next = Math.round(Math.max(12, Math.min(Math.max(L.n, 12), old * f)));
    if (next === old) return;
    if (atX !== null && atX !== undefined && atX < L.plotW) {   // keep the bar under the cursor in place
      var fromRight = (1 - atX / L.plotW) * old;
      this.off = Math.max(0, Math.round(this.off + fromRight - fromRight * next / old));
    }
    this.span = next; this.clampOff(); this.view(); this.req();
  };
  CandleChart.prototype.panBy = function (bars) {
    if (!this.data) return;
    this.off = this.off + bars; this.clampOff(); this.view(); this.req();
  };
  CandleChart.prototype.clampOff = function () {
    var L = this.layout(); this.off = Math.max(0, Math.min(this.off, Math.max(0, L.n - Math.min(L.span, L.n))));
    if (this.off < 0.5) this.off = 0;
  };
  CandleChart.prototype.reset = function () { this.span = 0; this.off = 0; this.view(); this.req(); };
  CandleChart.prototype.view = function () { if (this.onView) this.onView({ live: this.off === 0, zoomed: this.span !== 0 }); };
  CandleChart.prototype.set = function (d, labelFn, markers) {
    this.data = d; this.labelFn = labelFn; this.markers = markers || null;
    if (this.off && d) this.off += Math.max(0, d.c.length - (this._n || d.c.length));   // panned back: stay on the same bars
    this._n = d ? d.c.length : 0;
    this.clampOff(); this.req();
  };
  CandleChart.prototype.draw = function () {
    var f = fit(this.c), ctx = f.ctx, W = f.w, H = f.h, d = this.data, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!d || !d.c.length || W < 50) return;
    var axisW = 64, timeH = 18, padT = 22;
    var plotW = W - axisW, volH = Math.max(30, (H - timeH) * 0.18), priceH = H - timeH - volH - padT - 6;
    var n = d.c.length, L = this.layout(), off = Math.round(this.off);
    var end = n - off, start = Math.max(0, end - L.span), i;
    var bw = plotW / L.span, body = Math.max(1, Math.floor(bw * 0.68));
    var hi = -Infinity, lo = Infinity, vmax = 0;
    for (i = start; i < end; i++) { if (d.h[i] > hi) hi = d.h[i]; if (d.l[i] < lo) lo = d.l[i]; if (d.v[i] > vmax) vmax = d.v[i]; }
    // indicator series over the whole data (so the first visible bars have values)
    var sma20 = this.ind.sma20 || this.ind.bb ? sma(d.c, 20) : null, sma50 = this.ind.sma50 ? sma(d.c, 50) : null;
    var bbU = null, bbL = null, vw = null;
    if (this.ind.bb) {
      bbU = new Float64Array(n).fill(NaN); bbL = new Float64Array(n).fill(NaN);
      for (i = 19; i < n; i++) { var m = sma20[i], ss = 0; for (var q = i - 19; q <= i; q++) ss += (d.c[q] - m) * (d.c[q] - m); var sd = Math.sqrt(ss / 20); bbU[i] = m + 2 * sd; bbL[i] = m - 2 * sd; }
      for (i = start; i < end; i++) { if (bbU[i] > hi) hi = bbU[i]; if (bbL[i] < lo) lo = bbL[i]; }
    }
    if (this.ind.vwap && d.bpd) {
      vw = new Float64Array(n).fill(NaN); var pv = 0, vv = 0;
      for (i = 0; i < n; i++) { if (((d.t[i] % d.bpd) + d.bpd) % d.bpd === 0) { pv = 0; vv = 0; } pv += (d.h[i] + d.l[i] + d.c[i]) / 3 * d.v[i]; vv += d.v[i]; vw[i] = vv > 0 ? pv / vv : d.c[i]; }
    }
    if (hi === lo) { hi *= 1.001; lo *= 0.999; }
    var padP = (hi - lo) * 0.06; hi += padP; lo -= padP;
    var y = function (p) { return padT + (hi - p) / (hi - lo) * priceH; };
    var xOf = function (k) { return (k - start) * bw + bw / 2; };

    // grid + price axis
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
    var step = niceStep(hi - lo, Math.max(3, Math.floor(priceH / 48)));
    ctx.strokeStyle = P.grid; ctx.fillStyle = P.text; ctx.lineWidth = 1;
    for (var g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      var gy = Math.round(y(g)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(plotW, gy); ctx.stroke();
      ctx.fillText(fmtPrice(g), plotW + 6, gy);
    }
    // time labels
    ctx.textBaseline = "alphabetic";
    var every = Math.max(1, Math.ceil(80 / bw));
    for (i = start; i < end; i++) {
      if ((i - start) % every !== 0 || !this.labelFn) continue;
      var lx = xOf(i);
      ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(Math.round(lx) + 0.5, padT); ctx.lineTo(Math.round(lx) + 0.5, H - timeH); ctx.stroke();
      ctx.fillStyle = P.text; ctx.fillText(this.labelFn(d.t[i]), Math.min(lx - 14, plotW - 50), H - 5);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, H); ctx.clip();
    // Bollinger band fill
    if (bbU) {
      ctx.fillStyle = P.accent; ctx.globalAlpha = 0.07; ctx.beginPath();
      var first = true;
      for (i = start; i < end; i++) if (!isNaN(bbU[i])) { if (first) { ctx.moveTo(xOf(i), y(bbU[i])); first = false; } else ctx.lineTo(xOf(i), y(bbU[i])); }
      for (i = end - 1; i >= start; i--) if (!isNaN(bbL[i])) ctx.lineTo(xOf(i), y(bbL[i]));
      ctx.fill(); ctx.globalAlpha = 0.45; ctx.strokeStyle = P.accent; ctx.lineWidth = 1;
      line(ctx, bbU, start, end, xOf, y); line(ctx, bbL, start, end, xOf, y); ctx.globalAlpha = 1;
    }
    // price
    var vTop = H - timeH - volH;
    if (this.type === "candle") {
      for (i = start; i < end; i++) {
        var upc = d.c[i] >= d.o[i], col = upc ? P.up : P.down, x = xOf(i);
        ctx.fillStyle = col; ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(d.h[i])); ctx.lineTo(Math.round(x) + 0.5, y(d.l[i])); ctx.stroke();
        var yo = y(d.o[i]), yc = y(d.c[i]), top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(Math.round(x - body / 2), top, body, hh);
      }
    } else {
      var rising = d.c[end - 1] >= d.c[start], lc = rising ? P.up : P.down;
      if (this.type === "area") {
        var grad = ctx.createLinearGradient(0, padT, 0, vTop);
        grad.addColorStop(0, hexA(lc, 0.28)); grad.addColorStop(1, hexA(lc, 0));
        ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(xOf(start), vTop);
        for (i = start; i < end; i++) ctx.lineTo(xOf(i), y(d.c[i]));
        ctx.lineTo(xOf(end - 1), vTop); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = lc; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.beginPath();
      for (i = start; i < end; i++) { if (i === start) ctx.moveTo(xOf(i), y(d.c[i])); else ctx.lineTo(xOf(i), y(d.c[i])); }
      ctx.stroke(); ctx.lineWidth = 1;
    }
    // moving averages and VWAP
    ctx.lineWidth = 1.25;
    if (this.ind.sma20) { ctx.strokeStyle = P.accent; ctx.globalAlpha = 0.85; line(ctx, sma20, start, end, xOf, y); }
    if (sma50) { ctx.strokeStyle = P.warn; ctx.globalAlpha = 0.85; line(ctx, sma50, start, end, xOf, y); }
    if (vw) { ctx.strokeStyle = P.violet; ctx.globalAlpha = 0.9; ctx.setLineDash([5, 3]); line(ctx, vw, start, end, xOf, y); ctx.setLineDash([]); }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
    // volume
    if (vmax > 0) {
      ctx.globalAlpha = 0.35;
      for (i = start; i < end; i++) {
        var vh = d.v[i] / vmax * (volH - 4);
        ctx.fillStyle = d.c[i] >= d.o[i] ? P.up : P.down;
        ctx.fillRect(Math.round(xOf(i) - body / 2), H - timeH - vh, body, vh);
      }
      ctx.globalAlpha = 1;
    }
    // bot trades on this symbol: green triangles under the bar for buys and covers, red over the bar for sells and shorts
    var tips = [];
    if (this.markers && this.markers.length) {
      var byT = this.markers.index;
      for (i = start; i < end; i++) {
        var mk = byT[d.t[i]]; if (!mk) continue;
        var mx = xOf(i), sz = Math.max(4, Math.min(7, bw * 0.45));
        if (mk.buy) { var yb = y(d.l[i]) + 5; tri(ctx, mx, yb, sz, true, P.up); if (mk.buy > 1) label(ctx, mk.buy, mx, yb + sz + 7, P.up); tips.push([i, mk]); }
        if (mk.sell) { var ys = y(d.h[i]) - 5; tri(ctx, mx, ys, sz, false, P.down); if (mk.sell > 1) label(ctx, mk.sell, mx, ys - sz - 6, P.down); if (!mk.buy) tips.push([i, mk]); }
      }
    }
    ctx.restore();
    ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(0, vTop + 0.5); ctx.lineTo(plotW, vTop + 0.5); ctx.stroke();
    // last price line
    var last = d.c[n - 1], ly = Math.round(y(last)) + 0.5, lastUp = last >= d.o[n - 1];
    if (ly > padT - 4 && ly < vTop) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = lastUp ? P.up : P.down;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = lastUp ? P.up : P.down; ctx.fillRect(plotW, ly - 9, axisW, 18);
      ctx.fillStyle = P.card; ctx.textBaseline = "middle"; ctx.font = "600 11px Inter, system-ui, sans-serif";
      ctx.fillText(fmtPrice(last), plotW + 6, ly);
    }
    // legend (indicator values at the cursor or the latest bar)
    var at = end - 1;
    if (this.mx >= 0 && this.mx < plotW) at = Math.min(end - 1, Math.max(start, start + Math.floor(this.mx / bw)));
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "top";
    var lgx = 8;
    function leg(name, v, col) { if (v === undefined || isNaN(v)) return; var t = name + " " + fmtPrice(v); ctx.fillStyle = col; ctx.fillText(t, lgx, 5); lgx += ctx.measureText(t).width + 12; }
    var chg = d.o[at] ? (d.c[at] / d.o[at] - 1) * 100 : 0;
    var ohlc = (this.labelFn ? this.labelFn(d.t[at]) + "  " : "") + "O " + fmtPrice(d.o[at]) + "  H " + fmtPrice(d.h[at]) + "  L " + fmtPrice(d.l[at]) +
      "  C " + fmtPrice(d.c[at]) + "  " + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%  Vol " + fmtVol(d.v[at]);
    ctx.fillStyle = chg >= 0 ? P.up : P.down; ctx.fillText(ohlc, lgx, 5); lgx += ctx.measureText(ohlc).width + 16;
    if (lgx < plotW - 120) {
      if (this.ind.sma20) leg("SMA 20", sma20[at], P.accent);
      if (sma50) leg("SMA 50", sma50[at], P.warn);
      if (bbU) leg("BB", bbU[at], P.text), leg("/", bbL[at], P.text);
      if (vw) leg("VWAP", vw[at], P.violet);
    }
    if (off > 0) {   // scrolled back in time
      ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.fillStyle = P.text; ctx.textBaseline = "middle";
      var ht = "← " + off + " bars back · double-click for live"; ctx.globalAlpha = 0.8; ctx.fillText(ht, plotW - ctx.measureText(ht).width - 8, vTop - 10); ctx.globalAlpha = 1;
    }
    // crosshair
    if (this.mx >= 0 && this.mx < plotW) {
      var cx = Math.round(xOf(at)) + 0.5, cy = Math.round(Math.min(this.my, H - timeH)) + 0.5;
      ctx.strokeStyle = P.cross; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, H - timeH); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke(); ctx.setLineDash([]);
      if (cy < vTop) {
        var pvv = hi - (cy - padT) / priceH * (hi - lo);
        ctx.fillStyle = P.elev; ctx.fillRect(plotW, cy - 9, axisW, 18);
        ctx.fillStyle = P.strong; ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.fillText(fmtPrice(pvv), plotW + 6, cy);
      }
      var hit = this.markers && this.markers.index[d.t[at]];
      if (hit && hit.lines.length) {   // which bots traded on the bar under the cursor
        var lines = hit.lines.slice(0, 6).concat(hit.lines.length > 6 ? ["+" + (hit.lines.length - 6) + " more"] : []);
        ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "top";
        var bwid = 0; lines.forEach(function (t) { bwid = Math.max(bwid, ctx.measureText(t).width); });
        var bx = Math.min(cx + 10, plotW - bwid - 18), by = Math.max(padT, Math.min(cy + 10, vTop - lines.length * 15 - 12));
        ctx.fillStyle = P.elev; ctx.globalAlpha = 0.96; ctx.fillRect(bx, by, bwid + 14, lines.length * 15 + 8); ctx.globalAlpha = 1;
        ctx.strokeStyle = P.border; ctx.strokeRect(bx + 0.5, by + 0.5, bwid + 13, lines.length * 15 + 7);
        lines.forEach(function (t, k) { ctx.fillStyle = /^(BUY|COVER)/.test(t) ? P.up : /^(SELL|SHORT)/.test(t) ? P.down : P.text; ctx.fillText(t, bx + 7, by + 5 + k * 15); });
      }
    }
  };
  function sma(c, w) {
    var out = new Float64Array(c.length).fill(NaN), sum = 0;
    for (var i = 0; i < c.length; i++) { sum += c[i]; if (i >= w) sum -= c[i - w]; if (i >= w - 1) out[i] = sum / w; }
    return out;
  }
  function line(ctx, s, a, b, xOf, y) {
    ctx.beginPath(); var on = false;
    for (var i = a; i < b; i++) { if (isNaN(s[i])) { on = false; continue; } if (!on) { ctx.moveTo(xOf(i), y(s[i])); on = true; } else ctx.lineTo(xOf(i), y(s[i])); }
    ctx.stroke();
  }
  function tri(ctx, x, yy, s, up, col) {
    ctx.fillStyle = col; ctx.beginPath();
    if (up) { ctx.moveTo(x, yy); ctx.lineTo(x - s, yy + s * 1.3); ctx.lineTo(x + s, yy + s * 1.3); }
    else { ctx.moveTo(x, yy); ctx.lineTo(x - s, yy - s * 1.3); ctx.lineTo(x + s, yy - s * 1.3); }
    ctx.closePath(); ctx.fill();
  }
  function label(ctx, n, x, yy, col) { ctx.font = "600 9px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = col; var t = String(n); ctx.fillText(t, x - ctx.measureText(t).width / 2, yy); }
  function hexA(col, a) {
    if (/^#[0-9a-f]{6}$/i.test(col)) return "rgba(" + parseInt(col.slice(1, 3), 16) + "," + parseInt(col.slice(3, 5), 16) + "," + parseInt(col.slice(5, 7), 16) + "," + a + ")";
    return col;
  }

  /* Equity curve for the bot dialog: the bot against the index, both rebased to the bot's starting cash. */
  function equityChart(canvas, eq, idx, base) {
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!eq || eq.length < 2) { ctx.fillStyle = P.text; ctx.font = "12px Inter, system-ui, sans-serif"; ctx.fillText("The curve fills in as the bot trades.", 10, 20); return; }
    var ix = idx && idx.length >= eq.length ? idx.slice(0, eq.length).map(function (v) { return base * v / idx[0]; }) : null;
    var all = eq.concat(ix || []).concat([base]), hi = Math.max.apply(null, all), lo = Math.min.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var left = 64, pad = 10, pw = W - left - pad, ph = H - 2 * pad;
    var y = function (v) { return pad + (hi - v) / (hi - lo) * ph; }, x = function (k) { return left + k / (eq.length - 1) * pw; };
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
    var step = niceStep(hi - lo, 4);
    for (var g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(left, Math.round(y(g)) + 0.5); ctx.lineTo(W - pad, Math.round(y(g)) + 0.5); ctx.stroke();
      ctx.fillStyle = P.text; ctx.fillText("$" + fmtVol(g), 4, y(g));
    }
    ctx.strokeStyle = P.border; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(left, y(base)); ctx.lineTo(W - pad, y(base)); ctx.stroke(); ctx.setLineDash([]);
    if (ix) { ctx.strokeStyle = P.text; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.2; ctx.beginPath(); ix.forEach(function (v, k) { if (k) ctx.lineTo(x(k), y(v)); else ctx.moveTo(x(k), y(v)); }); ctx.stroke(); ctx.globalAlpha = 1; }
    var col = eq[eq.length - 1] >= base ? P.up : P.down, grad = ctx.createLinearGradient(0, pad, 0, H - pad);
    grad.addColorStop(0, hexA(col, 0.25)); grad.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(x(0), y(base));
    eq.forEach(function (v, k) { ctx.lineTo(x(k), y(v)); }); ctx.lineTo(x(eq.length - 1), y(base)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath(); eq.forEach(function (v, k) { if (k) ctx.lineTo(x(k), y(v)); else ctx.moveTo(x(k), y(v)); }); ctx.stroke(); ctx.lineWidth = 1;
  }
  T.equityChart = equityChart;

  function miniCandles(canvas, d, count) {
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!d || !d.c.length) return;
    var n = d.c.length, start = Math.max(0, n - (count || 60)), cnt = n - start;
    var hi = -Infinity, lo = Infinity, i;
    for (i = start; i < n; i++) { if (d.h[i] > hi) hi = d.h[i]; if (d.l[i] < lo) lo = d.l[i]; }
    if (hi === lo) { hi *= 1.001; lo *= 0.999; }
    var bw = W / Math.max(cnt, 20), body = Math.max(1, bw * 0.6);
    for (i = start; i < n; i++) {
      var x = (i - start) * bw + bw / 2, col = d.c[i] >= d.o[i] ? P.up : P.down;
      var yh = 2 + (hi - d.h[i]) / (hi - lo) * (H - 4), yl = 2 + (hi - d.l[i]) / (hi - lo) * (H - 4);
      var yo = 2 + (hi - d.o[i]) / (hi - lo) * (H - 4), yc = 2 + (hi - d.c[i]) / (hi - lo) * (H - 4);
      ctx.fillStyle = col; ctx.fillRect(x - 0.5, yh, 1, Math.max(1, yl - yh));
      ctx.fillRect(x - body / 2, Math.min(yo, yc), body, Math.max(1, Math.abs(yc - yo)));
    }
  }

  function sparkline(canvas, vals, base) {
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!vals || vals.length < 2) { vals = [base, base]; }
    if (vals.length > 160) {   // downsample, keep the latest point
      var step = Math.ceil(vals.length / 160), ds = [];
      for (var q = 0; q < vals.length - 1; q += step) ds.push(vals[q]);
      ds.push(vals[vals.length - 1]); vals = ds;
    }
    var hi = Math.max.apply(null, vals.concat([base])), lo = Math.min.apply(null, vals.concat([base]));
    if (hi === lo) { hi += 1; lo -= 1; }
    var yb = 1 + (hi - base) / (hi - lo) * (H - 2);
    ctx.strokeStyle = P.grid; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(0, yb); ctx.lineTo(W, yb); ctx.stroke(); ctx.setLineDash([]);
    var last = vals[vals.length - 1];
    ctx.strokeStyle = last >= base ? P.up : P.down; ctx.lineWidth = 1.25; ctx.beginPath();
    for (var i = 0; i < vals.length; i++) {
      var x = i / (vals.length - 1) * (W - 1), yy = 1 + (hi - vals[i]) / (hi - lo) * (H - 2);
      if (i) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
    }
    ctx.stroke();
  }

  /* Report: per-generation bars (avg return) with best/worst whiskers and an index marker */
  function genBars(canvas, gens) {
    var f = fit(canvas), ctx = f.ctx, W = f.w, H = f.h, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!gens.length) return;
    var hi = 0, lo = 0;
    gens.forEach(function (g) { hi = Math.max(hi, g.bestReturn, g.indexReturn); lo = Math.min(lo, g.worstReturn, g.indexReturn); });
    var pad = (hi - lo) * 0.1 || 0.01; hi += pad; lo -= pad;
    var left = 48, bottom = 20, ph = H - bottom - 6, pw = W - left - 8;
    var y = function (v) { return 6 + (hi - v) / (hi - lo) * ph; };
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.fillStyle = P.text; ctx.textBaseline = "middle";
    var step = niceStep(hi - lo, 4);
    for (var g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      ctx.strokeStyle = Math.abs(g) < 1e-9 ? P.border : P.grid;
      ctx.beginPath(); ctx.moveTo(left, Math.round(y(g)) + 0.5); ctx.lineTo(W - 8, Math.round(y(g)) + 0.5); ctx.stroke();
      ctx.fillText((g * 100).toFixed(Math.abs(step) < 0.01 ? 1 : 0) + "%", 4, y(g));
    }
    var bw = pw / gens.length, body = Math.min(36, bw * 0.5);
    gens.forEach(function (gn, k) {
      var x = left + k * bw + bw / 2;
      ctx.strokeStyle = P.text; ctx.beginPath(); ctx.moveTo(x, y(gn.bestReturn)); ctx.lineTo(x, y(gn.worstReturn)); ctx.stroke();
      ctx.fillStyle = gn.avgReturn >= 0 ? P.up : P.down;
      var y0 = y(0), ya = y(gn.avgReturn);
      ctx.fillRect(x - body / 2, Math.min(y0, ya), body, Math.max(1, Math.abs(ya - y0)));
      ctx.fillStyle = P.accent; ctx.fillRect(x - body / 2 - 3, y(gn.indexReturn) - 1, body + 6, 2);
      ctx.fillStyle = P.text; ctx.textBaseline = "alphabetic"; ctx.fillText("G" + gn.gen, x - 8, H - 4); ctx.textBaseline = "middle";
    });
  }

  T.CandleChart = CandleChart;
  T.miniCandles = miniCandles;
  T.sparkline = sparkline;
  T.genBars = genBars;
})(window.T = window.T || {});
