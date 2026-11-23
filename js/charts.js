/* Canvas charts: candlestick + volume with crosshair, mini candles, sparklines, report bars. No dependencies. */
(function (T) {
  "use strict";

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function palette() {
    return { up: css("--up"), down: css("--down"), grid: css("--grid"), text: css("--muted"), strong: css("--text"),
      cross: css("--cross"), accent: css("--accent"), card: css("--card"), elev: css("--elev2"), border: css("--border-strong") };
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

  /* Main chart */
  function CandleChart(canvas) {
    this.c = canvas; this.data = null; this.hover = -1; this.labelFn = null;
    var self = this;
    function move(e) {
      var r = canvas.getBoundingClientRect();
      self.mx = e.clientX - r.left; self.my = e.clientY - r.top; self.draw();
    }
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", move);
    canvas.addEventListener("pointerleave", function () { self.mx = -1; self.draw(); });
    this.mx = -1;
  }
  CandleChart.prototype.set = function (d, labelFn) { this.data = d; this.labelFn = labelFn; this.draw(); };
  CandleChart.prototype.draw = function () {
    var f = fit(this.c), ctx = f.ctx, W = f.w, H = f.h, d = this.data, P = palette();
    ctx.clearRect(0, 0, W, H);
    if (!d || !d.c.length || W < 50) return;
    var axisW = 64, timeH = 18, padT = 10;
    var plotW = W - axisW, volH = Math.max(30, (H - timeH) * 0.18), priceH = H - timeH - volH - padT - 6;
    var n = d.c.length, maxBars = Math.max(10, Math.floor(plotW / 5));
    var start = Math.max(0, n - maxBars), cnt = n - start;
    var bw = plotW / Math.max(cnt, 30), body = Math.max(1, Math.floor(bw * 0.68));
    var hi = -Infinity, lo = Infinity, vmax = 0, i;
    for (i = start; i < n; i++) { if (d.h[i] > hi) hi = d.h[i]; if (d.l[i] < lo) lo = d.l[i]; if (d.v[i] > vmax) vmax = d.v[i]; }
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
    for (i = start; i < n; i++) {
      if ((i - start) % every !== 0 || !this.labelFn) continue;
      var lx = xOf(i);
      ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(Math.round(lx) + 0.5, padT); ctx.lineTo(Math.round(lx) + 0.5, H - timeH); ctx.stroke();
      ctx.fillStyle = P.text; ctx.fillText(this.labelFn(d.t[i]), Math.min(lx - 14, plotW - 50), H - 5);
    }
    // SMA 20
    ctx.strokeStyle = P.accent; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.25; ctx.beginPath();
    var started = false, sum = 0;
    for (i = 0; i < n; i++) {
      sum += d.c[i]; if (i >= 20) sum -= d.c[i - 20];
      if (i >= 19 && i >= start) { var sy = y(sum / 20); if (!started) { ctx.moveTo(xOf(i), sy); started = true; } else ctx.lineTo(xOf(i), sy); }
    }
    ctx.stroke(); ctx.globalAlpha = 1;
    // candles + volume
    var vTop = H - timeH - volH;
    for (i = start; i < n; i++) {
      var up = d.c[i] >= d.o[i], col = up ? P.up : P.down, x = xOf(i);
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(d.h[i])); ctx.lineTo(Math.round(x) + 0.5, y(d.l[i])); ctx.stroke();
      var yo = y(d.o[i]), yc = y(d.c[i]), top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(Math.round(x - body / 2), top, body, hh);
      if (vmax > 0) {
        var vh = d.v[i] / vmax * (volH - 4);
        ctx.globalAlpha = 0.35; ctx.fillRect(Math.round(x - body / 2), H - timeH - vh, body, vh); ctx.globalAlpha = 1;
      }
    }
    ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(0, vTop + 0.5); ctx.lineTo(plotW, vTop + 0.5); ctx.stroke();
    // last price line
    var last = d.c[n - 1], ly = Math.round(y(last)) + 0.5, lastUp = last >= d.o[n - 1];
    ctx.setLineDash([3, 3]); ctx.strokeStyle = lastUp ? P.up : P.down;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = lastUp ? P.up : P.down; ctx.fillRect(plotW, ly - 9, axisW, 18);
    ctx.fillStyle = P.card; ctx.textBaseline = "middle"; ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.fillText(fmtPrice(last), plotW + 6, ly);
    // crosshair
    if (this.mx >= 0 && this.mx < plotW) {
      var k = Math.min(n - 1, Math.max(start, start + Math.floor(this.mx / bw)));
      var cx = Math.round(xOf(k)) + 0.5, cy = Math.round(Math.min(this.my, H - timeH)) + 0.5;
      ctx.strokeStyle = P.cross; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, H - timeH); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke(); ctx.setLineDash([]);
      if (cy < vTop) {
        var pv = hi - (cy - padT) / priceH * (hi - lo);
        ctx.fillStyle = P.elev; ctx.fillRect(plotW, cy - 9, axisW, 18);
        ctx.fillStyle = P.strong; ctx.font = "11px Inter, system-ui, sans-serif"; ctx.fillText(fmtPrice(pv), plotW + 6, cy);
      }
      var chg = d.o[k] ? (d.c[k] / d.o[k] - 1) * 100 : 0;
      var txt = (this.labelFn ? this.labelFn(d.t[k]) + "  " : "") + "O " + fmtPrice(d.o[k]) + "  H " + fmtPrice(d.h[k]) + "  L " + fmtPrice(d.l[k]) +
        "  C " + fmtPrice(d.c[k]) + "  " + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%  Vol " + fmtVol(d.v[k]);
      ctx.font = "11px Inter, system-ui, sans-serif"; ctx.textBaseline = "top";
      var tw = ctx.measureText(txt).width;
      ctx.fillStyle = P.card; ctx.globalAlpha = 0.9; ctx.fillRect(4, 2, tw + 12, 18); ctx.globalAlpha = 1;
      ctx.fillStyle = chg >= 0 ? P.up : P.down; ctx.fillText(txt, 10, 5);
    }
  };

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
