/* node tests/docs.js - the Trading data bot builds the right files and drives the GitHub API correctly (mock GitHub). */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert"), zlib = require("zlib");
global.window = global;
["js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/breeding.js", "js/sim.js", "js/report.js", "js/final.js", "js/docs-push.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
var D = T.DocsPush;

/* A tiny in-memory GitHub: refs, commits, trees, blobs, pulls, labels. */
function mockGitHub(opts) {
  opts = opts || {};
  var blobs = {}, trees = {}, commits = { base: { tree: { sha: "t0" } } }, refs = { "heads/main": "base" }, pulls = [], files = {}, calls = [], id = 0;
  if (opts.hasShelf) files[D.SHELF + "/README.md"] = "x";
  async function api(method, p, body) {
    calls.push(method + " " + p);
    var m;
    if (opts.fail) { var e = new Error("Bad credentials"); e.status = opts.fail; throw e; }
    if (method === "GET" && p === "/repos/o/r") return { default_branch: "main" };
    if (method === "GET" && (m = /\/git\/ref\/(.+)$/.exec(p))) { var r = refs[m[1]]; if (!r) { var e4 = new Error("Not Found"); e4.status = 404; throw e4; } return { object: { sha: r } }; }
    if (method === "GET" && (m = /\/git\/commits\/(.+)$/.exec(p))) return commits[m[1]];
    if (method === "GET" && (m = /\/contents\/(.+)\?ref=/.exec(p))) { if (files[m[1]]) return {}; var e5 = new Error("Not Found"); e5.status = 404; throw e5; }
    if (method === "POST" && /\/git\/blobs$/.test(p)) { var b = "b" + (++id); blobs[b] = Buffer.from(body.content, "base64"); return { sha: b }; }
    if (method === "POST" && /\/git\/trees$/.test(p)) { var t = "t" + (++id); trees[t] = body; return { sha: t }; }
    if (method === "POST" && /\/git\/commits$/.test(p)) { var c = "c" + (++id); commits[c] = { tree: { sha: body.tree }, parents: body.parents, message: body.message }; return { sha: c }; }
    if (method === "POST" && /\/git\/refs$/.test(p)) { refs[body.ref.replace("refs/", "")] = body.sha; return {}; }
    if (method === "PATCH" && (m = /\/git\/refs\/(.+)$/.exec(p))) { assert.ok(refs[m[1]], "patching an existing ref"); refs[m[1]] = body.sha; return {}; }
    if (method === "POST" && /\/pulls$/.test(p)) { pulls.push(body); return { number: pulls.length, html_url: "https://github.com/o/r/pull/" + pulls.length }; }
    if (method === "PATCH" && (m = /\/pulls\/(\d+)$/.exec(p))) { pulls[+m[1] - 1].title = body.title; return { number: +m[1], html_url: "https://github.com/o/r/pull/" + m[1] }; }
    if (method === "POST" && /\/labels$/.test(p)) { pulls[pulls.length - 1].labels = body.labels; return {}; }
    throw new Error("unexpected " + method + " " + p);
  }
  return { api: api, blobs: blobs, trees: trees, refs: refs, pulls: pulls, calls: calls, commits: commits };
}

(async function () {
  var sim = new T.Sim({ mult: 1, generations: 3, daysPerGen: 2, seed: 5, maxSymbols: 400 });
  while (!sim.done) sim.step();
  var gh = mockGitHub(), b1 = D.simBundle(sim);
  var r1 = await D.push(b1, { repo: "o/r", request: gh.api, zlib: zlib });
  assert.strictEqual(r1.pr, 1);
  assert.ok(gh.refs["heads/" + r1.branch] && /^trading-data-bot\/simulation-/.test(r1.branch), "branch created");
  assert.deepStrictEqual(gh.pulls[0].labels, ["trading data bot"], "pull request labelled");
  var tree = gh.trees[Object.keys(gh.trees)[0]].tree, byPath = {};
  tree.forEach(function (e) { byPath[e.path] = gh.blobs[e.sha]; });
  var readme = byPath[b1.dir + "README.md"].toString();
  assert.ok(/GK-LABS INTERNAL · CONFIDENTIAL/.test(readme) && readme.indexOf(b1.docId) > 0 && /HANDLING\.md\]\(\.\.\/\.\.\/\.\.\/HANDLING\.md\)/.test(readme), "README has header, doc ID and handling link");
  assert.ok(byPath[D.SHELF + "/README.md"] && /GKL-12-0000/.test(byPath[D.SHELF + "/README.md"].toString()), "shelf index added when missing");
  var gz = byPath[b1.dir + "training/market-samples.csv.gz"];
  assert.ok(gz && gz[0] === 0x1f && gz[1] === 0x8b, "big tables are gzipped");
  var csv = zlib.gunzipSync(gz).toString();
  assert.ok(/^gen,date,symbol/.test(csv) && csv.split("\n").length - 2 === sim.log.mlSamples.length, "gzipped table holds every row");
  assert.ok(Object.keys(byPath).every(function (p) { return p.indexOf(D.SHELF + "/") === 0; }), "everything stays inside the shelf");
  assert.ok(!/token|Bearer/i.test(JSON.stringify(gh.pulls) + readme), "no credentials in what is uploaded");
  console.log("ok  first send: branch, labelled pull request, " + tree.length + " files, confidential README, gzipped tables, shelf index");

  // a second send of the same run updates the same branch and pull request
  var before = gh.refs["heads/" + r1.branch], r2 = await D.push(D.simBundle(sim), { repo: "o/r", request: gh.api, zlib: zlib, state: { branch: r1.branch, pr: r1.pr } });
  assert.strictEqual(r2.pr, 1); assert.ok(r2.updated); assert.strictEqual(gh.pulls.length, 1);
  assert.strictEqual(gh.commits[gh.refs["heads/" + r1.branch]].parents[0], before, "new commit on top of the run's branch");
  console.log("ok  later sends of the same run add a commit to the same pull request");

  // shelf index is not re-added when it exists; final training bundle
  var gh2 = mockGitHub({ hasShelf: true });
  var ds = T.Final.loadPrices([{ name: "p.csv", text: T.Final.simulatedCSV({ symbols: 12, days: 400 }) }]);
  var res = await T.Final.run(ds, { horizon: 5, trees: 60 });
  var r3 = await D.push(D.finalBundle(res, true), { repo: "o/r", request: gh2.api, zlib: zlib });
  var paths = gh2.trees[Object.keys(gh2.trees)[0]].tree.map(function (e) { return e.path; });
  assert.ok(!paths.some(function (p) { return p === D.SHELF + "/README.md"; }), "existing shelf index left alone");
  assert.ok(paths.some(function (p) { return /final-training\/.*practice.*\/model\.json$/.test(p); }), "final training folder with the model, marked practice");
  assert.ok(/practice data/.test(gh2.pulls[0].title));
  console.log("ok  final training bundle: " + paths.length + " files incl. model.json, practice data marked, shelf index untouched (" + r3.url + ")");

  // size cap: optional tables are dropped first and listed
  var big = D.simBundle(sim);
  big.files.push({ path: big.dir + "trades-huge.csv", text: "x".repeat(95 * 1024 * 1024), gzip: false, rows: 1, optional: true });
  var enc = await D.encode(big, { zlib: zlib });
  assert.ok(enc.omitted.some(function (p) { return /trades-huge/.test(p); }) && enc.bytes < 91 * 1024 * 1024, "over-size optional table left out");
  assert.ok(/Left out to stay under GitHub's size limits/.test(Buffer.from(enc.files[enc.files.length - 1].bytes).toString()), "README says what was left out");
  console.log("ok  size cap: optional tables over 90 MB are left out and listed in the README");

  // errors explained in plain words
  assert.ok(/rejected the token/.test(D.explain({ status: 401, message: "x" }, "o/r")));
  assert.ok(/can't write to o\/r/.test(D.explain({ status: 404, message: "x" }, "o/r")));
  assert.ok(/can't reach GitHub/.test(D.explain(new TypeError("Failed to fetch"), "o/r")));
  await assert.rejects(D.push(D.simBundle(sim), { repo: "o/r", request: mockGitHub({ fail: 401 }).api, zlib: zlib }), /Bad credentials/);
  console.log("ok  errors explained: bad token, no access, GitHub unreachable");
})().catch(function (e) { console.error(e); process.exit(1); });
