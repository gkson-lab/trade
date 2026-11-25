#!/usr/bin/env node
/* Run several simulations at once, one per processor core (Apple silicon Macs have 8-16).
 * Each run gets its own seed and output folder; any other options go to every run (see node cli.js --help).
 *   node tools/parallel.js                          one run per performance core, 10 generations each
 *   node tools/parallel.js --runs 6 --gens 50 --gzip --out runs
 *   node tools/parallel.js --runs 4 --forever --max-minutes 60 --symbols 1500
 * With DOCS_TOKEN set, every finished run is sent to the internal documents repository automatically. */
"use strict";
var cp = require("child_process"), os = require("os"), path = require("path");
var argv = process.argv.slice(2), opts = {}, pass = [];
for (var i = 0; i < argv.length; i++) {
  var a = argv[i];
  if (a === "--runs" || a === "--out" || a === "--seed") { opts[a.slice(2)] = argv[++i]; continue; }
  pass.push(a);
}
var cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
var runs = Math.max(1, +(opts.runs || Math.max(1, cores - 1))), out = opts.out || "runs", seed0 = +(opts.seed || 20270104);
if (pass.indexOf("--gens") < 0 && pass.indexOf("--forever") < 0) pass.push("--gens", "10");
console.log("Starting " + runs + " runs on " + cores + " cores -> " + out + "/seed-<n>/");
var t0 = Date.now(), left = runs, failed = 0;
for (var r = 0; r < runs; r++) (function (k) {
  var seed = seed0 + k, dir = path.join(out, "seed-" + seed);
  var child = cp.spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), "--seed", String(seed), "--out", dir].concat(pass), { stdio: ["ignore", "pipe", "pipe"] });
  var tag = "[seed " + seed + "] ", buf = "";
  function lines(chunk) { buf += chunk; var parts = buf.split("\n"); buf = parts.pop(); parts.forEach(function (l) { if (l.trim()) console.log(tag + l); }); }
  child.stdout.on("data", lines); child.stderr.on("data", lines);
  child.on("exit", function (code) {
    if (code) failed++;
    console.log(tag + (code ? "failed (exit " + code + ")" : "done") + " · " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
    if (--left === 0) { console.log(runs - failed + " of " + runs + " runs finished in " + ((Date.now() - t0) / 60000).toFixed(1) + " min."); process.exit(failed ? 1 : 0); }
  });
})(r);
