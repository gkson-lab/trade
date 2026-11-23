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
    tradeSeen: {}, cfg: { mult: 1, generations: 6, daysPerGen: 10, seed: 20270104, fitness: "return", detailBudget: 1500000, startCash: 100000 }, dirtyBots: true
  };

  var chart = new T.CandleChart($("mainChart"));

  /* ---------- setup ---------- */
  function build(cfg) {
    S.running = false; setPlay();
    S.sim = new T.Sim(cfg);
    S.cfg = cfg;
    S.newsSeen = 0; S.tradeSeen = {}; S.dirtyBots = true; S.heldCount = null;
    clear($("feedNews")); clear($("feedTrades"));
    S.sim.on(onSimEvent);
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
  function frame(t) {
    requestAnimationFrame(frame);
    if (!S.sim) return;
    var dt = S.lastT ? Math.min(0.25, (t - S.lastT) / 1000) : 0;
    S.lastT = t;
    if (S.running && !S.sim.done) {
      var t0 = performance.now();
      if (S.speed === 0) {
        while (performance.now() - t0 < 28 && !S.sim.done) S.sim.step();
      } else {
        S.acc += dt * S.speed;
        while (S.acc >= 1 && !S.sim.done && performance.now() - t0 < 40) { S.sim.step(); S.acc -= 1; }
        if (S.acc > 3) S.acc = 0;
      }
      renderAll(false);
    }
  }

  function renderAll(force) {
    var now = performance.now();
    renderTop();
    renderChart();
    if (force || now - S.lastList > 350) {
      S.lastList = now;
      if (S.filter === "gain" || S.filter === "lose" || S.filter === "held") refilter();
      renderList();
      renderBots();
      renderFeeds();
    }
    if (force || now - S.lastMinis > 2500) { S.lastMinis = now; pickMinis(); }
    renderMinis();
  }

  /* ---------- top bar ---------- */
  function renderTop() {
    var m = S.sim.market, ch = m.indexChangePct();
    $("idxVal").textContent = T.fmtPrice(m.index);
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
  function renderChart() {
    var m = S.sim.market, i = S.sel, d = m.candles(i, S.tf, S.tf === "5m" ? m.INTRA : m.DAILY);
    if (S.tf === "5m" && d.c.length < 2) d = m.candles(i, "1D", m.DAILY);
    chart.set(d, tfLabel);
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
      row._p.textContent = T.fmtPrice(m.price[i]);
      var ch = m.changePct(i); row._c.textContent = pct(ch); row._c.className = "c num " + cls(ch);
      row.classList.toggle("sel", i === S.sel);
      row.setAttribute("aria-selected", i === S.sel ? "true" : "false");
    }
  }

  function select(i) {
    S.sel = i;
    renderChart(); renderList(); renderMinis();
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
      clear(list); botRows = {};
      bots.forEach(function (b) {
        var li = el("li"), btn = el("button", "bot-row"); btn.type = "button";
        var left = el("span", "lft"), nm = el("span", "nm"), rk = el("span", "rank num"), nmT = el("span"), st = el("span", "st");
        nm.appendChild(rk); nm.appendChild(nmT); left.appendChild(nm); left.appendChild(st);
        var cv = el("canvas"); cv.setAttribute("aria-hidden", "true");
        var pl = el("span", "pl num"), plA = el("span"), plP = el("small");
        pl.appendChild(plA); pl.appendChild(plP);
        btn.appendChild(left); btn.appendChild(cv); btn.appendChild(pl);
        btn.addEventListener("click", function () { showBot(b); });
        li.appendChild(btn);
        botRows[b.id] = { li: li, btn: btn, rk: rk, nm: nmT, st: st, cv: cv, plA: plA, plP: plP, pl: pl };
        list.appendChild(li);
      });
      S.dirtyBots = false;
    }
    var start = sim.cfg.startCash, up = 0, sum = 0;
    bots.forEach(function (b, k) {
      var r = botRows[b.id]; if (!r) return;
      list.appendChild(r.li);
      var pnl = b.equity - start, ret = pnl / start;
      sum += pnl; if (pnl > 0) up++;
      r.rk.textContent = k + 1; r.nm.textContent = b.name;
      r.st.textContent = b.style + " · " + b.nPos + " pos" + (b.age ? " · survived " + b.age : "");
      r.btn.classList.toggle("new", b.gen === sim.gen && sim.gen > 1 && b.age === 0);
      r.plA.textContent = signed$(pnl); r.plP.textContent = pct(ret);
      r.pl.className = "pl num " + cls(pnl);
      r.btn.setAttribute("aria-label", b.name + ", P/L " + signed$(pnl) + " (" + pct(ret) + ")");
      T.sparkline(r.cv, b.intraCurve.concat([b.equity]), start);
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
    var c = b.cfg;
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
  }
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
      document.documentElement.dataset.theme = t; store("tb-theme", t); renderAll(true);
    });
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
      $("inBudget").value = String(S.cfg.detailBudget || 1500000); $("inDays").value = S.cfg.daysPerGen; $("inCash").value = S.cfg.startCash || 100000; $("inSeed").value = S.cfg.seed; $("inFit").value = S.cfg.fitness;
      $("newErr").hidden = true;
      $("dlgNew").showModal();
    });
    $("popDouble").addEventListener("click", function () { if (mult < 512) mult *= 2; popText(); });
    $("popHalf").addEventListener("click", function () { if (mult > 1) mult /= 2; popText(); });
    $("btnCancelNew").addEventListener("click", function () { $("dlgNew").close(); });
    $("inForever").addEventListener("change", function () { $("inGens").disabled = this.checked; });
    $("formNew").addEventListener("submit", function (e) {
      var forever = $("inForever").checked;
      var g = forever ? 0 : +$("inGens").value, d = +$("inDays").value, s = +$("inSeed").value, cash = +$("inCash").value, err = $("newErr");
      var bad = !forever && !(g >= 2 && g <= 100000) ? "Generations must be between 2 and 100,000, or tick Run forever." : !(d >= 1 && d <= 120) ? "Days per generation must be between 1 and 120." :
        !(s >= 1) ? "Seed must be a positive whole number." : !(cash >= 100 && cash <= 1e12) ? "Starting cash must be between $100 and $1,000,000,000,000." : "";
      if (bad) { e.preventDefault(); err.textContent = bad; err.hidden = false; return; }
      build({ mult: mult, generations: Math.round(g), forever: forever, daysPerGen: Math.round(d), seed: Math.round(s), fitness: $("inFit").value,
        detailBudget: +$("inBudget").value, startCash: Math.round(cash * 100) / 100 });
    });
    $("btnCloseBot").addEventListener("click", function () { $("dlgBot").close(); });
    $("btnCloseReport").addEventListener("click", function () { $("dlgReport").close(); });
    $("btnXlsx").addEventListener("click", function () {
      if (needX()) busy(this, function () { saveBook(T.Report.master(S.sim, window.XLSX), runName() + "-all-generations.xlsx"); });
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
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || document.querySelector("dialog[open]")) return;
      if (e.key === " ") { e.preventDefault(); $("btnPlay").click(); }
    });
  }

  var theme = store("tb-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  wire();
  showPanel("pChart");
  build(S.cfg);
  requestAnimationFrame(frame);
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) navigator.serviceWorker.register("sw.js").catch(function () {});
  T.app = S;
})(window.T = window.T || {});
