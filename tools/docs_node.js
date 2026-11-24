/* Node side of the Trading data bot: picks a way to talk to GitHub and sends bundles.
 * Token from DOCS_TOKEN, GH_TOKEN or GITHUB_TOKEN; otherwise the GitHub CLI's login (`gh auth login`). */
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

module.exports = { send: send, transport: transport };
