/* Data sheets: builds the end-of-run workbook (XLSX via SheetJS) and per-sheet CSVs. */
(function (T) {
  "use strict";

  var PCT = /(Pct|Return|returnPct|Rate|Drawdown|vsIndex|changePct|positionSize|stopLoss|takeProfit)$/;

  function summaryRows(rep) {
    var c = rep.config;
    return [
      { metric: "Starting bots", value: 20 * c.mult },
      { metric: "Population multiplier", value: c.mult },
      { metric: "Generations", value: rep.generations },
      { metric: "Trading days per generation", value: c.daysPerGen },
      { metric: "Seed", value: c.seed },
      { metric: "Fitness", value: c.fitness === "risk" ? "Return - 0.5 x max drawdown" : "Total return" },
      { metric: "Unique bots", value: rep.uniqueBots },
      { metric: "Bot-generation runs", value: rep.botRuns },
      { metric: "Average return (all runs)", value: rep.avgReturn },
      { metric: "Median return (all runs)", value: rep.medianReturn },
      { metric: "Average P/L $ (all runs)", value: +rep.avgPnl.toFixed(2) },
      { metric: "Average Sharpe", value: +rep.avgSharpe.toFixed(3) },
      { metric: "Average win rate", value: rep.avgWinRate },
      { metric: "Average max drawdown", value: rep.avgMaxDrawdown },
      { metric: "Gen 1 average return", value: rep.firstGenAvg },
      { metric: "Final gen average return", value: rep.lastGenAvg },
      { metric: "SIM 500 return (whole run)", value: rep.indexReturn },
      { metric: "Total trades", value: rep.totalTrades },
      { metric: "Best single run", value: rep.best ? rep.best.bot + " (gen " + rep.best.gen + ", " + (rep.best.returnPct * 100).toFixed(2) + "%)" : "" },
      { metric: "Note", value: "Fictional market. Symbols are real US listings; every price after the start is simulated." }
    ];
  }

  function sheets(sim) {
    var rep = sim.report();
    return [
      ["Summary", summaryRows(rep)],
      ["Generations", sim.log.generations],
      ["Bots", sim.log.bots],
      ["Trades", sim.log.trades],
      ["Equity Daily", sim.log.equity],
      ["Market Daily", sim.log.market],
      ["News", sim.log.news],
      ["Genomes", sim.log.genomes]
    ];
  }

  function toCSV(rows) {
    if (!rows.length) return "";
    var cols = Object.keys(rows[0]);
    var esc = function (v) {
      if (v === null || v === undefined) return "";
      var s = typeof v === "number" ? String(+v.toFixed(6)) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [cols.join(",")];
    for (var i = 0; i < rows.length; i++) out.push(cols.map(function (c) { return esc(rows[i][c]); }).join(","));
    return out.join("\n") + "\n";
  }

  function workbook(sim, XLSX) {
    var wb = XLSX.utils.book_new();
    sheets(sim).forEach(function (s) {
      var rows = s[1].length ? s[1] : [{ empty: "no rows" }];
      var ws = XLSX.utils.json_to_sheet(rows);
      var cols = Object.keys(rows[0]);
      ws["!cols"] = cols.map(function (c) { return { wch: Math.max(10, Math.min(60, c.length + 4)) }; });
      // percent formatting
      var range = XLSX.utils.decode_range(ws["!ref"]);
      cols.forEach(function (c, ci) {
        var pct = PCT.test(c) || (s[0] === "Summary" && false);
        if (!pct) return;
        for (var r = 1; r <= range.e.r; r++) {
          var cell = ws[XLSX.utils.encode_cell({ r: r, c: ci })];
          if (cell && cell.t === "n") cell.z = "0.00%";
        }
      });
      if (s[0] === "Summary") {
        for (var r = 1; r <= range.e.r; r++) {
          var label = ws[XLSX.utils.encode_cell({ r: r, c: 0 })], v = ws[XLSX.utils.encode_cell({ r: r, c: 1 })];
          if (label && v && v.t === "n" && /return|rate|drawdown/i.test(label.v)) v.z = "0.00%";
        }
      }
      ws["!autofilter"] = { ref: ws["!ref"] };
      XLSX.utils.book_append_sheet(wb, ws, s[0]);
    });
    return wb;
  }

  T.Report = { sheets: sheets, toCSV: toCSV, workbook: workbook, summaryRows: summaryRows };
})(window.T = window.T || {});
