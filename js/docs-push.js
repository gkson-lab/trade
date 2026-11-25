/* Trading data bot: sends the data the bots collect to the internal documents repository as a pull request.
 *
 * Everything goes through the GitHub REST API (blobs -> tree -> commit -> branch -> pull request), so the same code
 * runs in the browser and in Node. It authenticates with a token the user supplies at run time (or the GitHub CLI's
 * login, from Node). No token is ever stored in this repository or in what it uploads; commits are authored by
 * whoever owns the token.
 *
 * Layout in the documents repo:
 *   shelf-12-trading-data/README.md                       shelf index (added when missing)
 *   shelf-12-trading-data/simulation-runs/<run>/...       one folder per simulation run
 *   shelf-12-trading-data/final-training/<run>/...        one folder per final training */
(function (T) {
  "use strict";

  var DEFAULT_REPO = "gk-research-group/internal-documents-";
  var SHELF = "shelf-12-trading-data";
  var LABEL = "trading data bot";
  var MAX_BYTES = 90 * 1024 * 1024;           // stay well under GitHub's 100 MB per-file and push limits

  function header(docId, shelfTitle, prepared) {
    return "> **GK-LABS INTERNAL · CONFIDENTIAL · DO NOT DISTRIBUTE**\n>\n" +
      "> This document is the property of gk-labs. It is for gk-labs members only. Do not share, forward, copy,\n" +
      "> publish, screenshot, upload to third-party services, or duplicate it outside gk-labs, in whole or in part.\n" +
      "> If you received it by mistake, delete it and tell the project lead.\n>\n" +
      "> Classification: **INTERNAL / RESTRICTED** · Doc ID: `" + docId + "` · Shelf: 12 · " + shelfTitle + " · Prepared: " + prepared +
      " · Owner: gk (founder & project lead)\n\n";
  }
  function footer(docId, depth) {
    return "\n---\n\n<sub>GK-LABS INTERNAL · CONFIDENTIAL. Property of gk-labs. Not for distribution or duplication outside gk-labs.\n" +
      "Doc ID `" + docId + "`. Handling rules: [HANDLING.md](" + new Array(depth + 1).join("../") + "HANDLING.md).</sub>\n";
  }

  function shelfReadme(today) {
    var id = "GKL-12-0000";
    return header(id, "Trading data", today) +
      "# Shelf 12 · Trading data\n\n" +
      "Data collected by the Trade Box bots, delivered by the **Trading data bot**. Each delivery is one pull request that adds one folder:\n\n" +
      "| folder | what is inside |\n|---|---|\n" +
      "| `simulation-runs/<run>/` | One simulation run: generations, genetics, every bot's results and genes, family tree, market and sector days, and the training tables (market samples, round trips). Large tables are gzipped CSV. |\n" +
      "| `final-training/<run>/` | One final-training session on real or practice price data: verdict, test metrics, calibration, backtest and trades, predictions with chances of profit or loss, and the trained model. |\n\n" +
      "Every folder has a `README.md` with its own document ID (`GKL-12-S...` for simulation runs, `GKL-12-F...` for final training), the settings, the headline numbers and the list of files.\n\n" +
      "How data arrives:\n\n" +
      "- **Trade Box app:** the *Trading data bot* button opens a pull request with the current run or the latest final training. It can also send automatically when a run or a training finishes.\n" +
      "- **Command line:** `node cli.js --push-docs` and `node tools/final_train.js --push-docs`.\n" +
      "- **Cloud:** the *Simulate* workflow in `gkson-lab/trade` sends each run when the `DOCS_TOKEN` secret is set.\n\n" +
      "Simulation data comes from a fictional market: real US symbols, simulated prices. Final-training data marked *practice* is simulated too. Nothing here is investment advice.\n" +
      "Run folders are not listed in the catalog one by one; this index and the folder READMEs are the entry points.\n" + footer(id, 1);
  }

  function stamp(d) { return d.toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60); }
  function rand4() { return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0"); }
  function pct(x) { return isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%" : "n/a"; }
  function n(x) { return Number(x).toLocaleString("en-US"); }

  /* ---------- bundles ---------- */

  /* All data from a simulation run. Big tables are gzipped. Keeps a stable key on the sim so later sends update the same PR. */
  function simBundle(sim) {
    var R = T.Report, now = new Date(), cfg = sim.cfg, rep = sim.report();
    sim.docsKey = sim.docsKey || now.toISOString().slice(0, 10) + "-seed" + cfg.seed + "-x" + cfg.mult + "-" + slug(cfg.breeding) + "-" + rand4();
    var key = sim.docsKey, dir = SHELF + "/simulation-runs/" + key + "/", docId = "GKL-12-S" + key.replace(/-/g, "").slice(0, 8) + key.slice(-4).toUpperCase();
    var L = sim.log, tables = [
      ["summary.csv", R.summaryRows(rep, sim)], ["generations.csv", L.generations], ["genetics.csv", L.genetics],
      ["bot-profiles.csv", sim.profiles()], ["family-tree.csv", sim.familyTree()], ["pedigree.csv", sim.pedigree()],
      ["bots.csv.gz", L.bots], ["genomes.csv.gz", L.genomes], ["market-daily.csv", L.market], ["sector-daily.csv.gz", L.sectors],
      ["symbols.csv.gz", sim.symbols()], ["training/market-samples.csv.gz", L.mlSamples], ["training/round-trips.csv.gz", L.roundTrips],
      ["trades.csv.gz", L.trades], ["bot-daily.csv.gz", L.botDaily], ["positions.csv.gz", L.positions], ["news.csv.gz", L.news],
      ["equity-intraday.csv.gz", L.equityIntraday]
    ];
    var files = tables.filter(function (t) { return t[1].length; }).map(function (t) { return { path: dir + t[0], text: R.toCSV(t[1]), gzip: /\.gz$/.test(t[0]), rows: t[1].length, optional: /^(trades|bot-daily|positions|news|equity-intraday)/.test(t[0]) }; });
    var best = rep.best;
    var title = "Trading data bot: simulation run " + key + " (" + rep.generations + " generation" + (rep.generations === 1 ? "" : "s") + (sim.done ? "" : ", in progress") + ")";
    var facts = [
      ["Run", key], ["Status", sim.done ? "finished" : "in progress (this pull request is updated as the run continues)"], ["Sent", stamp(now)],
      ["Population", (20 * cfg.mult) + " starting bots (x" + cfg.mult + ")"], ["Generations", rep.generations + (sim.forever ? " (endless run)" : " of " + cfg.generations)],
      ["Days per generation", cfg.daysPerGen], ["Starting cash per bot", "$" + n(cfg.startCash)], ["Breeding", sim.ruleName], ["Mutation", cfg.mutation + "x"],
      ["Seed", cfg.seed], ["Simulated dates", rep.startDate + " to " + rep.endDate], ["Average return per bot-generation", pct(rep.avgReturn)],
      ["Gen 1 average / latest average", pct(rep.firstGenAvg) + " / " + pct(rep.lastGenAvg)], ["SIM 500 over the run", pct(rep.indexReturn)],
      ["Best single run", best ? best.bot + " (gen " + best.gen + ", " + pct(best.returnPct) + ")" : "n/a"], ["Trades", n(rep.totalTrades)],
      ["Trade-level rows dropped from memory", rep.trimmedThrough ? "generations 1-" + rep.trimmedThrough : "none"]
    ];
    return finish({ kind: "simulation", key: key, dir: dir, docId: docId, title: title, files: files, facts: facts,
      intro: "One Trade Box simulation run. Fictional market: real US symbols, simulated prices. Column meanings: `docs/DATASET.md` in gkson-lab/trade." });
  }

  /* Final-training results, model and training table. */
  function finalBundle(res, practice) {
    var F = T.Final, R = T.Report, now = new Date(), cfg = res.cfg, ev = res.eval, bt = res.backtest;
    var key = now.toISOString().slice(0, 10) + (practice ? "-practice" : "") + "-h" + cfg.horizon + "-" + res.data.list.length + "sym-" + rand4();
    var dir = SHELF + "/final-training/" + key + "/", docId = "GKL-12-F" + key.replace(/-/g, "").slice(0, 8) + key.slice(-4).toUpperCase();
    var sheets = F.resultSheets(res), names = { "Summary": "summary.csv", "Predictions": "predictions.csv", "Calibration": "calibration.csv",
      "Outcome Ranges": "outcome-ranges.csv", "Backtest": "backtest.csv", "Backtest Trades": "backtest-trades.csv.gz", "Feature Importance": "feature-importance.csv",
      "Test Predictions": "test-predictions.csv.gz", "Data Quality": "data-quality.csv" };
    var files = sheets.map(function (s) { var nm = names[s[0]]; return { path: dir + nm, text: R.toCSV(s[1]), gzip: /\.gz$/.test(nm), rows: s[1].length }; });
    files.push({ path: dir + "model.json", text: JSON.stringify(res.model), gzip: false, rows: 1 });
    var tr = F.trainingRows(res.features);
    files.push({ path: dir + "training-table.csv.gz", text: R.toCSV(tr), gzip: true, rows: tr.length, optional: true });
    var title = "Trading data bot: final training " + key + (practice ? " (practice data)" : "");
    var facts = [
      ["Run", key], ["Data", (practice ? "PRACTICE (simulated prices). " : "") + res.data.list.length + " symbols, " + res.data.first + " to " + res.data.last],
      ["Sent", stamp(now)], ["Holding period", cfg.horizon + " trading days"], ["Model", cfg.model === "gbm" ? "boosted decision trees" : "logistic regression"],
      ["Verdict", res.verdict.text], ["Test dates", res.split.testStart + " to " + res.split.lastDate + " (" + n(res.split.test) + " rows)"],
      ["Test AUC", ev.auc.toFixed(3)], ["Daily rank correlation", ev.ic.toFixed(4)], ["Top minus bottom 10%", pct(ev.spread)],
      ["Backtest vs buying everything equally", pct(bt.totalReturn) + " vs " + pct(bt.equalWeightReturn)], ["Sharpe / max drawdown", (isFinite(bt.sharpe) ? bt.sharpe.toFixed(2) : "n/a") + " / " + pct(-bt.maxDrawdown)],
      ["Buy signals", res.predictions.filter(function (p) { return p.signal === "Buy"; }).length + " of " + res.predictions.length]
    ];
    return finish({ kind: "final", key: key, dir: dir, docId: docId, title: title, files: files, facts: facts,
      intro: "One final-training session of the Trade Box trading bot. Estimates from past prices, not investment advice; nothing here placed orders." });
  }

  function finish(b) {
    b.readme = function (omitted, link) {
      var today = new Date().toISOString().slice(0, 10), depth = 3;
      var s = header(b.docId, "Trading data", today) + "# " + b.title.replace(/^Trading data bot: /, "") + "\n\n" + b.intro + "\n\n| | |\n|---|---|\n" +
        b.facts.map(function (f) { return "| " + f[0] + " | " + String(f[1]).replace(/\|/g, "/") + " |"; }).join("\n") + "\n\n## Files\n\n| file | rows |\n|---|---|\n" +
        b.files.map(function (f) { return "| `" + f.path.slice(b.dir.length) + "` | " + n(f.rows) + " |"; }).join("\n") + "\n";
      if (omitted && omitted.length) s += "\nLeft out to stay under GitHub's size limits: " + omitted.map(function (p) { return "`" + p.slice(b.dir.length) + "`"; }).join(", ") + "." + (link ? " The complete data: " + link : "") + "\n";
      else if (link) s += "\nComplete archive: " + link + "\n";
      s += "\n`.csv.gz` files are gzipped CSV (pandas and Excel's Power Query read them directly).\n";
      return s + footer(b.docId, depth);
    };
    return b;
  }

  /* ---------- encoding ---------- */

  function utf8(s) { return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Buffer.from(s, "utf8"); }
  async function gzipBytes(bytes, nodeZlib) {
    if (nodeZlib) return new Uint8Array(nodeZlib.gzipSync(Buffer.from(bytes), { level: 9 }));
    if (typeof CompressionStream === "undefined") return null;
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function base64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");   // Node
    var s = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  }

  /* Turn a bundle into [{path, bytes}], gzipping where asked and dropping optional tables past the size cap. */
  async function encode(bundle, opts) {
    var out = [], omitted = [], total = 0;
    for (var k = 0; k < bundle.files.length; k++) {
      var f = bundle.files[k], bytes = utf8(f.text), path = f.path;
      if (f.gzip) { var gz = await gzipBytes(bytes, opts.zlib); if (gz) bytes = gz; else path = path.replace(/\.gz$/, ""); }
      out.push({ path: path, bytes: bytes, optional: f.optional });
    }
    out.sort(function (a, b) { return (a.optional ? 1 : 0) - (b.optional ? 1 : 0) || a.bytes.length - b.bytes.length; });
    var keep = [];
    out.forEach(function (f) { if (total + f.bytes.length <= MAX_BYTES || !f.optional) { keep.push(f); total += f.bytes.length; } else omitted.push(f.path); });
    keep.push({ path: bundle.dir + "README.md", bytes: utf8(bundle.readme(omitted, opts.link)) });
    return { files: keep, omitted: omitted, bytes: total };
  }

  /* ---------- GitHub ---------- */

  function fetchTransport(token) {
    return async function (method, path, body) {
      var r = await fetch("https://api.github.com" + path, { method: method, headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      var txt = await r.text(), data = txt ? JSON.parse(txt) : {};
      if (!r.ok) { var e = new Error(data.message || ("GitHub returned " + r.status)); e.status = r.status; throw e; }
      return data;
    };
  }

  function explain(e, repo) {
    if (/proxy/i.test(e.message || "")) return "A network proxy between this device and GitHub blocked the upload (" + e.message.replace(/\.$/, "") + "). Send from a network without that proxy, or use the bundle download and GitHub's upload page.";
    if (e.status === 401) return "GitHub rejected the token. Check it was copied in full and hasn't expired.";
    if (e.status === 403 || e.status === 404) return "The token can't write to " + repo + ". Give it access to that repository with Contents and Pull requests set to Read and write. The gk-research-group organization may also need to approve fine-grained tokens.";
    if (e.status === 422) return "GitHub refused the change: " + e.message + ".";
    if (e instanceof TypeError || /fetch|network|Load failed/i.test(e.message)) return "This page can't reach GitHub. The claude.ai viewer blocks it; open Trade Box from your computer or GitHub Pages, or download the bundle and use GitHub's upload page.";
    return e.message;
  }

  /* Create (or update) the branch and pull request. state: {branch, pr} from an earlier send of the same run, or null. */
  async function push(bundle, opts) {
    var repo = opts.repo || DEFAULT_REPO, api = opts.request, say = opts.progress || function () {}, state = opts.state || {};
    var enc = await encode(bundle, opts);
    say("Checking " + repo);
    var meta = await api("GET", "/repos/" + repo), base = opts.base || meta.default_branch;
    if (state.pr) {   // the repository's bot merges pull requests as they arrive: once merged or closed, later sends open a fresh one
      var open = true;
      try { open = (await api("GET", "/repos/" + repo + "/pulls/" + state.pr)).state === "open"; } catch (e) { if (e.status !== 404) throw e; open = false; }
      if (!open) state = { branch: null, pr: null, next: true };
    }
    var branch = state.branch || "trading-data-bot/" + bundle.kind + "-" + bundle.key + (state.next ? "-u" + Date.now().toString(36) : "");
    var headRef = null;
    if (state.branch) { try { headRef = await api("GET", "/repos/" + repo + "/git/ref/heads/" + encodeURIComponent(branch).replace(/%2F/g, "/")); } catch (e) { if (e.status !== 404) throw e; } }
    var baseRef = await api("GET", "/repos/" + repo + "/git/ref/heads/" + base), parentSha = headRef ? headRef.object.sha : baseRef.object.sha;
    var parent = await api("GET", "/repos/" + repo + "/git/commits/" + parentSha);
    var files = enc.files.slice();
    try { await api("GET", "/repos/" + repo + "/contents/" + SHELF + "/README.md?ref=" + base); }
    catch (e) { if (e.status === 404) files.push({ path: SHELF + "/README.md", bytes: utf8(shelfReadme(new Date().toISOString().slice(0, 10))) }); else throw e; }
    var tree = [];
    for (var k = 0; k < files.length; k++) {
      say("Uploading " + (k + 1) + " of " + files.length + ": " + files[k].path.split("/").pop());
      var blob = await api("POST", "/repos/" + repo + "/git/blobs", { content: base64(files[k].bytes), encoding: "base64" });
      tree.push({ path: files[k].path, mode: "100644", type: "blob", sha: blob.sha });
    }
    say("Committing");
    var t = await api("POST", "/repos/" + repo + "/git/trees", { base_tree: parent.tree.sha, tree: tree });
    var commit = await api("POST", "/repos/" + repo + "/git/commits", { message: bundle.title + "\n\nSent by the Trading data bot in Trade Box. " + files.length + " files, " + (enc.bytes / 1048576).toFixed(1) + " MB.", tree: t.sha, parents: [parentSha] });
    if (headRef) await api("PATCH", "/repos/" + repo + "/git/refs/heads/" + branch, { sha: commit.sha, force: false });
    else await api("POST", "/repos/" + repo + "/git/refs", { ref: "refs/heads/" + branch, sha: commit.sha });
    var body = bundle.intro + "\n\n" + bundle.facts.map(function (f) { return "- **" + f[0] + ":** " + f[1]; }).join("\n") + "\n\nAdds `" + bundle.dir + "` (" + files.length +
      " files, " + (enc.bytes / 1048576).toFixed(1) + " MB)." + (enc.omitted.length ? " Left out for size: " + enc.omitted.length + " table(s), listed in the folder README." : "") +
      "\n\nOpened by the **Trading data bot** in Trade Box (gkson-lab/trade).";
    var pr;
    if (state.pr) { pr = await api("PATCH", "/repos/" + repo + "/pulls/" + state.pr, { title: bundle.title, body: body }); }
    else {
      say("Opening the pull request");
      pr = await api("POST", "/repos/" + repo + "/pulls", { title: bundle.title, head: branch, base: base, body: body });
      try { await api("POST", "/repos/" + repo + "/issues/" + pr.number + "/labels", { labels: [LABEL] }); } catch (e) { /* labels are a nicety */ }
    }
    return { url: pr.html_url, pr: pr.number, branch: branch, commit: commit.sha, files: files.length, bytes: enc.bytes, omitted: enc.omitted, updated: !!state.pr };
  }

  /* Plain zip of the bundle for GitHub's upload page (fallback when the API can't be reached). */
  async function bundleZip(bundle, XLSX, opts) {
    var enc = await encode(bundle, opts || {}), C = XLSX.CFB, c = C.utils.cfb_new();
    try { C.utils.cfb_del(c, "\u0001Sh33tJ5"); } catch (e) { /* absent */ }
    enc.files.forEach(function (f) { C.utils.cfb_add(c, f.path.slice(bundle.dir.length), f.bytes); });
    return C.write(c, { fileType: "zip", type: "array", compression: false });
  }
  function uploadPage(repo, base, dir) { return "https://github.com/" + (repo || DEFAULT_REPO) + "/upload/" + (base || "main") + "/" + dir.replace(/\/$/, ""); }

  T.DocsPush = { DEFAULT_REPO: DEFAULT_REPO, SHELF: SHELF, LABEL: LABEL, simBundle: simBundle, finalBundle: finalBundle, push: push, encode: encode,
    fetchTransport: fetchTransport, explain: explain, bundleZip: bundleZip, uploadPage: uploadPage, shelfReadme: shelfReadme, header: header, footer: footer };
})(window.T = window.T || {});
