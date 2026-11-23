/* Breeding rules, built from three choices:
 *   pool     who is allowed to breed (winners, losers, profitable, above a return, chosen brackets, ...)
 *   pairing  how the pool pairs up (similar rank, opposite rank, same bracket, next bracket down, ...)
 *   brackets how the generation is cut into brackets (quartiles, thirds, ... or profit levels you set)
 * Presets are named combinations; changing any part makes it "custom".
 * The population schedule never changes (20 -> 10 -> 20 ...): if a pool is smaller than the number of
 * parents needed, its bots parent more than one pair; if fewer than 2 qualify, the next bots in line fill in. */
(function (T) {
  "use strict";

  var POOLS = [
    { key: "breeders", name: "The usual breeders", desc: "Gen 1: everyone. Gen 2: all of them. Gen 3 on: the surviving top half." },
    { key: "all", name: "Everyone", desc: "Every bot in the generation can breed." },
    { key: "winners", name: "Winners (top half)", desc: "Only the top half of the rankings breeds." },
    { key: "losers", name: "Losers (bottom half)", desc: "Only the bottom half of the rankings breeds." },
    { key: "split", name: "Winners and losers, kept apart", desc: "Half the pairs come from the top half, half from the bottom half; the halves never mix." },
    { key: "profitable", name: "Profitable bots", desc: "Only bots that made money this generation." },
    { key: "unprofitable", name: "Unprofitable bots", desc: "Only bots that lost money this generation." },
    { key: "beatIndex", name: "Beat the SIM 500", desc: "Only bots whose return beat the index over the same days." },
    { key: "lostToIndex", name: "Lost to the SIM 500", desc: "Only bots that trailed the index." },
    { key: "above", name: "Return at or above a level", desc: "Only bots at or above the return you set." },
    { key: "below", name: "Return below a level", desc: "Only bots below the return you set." },
    { key: "between", name: "Return between two levels", desc: "Only bots inside the return range you set." },
    { key: "topPct", name: "Top X%", desc: "Only the best X% of the rankings." },
    { key: "bottomPct", name: "Bottom X%", desc: "Only the worst X% of the rankings." },
    { key: "brackets", name: "Chosen brackets", desc: "Only the brackets you tick." }
  ];
  var PAIRINGS = [
    { key: "similar", name: "Similar rank", desc: "Best with next best: 1st + 2nd, 3rd + 4th ..." },
    { key: "opposite", name: "Opposite rank", desc: "Best with worst: 1st + last, 2nd + second-to-last ..." },
    { key: "random", name: "Random", desc: "Partners drawn at random." },
    { key: "closestProfit", name: "Closest profit", desc: "Each bot with the one whose return is nearest its own." },
    { key: "sameBracket", name: "Same bracket only", desc: "Partners always come from the same bracket." },
    { key: "crossBracket", name: "Next bracket down", desc: "Each bracket pairs with the bracket just below it." },
    { key: "mirrorBracket", name: "Mirror brackets", desc: "Top bracket with bottom bracket, 2nd with second-to-last ..." },
    { key: "tournament", name: "Tournament", desc: "Each parent is the best of 3 drawn at random." },
    { key: "roulette", name: "Rank roulette", desc: "Better ranks are drawn more often." },
    { key: "outbreed", name: "Least related", desc: "Each bot picks the partner it shares the least ancestry with." },
    { key: "inbreed", name: "Most related", desc: "Each bot picks its closest relative, preferring its own house." }
  ];
  var BRACKETS = [
    { key: "halves", name: "Halves", n: 2 }, { key: "thirds", name: "Thirds", n: 3 }, { key: "quartiles", name: "Quartiles", n: 4 },
    { key: "quintiles", name: "Fifths", n: 5 }, { key: "deciles", name: "Tenths", n: 10 }, { key: "profit", name: "Profit levels (set your own)" }
  ];
  var PRESETS = [
    { key: "ranked", name: "Ranked neighbours", pool: "breeders", pairing: "similar" },
    { key: "winners", name: "Winners with winners", pool: "winners", pairing: "similar" },
    { key: "losers", name: "Losers with losers", pool: "losers", pairing: "similar" },
    { key: "assortative", name: "Winners with winners and losers with losers", pool: "split", pairing: "similar" },
    { key: "disassortative", name: "Winners with losers", pool: "all", pairing: "opposite" },
    { key: "profitable", name: "Only profitable bots", pool: "profitable", pairing: "similar" },
    { key: "unprofitable", name: "Only losing bots", pool: "unprofitable", pairing: "similar" },
    { key: "beatIndex", name: "Only bots that beat the SIM 500", pool: "beatIndex", pairing: "similar" },
    { key: "above", name: "Only bots above a return you set", pool: "above", pairing: "similar", threshold: 1 },
    { key: "between", name: "Only bots in a return range you set", pool: "between", pairing: "random", threshold: -1, threshold2: 1 },
    { key: "topPct", name: "Top 25% mate at random", pool: "topPct", pairing: "random", pct: 25 },
    { key: "bottomPct", name: "Bottom 25% mate at random", pool: "bottomPct", pairing: "random", pct: 25 },
    { key: "sameBracket", name: "Within each quartile", pool: "all", pairing: "sameBracket", brackets: "quartiles" },
    { key: "crossBracket", name: "Each quartile with the one below", pool: "all", pairing: "crossBracket", brackets: "quartiles" },
    { key: "mirrorBracket", name: "Top quartile with bottom quartile", pool: "all", pairing: "mirrorBracket", brackets: "quartiles" },
    { key: "topBrackets", name: "Top two quartiles only", pool: "brackets", pairing: "similar", brackets: "quartiles", allowed: [0, 1] },
    { key: "profitLevels", name: "Within profit levels (below -2%, -2 to 0%, 0 to 2%, above 2%)", pool: "all", pairing: "sameBracket", brackets: "profit", levels: [-2, 0, 2] },
    { key: "random", name: "Random mating", pool: "breeders", pairing: "random" },
    { key: "tournament", name: "Tournament", pool: "all", pairing: "tournament" },
    { key: "roulette", name: "Rank roulette", pool: "all", pairing: "roulette" },
    { key: "outbreed", name: "Avoid relatives", pool: "breeders", pairing: "outbreed" },
    { key: "inbreed", name: "Keep it in the family", pool: "breeders", pairing: "inbreed" },
    { key: "custom", name: "Custom", pool: "breeders", pairing: "similar" }
  ];
  var LOSER_POOLS = { losers: 1, unprofitable: 1, lostToIndex: 1, below: 1, bottomPct: 1 };

  function find(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }

  /* Fill in a full settings object from a preset key plus any explicit overrides. */
  function normalize(c) {
    c = c || {};
    var p = find(PRESETS, c.breeding) || PRESETS[0];
    var s = {
      preset: p.key,
      pool: c.breedPool || p.pool, pairing: c.breedPairing || p.pairing,
      brackets: c.brackets || p.brackets || "quartiles",
      levels: (c.levels || p.levels || [-2, 0, 2]).map(Number).filter(isFinite).sort(function (a, b) { return a - b; }),
      threshold: c.threshold !== undefined && c.threshold !== "" ? +c.threshold : (p.threshold !== undefined ? p.threshold : 0),
      threshold2: c.threshold2 !== undefined && c.threshold2 !== "" ? +c.threshold2 : (p.threshold2 !== undefined ? p.threshold2 : 2),
      pct: c.pct > 0 ? Math.min(100, +c.pct) : (p.pct || 25),
      allowed: (c.allowed || p.allowed || [0]).map(Number)
    };
    if (!find(POOLS, s.pool)) throw new Error("Unknown breeding pool: " + s.pool);
    if (!find(PAIRINGS, s.pairing)) throw new Error("Unknown pairing: " + s.pairing);
    if (!find(BRACKETS, s.brackets)) throw new Error("Unknown brackets: " + s.brackets);
    if (s.threshold2 < s.threshold) { var t = s.threshold; s.threshold = s.threshold2; s.threshold2 = t; }
    if (!s.levels.length) s.levels = [0];
    return s;
  }

  function bracketCount(s) { return s.brackets === "profit" ? s.levels.length + 1 : find(BRACKETS, s.brackets).n; }

  /* Labels, best bracket first. */
  function bracketLabels(s) {
    var n = bracketCount(s), out = [], i;
    if (s.brackets === "profit") {
      var L = s.levels;
      for (i = L.length; i >= 0; i--) {
        out.push(i === L.length ? "at or above " + L[i - 1] + "%" : i === 0 ? "below " + L[0] + "%" : L[i - 1] + "% to " + L[i] + "%");
      }
      return out;
    }
    var nm = { 2: "Half", 3: "Third", 4: "Quartile", 5: "Fifth", 10: "Tenth" }[n] || "Bracket";
    for (i = 0; i < n; i++) out.push(nm + " " + (i + 1) + (i === 0 ? " (top)" : i === n - 1 ? " (bottom)" : ""));
    return out;
  }

  /* Bracket index (0 = best) for every bot in the ranked list. */
  function bracketsOf(ranked, s) {
    var N = ranked.length, n = bracketCount(s);
    return ranked.map(function (b, k) {
      if (s.brackets !== "profit") return Math.min(n - 1, Math.floor(k * n / N));
      var pct = (b.lastReturn || 0) * 100, below = 0;
      for (var j = 0; j < s.levels.length; j++) if (pct >= s.levels[j]) below++;
      return s.levels.length - below;
    });
  }

  function describe(s) {
    var pool = find(POOLS, s.pool).name, pair = find(PAIRINGS, s.pairing).name, extra = "";
    if (s.pool === "above") extra = " (" + s.threshold + "% or better)";
    else if (s.pool === "below") extra = " (below " + s.threshold + "%)";
    else if (s.pool === "between") extra = " (" + s.threshold + "% to " + s.threshold2 + "%)";
    else if (s.pool === "topPct" || s.pool === "bottomPct") pool = pool.replace("X", s.pct);
    var usesBr = s.pool === "brackets" || /Bracket$/.test(s.pairing);
    var br = usesBr ? "; brackets: " + (s.brackets === "profit" ? "profit levels " + s.levels.join(", ") + "%" : find(BRACKETS, s.brackets).name.toLowerCase()) +
      (s.pool === "brackets" ? " (" + s.allowed.map(function (i) { return bracketLabels(s)[i]; }).filter(Boolean).join(", ") + ")" : "") : "";
    var preset = find(PRESETS, s.preset);
    return (preset && preset.key !== "custom" ? preset.name + ": " : "Custom: ") + pool + extra + ", paired by " + pair.toLowerCase() + br;
  }

  /* --- pairing helpers --- */
  function chunk(order, n) {
    var out = [], L = order.length;
    if (L < 2) return out;
    // first pass 1+2, 3+4 ...; if more pairs are needed, bots parent again with the next-nearest partner
    for (var d = 1; out.length < n; d = d % (L - 1) + 1)
      for (var off = 0; off < 2 && out.length < n; off++)
        for (var i = off; i + d < L && out.length < n; i += 2) out.push([order[i], order[i + d]]);
    return out;
  }
  function interleave(order) { var o = [], i = 0, j = order.length - 1; while (i <= j) { o.push(order[i++]); if (i <= j) o.push(order[j--]); } return o; }

  function pairPool(sim, pool, n, s, br, rankOf) {
    var r = sim.rng, out = [], i, order = pool.slice().sort(function (a, b) { return rankOf(a) - rankOf(b); });
    if (order.length < 2 || n <= 0) return out;
    switch (s.pairing) {
      case "opposite": return chunk(interleave(order), n);
      case "random":
        for (i = order.length - 1; i > 0; i--) { var j = Math.floor(r.next() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
        return chunk(order, n);
      case "closestProfit":
        return chunk(order.slice().sort(function (a, b) { return (b.lastReturn || 0) - (a.lastReturn || 0); }), n);
      case "tournament":
      case "roulette": {
        var N = order.length;
        var draw = s.pairing === "tournament"
          ? function () { var best = N; for (var k = 0; k < 3; k++) best = Math.min(best, Math.floor(r.next() * N)); return order[best]; }
          : function () { var tot = N * (N + 1) / 2, x = r.next() * tot; for (var k = 0; k < N; k++) { x -= N - k; if (x <= 0) return order[k]; } return order[N - 1]; };
        for (i = 0; i < n; i++) {
          var a = draw(), b = a;
          for (var tries = 0; b === a && tries < 50; tries++) b = draw();
          if (b === a) b = order[order[0] === a ? 1 : 0];
          out.push([a, b]);
        }
        return out;
      }
      case "outbreed":
      case "inbreed": {
        while (out.length < n) {
          var left = order.slice();
          while (left.length > 1 && out.length < n) {
            var me = left.shift(), bestK = 0, bestV = s.pairing === "outbreed" ? Infinity : -Infinity;
            for (var k = 0; k < left.length; k++) {
              var v = sim.kin(me, left[k]) + (s.pairing === "inbreed" && left[k].house === me.house ? 0.01 : 0);
              if (s.pairing === "outbreed" ? v < bestV - 1e-12 : v > bestV + 1e-12) { bestV = v; bestK = k; }
            }
            out.push([me, left.splice(bestK, 1)[0]]);
          }
        }
        return out;
      }
      case "sameBracket":
      case "crossBracket":
      case "mirrorBracket": {
        var groups = {};
        order.forEach(function (b) { (groups[br.get(b)] = groups[br.get(b)] || []).push(b); });
        var G = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return groups[k]; });
        if (s.pairing === "sameBracket") {
          var usable = G.filter(function (g) { return g.length >= 2; });
          if (!usable.length) return chunk(order, n);
          var cap = usable.map(function (g) { return Math.floor(g.length / 2); }), tot = cap.reduce(function (x, y) { return x + y; }, 0);
          var want = cap.map(function (c) { return Math.floor(n * c / tot); }), given = want.reduce(function (x, y) { return x + y; }, 0);
          for (i = 0; given < n; i = (i + 1) % usable.length) { want[i]++; given++; }
          usable.forEach(function (g, gi) { out = out.concat(chunk(g, want[gi])); });
          return out;
        }
        if (G.length < 2) return chunk(order, n);
        var used = G.map(function () { return 0; });
        function next(gi) { var g = G[gi]; return g[used[gi]++ % g.length]; }
        var lanes = s.pairing === "crossBracket" ? G.length - 1 : Math.ceil(G.length / 2);
        for (i = 0; i < n; i++) {
          var lane = i % lanes, ga = lane, gb = s.pairing === "crossBracket" ? lane + 1 : G.length - 1 - lane;
          if (ga === gb) { var pr = chunk(G[ga].length >= 2 ? G[ga] : order, 1)[0]; out.push(pr); continue; }
          out.push([next(ga), next(gb)]);
        }
        return out;
      }
      default: return chunk(order, n);
    }
  }

  /* Pick nPairs parent pairs. ranked: whole generation, best first. elite: the usual breeders. */
  function select(sim, ranked, nPairs, elite) {
    var s = sim.breedSettings, N = ranked.length, rank = new Map(), br = new Map(), labels = bracketLabels(s), idxRet = sim.lastIdxRet || 0;
    ranked.forEach(function (b, k) { rank.set(b, k); });
    bracketsOf(ranked, s).forEach(function (x, k) { br.set(ranked[k], x); });
    var rankOf = function (b) { return rank.get(b); }, ret = function (b) { return (b.lastReturn || 0) * 100; };
    var half = Math.ceil(N / 2), note = "";
    function qualify(fn) { return ranked.filter(fn); }
    function topUp(pool, loserSide) {
      if (pool.length >= 2) return pool;
      var extra = (loserSide ? ranked.slice().reverse() : ranked).filter(function (b) { return pool.indexOf(b) < 0; });
      note = "fewer than 2 bots qualified; the next in line filled in";
      return pool.concat(extra.slice(0, 2 - pool.length));
    }
    var pairs;
    if (s.pool === "split") {
      var top = ranked.slice(0, half), bottom = ranked.slice(half), nTop = Math.ceil(nPairs / 2);
      pairs = pairPool(sim, top, nTop, s, br, rankOf).concat(pairPool(sim, topUp(bottom, true), nPairs - nTop, s, br, rankOf));
    } else {
      var pool;
      switch (s.pool) {
        case "all": pool = ranked.slice(); break;
        case "winners": pool = ranked.slice(0, half); break;
        case "losers": pool = ranked.slice(N - half); break;
        case "profitable": pool = qualify(function (b) { return b.lastReturn > 0; }); break;
        case "unprofitable": pool = qualify(function (b) { return !(b.lastReturn > 0); }); break;
        case "beatIndex": pool = qualify(function (b) { return b.lastReturn > idxRet; }); break;
        case "lostToIndex": pool = qualify(function (b) { return !(b.lastReturn > idxRet); }); break;
        case "above": pool = qualify(function (b) { return ret(b) >= s.threshold; }); break;
        case "below": pool = qualify(function (b) { return ret(b) < s.threshold; }); break;
        case "between": pool = qualify(function (b) { return ret(b) >= s.threshold && ret(b) <= s.threshold2; }); break;
        case "topPct": pool = ranked.slice(0, Math.max(2, Math.round(N * s.pct / 100))); break;
        case "bottomPct": pool = ranked.slice(N - Math.max(2, Math.round(N * s.pct / 100))); break;
        case "brackets": pool = qualify(function (b) { return s.allowed.indexOf(br.get(b)) >= 0; }); break;
        default: pool = elite.slice();
      }
      pairs = pairPool(sim, topUp(pool, !!LOSER_POOLS[s.pool]), nPairs, s, br, rankOf);
    }
    while (pairs.length < nPairs) pairs.push([ranked[0], ranked[1]]);   // safety net for tiny populations
    return pairs.slice(0, nPairs).map(function (p) {
      var a = p[0], b = p[1];
      if (rankOf(b) < rankOf(a)) { var t = a; a = b; b = t; }   // the better-ranked parent passes on the house name
      return { a: a, b: b, meta: { rule: s.preset, label: sim.ruleName, rankA: rankOf(a) + 1, rankB: rankOf(b) + 1,
        retA: a.lastReturn, retB: b.lastReturn, bracketA: labels[br.get(a)], bracketB: labels[br.get(b)], note: note } };
    });
  }

  T.Breeding = { POOLS: POOLS, PAIRINGS: PAIRINGS, BRACKETS: BRACKETS, PRESETS: PRESETS, normalize: normalize, describe: describe,
    select: select, bracketLabels: bracketLabels, bracketCount: bracketCount, bracketsOf: bracketsOf, find: find };
  // older code and the CLI list presets under this name
  T.BREEDING_RULES = PRESETS.filter(function (p) { return p.key !== "custom"; }).map(function (p) {
    return { key: p.key, name: p.name, desc: describe(normalize({ breeding: p.key })) };
  });
})(window.T = window.T || {});
