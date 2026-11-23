/* Data exports.
 *   master(sim)        one big workbook: every table for every generation stacked (with a gen column),
 *                      plus one sheet per generation
 *   botWorkbook        everything about one bot
 *   perBotWorkbook     an index sheet plus one daily-ledger sheet per bot
 *   generationsZip     gen-0001/ ... gen-NNNN/ folders of CSVs, plus run-level CSVs
 *   botsZip            bots/<name>/ folders of CSVs
 *   combine(files)     any set of CSVs (or ZIPs of CSVs) -> one workbook, same-named files stacked
 * Sheets past Excel's row limit continue on "(2)", "(3)" ... sheets. */
(function (T) {
  "use strict";

  var MAX_ROWS = 1000000;
  var PCT = /(Pct|Return|returnPct|Rate|rawdown|vsIndex|changePct|positionSize|stopLoss|takeProfit|volatility|Volatility|alphaAnn|AlphaAnn|trackingError|var95Pct|cvar95Pct|Exposure|dividendYield|shortInterest|atrPct|pctAbove20d|cashReserve|shortersPct|trailersPct|^weight_|cumulative|changeVsPrevGen|returnSinceStart|indexVolAnn|idioVol)$/;
  var PCT_ALSO = /^weight_/;

  function r2(x) { return Math.round(x * 100) / 100; }

  function summaryRows(rep, sim) {
    var c = rep.config;
    var rows = [
      ["Starting bots", 20 * c.mult], ["Population multiplier", c.mult], ["Starting cash per bot $", c.startCash],
      ["Generations", rep.generations + (rep.forever ? " (endless run)" : "")], ["Trading days per generation", c.daysPerGen],
      ["Trading days simulated", rep.tradingDays], ["Simulated dates", rep.startDate + " to " + rep.endDate],
      ["Seed", c.seed], ["Fitness", c.fitness === "risk" ? "Return - 0.5 x max drawdown" : "Total return"],
      ["Breeding rule", sim.ruleName], ["Mutation strength", c.mutation + "x"], ["Training samples per day", c.samplesPerDay],
      ["Symbols", sim.market.n], ["Unique bots", rep.uniqueBots], ["Bot-generation runs", rep.botRuns],
      ["Average return (all runs)", rep.avgReturn], ["Median return (all runs)", rep.medianReturn],
      ["Average P/L $ (all runs)", r2(rep.avgPnl)], ["Average Sharpe", r2(rep.avgSharpe)], ["Average Sortino", r2(rep.avgSortino)],
      ["Average alpha (annualized)", rep.avgAlpha], ["Average beta", r2(rep.avgBeta)], ["Average win rate", rep.avgWinRate],
      ["Average profit factor (capped at 10)", r2(rep.avgProfitFactor)], ["Average max drawdown", rep.avgMaxDrawdown],
      ["Gen 1 average return", rep.firstGenAvg], ["Final gen average return", rep.lastGenAvg],
      ["Compounded average bot (all gens)", rep.cumulativeAvgBot], ["Compounded SIM 500 (same windows)", rep.cumulativeIndex],
      ["SIM 500 return (whole run)", rep.indexReturn], ["Total trades", rep.totalTrades], ["Total round trips", rep.totalRoundTrips],
      ["Total fees $", r2(rep.totalFees)],
      ["Best single run", rep.best ? rep.best.bot + " (gen " + rep.best.gen + ", " + (rep.best.returnPct * 100).toFixed(2) + "%)" : ""],
      ["Detail rows dropped from memory", rep.trimmedThrough ? "generations 1-" + rep.trimmedThrough + " (summaries kept)" : "none"],
      ["Per-bot history kept in memory", rep.historyFrom ? "generations " + (rep.historyFrom + 1) + " onward (the CLI's gen folders hold every generation)" : "all generations"],
      ["Wall-clock seconds", r2(rep.wallSeconds)],
      ["Note", "Fictional market. Symbols are real US listings; every price after the start is simulated."]
    ];
    return rows.map(function (r) { return { metric: r[0], value: r[1] }; });
  }

  /* All run tables in display order. */
  function sheets(sim) {
    var L = sim.log;
    return [
      ["Summary", summaryRows(sim.report(), sim)],
      ["Generations", L.generations],
      ["Genetics", L.genetics],
      ["Bots", L.bots],
      ["Bot Profiles", sim.profiles()],
      ["Genomes", L.genomes],
      ["Trades", L.trades],
      ["Round Trips", L.roundTrips],
      ["Bot Daily", L.botDaily],
      ["Equity Intraday", L.equityIntraday],
      ["Positions", L.positions],
      ["Market Daily", L.market],
      ["Sector Daily", L.sectors],
      ["News", L.news],
      ["Symbols", sim.symbols()],
      ["Market Samples", L.mlSamples],
      ["Family Tree", sim.familyTree()],
      ["Pedigree", sim.pedigree()]
    ];
  }

  function toCSV(rows) {
    if (!rows.length) return "";
    var cols = columns(rows);
    var esc = function (v) {
      if (v === null || v === undefined) return "";
      var s = typeof v === "number" ? (isFinite(v) ? String(+v.toFixed(6)) : "") : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [cols.join(",")];
    for (var i = 0; i < rows.length; i++) out.push(cols.map(function (c) { return esc(rows[i][c]); }).join(","));
    return out.join("\n") + "\n";
  }

  function columns(rows) {
    var seen = Object.create(null), cols = [];
    var n = Math.min(rows.length, 50);
    for (var i = 0; i < n; i++) for (var k in rows[i]) if (!seen[k]) { seen[k] = 1; cols.push(k); }
    return cols;
  }

  function safeName(name, wb) {
    var s = String(name).replace(/[\\\/?*\[\]:]/g, " ").slice(0, 31), base = s, k = 2;
    while (wb.SheetNames.indexOf(s) >= 0) { s = base.slice(0, 26) + " (" + k++ + ")"; }
    return s;
  }

  /* Append rows as one or more sheets (split at the Excel row limit), with % formats and filters. */
  function appendSheet(XLSX, wb, name, rows, pctAll) {
    if (!rows.length) rows = [{ note: "no rows" }];
    for (var part = 0; part * MAX_ROWS < rows.length; part++) {
      var chunk = rows.length > MAX_ROWS ? rows.slice(part * MAX_ROWS, (part + 1) * MAX_ROWS) : rows;
      var cols = columns(chunk);
      var ws = XLSX.utils.json_to_sheet(chunk, { header: cols });
      ws["!cols"] = cols.map(function (c) { return { wch: Math.max(9, Math.min(48, c.length + 3)) }; });
      var range = XLSX.utils.decode_range(ws["!ref"]);
      cols.forEach(function (c, ci) {
        var isPct = pctAll ? !/(level|^gen$|^day$|^date$)/.test(c) : (PCT.test(c) || PCT_ALSO.test(c));
        if (!isPct) return;
        for (var r = 1; r <= range.e.r; r++) {
          var cell = ws[XLSX.utils.encode_cell({ r: r, c: ci })];
          if (cell && cell.t === "n") cell.z = "0.00%";
        }
      });
      if (name === "Summary") {
        for (var r = 1; r <= range.e.r; r++) {
          var label = ws[XLSX.utils.encode_cell({ r: r, c: 0 })], v = ws[XLSX.utils.encode_cell({ r: r, c: 1 })];
          if (label && v && v.t === "n" && /return|rate|drawdown|alpha|Compounded/i.test(label.v)) v.z = "0.00%";
        }
      }
      ws["!autofilter"] = { ref: ws["!ref"] };
      XLSX.utils.book_append_sheet(wb, ws, safeName(part ? name + " (" + (part + 1) + ")" : name, wb));
    }
  }

  function groupBy(rows, key) {
    var g = Object.create(null);
    for (var i = 0; i < rows.length; i++) { var k = rows[i][key]; (g[k] = g[k] || []).push(rows[i]); }
    return g;
  }

  /* Training-ready files: inputs are x_* columns, targets are y_* columns. */
  function trainingFiles(sim) {
    return [["training/market-samples.csv", sim.log.mlSamples], ["training/round-trips.csv", sim.log.roundTrips],
      ["training/bot-generations.csv", sim.log.bots], ["training/family-tree.csv", sim.familyTree()]]
      .map(function (x) { return { path: x[0], text: toCSV(x[1]) }; });
  }
  function trainingZip(sim, XLSX, type) { return zip(XLSX, trainingFiles(sim), type); }

  /* One big spreadsheet: every table across all generations, then one sheet per generation. */
  function master(sim, XLSX, opts) {
    opts = opts || {};
    var wb = XLSX.utils.book_new();
    sheets(sim).forEach(function (s) { appendSheet(XLSX, wb, s[0], s[1], s[0] === "Sector Daily"); });
    var perGen = opts.perGenSheets === undefined ? 300 : opts.perGenSheets;
    var byGen = groupBy(sim.log.bots, "gen"), gens = sim.log.generations;
    if (gens.length <= perGen) gens.forEach(function (g) { appendSheet(XLSX, wb, "Gen " + g.gen, byGen[g.gen] || []); });
    return wb;
  }

  function botTables(sim, name, idx) {
    idx = idx || indexByBot(sim);
    var prof = sim.profiles().filter(function (p) { return p.bot === name; })[0] || {};
    var rt = idx.roundTrips[name] || [], sec = {}, sym = {};
    rt.forEach(function (t) {
      var s = sec[t.sector] = sec[t.sector] || { sector: t.sector, roundTrips: 0, wins: 0, pnl: 0 };
      s.roundTrips++; s.pnl += t.pnl; if (t.pnl > 0) s.wins++;
      var y = sym[t.symbol] = sym[t.symbol] || { symbol: t.symbol, sector: t.sector, roundTrips: 0, wins: 0, pnl: 0 };
      y.roundTrips++; y.pnl += t.pnl; if (t.pnl > 0) y.wins++;
    });
    var fin = function (o) { return Object.keys(o).map(function (k) { var x = o[k]; x.winRate = x.roundTrips ? x.wins / x.roundTrips : 0; x.pnl = r2(x.pnl); return x; }).sort(function (a, b) { return b.pnl - a.pnl; }); };
    var genome = sim.log.genomes.filter(function (g) { return g.bot === name; })[0];
    var profRows = Object.keys(prof).map(function (k) { return { field: k, value: prof[k] }; });
    if (genome) profRows.push({ field: "genome (weights + genes)", value: genome.genome });
    return [
      ["Profile", profRows],
      ["Generations", idx.bots[name] || []],
      ["Daily Ledger", idx.botDaily[name] || []],
      ["Round Trips", rt],
      ["Trades", idx.trades[name] || []],
      ["Equity Intraday", idx.equityIntraday[name] || []],
      ["Positions", idx.positions[name] || []],
      ["Sector PnL", fin(sec)],
      ["Symbol PnL", fin(sym)]
    ];
  }

  function indexByBot(sim) {
    var L = sim.log, o = {};
    ["bots", "trades", "roundTrips", "botDaily", "equityIntraday", "positions"].forEach(function (k) { o[k] = groupBy(L[k], "bot"); });
    return o;
  }

  function botWorkbook(sim, name, XLSX) {
    var wb = XLSX.utils.book_new();
    botTables(sim, name).forEach(function (s) { appendSheet(XLSX, wb, s[0], s[1]); });
    return wb;
  }

  /* Index of every bot, then a daily ledger sheet for each (most recent bots first if there are too many). */
  function perBotWorkbook(sim, XLSX, maxSheets) {
    maxSheets = maxSheets || 600;
    var wb = XLSX.utils.book_new(), prof = sim.profiles(), daily = groupBy(sim.log.botDaily, "bot");
    appendSheet(XLSX, wb, "Index", prof);
    prof.slice(-maxSheets).forEach(function (p) { appendSheet(XLSX, wb, p.bot, daily[p.bot] || []); });
    return wb;
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function enc(s) { return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Buffer.from(s, "utf8"); }

  function zip(XLSX, files, type) {
    var C = XLSX.CFB, c = C.utils.cfb_new();
    try { C.utils.cfb_del(c, "\u0001Sh33tJ5"); } catch (e) { /* placeholder entry absent */ }
    files.forEach(function (f) { C.utils.cfb_add(c, f.path, enc(f.text)); });
    return C.write(c, { fileType: "zip", type: type || "array", compression: true });
  }

  var GEN_TABLES = [["bots", "bots"], ["trades", "trades"], ["round-trips", "roundTrips"], ["bot-daily", "botDaily"], ["equity-intraday", "equityIntraday"],
    ["positions", "positions"], ["market-daily", "market"], ["sector-daily", "sectors"], ["news", "news"], ["generation", "generations"], ["genetics", "genetics"],
    ["market-samples", "mlSamples"], ["births", "births"]];

  /* Rows of a single generation, keyed by CSV file name. */
  function generationFiles(rows) {
    var out = [];
    GEN_TABLES.forEach(function (t) {
      var src = t[1] === "generations" ? rows.generation : t[1] === "sectors" ? rows.sectors : rows[t[1]];
      if (src && src.length) out.push({ name: t[0] + ".csv", text: toCSV(src) });
    });
    return out;
  }
  function genDir(g) { return "gen-" + String(g).padStart(4, "0"); }

  function generationsZip(sim, XLSX, type) {
    var L = sim.log, files = [], by = {};
    GEN_TABLES.forEach(function (t) { by[t[1]] = t[1] === "births" ? groupBy(L.genomes, "born") : groupBy(L[t[1]], "gen"); });
    L.generations.forEach(function (g) {
      var rows = { generation: [g] };
      GEN_TABLES.forEach(function (t) { if (t[1] !== "generations") rows[t[1]] = by[t[1]][g.gen] || []; });
      rows.sectors = by.sectors[g.gen] || [];
      generationFiles(rows).forEach(function (f) { files.push({ path: genDir(g.gen) + "/" + f.name, text: f.text }); });
      if (g.gen <= sim.trimmedThrough) files.push({ path: genDir(g.gen) + "/README.txt", text: "Trade-level detail for this generation was dropped from memory during an endless run. Summary tables are complete.\n" });
    });
    runLevelFiles(sim).forEach(function (f) { files.push({ path: f.name, text: f.text }); });
    return zip(XLSX, files, type);
  }

  function runLevelFiles(sim) {
    return [["summary.csv", summaryRows(sim.report(), sim)], ["generations.csv", sim.log.generations], ["genetics.csv", sim.log.genetics],
      ["bots.csv", sim.log.bots], ["bot-profiles.csv", sim.profiles()], ["genomes.csv", sim.log.genomes], ["symbols.csv", sim.symbols()],
      ["market-daily.csv", sim.log.market], ["sector-daily.csv", sim.log.sectors], ["family-tree.csv", sim.familyTree()],
      ["pedigree.csv", sim.pedigree()]].map(function (x) { return { name: x[0], text: toCSV(x[1]) }; });
  }

  function botsZip(sim, XLSX, type) {
    var idx = indexByBot(sim), files = [];
    sim.log.genomes.forEach(function (g) {
      botTables(sim, g.bot, idx).forEach(function (s) {
        if (s[1].length) files.push({ path: "bots/" + g.bot + "/" + slug(s[0]) + ".csv", text: toCSV(s[1]) });
      });
    });
    files.push({ path: "bot-profiles.csv", text: toCSV(sim.profiles()) });
    return zip(XLSX, files, type);
  }

  /* Merge CSVs into one workbook. files: [{name: "gen-0003/trades.csv", text}] or ZIP bytes via unzip().
   * Files with the same table name are stacked into one sheet with a "source" column. */
  function combine(files, XLSX) {
    var groups = {}, order = [];
    files.forEach(function (f) {
      var parts = f.name.replace(/\\/g, "/").split("/"), file = parts.pop(), folder = parts.join("/");
      var key = file.replace(/\.csv$/i, "").replace(/^trade-box-seed\d+-x\d+-g[^-]+-/i, "").replace(/^gen-\d+-/i, "");
      var src = folder || (file.match(/gen-\d+/i) || [file])[0];
      if (!groups[key]) { groups[key] = []; order.push(key); }
      var wb = XLSX.read(f.text, { type: "string", raw: true });
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      var many = files.length > 1;
      rows.forEach(function (r) { if (many) { var o = { source: src }; for (var k in r) o[k] = r[k]; groups[key].push(o); } else groups[key].push(r); });
    });
    var out = XLSX.utils.book_new();
    order.forEach(function (k) {
      // numbers come back as strings with raw:true; convert numeric-looking cells
      var rows = groups[k].map(function (r) { var o = {}; for (var c in r) { var v = r[c]; o[c] = typeof v === "string" && v !== "" && isFinite(v) ? +v : v; } return o; });
      appendSheet(XLSX, out, titleCase(k), rows, /sector-daily/.test(k));
    });
    return { workbook: out, sheets: order.length, rows: order.reduce(function (a, k) { return a + groups[k].length; }, 0) };
  }

  function unzip(XLSX, bytes) {
    var c = XLSX.CFB.read(bytes, { type: typeof Buffer !== "undefined" && bytes instanceof Buffer ? "buffer" : "array" }), out = [];
    c.FileIndex.forEach(function (f, i) {
      if (f.type !== 2 || !/\.csv$/i.test(f.name)) return;
      var path = c.FullPaths[i].replace(/^Root Entry\//, "");
      var text = typeof TextDecoder !== "undefined" ? new TextDecoder().decode(f.content) : Buffer.from(f.content).toString("utf8");
      out.push({ name: path, text: text });
    });
    return out;
  }

  function titleCase(k) { return k.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  T.Report = {
    sheets: sheets, toCSV: toCSV, master: master, workbook: master, botWorkbook: botWorkbook, botTables: botTables, perBotWorkbook: perBotWorkbook,
    generationsZip: generationsZip, trainingZip: trainingZip, trainingFiles: trainingFiles, generationFiles: generationFiles, runLevelFiles: runLevelFiles, genDir: genDir, botsZip: botsZip,
    combine: combine, unzip: unzip, summaryRows: summaryRows, appendSheet: appendSheet
  };
})(window.T = window.T || {});
