#!/usr/bin/env node
/* Combine every generation's CSVs into one spreadsheet.
 *   node tools/combine.js out/run-20270104-x1 [all-generations.xlsx]
 *   node tools/combine.js some.zip other/*.csv --out merged.xlsx
 * Same-named files (trades.csv from gen-0001, gen-0002, ...) are stacked into one sheet with a "source" column. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");

function load() {
  if (global.T && global.T.Report) return;
  global.window = global;
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "report.js"), "utf8"), { filename: "report.js" });
}
function XLSXlib() { return require(path.join(__dirname, "..", "vendor", "xlsx.full.min.js")); }

function collect(p, base, out) {
  var st = fs.statSync(p);
  if (st.isDirectory()) {
    fs.readdirSync(p).sort().forEach(function (f) {
      if (f === "bots") return;                     // per-bot folders are a different view of the same rows
      var q = path.join(p, f);
      if (fs.statSync(q).isDirectory() ? /^gen-\d+$/.test(f) : /\.csv$/i.test(f) && base !== p) collect(q, base, out);
    });
  } else if (/\.zip$/i.test(p)) {
    T.Report.unzip(XLSXlib(), fs.readFileSync(p)).filter(function (f) { return /gen-\d+\//.test(f.name); }).forEach(function (f) { out.push(f); });
  } else if (/\.csv$/i.test(p)) {
    out.push({ name: path.relative(base, p).replace(/\\/g, "/") || path.basename(p), text: fs.readFileSync(p, "utf8") });
  }
  return out;
}

function combineDir(dir, outFile) {
  load();
  var XLSX = XLSXlib(), files = collect(dir, dir, []);
  var res = T.Report.combine(files, XLSX);
  fs.writeFileSync(outFile, XLSX.write(res.workbook, { type: "buffer", bookType: "xlsx", compression: true }));
  return { files: files.length, sheets: res.sheets, rows: res.rows };
}

module.exports = { combineDir: combineDir };

if (require.main === module) {
  load();
  var argv = process.argv.slice(2), outIdx = argv.indexOf("--out"), out = null;
  if (outIdx >= 0) { out = argv[outIdx + 1]; argv.splice(outIdx, 2); }
  if (!argv.length) { console.log("usage: node tools/combine.js <run folder | files.csv | archive.zip ...> [--out merged.xlsx]"); process.exit(1); }
  if (argv.length === 2 && /\.xlsx$/i.test(argv[1])) { out = argv[1]; argv = [argv[0]]; }
  var files = [];
  argv.forEach(function (a) {
    var base = fs.statSync(a).isDirectory() ? a : path.dirname(a);
    if (fs.statSync(a).isDirectory()) collect(a, a, files); else collect(a, base, files);
  });
  out = out || (fs.statSync(argv[0]).isDirectory() ? path.join(argv[0], "all-generations.xlsx") : "combined.xlsx");
  var XLSX = XLSXlib(), res = T.Report.combine(files, XLSX);
  fs.writeFileSync(out, XLSX.write(res.workbook, { type: "buffer", bookType: "xlsx", compression: true }));
  console.log("Combined " + files.length + " CSV files into " + out + ": " + res.sheets + " sheets, " + res.rows + " rows");
}
