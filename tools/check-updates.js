#!/usr/bin/env node
/* Checks GitHub for new commits every 5-10 minutes (random interval) and reports them.
 *   node tools/check-updates.js                 watch the current branch, report new commits
 *   node tools/check-updates.js --pull          also fast-forward this clone when the working tree is clean
 *   node tools/check-updates.js --branch main   watch another branch
 *   node tools/check-updates.js --once          check once and exit (exit code 10 = update available)
 * Run it from inside your clone of the repo. */
"use strict";
var cp = require("child_process"), path = require("path");

var args = {};
process.argv.slice(2).forEach(function (a, i, arr) { if (a.indexOf("--") === 0) args[a.slice(2)] = arr[i + 1] && arr[i + 1].indexOf("--") !== 0 ? arr[i + 1] : true; });
var cwd = path.resolve(args.dir || path.join(__dirname, ".."));
var MIN = 5 * 60 * 1000, MAX = 10 * 60 * 1000;

function git(a) { return cp.execFileSync("git", a, { cwd: cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

var branch = args.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);
var remote = args.remote || "origin";

function check() {
  try {
    git(["fetch", "--quiet", remote, "+refs/heads/" + branch + ":refs/remotes/" + remote + "/" + branch]);
  } catch (e) {
    console.log(stamp() + "  fetch failed: " + String(e.stderr || e.message).trim().split("\n")[0]);
    return false;
  }
  var head = git(["rev-parse", "HEAD"]), up = git(["rev-parse", remote + "/" + branch]);
  if (head === up) { console.log(stamp() + "  up to date on " + branch + " (" + head.slice(0, 7) + ")"); return false; }
  var ahead = git(["rev-list", "--count", "HEAD.." + remote + "/" + branch]);
  if (ahead === "0") { console.log(stamp() + "  local " + branch + " has commits GitHub doesn't; nothing to pull"); return false; }
  console.log(stamp() + "  " + ahead + " new commit(s) on " + remote + "/" + branch + ":");
  console.log(git(["log", "--format=    %h %an, %ar: %s", "HEAD.." + remote + "/" + branch]));
  if (args.pull) {
    if (git(["status", "--porcelain"])) console.log("    not pulling: you have uncommitted changes");
    else {
      try { git(["merge", "--ff-only", remote + "/" + branch]); console.log("    pulled, now at " + git(["rev-parse", "--short", "HEAD"])); }
      catch (e) { console.log("    not pulling: branches have diverged, pull by hand"); }
    }
  }
  return true;
}

if (args.once) process.exit(check() ? 10 : 0);

console.log("Watching " + remote + "/" + branch + " in " + cwd + " every 5-10 minutes" + (args.pull ? ", auto-pulling" : "") + ". Ctrl+C to stop.");
(function loop() {
  check();
  var wait = MIN + Math.random() * (MAX - MIN);
  console.log("    next check in " + (wait / 60000).toFixed(1) + " min");
  setTimeout(loop, wait);
})();
