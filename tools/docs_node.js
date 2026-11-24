/* Node side of the Trading data bot: picks a way to talk to GitHub and sends bundles.
 * Token from DOCS_TOKEN, GH_TOKEN or GITHUB_TOKEN; otherwise (or with DOCS_USE_GH=1) the GitHub CLI's login. */
"use strict";
var cp = require("child_process"), zlib = require("zlib");

function ghTransport() {
  return async function (method, path, body) {
    var res = cp.spawnSync("gh", ["api", "-X", method, path.replace(/^\//, ""), "-H", "Accept: application/vnd.github+json"].concat(body ? ["--input", "-"] : []),
      { input: body ? JSON.stringify(body) : undefined, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (res.error) throw new Error("Couldn't run the GitHub CLI (gh). Install it and run `gh auth login`, or set DOCS_TOKEN.");
    if (res.status !== 0) {
      var m = /HTTP (\d{3})/.exec(res.stderr || ""), e = new Error(((res.stdout && safeMessage(res.stdout)) || res.stderr || "gh api failed").trim());
      e.status = m ? +m[1] : 0; throw e;
    }
    return res.stdout ? JSON.parse(res.stdout) : {};
  };
}
function safeMessage(t) { try { return JSON.parse(t).message; } catch (e) { return ""; } }

function transport() {
  // DOCS_USE_GH=1 forces the GitHub CLI (useful behind a proxy, which Node's fetch ignores)
  if (process.env.DOCS_USE_GH) return ghTransport();
  var token = process.env.DOCS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return token ? global.T.DocsPush.fetchTransport(token) : ghTransport();
}

async function send(bundle, opts) {
  var D = global.T.DocsPush, repo = opts.repo || D.DEFAULT_REPO;
  try {
    var r = await D.push(bundle, { repo: repo, base: opts.base, request: transport(), zlib: zlib, state: opts.state, link: opts.link,
      progress: opts.quiet ? null : function (m) { process.stdout.write("\r  Trading data bot: " + m + "                    "); } });
    if (!opts.quiet) process.stdout.write("\n");
    return r;
  } catch (e) {
    if (!opts.quiet) process.stdout.write("\n");
    throw new Error("Trading data bot: " + D.explain(e, repo));
  }
}

/* Same bundle through a local clone: write files, commit on a branch, git push, open (or update) the PR with gh.
 * For machines with git credentials and the GitHub CLI login but no API token. */
async function sendViaGit(bundle, opts) {
  var D = global.T.DocsPush, dir = opts.git, fs = require("fs"), path = require("path"), repo = opts.repo || D.DEFAULT_REPO;
  function git(args) { var r = cp.spawnSync("git", ["-C", dir].concat(args), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error("git " + args[0] + ": " + (r.stderr || r.stdout).trim()); return r.stdout.trim(); }
  var base = opts.base || "main", state = opts.state || {}, branch = state.branch || "trading-data-bot/" + bundle.kind + "-" + bundle.key;
  var enc = await D.encode(bundle, { zlib: zlib, link: opts.link });
  git(["fetch", "--depth", "1", "origin", base]);
  if (state.branch) { git(["fetch", "--depth", "1", "origin", branch]); git(["checkout", "-B", branch, "origin/" + branch]); }
  else git(["checkout", "-B", branch, "origin/" + base]);
  var files = enc.files.slice(), shelfReadme = path.join(dir, D.SHELF, "README.md");
  if (!fs.existsSync(shelfReadme)) files.push({ path: D.SHELF + "/README.md", bytes: Buffer.from(D.shelfReadme(new Date().toISOString().slice(0, 10))) });
  files.forEach(function (f) { var p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(f.bytes)); });
  git(["add", "--", D.SHELF]);
  git(["commit", "-q", "-m", bundle.title, "-m", "Sent by the Trading data bot in Trade Box. " + files.length + " files, " + (enc.bytes / 1048576).toFixed(1) + " MB."]);
  git(["-c", "push.negotiate=true", "push", "-q", "-u", "origin", branch]);
  var body = bundle.intro + "\n\n" + bundle.facts.map(function (f) { return "- **" + f[0] + ":** " + f[1]; }).join("\n") + "\n\nAdds `" + bundle.dir + "` (" + files.length +
    " files, " + (enc.bytes / 1048576).toFixed(1) + " MB).\n\nOpened by the **Trading data bot** in Trade Box (gkson-lab/trade).";
  var api = ghTransport(), pr;
  if (state.pr) pr = await api("PATCH", "/repos/" + repo + "/pulls/" + state.pr, { title: bundle.title, body: body });
  else {
    pr = await api("POST", "/repos/" + repo + "/pulls", { title: bundle.title, head: branch, base: base, body: body });
    try { await api("POST", "/repos/" + repo + "/issues/" + pr.number + "/labels", { labels: [D.LABEL] }); } catch (e) { /* labels are a nicety */ }
  }
  return { url: pr.html_url, pr: pr.number, branch: branch, files: files.length, bytes: enc.bytes, omitted: enc.omitted, updated: !!state.pr };
}

async function sendAny(bundle, opts) {
  if (!opts.git) return send(bundle, opts);
  try { return await sendViaGit(bundle, opts); }
  catch (e) { throw new Error("Trading data bot: " + global.T.DocsPush.explain(e, opts.repo || global.T.DocsPush.DEFAULT_REPO)); }
}

module.exports = { send: sendAny, transport: transport };
