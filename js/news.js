/* News wire: scheduled macro releases, earnings, sector stories and company events.
 * Every item carries a signed impact that the market engine absorbs over the next bars. */
(function (T) {
  "use strict";

  var BROKERS = ["Halvorsen & Pike", "Northgate Capital", "Brightwater Securities", "Calder Research",
    "Ironbridge Partners", "Meridian Equity", "Westlake Analytics", "Sable Rock Markets"];
  var QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

  var COMPANY_EVENTS = [
    // [weight, kind, sentimentSign or 0 for random, impact sigma multiple, template fn]
    [10, "analyst", 0, 1.2, function (c, g, r) {
      var up = g > 0, b = r.pick(BROKERS), pt = c.price * (1 + g * r.range(0.15, 0.4));
      return b + (up ? " upgrades " : " downgrades ") + c.sym + " to " + (up ? r.pick(["Buy", "Outperform", "Overweight"]) : r.pick(["Sell", "Underperform", "Underweight"])) +
        ", PT $" + fmt(pt);
    }],
    [5, "guidance", 0, 2.4, function (c, g) {
      return c.name + " " + (g > 0 ? "raises" : "cuts") + " full-year outlook; sees revenue " + (g > 0 ? "above" : "below") + " consensus";
    }],
    [3, "contract", 1, 1.8, function (c, g, r) {
      return c.name + " wins $" + fmt(c.mcap * r.range(0.005, 0.04) / 1000, 1) + "B multi-year " + r.pick(["federal", "enterprise", "supply", "licensing", "cloud"]) + " contract";
    }],
    [2, "lawsuit", -1, 1.6, function (c, g, r) {
      return c.name + " hit with " + r.pick(["class-action suit", "DOJ antitrust probe", "SEC inquiry", "patent infringement ruling"]) + "; shares slide";
    }],
    [2, "exec", 0, 1.3, function (c, g, r) {
      return g > 0 ? c.name + " names " + r.pick(["new CEO", "industry veteran as CFO", "activist-backed board slate"]) + "; investors cheer"
                   : c.name + " CEO steps down " + r.pick(["unexpectedly", "amid board dispute", "effective immediately"]);
    }],
    [1.2, "mna_target", 1, 6.0, function (c, g, r) {
      return "REPORT: " + c.name + " (" + c.sym + ") exploring sale, attracts takeover interest at " + r.int(22, 45) + "% premium";
    }],
    [1.5, "buyback", 1, 1.1, function (c, g, r) {
      return c.name + " authorizes $" + fmt(c.mcap * r.range(0.02, 0.08) / 1000, 1) + "B share repurchase";
    }],
    [1.2, "offering", -1, 1.6, function (c, g, r) {
      return c.name + " prices " + fmt(r.range(5, 25), 0) + "M-share secondary offering below market";
    }],
    [1.0, "recall", -1, 1.7, function (c, g, r) {
      return c.name + " " + r.pick(["issues product recall", "reports data breach affecting customers", "halts production line after fire"]);
    }],
    [0.8, "short_report", -1, 2.8, function (c) {
      return "Short seller publishes report alleging accounting irregularities at " + c.name;
    }],
    [2.0, "product", 0, 1.2, function (c, g, r) {
      return g > 0 ? c.name + " unveils " + r.pick(["next-gen platform", "flagship product refresh", "AI-driven service line"]) + " to strong early reviews"
                   : c.name + " delays " + r.pick(["key product launch", "flagship release", "platform rollout"]) + " to next year";
    }]
  ];
  var HEALTH_EVENTS = [
    [3, "fda", 0, 4.5, function (c, g, r) {
      return g > 0 ? "FDA approves " + c.name + " " + r.pick(["oncology drug", "gene therapy", "cardiac device", "obesity treatment"])
                   : "FDA issues complete response letter to " + c.name + "; " + r.pick(["approval delayed", "trial data questioned"]);
    }],
    [2, "trial", 0, 3.8, function (c, g, r) {
      return c.name + " Phase " + r.pick(["2", "3"]) + " trial " + (g > 0 ? "meets primary endpoint" : "fails primary endpoint");
    }]
  ];

  var SECTOR_STORIES = {
    "Technology": ["chip export rules", "AI capex guidance", "cloud spending survey", "semiconductor lead times"],
    "Health Care": ["drug pricing bill", "Medicare reimbursement update", "biotech funding data"],
    "Finance": ["bank stress test results", "yield curve moves", "credit card delinquency data", "deposit flow data"],
    "Consumer Discretionary": ["holiday sales tracker", "auto sales data", "consumer confidence reading"],
    "Consumer Staples": ["input cost trends", "grocery inflation data", "retail inventory levels"],
    "Industrials": ["ISM manufacturing new orders", "freight volumes", "infrastructure bill progress"],
    "Energy": ["OPEC+ output decision", "crude inventory report", "natural gas storage data"],
    "Utilities": ["power demand forecast", "rate case decisions", "treasury yield swing"],
    "Real Estate": ["mortgage application data", "office vacancy report", "housing starts"],
    "Basic Materials": ["copper price swing", "China PMI data", "steel tariff headlines"],
    "Telecommunications": ["spectrum auction results", "subscriber growth data"],
    "Miscellaneous": ["IPO calendar activity", "small-cap fund flows"]
  };

  function fmt(x, d) {
    if (d === undefined) d = x >= 100 ? 0 : 2;
    return Number(x).toFixed(d);
  }

  function News(rng, market) {
    this.rng = rng;
    this.m = market;
    this.id = 0;
    this.macro = { fed: 4.50, cpi: 3.1, unemp: 4.1, gdp: 2.2 };
    this.weights = COMPANY_EVENTS.reduce(function (a, e) { return a + e[0]; }, 0);
    this.hweights = HEALTH_EVENTS.reduce(function (a, e) { return a + e[0]; }, 0);
  }

  News.prototype.item = function (scope, target, kind, headline, impact, extra) {
    var it = {
      id: ++this.id, day: this.m.day, bar: this.m.bar, scope: scope, target: target, kind: kind,
      headline: headline, impact: impact, sentiment: Math.max(-1, Math.min(1, impact * 12)),
      sym: scope === "stock" ? this.m.sym[target] : null
    };
    if (extra) for (var k in extra) it[k] = extra[k];
    return it;
  };

  function pickWeighted(r, list, total) {
    var x = r.next() * total;
    for (var i = 0; i < list.length; i++) { x -= list[i][0]; if (x <= 0) return list[i]; }
    return list[list.length - 1];
  }

  News.prototype.companyInfo = function (i) {
    var m = this.m;
    return { sym: m.sym[i], name: m.name[i], price: m.price[i], mcap: m.mcap0[i] * m.price[i] / m.price0[i] };
  };

  /* Called once per bar. Returns a list of new news items. */
  News.prototype.tick = function () {
    var m = this.m, r = this.rng, out = [], bar = m.bar, BPD = m.BARS_PER_DAY;

    // Scheduled macro releases (8:30am ET = pre-open, they hit at bar 0; FOMC at 2pm = bar 54)
    if (bar === 0) {
      var dom = m.dayOfMonth, dow = m.dayOfWeek;
      if (dow === 5 && dom <= 7) out.push(this.jobs());
      if (dom >= 10 && dom <= 14 && dow === 3) out.push(this.cpi());
      if (m.day % 63 === 20) out.push(this.gdp());
    }
    if (bar === 54 && m.day % 32 === 31) out.push(this.fomc());

    // Earnings: each stock reports once per 63-day quarter at its own offset; pre-open or after-close
    if (bar === 0 || bar === BPD - 1) {
      var q = m.day % 63, slot = bar === 0 ? 0 : 1;
      var list = m.earningsByOffset[q];
      if (list) for (var k = 0; k < list.length; k++) {
        var i = list[k];
        if ((i & 1) === slot && r.chance(0.55)) out.push(this.earnings(i));
      }
    }

    // Unscheduled company news (~0.0025 per stock per day), weighted toward large caps
    var lam = m.n * 0.0025 / BPD;
    var cnt = r.poisson(lam);
    for (var c = 0; c < cnt; c++) out.push(this.companyEvent(m.randomStock(r)));

    // Sector stories (~1.2 per day)
    if (r.chance(1.2 / BPD)) out.push(this.sectorStory(r.int(0, T.SECTORS.length - 1)));

    // Unscheduled macro shocks (~1 per 20 days), larger during fragile regimes
    var fragile = m.regime === 2 || m.regime === 3 ? 2.5 : 1;
    if (r.chance(fragile / 20 / BPD)) out.push(this.macroShock());

    return out;
  };

  News.prototype.earnings = function (i) {
    var r = this.rng, c = this.companyInfo(i), m = this.m;
    var surprise = Math.max(-3, Math.min(3, r.studentT(5) * 0.7 + m.earningsBias[i]));
    var q4 = m.eps[i] / 4;                                   // consensus anchors on trailing EPS with some growth
    var estEps = q4 * (1 + 0.02 * r.normal()) + Math.abs(q4) * 0.02;
    if (Math.abs(estEps) < 0.01) estEps = estEps < 0 ? -0.01 : 0.01;
    var eps = estEps + Math.abs(estEps) * surprise * 0.12;
    m.eps[i] = m.eps[i] - q4 + eps;                          // roll trailing-twelve-month EPS
    var rev = c.mcap / r.range(3, 9) / 4;
    var dailyVol = m.idioVol[i] / Math.sqrt(252);
    var impact = (surprise * 1.4 + r.normal() * 0.6) * dailyVol * 2.0;
    var qtr = QUARTERS[Math.floor(m.day / 63) % 4];
    var money = function (x) { return (x < 0 ? "-$" : "$") + fmt(Math.abs(x), 2); };
    var verdict = surprise > 0.3 ? " beats: " : surprise < -0.3 ? " misses: " : " in line: ";
    var h = c.name + " (" + c.sym + ") " + qtr + verdict + "EPS " + money(eps) + " vs " + money(estEps) + " est; revenue $" +
      (rev >= 1000 ? fmt(rev / 1000, 2) + "B" : rev >= 10 ? fmt(rev, 0) + "M" : fmt(rev, 1) + "M") +
      (surprise > 1 ? ", raises guidance" : surprise < -1 ? ", cuts guidance" : "");
    return this.item("stock", i, "earnings", h, impact, { drift: impact * 0.02, vol: 2.5, epsActual: +eps.toFixed(4), epsEstimate: +estEps.toFixed(4), surprisePct: +(surprise * 12).toFixed(2) });
  };

  News.prototype.companyEvent = function (i) {
    var r = this.rng, m = this.m, c = this.companyInfo(i);
    var bio = T.SECTORS[m.sector[i]] === "Health Care" && r.chance(0.45);
    var e = bio ? pickWeighted(r, HEALTH_EVENTS, this.hweights) : pickWeighted(r, COMPANY_EVENTS, this.weights);
    var g = e[2] !== 0 ? e[2] : (r.chance(0.52) ? 1 : -1);
    var dailyVol = m.idioVol[i] / Math.sqrt(252);
    var impact = g * Math.abs(r.normal() * 0.5 + 1) * e[3] * dailyVol;
    return this.item("stock", i, e[1], e[4](c, g, r), impact, { drift: impact * 0.015, vol: 1 + e[3] * 0.4 });
  };

  News.prototype.sectorStory = function (s) {
    var r = this.rng, name = T.SECTORS[s], g = r.chance(0.5) ? 1 : -1;
    var topic = r.pick(SECTOR_STORIES[name]);
    var impact = g * r.range(0.004, 0.018);
    var h = name + " stocks " + (g > 0 ? r.pick(["rally", "climb", "bid higher"]) : r.pick(["slide", "fall", "under pressure"])) + " on " + topic;
    return this.item("sector", s, "sector", h, impact, { drift: impact * 0.01, vol: 1.4 });
  };

  News.prototype.macroShock = function () {
    var r = this.rng, g = r.chance(0.45) ? 1 : -1;
    var neg = ["Treasury yields spike as bond auction tails badly", "Major regional bank fails; regulators step in",
      "Geopolitical flare-up sends oil sharply higher", "Credit spreads blow out on default fears",
      "Government shutdown looms as talks collapse"];
    var pos = ["Fed chair signals openness to rate cuts", "Trade deal reached, tariffs rolled back",
      "Stimulus package passes Congress", "Inflation expectations fall to two-year low"];
    var impact = g * r.range(0.008, 0.03);
    return this.item("market", -1, "macro", (g > 0 ? r.pick(pos) : r.pick(neg)), impact,
      { drift: impact * 0.01, vol: 1.8, regimePush: g });
  };

  News.prototype.jobs = function () {
    var r = this.rng, mac = this.macro;
    var est = Math.round(r.range(90, 230)), act = Math.round(est + r.normal() * 70);
    mac.unemp = Math.max(3.2, Math.min(9, mac.unemp + (act < est ? 0.1 : -0.05) * r.range(0.5, 1.5)));
    var s = (act - est) / 100;
    var impact = s * 0.006 * (mac.cpi > 3.5 ? -0.6 : 1);
    return this.item("market", -1, "macro", "Nonfarm payrolls +" + act + "K vs +" + est + "K est; unemployment " + fmt(mac.unemp, 1) + "%",
      impact, { drift: impact * 0.01, vol: 1.5 });
  };

  News.prototype.cpi = function () {
    var r = this.rng, mac = this.macro;
    var est = mac.cpi, act = Math.max(0.5, est + r.normal() * 0.25);
    mac.cpi = act;
    var impact = -(act - est) * 0.03;
    return this.item("market", -1, "macro", "CPI " + fmt(act, 1) + "% y/y vs " + fmt(est, 1) + "% est" +
      (act > est + 0.1 ? "; hot print rattles rate-cut hopes" : act < est - 0.1 ? "; cooler print lifts bonds" : ""),
      impact, { drift: impact * 0.01, vol: 1.6, regimePush: impact > 0.004 ? 1 : impact < -0.004 ? -1 : 0 });
  };

  News.prototype.gdp = function () {
    var r = this.rng, mac = this.macro;
    var est = mac.gdp, act = est + r.normal() * 0.8;
    mac.gdp = act;
    var impact = (act - est) * 0.005;
    return this.item("market", -1, "macro", "Q GDP advance estimate " + fmt(act, 1) + "% annualized vs " + fmt(est, 1) + "% est",
      impact, { drift: impact * 0.01, vol: 1.3 });
  };

  News.prototype.fomc = function () {
    var r = this.rng, mac = this.macro, move = 0;
    if (mac.cpi > 3.6) move = 0.25;
    else if (mac.cpi < 2.6 || mac.unemp > 5.2) move = -0.25;
    if (r.chance(0.25)) move = 0;
    var surprise = r.normal() * 0.6;
    mac.fed = Math.max(0.25, mac.fed + move);
    var verb = move > 0 ? "raises rates 25bp" : move < 0 ? "cuts rates 25bp" : "holds rates steady";
    var tone = surprise > 0.4 ? "; dovish dot plot" : surprise < -0.4 ? "; hawkish projections surprise markets" : "";
    var impact = (-move * 0.02) + surprise * 0.008;
    return this.item("market", -1, "fomc", "FOMC " + verb + " at " + fmt(mac.fed - 0.25, 2) + "-" + fmt(mac.fed, 2) + "%" + tone,
      impact, { drift: impact * 0.01, vol: 2.0, regimePush: impact > 0.006 ? 1 : impact < -0.006 ? -1 : 0 });
  };

  T.News = News;
})(window.T = window.T || {});
