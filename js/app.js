/* UI wiring. No innerHTML: every node is built with createElement/textContent. */
(function (T) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pct(x, d) { return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(d === undefined ? 2 : d) + "%"; }
  function money(x) { var a = Math.abs(x); return (x < 0 ? "−$" : "$") + (a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a.toLocaleString("en-US", { maximumFractionDigits: 0 })); }
  function signed$(x) { return (x >= 0 ? "+" : "") + money(x); }
  function cls(x) { return x > 0 ? "up" : x < 0 ? "down" : ""; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  var S = {
    sim: null, running: false, speed: 15, sel: -1, tf: "5m", filter: "all", sector: -1, query: "",
    feed: "news", acc: 0, lastT: 0, lastList: 0, lastMinis: 0, minis: [], newsSeen: 0, filtered: [], heldCount: null,
    tradeSeen: {}, cfg: { mult: 1, generations: 6, daysPerGen: 10, seed: 20270104, fitness: "return", detailBudget: 8000000, startCash: 100000, maxSymbols: 0 }, dirtyBots: true,
    lastTop: 0, chartSig: "", minisBar: -1, background: store("tb-background") !== "off", botOrder: "", prevPx: null
  };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var chart = new T.CandleChart($("mainChart"));
  (function chartPrefs() {
    var saved = null;
    try { saved = JSON.parse(store("tb-chart") || "null"); } catch (e) { saved = null; }
    if (saved) { if (saved.type) chart.type = saved.type; if (saved.ind) for (var k in chart.ind) if (k in saved.ind) chart.ind[k] = !!saved.ind[k]; }
  })();
  function saveChartPrefs() { store("tb-chart", JSON.stringify({ type: chart.type, ind: chart.ind })); }
  chart.onView = function (v) { $("btnLive").hidden = v.live && !v.zoomed; };

  /* ---------- setup ---------- */
  function build(cfg) {
    S.running = false; setPlay();
    S.sim = new T.Sim(cfg);
    S.cfg = cfg;
    S.newsSeen = 0; S.tradeSeen = {}; S.dirtyBots = true; S.heldCount = null; S.chartSig = ""; S.minisBar = -1; S.botOrder = ""; S.prevPx = null;
    hideToast();
    clear($("feedNews")); clear($("feedTrades"));
    S.sim.on(onSimEvent);
    if (T.onSimBuilt) T.onSimBuilt(S.sim);
    S.sim.market.on(function (t, d) { if (t === "regime") setStatus("Regime change: " + d + " market."); });
    $("genTotal").textContent = S.sim.forever ? "∞" : cfg.generations;
    $("genDays").textContent = cfg.daysPerGen;
    $("symCount").textContent = S.sim.market.n.toLocaleString() + " symbols";
    refilter();
    pickMinis();
    renderAll(true);
    setStatus("Box built: " + S.sim.bots.length + " bots, " + S.sim.market.n.toLocaleString() + " symbols. Press Start.");
  }

  function onSimEvent(type, d) {
    if (type === "generation") {
      var s = d.summary, next = d.final || S.sim.stopRequested ? " Run complete." : " Breeding generation " + (s.gen + 1) + ": " + S.sim.expectedSize(s.gen + 1) + " bots.";
      setStatus("Generation " + s.gen + " finished. Avg " + pct(s.avgReturn) + ", best " + s.bestBot + " " + pct(s.bestReturn) + ", SIM 500 " + pct(s.indexReturn) + "." + next);
      S.dirtyBots = true; S.tradeSeen = {};
      if (!d.final && !S.sim.stopRequested) genToast(d);
    } else if (type === "trimmed") {
      S.trimmed = d;
    } else if (type === "done") {
      S.running = false; setPlay();
      renderAll(true);
      showReport(d);
    }
  }

  function setStatus(t) { $("status").textContent = t; }
  function setPlay() {
    var b = $("btnPlay");
    $("btnFinish").disabled = !S.sim || S.sim.done;
    if (S.sim && S.sim.done) { b.textContent = "Report"; b.setAttribute("aria-label", "Open run report"); return; }
    b.textContent = S.running ? "Pause" : (S.sim && S.sim.market.gBar > 0 ? "Resume" : "Start");
    b.setAttribute("aria-label", S.running ? "Pause simulation" : "Start simulation");
  }

  /* ---------- main loop ---------- */
  /* Steps the simulation for up to `budget` ms at the chosen speed. */
  function advance(dt, budget) {
    var t0 = performance.now();
    if (S.speed === 0) {
      while (performance.now() - t0 < budget && !S.sim.done) S.sim.step();
    } else {
      S.acc += dt * S.speed;
      while (S.acc >= 1 && !S.sim.done && performance.now() - t0 < budget + 12) { S.sim.step(); S.acc -= 1; }
      if (S.acc > 3) S.acc = 0;
    }
  }
  function frame(t) {
    requestAnimationFrame(frame);
    if (!S.sim || document.hidden) return;
    var dt = S.lastT ? Math.min(0.25, (t - S.lastT) / 1000) : 0;
    S.lastT = t;
    if (S.running && !S.sim.done) {
      // Max speed gives the simulation most of each frame but always leaves time to draw (smooth on 60 and 120 Hz screens)
      advance(dt, S.speed === 0 ? (S.frameMs > 14 ? 24 : 12) : 28);
      renderAll(false);
    }
    S.frameMs = S.frameMs ? S.frameMs * 0.9 + 0.1 * Math.min(100, dt * 1000) : 16;
  }
  /* Hidden tab: browsers stop animation frames and slow timers, so a message-channel loop keeps the run going without drawing. */
  var bg = { ch: null, on: false, last: 0 };
  function bgTick() {
    if (!bg.on) return;
    if (!document.hidden || !S.running || !S.sim || S.sim.done) { bg.on = false; return; }
    var now = performance.now(), dt = Math.min(1, (now - bg.last) / 1000); bg.last = now;
    advance(dt, 45);
    bg.ch.port2.postMessage(0);
  }
  function startBackground() {
    if (bg.on || !S.background || typeof MessageChannel === "undefined") return;
    if (!bg.ch) { bg.ch = new MessageChannel(); bg.ch.port1.onmessage = bgTick; }
    bg.on = true; bg.last = performance.now(); bg.ch.port2.postMessage(0);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { if (S.running) startBackground(); }
    else { bg.on = false; S.lastT = 0; if (S.sim) { S.dirtyBots = true; renderAll(true); } }
  });

  function renderAll(force) {
    var now = performance.now();
    if (force || now - S.lastTop > 90) { S.lastTop = now; renderTop(); }
    renderChart(force);
    if (force || now - S.lastList > 350) {
      S.lastList = now;
      if (S.filter === "gain" || S.filter === "lose" || S.filter === "held") refilter();
      renderList();
      renderBots();
      renderFeeds();
    }
    if (force || now - S.lastMinis > 2500) { S.lastMinis = now; pickMinis(); S.minisBar = -1; }
    if (force || (S.minisBar !== S.sim.market.gBar && now - (S.lastMiniDraw || 0) > 240)) { S.lastMiniDraw = now; S.minisBar = S.sim.market.gBar; renderMinis(); }
  }

  /* ---------- top bar ---------- */
  function renderTop() {
    var m = S.sim.market, ch = m.indexChangePct();
    var iv = $("idxVal"), txt = T.fmtPrice(m.index);
    if (iv.textContent !== txt) { if (S.lastIdx !== undefined) flash(iv, m.index > S.lastIdx); iv.textContent = txt; S.lastIdx = m.index; }
    $("vixVal").textContent = m.vix().toFixed(2);
    var c = $("idxChg"); c.textContent = pct(ch); c.className = "num chg " + cls(ch);
    var rg = $("regime"); rg.textContent = m.REGIMES[m.regime].name; rg.className = "badge " + m.REGIMES[m.regime].name;
    $("clockDate").textContent = m.dateStr(m.day);
    $("clockTime").textContent = m.bar === 0 && m.gBar > 0 ? "Pre-open" : m.clockStr();
    $("genNum").textContent = S.sim.gen + (S.sim.stopRequested && !S.sim.done ? " (last)" : "");
    $("genDay").textContent = Math.min(S.sim.genDay + 1, S.sim.cfg.daysPerGen);
    var prog = (S.sim.genDay * m.BARS_PER_DAY + m.bar) / (S.sim.cfg.daysPerGen * m.BARS_PER_DAY);
    $("genProgress").style.width = (S.sim.done ? 100 : prog * 100).toFixed(1) + "%";
  }

  /* ---------- chart ---------- */
  function tfLabel(t) {
    var m = S.sim.market;
    if (S.tf === "5m") { var b = ((t % m.BARS_PER_DAY) + m.BARS_PER_DAY) % m.BARS_PER_DAY, mins = 570 + b * 5; var h = Math.floor(mins / 60), mm = mins % 60; return (h > 12 ? h - 12 : h) + ":" + (mm < 10 ? "0" : "") + mm; }
    return m.dateStr(t).slice(5);
  }
  function renderChart(force) {
    var m = S.sim.market, i = S.sel, sig = i + "|" + S.tf + "|" + m.gBar + "|" + S.sim.gen;
    if (!force && sig === S.chartSig) return;
    S.chartSig = sig;
    var d = m.candles(i, S.tf, S.tf === "5m" ? m.INTRA : m.DAILY), daily = S.tf !== "5m";
    if (S.tf === "5m" && d.c.length < 2) { d = m.candles(i, "1D", m.DAILY); daily = true; }
    if (!daily) d.bpd = m.BARS_PER_DAY;
    $("indVwap").disabled = daily;
    chart.set(d, tfLabel, i >= 0 ? tradeMarkers(i, d, daily) : null);
    var last, chg, hi, lo, vol;
    if (i < 0) {
      $("chartSym").textContent = "SIM 500"; $("chartName").textContent = "Cap-weighted index of S&P 500 members";
      last = m.index; chg = m.indexChangePct(); hi = m.indexHigh; lo = m.indexLow; vol = m.indexVol;
      $("csBA").textContent = "—";
    } else {
      $("chartSym").textContent = m.sym[i];
      $("chartName").textContent = m.name[i] + " · " + T.EXCHANGES[m.exch[i]] + " · " + T.SECTORS[m.sector[i]] + (m.isHalted(i) ? " · HALTED" : "");
      last = m.price[i]; chg = m.changePct(i); hi = m.dHigh[i]; lo = m.dLow[i]; vol = m.dVolume[i];
      var q = m.quote(i); $("csBA").textContent = T.fmtPrice(q.bid) + " / " + T.fmtPrice(q.ask);
    }
    $("csLast").textContent = T.fmtPrice(last);
    var c = $("csChg"); c.textContent = pct(chg); c.className = "num " + cls(chg);
    $("csHigh").textContent = T.fmtPrice(hi); $("csLow").textContent = T.fmtPrice(lo);
    $("csVol").textContent = i < 0 ? "$" + T.fmtVol(vol) : T.fmtVol(vol);
    var f = function (id, v) { $(id).textContent = v; };
    if (i < 0) {
      $("fundRow").hidden = true;
    } else {
      $("fundRow").hidden = false;
      var pe = m.pe(i), rsi = m.rsi(i);
      f("fCap", "$" + T.fmtVol(m.marketCap(i)));
      f("fPE", pe === null ? "n/m (loss)" : pe.toFixed(1));
      f("fEPS", (m.eps[i] < 0 ? "−$" : "$") + Math.abs(m.eps[i]).toFixed(2));
      f("fDiv", m.divYield[i] > 0 ? (m.divYield[i] * 100).toFixed(2) + "%" : "None");
      f("fSI", (m.shortInt[i] * 100).toFixed(1) + "%");
      f("fRSI", rsi.toFixed(1) + (rsi >= 70 ? " overbought" : rsi <= 30 ? " oversold" : ""));
      f("fATR", (m.atrPct[i] * 100).toFixed(2) + "%");
      f("fVWAP", T.fmtPrice(m.vwap(i)));
      f("fRange", T.fmtPrice(m.loRange[i]) + " – " + T.fmtPrice(m.hiRange[i]));
      f("fBeta", m.beta[i].toFixed(2));
    }
  }

  /* Bot trades on one symbol, keyed by the chart's bar time, for the chart's markers and hover box. */
  function tradeMarkers(i, d, daily) {
    var m = S.sim.market, sym = m.sym[i], BPD = m.BARS_PER_DAY, first = d.t.length ? d.t[0] : 0, idx = Object.create(null), count = 0;
    S.sim.bots.forEach(function (b) {
      for (var j = b.trades.length - 1; j >= 0; j--) {
        var t = b.trades[j], key = daily ? t.day : t.day * BPD + t.bar;
        if (key < first) break;
        if (t.sym !== sym) continue;
        var mk = idx[key] || (idx[key] = { buy: 0, sell: 0, lines: [] }), buy = t.side === "BUY" || t.side === "COVER";
        if (buy) mk.buy++; else mk.sell++;
        mk.lines.push(t.side + " " + t.qty.toLocaleString() + " @ " + T.fmtPrice(t.px) + " · " + b.name + (t.pnl !== null ? " · " + signed$(t.pnl) : ""));
        count++;
      }
    });
    return { index: idx, length: count };
  }

  /* Brief colour pulse when a number changes (green up, red down). */
  function flash(node, up) {
    if (reduceMotion || !node.animate || (S.running && S.speed === 0 && node !== $("idxVal"))) return;   // at Max speed every price moves every update: too busy
    node.animate([{ backgroundColor: up ? "var(--up-weak)" : "var(--down-weak)" }, { backgroundColor: "transparent" }], { duration: 600, easing: "ease-out" });
  }

  /* ---------- markets list (virtualized) ---------- */
  var ROW = 34, rowPool = [];
  function heldCounts() {
    var cnt = Object.create(null);
    S.sim.bots.forEach(function (b) { for (var k in b.pos) cnt[k] = (cnt[k] || 0) + 1; });
    return cnt;
  }
  function refilter() {
    var m = S.sim.market, q = S.query.trim().toUpperCase(), out = [], i, held = S.filter === "held" ? heldCounts() : null;
    for (i = 0; i < m.n; i++) {
      if (S.sector >= 0 && m.sector[i] !== S.sector) continue;
      if (S.filter === "sp" && !m.sp[i]) continue;
      if (held && !held[i]) continue;
      if (q && m.sym[i].indexOf(q) !== 0 && m.name[i].toUpperCase().indexOf(q) < 0) continue;
      out.push(i);
    }
    if (S.filter === "gain" || S.filter === "lose") {
      out = out.filter(function (j) { return m.price[j] >= 1 && m.avgVol[j] * m.price[j] > 1e6; });
      out.sort(function (a, b) { return S.filter === "gain" ? m.changePct(b) - m.changePct(a) : m.changePct(a) - m.changePct(b); });
      out = out.slice(0, 200);
    }
    if (held) out.sort(function (a, b) { return held[b] - held[a]; });
    if (q) out.sort(function (a, b) { return (m.sym[a] === q ? -1 : 0) - (m.sym[b] === q ? -1 : 0); });
    S.filtered = out;
    $("mListInner").style.height = (out.length * ROW) + "px";
  }
  function renderList() {
    var m = S.sim.market, box = $("mList"), inner = $("mListInner");
    var top = box.scrollTop, h = box.clientHeight || 400;
    var first = Math.max(0, Math.floor(top / ROW) - 4), last = Math.min(S.filtered.length, Math.ceil((top + h) / ROW) + 4);
    var need = last - first;
    while (rowPool.length < need) {
      var b = el("button", "mrow"); b.type = "button"; b.setAttribute("role", "option");
      var s = el("span", "s"), n = el("span", "n"), p = el("span", "p num"), c = el("span", "c num");
      var left = el("span", "lft"); left.appendChild(s); left.appendChild(n);
      b.appendChild(left); b.appendChild(p); b.appendChild(c);
      b._s = s; b._n = n; b._p = p; b._c = c;
      b.addEventListener("click", function () { select(this._idx); });
      inner.appendChild(b); rowPool.push(b);
    }
    for (var k = 0; k < rowPool.length; k++) {
      var row = rowPool[k];
      if (k >= need) { row.hidden = true; continue; }
      var i = S.filtered[first + k];
      row.hidden = false; row._idx = i;
      row.style.top = ((first + k) * ROW) + "px";
      row._s.textContent = m.sym[i]; row._n.textContent = m.name[i];
      var ptxt = T.fmtPrice(m.price[i]);
      if (row._p.textContent !== ptxt) { if (row._last !== undefined && row._lastIdx === i) flash(row._p, m.price[i] > row._last); row._p.textContent = ptxt; }
      row._last = m.price[i]; row._lastIdx = i;
      var ch = m.changePct(i); row._c.textContent = pct(ch); row._c.className = "c num " + cls(ch);
      row.classList.toggle("sel", i === S.sel);
      row.setAttribute("aria-selected", i === S.sel ? "true" : "false");
    }
  }

  function select(i) {
    S.sel = i; chart.reset();
    renderChart(true); renderList(); renderMinis();
    if (window.matchMedia("(max-width: 900px)").matches) showPanel("pChart");
  }

  /* ---------- mini charts ---------- */
  function pickMinis() {
    var m = S.sim.market, held = heldCounts(), ids = Object.keys(held).map(Number);
    ids.sort(function (a, b) { return held[b] - held[a] || Math.abs(m.changePct(b)) - Math.abs(m.changePct(a)); });
    var out = [-1];
    for (var k = 0; k < ids.length && out.length < 6; k++) out.push(ids[k]);
    if (out.length < 6) {
      var mv = m.topMovers(6, true).concat(m.topMovers(6, false));
      for (k = 0; k < mv.length && out.length < 6; k++) if (out.indexOf(mv[k]) < 0) out.push(mv[k]);
    }
    S.held = held;
    var box = $("minis");
    if (box.children.length !== 6) {
      clear(box);
      for (k = 0; k < 6; k++) {
        var b = el("button", "mini"); b.type = "button";
        var top = el("div", "mini-top"), s = el("b"), c = el("span", "num");
        top.appendChild(s); top.appendChild(c);
        var cv = el("canvas"); cv.setAttribute("aria-hidden", "true");
        b.appendChild(top); b.appendChild(cv);
        b._s = s; b._c = c; b._cv = cv;
        b.addEventListener("click", function () { select(this._idx); });
        box.appendChild(b);
      }
    }
    S.minis = out;
  }
  function renderMinis() {
    var m = S.sim.market, box = $("minis");
    for (var k = 0; k < 6; k++) {
      var b = box.children[k], i = S.minis[k];
      if (i === undefined) { b.hidden = true; continue; }
      b.hidden = false; b._idx = i;
      var ch = i < 0 ? m.indexChangePct() : m.changePct(i);
      var heldBy = i >= 0 && S.held && S.held[i] ? " · " + S.held[i] + " bots" : "";
      b._s.textContent = (i < 0 ? "SIM 500" : m.sym[i]);
      b._c.textContent = pct(ch) + heldBy; b._c.className = "num " + cls(ch);
      b.setAttribute("aria-label", "Open chart for " + (i < 0 ? "SIM 500" : m.sym[i]));
      b.classList.toggle("sel", i === S.sel);
      var d = m.candles(i, "5m", 60);
      if (d.c.length < 2) d = m.candles(i, "1D", 60);
      T.miniCandles(b._cv, d, 60);
    }
  }

  /* ---------- bots ---------- */
  var botRows = {};
  function renderBots() {
    var sim = S.sim, m = sim.market, bots = sim.bots.slice(), list = $("botList");
    bots.forEach(function (b) { b.markEquity(m); });
    bots.sort(function (a, b) { return b.equity - a.equity; });
    if (S.dirtyBots) {
      clear(list); botRows = {}; S.botOrder = "";
      bots.forEach(function (b) {
        var li = el("li"), btn = el("button", "bot-row"); btn.type = "button";
        var left = el("span", "lft"), nm = el("span", "nm"), rk = el("span", "rank num"), nmT = el("span"), st = el("span", "st"), mv = el("span", "mv");
        mv.setAttribute("aria-hidden", "true");
        nm.appendChild(rk); nm.appendChild(nmT); nm.appendChild(mv); left.appendChild(nm); left.appendChild(st);
        var cv = el("canvas"); cv.setAttribute("aria-hidden", "true");
        var pl = el("span", "pl num"), plA = el("span"), plP = el("small");
        pl.appendChild(plA); pl.appendChild(plP);
        btn.appendChild(left); btn.appendChild(cv); btn.appendChild(pl);
        btn.addEventListener("click", function () { showBot(b); });
        li.appendChild(btn);
        botRows[b.id] = { li: li, btn: btn, rk: rk, nm: nmT, st: st, cv: cv, plA: plA, plP: plP, pl: pl, mv: mv };
        list.appendChild(li);
      });
      S.dirtyBots = false;
    }
    var start = sim.cfg.startCash, up = 0, sum = 0, order = bots.map(function (b) { return b.id; }).join(",");
    if (order !== S.botOrder) {
      // FLIP: remember where rows were, reorder, then slide them from the old spot to the new one
      var animate = !reduceMotion && S.botOrder && bots.length <= 160, before = {};
      if (animate) bots.forEach(function (b) { var r = botRows[b.id]; if (r) before[b.id] = r.li.offsetTop; });
      var frag = document.createDocumentFragment();
      bots.forEach(function (b, k) {
        var r = botRows[b.id]; if (!r) return;
        if (r.rank !== undefined && r.rank !== k) { r.mv.textContent = k < r.rank ? "▲" : "▼"; r.mv.className = "mv " + (k < r.rank ? "up" : "down"); r.mvAt = performance.now(); }
        r.rank = k; frag.appendChild(r.li);
      });
      list.appendChild(frag);
      if (animate) bots.forEach(function (b) {
        var r = botRows[b.id]; if (!r || before[b.id] === undefined) return;
        var dy = before[b.id] - r.li.offsetTop;
        if (dy && Math.abs(dy) < 2000 && r.li.animate) r.li.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" });
      });
      S.botOrder = order;
    }
    var vTop = list.scrollTop, vBot = vTop + (list.clientHeight || 600), nowT = performance.now();
    bots.forEach(function (b, k) {
      var r = botRows[b.id]; if (!r) return;
      if (r.mvAt && nowT - r.mvAt > 2400) { r.mv.textContent = ""; r.mvAt = 0; }
      var pnl = b.equity - start, ret = pnl / start;
      sum += pnl; if (pnl > 0) up++;
      r.rk.textContent = k + 1; r.nm.textContent = b.name;
      r.st.textContent = b.house + " · " + b.style + " · " + b.nPos + " pos" + (b.age ? " · survived " + b.age : "");
      r.btn.classList.toggle("new", b.gen === sim.gen && sim.gen > 1 && b.age === 0);
      r.plA.textContent = signed$(pnl); r.plP.textContent = pct(ret);
      r.pl.className = "pl num " + cls(pnl);
      r.btn.setAttribute("aria-label", b.name + ", P/L " + signed$(pnl) + " (" + pct(ret) + ")");
      var y0 = r.li.offsetTop;
      if (y0 + 40 >= vTop && y0 <= vBot) T.sparkline(r.cv, b.intraCurve.concat([b.equity]), start);   // only rows on screen
    });
    var avg = bots.length ? sum / bots.length : 0;
    var a = $("bsAvg"); a.textContent = signed$(avg); a.className = "num strong " + cls(avg);
    var best = bots[0];
    if (best) { var bb = $("bsBest"); bb.textContent = best.name + " " + pct(best.equity / start - 1); bb.className = "num " + cls(best.equity - start); }
    $("bsUp").textContent = up + " / " + bots.length;
    $("botCount").textContent = "Gen " + sim.gen + " · " + bots.length + " bots";
  }

  function showBot(b) {
    var m = S.sim.market, s = b.stats(), body = $("botDetail");
    clear(body);
    $("dlgBotTitle").textContent = b.name + " · " + b.style;
    var meta = el("p", "hint", "Born in generation " + b.gen + (b.parents.length ? " to " + b.parents.join(" and ") : " (random genome)") +
      (b.age ? ". Survived " + b.age + " breeding round" + (b.age > 1 ? "s" : "") : "") + ".");
    body.appendChild(meta);
    // equity against the index, plus trait chips
    var eqWrap = el("div", "eq-wrap"), eqCv = el("canvas", "bot-equity");
    eqCv.setAttribute("role", "img"); eqCv.setAttribute("aria-label", b.name + " equity " + signed$(s.pnl) + " (" + pct(s.ret) + "), with SIM 500 for comparison");
    eqWrap.appendChild(eqCv);
    var lg = el("div", "eq-legend"); lg.appendChild(el("span", "sw bot")); lg.appendChild(el("span", null, b.name)); lg.appendChild(el("span", "sw idx")); lg.appendChild(el("span", null, "SIM 500 (rebased)"));
    eqWrap.appendChild(lg); body.appendChild(eqWrap);
    var chips = el("div", "chips");
    T.TRAITS.forEach(function (t) { var cp = el("span", "chip chr" + t.chr, b.traits[t.key]); cp.title = t.name + ": " + t.effect; chips.appendChild(cp); });
    body.appendChild(chips);
    var k = el("div", "kpis");
    [["P/L", signed$(s.pnl)], ["Return", pct(s.ret)], ["vs SIM 500", pct(s.excessVsIndex)], ["Max drawdown", pct(-s.maxDD)],
      ["Sharpe", s.sharpe.toFixed(2)], ["Sortino", s.sortino.toFixed(2)], ["Alpha (ann.)", pct(s.alpha, 1)], ["Beta", s.beta.toFixed(2)],
      ["Volatility (ann.)", (s.volatility * 100).toFixed(1) + "%"], ["1-day VaR 95%", pct(-s.var95)], ["Win rate", (s.winRate * 100).toFixed(1) + "%"],
      ["Profit factor", s.profitFactor.toFixed(2)], ["Expectancy / trip", signed$(s.expectancy)], ["Avg MFE / MAE", pct(s.avgMFE, 1) + " / " + pct(s.avgMAE, 1)],
      ["Long / short P/L", signed$(s.longPnl) + " / " + signed$(s.shortPnl)], ["Gross exposure", (s.avgGrossExposure * 100).toFixed(0) + "%"],
      ["Trades", s.trades], ["Fees", money(s.fees)], ["Dividends", signed$(s.dividends)], ["Open positions", b.nPos]].forEach(function (x) {
      var d = el("div", "kpi"); d.appendChild(el("span", "k", x[0])); d.appendChild(el("span", "v num", String(x[1]))); k.appendChild(d);
    });
    body.appendChild(k);
    var dl = el("div", "dlg-actions left"), btnB = el("button", "btn", "Download this bot's data (.xlsx)");
    btnB.type = "button";
    btnB.addEventListener("click", function () { downloadBot(b.name); });
    dl.appendChild(btnB);
    dl.appendChild(el("span", "hint", "Data from finished generations. Best " + (s.bestSector || "n/a") + ", worst " + (s.worstSector || "n/a") + "."));
    body.appendChild(dl);
    var c = b.cfg, all = S.sim.allBots;
    body.appendChild(el("h3", null, "Family"));
    var pa = all[b.parentIds[0]], pb = all[b.parentIds[1]], gps = [];
    [pa, pb].forEach(function (p) { if (p) p.parentIds.forEach(function (q) { if (all[q]) gps.push(all[q].name + " (" + all[q].house + ")"); }); });
    var kids = Object.keys(all).map(function (k) { return all[k]; }).filter(function (x) { return x.parentIds.indexOf(b.id) >= 0; });
    body.appendChild(el("p", "hint", "House " + b.house + ", generation depth " + b.lineageDepth + ". " +
      (pa ? "Parents: " + pa.name + " (" + pa.house + ", ranked " + b.breedMeta.rankA + ") and " + pb.name + " (" + pb.house + ", ranked " + b.breedMeta.rankB + "), paired by " +
        (b.breedMeta.label || b.breedMeta.rule) + (b.breedMeta.bracketA ? " (brackets: " + b.breedMeta.bracketA + " and " + b.breedMeta.bracketB + ")" : "") +
        ". Parents' returns: " + pct(b.breedMeta.retA) + " and " + pct(b.breedMeta.retB) + ". " + (b.breedMeta.note ? "Note: " + b.breedMeta.note + ". " : "") : "Founder of the house. ") +
      (gps.length ? "Grandparents: " + gps.join(", ") + ". " : "") +
      (kids.length ? "Children: " + kids.map(function (x) { return x.name; }).join(", ") + ". " : "No children yet. ") +
      "Inbreeding coefficient " + b.inbreeding.toFixed(3) + (b.inbreeding >= 0.25 ? " (as close as full siblings' children)" : b.inbreeding >= 0.0625 ? " (as close as first cousins' children or closer)" : "") + "."));
    body.appendChild(familyTree(b, pa, pb, kids));
    body.appendChild(el("h3", null, "Traits"));
    var traitTable = table(["Chromosome", "Trait", "Genotype", "Shows as", "Effect"], T.TRAITS.map(function (t) {
      return [t.chr + " " + T.genetics.CHR_NAMES[t.chr], t.name, T.genetics.show(t, b.genotype[t.key]), b.traits[t.key], t.effect];
    }), -1);
    traitTable.classList.add("wrap-last");
    body.appendChild(traitTable);
    body.appendChild(el("h3", null, "Genes"));
    body.appendChild(el("p", "hint", "Buys above score " + c.buyTh.toFixed(2) + ", exits below " + c.sellTh.toFixed(2) + ". Up to " + c.maxPos + " positions at " +
      (c.posSize * 100).toFixed(1) + "% of equity each. Stop " + (c.stopLoss * 100).toFixed(1) + "%" + (c.trail ? " (trailing)" : "") + ", target " +
      (c.takeProfit * 100).toFixed(1) + "%, max hold " + c.maxHold + " days. Decides every " + c.interval + " bars. Shorting " + (c.shortOn ? "on" : "off") +
      ". Cash reserve " + (c.cashReserve * 100).toFixed(0) + "%."));
    body.appendChild(el("h3", null, "Positions"));
    var rows = [];
    for (var key in b.pos) {
      var p = b.pos[key], px = m.price[key], upnl = (px - p.avg) * p.q;
      rows.push([m.sym[key], p.q > 0 ? "Long" : "Short", Math.abs(p.q).toLocaleString(), T.fmtPrice(p.avg), T.fmtPrice(px), signed$(upnl), upnl]);
    }
    body.appendChild(table(["Symbol", "Side", "Qty", "Avg", "Last", "Unrealized"], rows, 5));
    body.appendChild(el("h3", null, "Recent trades"));
    var tr = b.trades.slice(-40).reverse().map(function (t) {
      return [m.dateStr(t.day).slice(5) + " " + barLabel(t.bar), t.side, t.sym, t.qty.toLocaleString(), T.fmtPrice(t.px), t.pnl === null ? "" : signed$(t.pnl), t.reason, t.pnl];
    });
    body.appendChild(table(["Time", "Side", "Symbol", "Qty", "Price", "Realized", "Reason"], tr, 5));
    $("dlgBot").showModal();
    requestAnimationFrame(function () { T.equityChart(eqCv, b.intraCurve.slice(1).concat([b.equity]), b.idxCurve.concat([m.index]), b.startCash); });
  }

  /* Family tree: grandparents, parents, the bot, its children. Each card opens that bot if it is still in the box. */
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; }
  function familyTree(b, pa, pb, kids) {
    var all = S.sim.allBots, rows = [], live = {};
    S.sim.bots.forEach(function (x) { live[x.id] = x; });
    var gp = [];
    [pa, pb].forEach(function (p) { if (!p) return; p.parentIds.forEach(function (q) { if (all[q]) gp.push({ bot: all[q], child: p.id }); }); });
    if (gp.length) rows.push(gp);
    if (pa) rows.push([{ bot: pa }, { bot: pb }].filter(function (x) { return x.bot; }));
    rows.push([{ bot: b, self: true }]);
    if (kids.length) rows.push(kids.slice(0, 8).map(function (x) { return { bot: x }; }));
    var cw = 138, ch = 40, gapY = 30, widest = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var W = Math.max(600, widest * (cw + 14) + 14), H = rows.length * (ch + gapY) - gapY + 8, pos = {};
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "tree", role: "img", "aria-label": "Family tree of " + b.name });
    rows.forEach(function (row, r) {
      var n = row.length, gap = Math.min(18, (W - n * cw) / Math.max(1, n + 1)), total = n * cw + (n - 1) * gap, x0 = (W - total) / 2;
      row.forEach(function (it, k) { pos[it.bot.id + ":" + r] = { x: x0 + k * (cw + gap), y: 4 + r * (ch + gapY), it: it }; });
    });
    var g = svgEl("g", { class: "links" });
    rows.forEach(function (row, r) {
      if (!r) return;
      row.forEach(function (it) {
        var me = pos[it.bot.id + ":" + r];
        it.bot.parentIds.forEach(function (q) {
          var par = pos[q + ":" + (r - 1)]; if (!par) return;
          var x1 = par.x + cw / 2, y1 = par.y + ch, x2 = me.x + cw / 2, y2 = me.y, my = (y1 + y2) / 2;
          g.appendChild(svgEl("path", { d: "M" + x1 + " " + y1 + " C" + x1 + " " + my + " " + x2 + " " + my + " " + x2 + " " + y2 }));
        });
      });
    });
    svg.appendChild(g);
    Object.keys(pos).forEach(function (key) {
      var p = pos[key], x = p.it.bot, alive = live[x.id], ret = typeof x.lastReturn === "number" ? x.lastReturn : null;
      var node = svgEl("g", { class: "node" + (p.it.self ? " self" : "") + (alive ? " alive" : ""), transform: "translate(" + p.x + "," + p.y + ")" });
      node.appendChild(svgEl("rect", { width: cw, height: ch, rx: 6 }));
      node.appendChild(svgEl("text", { x: 8, y: 16, class: "nm" }, x.name.length > 18 ? x.name.slice(0, 17) + "…" : x.name));
      node.appendChild(svgEl("text", { x: 8, y: 31, class: "sub" + (ret !== null ? ret >= 0 ? " up" : " down" : "") }, x.house + " · G" + x.gen + (ret !== null ? " · " + pct(ret, 1) : "")));
      if (alive && !p.it.self) {
        node.setAttribute("tabindex", "0"); node.setAttribute("role", "button"); node.setAttribute("aria-label", "Open " + x.name);
        var open = function () { showBot(alive); };
        node.addEventListener("click", open);
        node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      }
      svg.appendChild(node);
    });
    var wrap = el("div", "tree-wrap"); wrap.appendChild(svg);
    return wrap;
  }

  /* ---------- generation toast ---------- */
  var toastTimer = 0;
  function hideToast() { var t = $("genToast"); if (t) { t.classList.remove("show"); t.hidden = true; } clearTimeout(toastTimer); }
  function genToast(d) {
    var s = d.summary, box = $("genToast"), start = S.sim.cfg.startCash, rows = (d.rows && d.rows.bots || []).slice().sort(function (a, b) { return b.returnPct - a.returnPct; });
    clear(box);
    var head = el("div", "toast-head");
    head.appendChild(el("b", null, "Generation " + s.gen + " finished"));
    var x = el("button", "btn icon small", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.addEventListener("click", hideToast);
    head.appendChild(x); box.appendChild(head);
    var pod = el("ol", "podium");
    rows.slice(0, 3).forEach(function (r, k) {
      var li = el("li", "p" + (k + 1)); li.appendChild(el("span", "place", String(k + 1))); li.appendChild(el("span", "who", r.bot));
      li.appendChild(el("span", "num " + cls(r.returnPct), pct(r.returnPct))); pod.appendChild(li);
    });
    box.appendChild(pod);
    var st = el("div", "toast-stats");
    [["Average", pct(s.avgReturn), s.avgReturn], ["SIM 500", pct(s.indexReturn), s.indexReturn], ["In profit", s.profitableBots + " / " + s.bots], ["Next", S.sim.expectedSize(s.gen + 1) + " bots"]].forEach(function (q) {
      var dv = el("div"); dv.appendChild(el("span", "k", q[0])); dv.appendChild(el("span", "num strong " + (q[2] !== undefined ? cls(q[2]) : ""), q[1])); st.appendChild(dv);
    });
    box.appendChild(st);
    box.appendChild(el("p", "hint", "Breeding: " + S.sim.ruleName + "."));
    var act = el("div", "toast-actions"), rep = el("button", "btn small", "Open report");
    rep.type = "button"; rep.addEventListener("click", function () { hideToast(); showReport(S.sim.report()); });
    act.appendChild(rep); box.appendChild(act);
    box.hidden = false;
    requestAnimationFrame(function () { box.classList.add("show"); });
    clearTimeout(toastTimer);
    var arm = function () { toastTimer = setTimeout(hideToast, 7000); };
    box.onmouseenter = function () { clearTimeout(toastTimer); }; box.onmouseleave = arm; arm();
  }

  /* ---------- command palette (⌘K / Ctrl+K) and shortcuts ---------- */
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent), MOD = isMac ? "⌘" : "Ctrl+";
  function commands() {
    var list = [
      { name: S.running ? "Pause" : "Start / resume", key: "Space", run: function () { $("btnPlay").click(); } },
      { name: "New run…", key: "N", run: function () { $("btnNew").click(); } },
      { name: "Finish the run…", key: "F", run: function () { $("btnFinish").click(); } },
      { name: "Report and data", key: "D", run: function () { $("btnData").click(); } },
      { name: "Trading data bot (pull requests)", key: "B", run: function () { $("btnDataBot").click(); } },
      { name: "Final training mode on / off", key: "M", run: function () { $("modeSwitch").click(); } },
      { name: "Toggle light / dark theme", key: "T", run: function () { $("btnTheme").click(); } },
      { name: "Search symbols", key: "/", run: function () { $("search").focus(); } },
      { name: "Chart: candles", key: "C", run: function () { setChartType("candle"); } },
      { name: "Chart: line", run: function () { setChartType("line"); } },
      { name: "Chart: area", run: function () { setChartType("area"); } },
      { name: "Chart: zoom in", key: "+", run: function () { chart.zoomBy(0.8, null); } },
      { name: "Chart: zoom out", key: "−", run: function () { chart.zoomBy(1.25, null); } },
      { name: "Chart: back to live", key: "0", run: function () { chart.reset(); } },
      { name: "Chart: 5-minute bars", run: function () { document.querySelector('[data-tf="5m"]').click(); } },
      { name: "Chart: daily bars", run: function () { document.querySelector('[data-tf="1D"]').click(); } },
      { name: "Show SIM 500 index", key: "I", run: function () { select(-1); } }
    ];
    ["sma20", "sma50", "bb", "vwap"].forEach(function (k) { list.push({ name: "Indicator: " + IND_NAMES[k] + (chart.ind[k] ? " (on)" : " (off)"), run: function () { toggleInd(k); } }); });
    [["1", "1 bar/s"], ["2", "4 bars/s"], ["3", "15 bars/s"], ["4", "60 bars/s"], ["5", "Max"]].forEach(function (q, k) {
      list.push({ name: "Speed: " + q[1], key: q[0], run: function () { setSpeed(k); } });
    });
    list.push({ name: "Keyboard shortcuts", key: "?", run: function () { openPalette(""); } });
    return list;
  }
  var IND_NAMES = { sma20: "SMA 20", sma50: "SMA 50", bb: "Bollinger bands", vwap: "VWAP" };
  function setSpeed(k) { var sel = $("speed"); sel.selectedIndex = k; sel.dispatchEvent(new Event("change")); setStatus("Speed: " + sel.options[k].text + "."); }
  function setChartType(t) {
    chart.type = t; saveChartPrefs(); chart.req();
    document.querySelectorAll("[data-ctype]").forEach(function (b) { var on = b.dataset.ctype === t; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function toggleInd(k, force) {
    chart.ind[k] = force === undefined ? !chart.ind[k] : force; saveChartPrefs(); chart.req();
    var b = document.querySelector('[data-ind="' + k + '"]'); if (b) b.setAttribute("aria-pressed", chart.ind[k] ? "true" : "false");
  }
  function paletteItems(q) {
    q = q.trim().toLowerCase();
    var out = [], m = S.sim.market;
    commands().forEach(function (c) { if (!q || c.name.toLowerCase().indexOf(q) >= 0) out.push({ label: c.name, hint: c.key || "", run: c.run, kind: "Action" }); });
    if (q) {
      var Q = q.toUpperCase(), hits = 0;
      for (var i = 0; i < m.n && hits < 8; i++) if (m.sym[i] === Q || (m.sym[i].indexOf(Q) === 0 && Q.length > 0)) { (function (j) { out.push({ label: m.sym[j] + " · " + m.name[j], hint: T.fmtPrice(m.price[j]) + " " + pct(m.changePct(j)), run: function () { select(j); }, kind: "Symbol" }); })(i); hits++; }
      for (i = 0; i < m.n && hits < 12; i++) if (m.sym[i].indexOf(Q) !== 0 && m.name[i].toLowerCase().indexOf(q) >= 0) { (function (j) { out.push({ label: m.sym[j] + " · " + m.name[j], hint: T.fmtPrice(m.price[j]), run: function () { select(j); }, kind: "Symbol" }); })(i); hits++; }
      S.sim.bots.filter(function (b) { return b.name.toLowerCase().indexOf(q) >= 0 || b.house.toLowerCase().indexOf(q) >= 0; }).slice(0, 8).forEach(function (b) {
        out.push({ label: b.name + " · " + b.house + " · " + b.style, hint: pct(b.equity / b.startCash - 1), run: function () { showBot(b); }, kind: "Bot" });
      });
    }
    return out.slice(0, 40);
  }
  var pal = { items: [], at: 0 };
  function openPalette(initial) {
    var d = $("dlgPalette"), inp = $("palInput");
    inp.value = initial || ""; renderPalette();
    if (!d.open) d.showModal();
    inp.focus();
  }
  function renderPalette() {
    var list = $("palList"); clear(list);
    pal.items = paletteItems($("palInput").value); pal.at = Math.min(pal.at, Math.max(0, pal.items.length - 1));
    pal.items.forEach(function (it, k) {
      var li = el("li", "pal-item" + (k === pal.at ? " on" : "")); li.setAttribute("role", "option"); li.id = "pal" + k;
      li.setAttribute("aria-selected", k === pal.at ? "true" : "false");
      li.appendChild(el("span", "pal-kind", it.kind)); li.appendChild(el("span", "pal-label", it.label));
      if (it.hint) li.appendChild(el(it.kind === "Action" ? "kbd" : "span", it.kind === "Action" ? null : "num muted", it.hint));
      li.addEventListener("mousemove", function () { if (pal.at !== k) { pal.at = k; markPal(); } });
      li.addEventListener("click", function () { runPal(k); });
      list.appendChild(li);
    });
    if (!pal.items.length) list.appendChild(el("li", "pal-empty", "Nothing matches. Try a symbol (AAPL), a bot name or an action (zoom, speed, report)."));
    $("palInput").setAttribute("aria-activedescendant", pal.items.length ? "pal" + pal.at : "");
  }
  function markPal() {
    Array.prototype.forEach.call($("palList").children, function (li, k) { li.classList.toggle("on", k === pal.at); li.setAttribute("aria-selected", k === pal.at ? "true" : "false"); });
    var on = $("pal" + pal.at); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    $("palInput").setAttribute("aria-activedescendant", "pal" + pal.at);
  }
  function runPal(k) { var it = pal.items[k]; if (!it) return; $("dlgPalette").close(); setTimeout(it.run, 0); }

  function barLabel(b) { var mins = 570 + b * 5, h = Math.floor(mins / 60), mm = mins % 60; return (h > 12 ? h - 12 : h) + ":" + (mm < 10 ? "0" : "") + mm; }

  function table(heads, rows, colorCol) {
    var wrap = el("div", "tbl-wrap scroll-y"), t = el("table"), th = el("thead"), tr = el("tr");
    heads.forEach(function (h) { var c = el("th", null, h); c.scope = "col"; tr.appendChild(c); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el("tbody");
    if (!rows.length) { var r0 = el("tr"), td0 = el("td", "muted", "None"); td0.colSpan = heads.length; r0.appendChild(td0); tb.appendChild(r0); }
    rows.forEach(function (r) {
      var row = el("tr");
      for (var i = 0; i < heads.length; i++) {
        var td = el("td", "num", r[i] === undefined ? "" : String(r[i]));
        if (i === colorCol && typeof r[heads.length] === "number") td.className = "num " + cls(r[heads.length]);
        row.appendChild(td);
      }
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  /* ---------- feeds ---------- */
  function renderFeeds() {
    var m = S.sim.market, box = $("feedNews"), log = m.recentNews;
    if (S.newsSeen > m.newsSeq) S.newsSeen = 0;
    for (var k = Math.max(0, log.length - 80); k < log.length; k++) {
      var it = log[k];
      if (it.seq <= S.newsSeen) continue;
      var row = el("div", "news-item " + it.kind);
      row.appendChild(el("span", "t num", it.date.slice(5) + " " + it.time.replace(" AM", "a").replace(" PM", "p")));
      if (it.scope === "stock") {
        var sb = el("button", "sym", it.sym); sb.type = "button"; sb._i = it.target;
        sb.addEventListener("click", function () { select(this._i); });
        row.appendChild(sb);
      } else row.appendChild(el("span", "sym", it.scope === "sector" ? "Sector" : "Macro"));
      row.appendChild(el("span", "h", it.headline));
      row.appendChild(el("span", "i num " + cls(it.impact), it.kind === "halt" ? "Halt" : it.kind === "split" ? "Split" : it.kind === "dividend" ? "Div" : pct(it.impact, 1)));
      box.insertBefore(row, box.firstChild);
    }
    S.newsSeen = m.newsSeq;
    while (box.children.length > 150) box.removeChild(box.lastChild);

    // trades from every bot in the box
    var tb = $("feedTrades"), fresh = [];
    S.sim.bots.forEach(function (b) {
      var seen = S.tradeSeen[b.id] || 0;
      if (seen > b.trades.length) seen = 0;
      for (var j = Math.max(seen, b.trades.length - 10); j < b.trades.length; j++) fresh.push([b, b.trades[j]]);
      S.tradeSeen[b.id] = b.trades.length;
    });
    fresh.sort(function (a, b) { return (a[1].day - b[1].day) || (a[1].bar - b[1].bar); });
    fresh.slice(-60).forEach(function (x) {
      var t = x[1], row = el("div", "trade-item");
      row.appendChild(el("span", "num muted", m.dateStr(t.day).slice(5) + " " + barLabel(t.bar)));
      row.appendChild(el("span", null, x[0].name));
      row.appendChild(el("span", "side " + (t.side === "BUY" || t.side === "COVER" ? "up" : "down"), t.side));
      row.appendChild(el("span", "num", t.sym));
      row.appendChild(el("span", "num qty muted", t.qty.toLocaleString() + " @ " + T.fmtPrice(t.px) + " · " + t.reason));
      row.appendChild(el("span", "num " + (t.pnl === null ? "muted" : cls(t.pnl)), t.pnl === null ? "open" : signed$(t.pnl)));
      tb.insertBefore(row, tb.firstChild);
    });
    while (tb.children.length > 150) tb.removeChild(tb.lastChild);

    if (S.feed === "sectors") {
      var sec = $("feedSectors");
      if (sec.children.length !== T.SECTORS.length) {
        clear(sec);
        T.SECTORS.forEach(function (name) { var d = el("div", "sector-tile"); d.appendChild(el("b", null, name)); d.appendChild(el("span", "num")); sec.appendChild(d); });
      }
      T.SECTORS.forEach(function (name, s) {
        var ch = m.sectorIdx[s] / m.sectorPrev[s] - 1, tile = sec.children[s];
        tile.lastChild.textContent = pct(ch);
        tile.lastChild.className = "num " + cls(ch);
        var a = Math.min(0.35, Math.abs(ch) * 12);
        tile.style.background = ch >= 0 ? "rgba(52,211,153," + a.toFixed(3) + ")" : "rgba(248,113,113," + a.toFixed(3) + ")";
      });
    }
  }

  /* ---------- report ---------- */
  function showReport(rep) {
    var sim = S.sim, body = $("reportBody");
    clear(body);
    var gensAll = sim.log.generations, gensShown = gensAll.slice(-60);
    body.appendChild(el("p", "hint", gensAll.length + " generations" + (sim.done ? "" : " so far (run still going)") + ", " + rep.uniqueBots + " unique bots, " + rep.botRuns +
      " bot-generation runs, " + rep.tradingDays + " trading days (" + rep.startDate + " to " + rep.endDate + ") on " + sim.market.n.toLocaleString() + " symbols. Seed " + rep.config.seed + "."));
    if (!gensAll.length) body.appendChild(el("p", "hint", "No generation has finished yet. Tables fill in as each generation ends."));
    var k = el("div", "kpis");
    [["Avg return", pct(rep.avgReturn), rep.avgReturn], ["Avg P/L", signed$(rep.avgPnl), rep.avgPnl], ["Avg win rate", (rep.avgWinRate * 100).toFixed(1) + "%"],
      ["Avg Sharpe", rep.avgSharpe.toFixed(2), rep.avgSharpe], ["Avg max drawdown", pct(-rep.avgMaxDrawdown)], ["SIM 500", pct(rep.indexReturn), rep.indexReturn],
      ["Gen 1 avg", pct(rep.firstGenAvg), rep.firstGenAvg], ["Latest gen avg", pct(rep.lastGenAvg), rep.lastGenAvg],
      ["Avg Sortino", rep.avgSortino.toFixed(2), rep.avgSortino], ["Avg alpha (ann.)", pct(rep.avgAlpha, 1), rep.avgAlpha],
      ["Compounded avg bot", pct(rep.cumulativeAvgBot), rep.cumulativeAvgBot], ["Compounded SIM 500", pct(rep.cumulativeIndex), rep.cumulativeIndex],
      ["Round trips", rep.totalRoundTrips.toLocaleString()], ["Fees paid", money(rep.totalFees)]].forEach(function (x) {
      var d = el("div", "kpi"); d.appendChild(el("span", "k", x[0])); d.appendChild(el("span", "v num " + (x[2] !== undefined ? cls(x[2]) : ""), x[1])); k.appendChild(d);
    });
    body.appendChild(k);
    body.appendChild(el("h3", null, "Average return by generation" + (gensAll.length > gensShown.length ? " (last " + gensShown.length + ")" : "")));
    body.appendChild(el("p", "hint", "Bar: average bot return. Whisker: best to worst bot. Teal tick: SIM 500 over the same days."));
    var cv = el("canvas", "report-chart"); cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", "Average return per generation: " + gensShown.map(function (g) { return "G" + g.gen + " " + pct(g.avgReturn); }).join(", "));
    body.appendChild(cv);
    body.appendChild(table(["Gen", "Bots", "Avg", "Median", "Best", "Worst", "In profit", "Beat index", "Sharpe", "Alpha", "Win rate", "Diversity", "SIM 500", "VIX"],
      gensShown.slice().reverse().map(function (g, k) {
        var gen = sim.log.genetics[sim.log.genetics.length - 1 - k] || {};
        return ["G" + g.gen, g.bots, pct(g.avgReturn), pct(g.medianReturn), pct(g.bestReturn), pct(g.worstReturn), g.profitableBots, g.beatIndex,
          g.avgSharpe.toFixed(2), pct(g.avgAlphaAnn, 1), (g.avgWinRate * 100).toFixed(1) + "%", gen.diversity ? gen.diversity.toFixed(3) : "", pct(g.indexReturn), g.avgSimVix.toFixed(1), g.avgReturn];
      }), 2));
    body.appendChild(el("h3", null, "Genetics" + (gensAll.length > 20 ? " (last 20 generations)" : "")));
    var bin = T.TRAITS.filter(function (t) { return t.mode !== "multi"; });
    body.appendChild(el("p", "hint", "Breeding rule: " + sim.ruleName + ". Letter columns show how common each dominant allele is: " +
      bin.map(function (t) { return t.a + " " + (t.dom || t.looks[2]).toLowerCase(); }).join(", ") + "."));
    var gtab = table(["Gen", "Inbreeding", "Houses", "Top house"].concat(bin.map(function (t) { return t.a; })).concat(["Favourite sectors"]),
      sim.log.genetics.slice(-20).reverse().map(function (g) {
        return ["G" + g.gen, g.avgInbreeding.toFixed(3), g.housesAlive, g.topHouse].concat(bin.map(function (t) { return Math.round(g["allele_" + t.a] * 100) + "%"; }))
          .concat([(g.alleles_sector || "").split("; ").slice(0, 2).join("; ")]);
      }), -1);
    gtab.classList.add("wrap-last");
    body.appendChild(gtab);
    body.appendChild(el("h3", null, "Top 10 bot runs"));
    var top = sim.log.bots.slice().sort(function (a, b) { return b.returnPct - a.returnPct; }).slice(0, 10);
    body.appendChild(table(["Bot", "Gen", "Style", "Return", "P/L", "Max DD", "Sharpe", "Trades", "Win rate"],
      top.map(function (b) { return [b.bot, b.gen, b.style, pct(b.returnPct), signed$(b.pnl), pct(-b.maxDrawdown), b.sharpe.toFixed(2), b.trades, (b.winRate * 100).toFixed(1) + "%", b.returnPct]; }), 3));
    var sel = $("csvSel"); clear(sel);
    T.Report.sheets(sim).forEach(function (s) { var o = el("option", null, s[0] + " (" + s[1].length.toLocaleString() + " rows)"); o.value = s[0]; sel.appendChild(o); });
    var bs = $("botSel"); clear(bs);
    sim.profiles().slice().reverse().forEach(function (p) { var o = el("option", null, p.bot + " · " + p.status + (p.compoundedReturn !== "" ? " · " + pct(p.compoundedReturn) : "")); o.value = p.bot; bs.appendChild(o); });
    $("exportNote").textContent = sim.trimmedThrough ? "Trade-level rows for generations 1-" + sim.trimmedThrough + " were dropped from memory to keep this endless run going. Their summary rows are in every export." :
      "Everything from every finished generation is in memory and in every export.";
    if (!$("dlgReport").open) $("dlgReport").showModal();
    requestAnimationFrame(function () { T.genBars(cv, gensShown); });
  }

  // Inside the claude.ai viewer (the phone link), files are saved through the viewer's own save prompt.
  var savePrompt = null;
  try { if (window.claude && window.claude.use) window.claude.use("downloads").then(function (d) { savePrompt = d; }, function () {}); } catch (e) { /* plain browser */ }
  function download(name, blob) {
    if (savePrompt) {
      savePrompt.save({ filename: name, data: blob }).then(function () { setStatus("Saved " + name + "."); }, function (e) {
        setStatus(e && e.code === "declined" ? "Download cancelled." : e && e.code === "rate_limited" ? "Another save is waiting for you. Finish it, then try again." : "Could not save " + name + (e && e.message ? ": " + e.message : "."));
      });
      return;
    }
    var a = el("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function runName() { var c = S.sim.cfg; return "trade-box-seed" + c.seed + "-x" + c.mult + "-g" + (S.sim.forever ? "inf" : c.generations); }
  function needX() { if (!window.XLSX) { setStatus("Spreadsheet library still loading. Try again in a moment."); return false; } return true; }
  var XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  function saveBook(wb, name) { download(name, new Blob([window.XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true })], { type: XLSX_TYPE })); }
  function busy(btn, fn) {
    var t = btn.textContent; btn.disabled = true; btn.textContent = "Building…";
    setTimeout(function () { try { fn(); } catch (e) { setStatus("Export failed: " + e.message); } btn.disabled = false; btn.textContent = t; }, 30);
  }
  function downloadBot(name) { if (needX()) saveBook(T.Report.botWorkbook(S.sim, name, window.XLSX), runName() + "-" + name + ".xlsx"); }

  /* ---------- panels / events ---------- */
  function showPanel(id) {
    ["pMarkets", "pChart", "pBots", "pFeed"].forEach(function (p) { $(p).classList.toggle("show", p === id); });
    document.querySelectorAll(".mobile-tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.panel === id); });
    requestAnimationFrame(function () { renderAll(true); });
  }

  function segGroup(selector, onPick) {
    document.querySelectorAll(selector).forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.parentNode.querySelectorAll(".seg-btn").forEach(function (o) { o.classList.toggle("active", o === btn); o.setAttribute("aria-selected", o === btn ? "true" : "false"); });
        onPick(btn);
      });
    });
  }

  /* ---------- breeding settings ---------- */
  var BR = T.Breeding, PRESET_GROUPS = [
    ["Winners and losers", ["ranked", "winners", "losers", "assortative", "disassortative"]],
    ["By profit", ["profitable", "unprofitable", "beatIndex", "above", "between", "topPct", "bottomPct"]],
    ["By bracket", ["sameBracket", "crossBracket", "mirrorBracket", "topBrackets", "profitLevels"]],
    ["Other", ["random", "tournament", "roulette", "outbreed", "inbreed"]],
    ["Your own", ["custom"]]
  ];
  function fillSelect(id, list) { var sel = $(id); list.forEach(function (x) { var o = el("option", null, x.name); o.value = x.key; sel.appendChild(o); }); }
  function wireBreeding() {
    PRESET_GROUPS.forEach(function (g) {
      var og = document.createElement("optgroup"); og.label = g[0];
      g[1].forEach(function (k) { var p = BR.find(BR.PRESETS, k); if (p) { var o = el("option", null, p.name); o.value = k; og.appendChild(o); } });
      $("inBreed").appendChild(og);
    });
    fillSelect("inPool", BR.POOLS); fillSelect("inPair", BR.PAIRINGS); fillSelect("inBrackets", BR.BRACKETS);
    $("inBreed").addEventListener("change", function () { if (this.value !== "custom") loadBreeding({ breeding: this.value }); else refreshBreeding(); });
    ["inPool", "inPair", "inBrackets", "inThresh", "inThresh2", "inPct", "inLevels"].forEach(function (id) {
      $(id).addEventListener(id === "inLevels" || /Thresh|Pct/.test(id) ? "input" : "change", function () { $("inBreed").value = "custom"; refreshBreeding(); });
    });
    $("allowedBoxes").addEventListener("change", function () { $("inBreed").value = "custom"; refreshBreeding(); });
    loadBreeding(S.cfg);
  }
  function loadBreeding(cfg) {
    var s;
    try { s = BR.normalize(cfg); } catch (e) { s = BR.normalize({}); }
    $("inBreed").value = s.preset; $("inPool").value = s.pool; $("inPair").value = s.pairing; $("inBrackets").value = s.brackets;
    $("inThresh").value = s.threshold; $("inThresh2").value = s.threshold2; $("inPct").value = s.pct; $("inLevels").value = s.levels.join(", ");
    renderAllowed(s, s.allowed);
    refreshBreeding();
  }
  function renderAllowed(s, checked) {
    var box = $("allowedBoxes"), labels = BR.bracketLabels(s);
    clear(box);
    labels.forEach(function (lab, k) {
      var l = el("label", "check"), c = el("input"); c.type = "checkbox"; c.value = k; c.checked = checked.indexOf(k) >= 0;
      l.appendChild(c); l.appendChild(document.createTextNode(" " + lab)); box.appendChild(l);
    });
  }
  function readBreeding() {
    var levels = $("inLevels").value.split(/[,\s]+/).filter(function (x) { return x !== ""; }).map(Number);
    var out = { breeding: $("inBreed").value, breedPool: $("inPool").value, breedPairing: $("inPair").value, brackets: $("inBrackets").value,
      levels: levels, threshold: $("inThresh").value, threshold2: $("inThresh2").value, pct: +$("inPct").value,
      allowed: Array.prototype.filter.call($("allowedBoxes").querySelectorAll("input"), function (c) { return c.checked; }).map(function (c) { return +c.value; }) };
    if (out.brackets === "profit" && (!levels.length || levels.some(function (x) { return !isFinite(x); }))) out.error = "Profit levels must be numbers separated by commas, like -2, 0, 2.";
    else if (out.breedPool === "brackets" && !out.allowed.length) out.error = "Tick at least one bracket that can breed.";
    else if (/^(above|below|between)$/.test(out.breedPool) && !isFinite(parseFloat(out.threshold))) out.error = "Enter a return level, for example 1 for +1%.";
    else if (out.breedPool === "between" && !isFinite(parseFloat(out.threshold2))) out.error = "Enter the upper return level.";
    else if (/Pct$/.test(out.breedPool) && !(out.pct >= 1 && out.pct <= 100)) out.error = "The share must be between 1% and 100%.";
    return out;
  }
  function refreshBreeding() {
    var r = readBreeding(), pool = r.breedPool, pair = r.breedPairing;
    var usesBr = pool === "brackets" || /Bracket$/.test(pair);
    $("fThresh").hidden = !/^(above|below|between)$/.test(pool);
    $("lblThresh").textContent = pool === "between" ? "Lower return level (%)" : "Return level (%)";
    $("fThresh2").hidden = pool !== "between";
    $("fPct").hidden = !/Pct$/.test(pool);
    $("fBrackets").hidden = !usesBr;
    $("fLevels").hidden = !usesBr || r.brackets !== "profit";
    $("fAllowed").hidden = pool !== "brackets";
    $("poolHint").textContent = BR.find(BR.POOLS, pool).desc;
    $("pairHint").textContent = BR.find(BR.PAIRINGS, pair).desc;
    var sum = $("breedSummary");
    if (!r.error) {
      try {
        var s = BR.normalize(r);
        if (pool === "brackets" && $("allowedBoxes").children.length !== BR.bracketCount(s)) renderAllowed(s, r.allowed.filter(function (k) { return k < BR.bracketCount(s); }));
        else Array.prototype.forEach.call($("allowedBoxes").querySelectorAll("label"), function (l, k) { l.lastChild.textContent = " " + BR.bracketLabels(s)[k]; });
        r = readBreeding();
        if (!r.error) {
          sum.textContent = BR.describe(BR.normalize(r)) + ". The top half still survives each generation from Gen 3 on; only who parents the children changes.";
          sum.classList.remove("bad");
          return;
        }
      } catch (e) { r.error = e.message; }
    }
    sum.textContent = r.error; sum.classList.add("bad");
  }

  function wire() {
    T.SECTORS.forEach(function (s, k) { var o = el("option", null, s); o.value = k; $("sectorSel").appendChild(o); });
    $("btnPlay").addEventListener("click", function () {
      if (S.sim.done) { showReport(S.sim.report()); return; }
      S.running = !S.running; S.lastT = 0; setPlay();
      setStatus(S.running ? "Running generation " + S.sim.gen + "." : "Paused.");
    });
    $("speed").addEventListener("change", function () { S.speed = +this.value; S.acc = 0; });
    $("btnTheme").addEventListener("click", function () {
      var t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      store("tb-theme", t); applyTheme(); setStatus("Theme: " + t + ". It stays " + t + " until you switch back; double-click the button to follow your system again.");
    });
    $("btnTheme").addEventListener("dblclick", function () { store("tb-theme", "auto"); applyTheme(); setStatus("Theme follows your system's light or dark setting."); });
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onSys = function () { applyTheme(); };
      if (mq.addEventListener) mq.addEventListener("change", onSys); else if (mq.addListener) mq.addListener(onSys);
    }
    // chart toolbar
    document.querySelectorAll("[data-ctype]").forEach(function (b) { b.addEventListener("click", function () { setChartType(b.dataset.ctype); }); });
    document.querySelectorAll("[data-ind]").forEach(function (b) { b.addEventListener("click", function () { toggleInd(b.dataset.ind); }); });
    setChartType(chart.type); Object.keys(chart.ind).forEach(function (k) { toggleInd(k, chart.ind[k]); });
    $("btnZoomIn").addEventListener("click", function () { chart.zoomBy(0.8, null); });
    $("btnZoomOut").addEventListener("click", function () { chart.zoomBy(1.25, null); });
    $("btnLive").addEventListener("click", function () { chart.reset(); });
    $("botList").addEventListener("scroll", function () { clearTimeout(S.botScroll); S.botScroll = setTimeout(renderBots, 60); }, { passive: true });
    // command palette
    $("palInput").addEventListener("input", function () { pal.at = 0; renderPalette(); });
    $("palInput").addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); pal.at = Math.min(pal.items.length - 1, pal.at + 1); markPal(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); pal.at = Math.max(0, pal.at - 1); markPal(); }
      else if (e.key === "Enter") { e.preventDefault(); runPal(pal.at); }
    });
    $("btnPalette").addEventListener("click", function () { openPalette(""); });
    $("btnPalette").setAttribute("title", "Commands and search (" + MOD + "K)");
    $("palKbd").textContent = MOD + "K";
    $("search").addEventListener("input", function () { S.query = this.value; refilter(); $("mList").scrollTop = 0; renderList(); });
    $("sectorSel").addEventListener("change", function () { S.sector = +this.value; refilter(); $("mList").scrollTop = 0; renderList(); });
    $("mList").addEventListener("scroll", renderList, { passive: true });
    segGroup("[data-filter]", function (b) { S.filter = b.dataset.filter; refilter(); $("mList").scrollTop = 0; renderList(); });
    segGroup("[data-tf]", function (b) { S.tf = b.dataset.tf; renderChart(); });
    segGroup("[data-feed]", function (b) {
      S.feed = b.dataset.feed;
      $("feedNews").hidden = S.feed !== "news"; $("feedTrades").hidden = S.feed !== "trades"; $("feedSectors").hidden = S.feed !== "sectors";
      renderFeeds();
    });
    document.querySelectorAll(".mobile-tabs button").forEach(function (b) { b.addEventListener("click", function () { showPanel(b.dataset.panel); }); });

    // new run dialog
    var mult = 1;
    function popText() {
      $("popOut").textContent = (20 * mult).toLocaleString();
      $("popHint").textContent = "Gen 1: " + 20 * mult + " bots. Gen 2: pairs breed one child each, " + 10 * mult +
        " bots. Gen 3 on: pairs have twins, back to " + 20 * mult + (mult >= 16 ? ". Large boxes run slower." : ".");
      $("popHalf").disabled = mult <= 1;
    }
    $("btnNew").addEventListener("click", function () {
      S.running = false; setPlay();
      mult = S.cfg.mult; popText();
      $("inGens").value = S.cfg.generations || 6; $("inForever").checked = !!S.cfg.forever; $("inGens").disabled = !!S.cfg.forever;
      $("inBudget").value = String(S.cfg.detailBudget || 8000000); $("inDays").value = S.cfg.daysPerGen; $("inCash").value = S.cfg.startCash || 100000; $("inSeed").value = S.cfg.seed; $("inFit").value = S.cfg.fitness;
      $("inMut").value = String(S.cfg.mutation || 1); loadBreeding(S.cfg);
      $("inSamples").value = String(S.cfg.samplesPerDay !== undefined ? S.cfg.samplesPerDay : 150);
      $("inSymbols").value = String(S.cfg.maxSymbols || 0); $("inBackground").checked = S.background;
      $("newErr").hidden = true;
      $("dlgNew").showModal();
    });
    $("popDouble").addEventListener("click", function () { if (mult < 512) mult *= 2; popText(); });
    $("popHalf").addEventListener("click", function () { if (mult > 1) mult /= 2; popText(); });
    $("btnCancelNew").addEventListener("click", function () { $("dlgNew").close(); });
    $("inForever").addEventListener("change", function () { $("inGens").disabled = this.checked; });
    wireBreeding();
    $("formNew").addEventListener("submit", function (e) {
      var forever = $("inForever").checked;
      var g = forever ? 0 : +$("inGens").value, d = +$("inDays").value, s = +$("inSeed").value, cash = +$("inCash").value, err = $("newErr");
      var bad = !forever && !(g >= 2 && g <= 100000) ? "Generations must be between 2 and 100,000, or tick Run forever." : !(d >= 1 && d <= 120) ? "Days per generation must be between 1 and 120." :
        !(s >= 1) ? "Seed must be a positive whole number." : !(cash >= 100 && cash <= 1e12) ? "Starting cash must be between $100 and $1,000,000,000,000." : "";
      var br = readBreeding();
      if (!bad && br.error) bad = br.error;
      if (bad) { e.preventDefault(); err.textContent = bad; err.hidden = false; return; }
      S.background = $("inBackground").checked; store("tb-background", S.background ? "on" : "off");
      build({ mult: mult, generations: Math.round(g), forever: forever, daysPerGen: Math.round(d), seed: Math.round(s), fitness: $("inFit").value,
        maxSymbols: +$("inSymbols").value, detailBudget: +$("inBudget").value, startCash: Math.round(cash * 100) / 100, mutation: +$("inMut").value, samplesPerDay: +$("inSamples").value, breeding: br.breeding, breedPool: br.breedPool,
        breedPairing: br.breedPairing, brackets: br.brackets, levels: br.levels, threshold: br.threshold, threshold2: br.threshold2, pct: br.pct, allowed: br.allowed });
    });
    $("btnCloseBot").addEventListener("click", function () { $("dlgBot").close(); });
    $("btnCloseReport").addEventListener("click", function () { $("dlgReport").close(); });
    $("btnXlsx").addEventListener("click", function () {
      if (needX()) busy(this, function () { saveBook(T.Report.master(S.sim, window.XLSX), runName() + "-all-generations.xlsx"); });
    });
    $("btnTrainZip").addEventListener("click", function () {
      if (needX()) busy(this, function () { download(runName() + "-training.zip", new Blob([T.Report.trainingZip(S.sim, window.XLSX)], { type: "application/zip" })); });
    });
    $("btnGenZip").addEventListener("click", function () {
      if (needX()) busy(this, function () { download(runName() + "-generations.zip", new Blob([T.Report.generationsZip(S.sim, window.XLSX)], { type: "application/zip" })); });
    });
    $("btnBotZip").addEventListener("click", function () {
      if (needX()) busy(this, function () { download(runName() + "-bots.zip", new Blob([T.Report.botsZip(S.sim, window.XLSX)], { type: "application/zip" })); });
    });
    $("btnBotBook").addEventListener("click", function () {
      if (needX()) busy(this, function () { saveBook(T.Report.perBotWorkbook(S.sim, window.XLSX), runName() + "-bot-ledgers.xlsx"); });
    });
    $("btnOneBot").addEventListener("click", function () { var n = $("botSel").value; if (n) busy(this, function () { downloadBot(n); }); });
    $("btnCombine").addEventListener("click", function () {
      var files = Array.prototype.slice.call($("combineFiles").files), err = $("combineErr"), btn = this;
      err.hidden = true;
      if (!files.length) { err.textContent = "Choose one or more .csv or .zip files first."; err.hidden = false; return; }
      if (!needX()) return;
      btn.disabled = true; btn.textContent = "Combining…";
      Promise.all(files.map(function (f) {
        return /\.zip$/i.test(f.name) ? f.arrayBuffer().then(function (b) { var fs = T.Report.unzip(window.XLSX, new Uint8Array(b)), gens = fs.filter(function (x) { return /gen-\d+\//.test(x.name); });
          return gens.length ? gens : fs; })
          : f.text().then(function (t) { return [{ name: f.name, text: t }]; });
      })).then(function (lists) {
        var all = [].concat.apply([], lists);
        if (!all.length) throw new Error("No CSV files found in that selection.");
        var res = T.Report.combine(all, window.XLSX);
        saveBook(res.workbook, "trade-box-combined.xlsx");
        setStatus("Combined " + all.length + " CSV files into " + res.sheets + " sheets (" + res.rows.toLocaleString() + " rows).");
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; })
        .then(function () { btn.disabled = false; btn.textContent = "Combine and download .xlsx"; });
    });
    $("btnData").addEventListener("click", function () { showReport(S.sim.report()); });
    $("btnFinish").addEventListener("click", function () { if (!S.sim.done) $("dlgFinish").showModal(); });
    $("btnCancelFinish").addEventListener("click", function () { $("dlgFinish").close(); });
    $("btnStopAfter").addEventListener("click", function () {
      S.sim.stop(); $("dlgFinish").close();
      setStatus("The run will finish when generation " + S.sim.gen + " ends.");
      if (!S.running) { S.running = true; S.lastT = 0; setPlay(); }
    });
    $("btnEndNow").addEventListener("click", function () {
      $("dlgFinish").close(); S.running = false; S.sim.endNow(); setPlay();
    });
    $("btnCsv").addEventListener("click", function () {
      var name = $("csvSel").value, sh = T.Report.sheets(S.sim).filter(function (s) { return s[0] === name; })[0];
      if (sh) download(runName() + "-" + name.toLowerCase().replace(/ /g, "-") + ".csv", new Blob([T.Report.toCSV(sh[1])], { type: "text/csv" }));
    });
    window.addEventListener("resize", function () { renderAll(true); });
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); if ($("dlgPalette").open) $("dlgPalette").close(); else openPalette(""); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "Enter")) { e.preventDefault(); $("btnPlay").click(); return; }
      var tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable || document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.body.classList.contains("final-mode")) return;
      var k = e.key, hit = true;
      if (k === " ") $("btnPlay").click();
      else if (k === "n" || k === "N") $("btnNew").click();
      else if (k === "f" || k === "F") $("btnFinish").click();
      else if (k === "d" || k === "D") $("btnData").click();
      else if (k === "b" || k === "B") $("btnDataBot").click();
      else if (k === "m" || k === "M") $("modeSwitch").click();
      else if (k === "t" || k === "T") $("btnTheme").click();
      else if (k === "c" || k === "C") setChartType(chart.type === "candle" ? "line" : chart.type === "line" ? "area" : "candle");
      else if (k === "i" || k === "I") select(-1);
      else if (k === "/") $("search").focus();
      else if (k === "?") openPalette("");
      else if (k === "+" || k === "=") chart.zoomBy(0.8, null);
      else if (k === "-" || k === "_") chart.zoomBy(1.25, null);
      else if (k === "0") chart.reset();
      else if (k === "ArrowLeft") chart.panBy(e.shiftKey ? 40 : 8);
      else if (k === "ArrowRight") chart.panBy(e.shiftKey ? -40 : -8);
      else if (k === "ArrowDown" || k === "ArrowUp") {
        var at = S.filtered.indexOf(S.sel), nx = Math.max(0, Math.min(S.filtered.length - 1, at + (k === "ArrowDown" ? 1 : -1)));
        if (S.filtered.length) { select(S.filtered[nx]); var box = $("mList"); if (nx * ROW < box.scrollTop || nx * ROW > box.scrollTop + box.clientHeight - ROW) box.scrollTop = nx * ROW - box.clientHeight / 2; }
      }
      else if (k >= "1" && k <= "5") setSpeed(+k - 1);
      else hit = false;
      if (hit) e.preventDefault();
    });
  }

  function applyTheme() {
    var pick = store("tb-theme"), sysLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    var t = pick === "light" || pick === "dark" ? pick : sysLight ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    var meta = document.querySelector('meta[name="theme-color"]:not([media])'); if (meta) meta.setAttribute("content", t === "light" ? "#ffffff" : "#161b21");
    if (S.sim) renderAll(true);
  }
  applyTheme();
  wire();
  showPanel("pChart");
  build(S.cfg);
  requestAnimationFrame(frame);
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) navigator.serviceWorker.register("sw.js").catch(function () {});
  T.app = S;
  // shared with final training mode (js/final-ui.js)
  T.ui = {
    download: download, setStatus: setStatus, table: table, el: el, clear: clear, pct: pct, money: money, signedMoney: signed$, cls: cls,
    pauseSim: function () { S.running = false; setPlay(); },
    bestBot: function () {
      var sim = S.sim; if (!sim || !sim.log.generations.length) return null;
      var g = sim.log.generations[sim.log.generations.length - 1], top = sim.log.bots.filter(function (r) { return r.gen === g.gen && r.rank === 1; })[0];
      var b = top && sim.allBots[top.id];
      return b ? { name: b.name, gen: g.gen, stopLoss: b.cfg.stopLoss, takeProfit: b.cfg.takeProfit, maxPos: b.cfg.maxPos, ret: top.returnPct } : null;
    },
    redraw: function () { renderAll(true); }
  };
})(window.T = window.T || {});
