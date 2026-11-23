/* Update checker: asks GitHub for the newest commit on the published branch every 5-10 minutes
 * (random interval, so many open tabs don't all poll at once) and offers a reload when it changes.
 * Uses the public REST API without a token (60 requests/hour/IP; this uses at most 12).
 * Configure with <meta name="update-repo" content="owner/repo"> and <meta name="update-branch" content="main">. */
(function (T) {
  "use strict";

  function meta(name, dflt) { var m = document.querySelector('meta[name="' + name + '"]'); return (m && m.content) || dflt; }
  var REPO = meta("update-repo", "gkson-lab/trade");
  var BRANCH = meta("update-branch", "main");
  var MIN_MS = 5 * 60 * 1000, MAX_MS = 10 * 60 * 1000;
  var KEY = "tb-update-base:" + REPO + "@" + BRANCH;

  var state = { base: null, latest: null, lastCheck: 0, nextAt: 0, timer: 0, dismissed: null, error: null };

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function fetchLatest() {
    var url = "https://api.github.com/repos/" + REPO + "/commits/" + encodeURIComponent(BRANCH);
    return fetch(url, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" }).then(function (r) {
      if (r.status === 403 || r.status === 429) throw new Error("GitHub rate limit reached; will retry");
      if (!r.ok) throw new Error("GitHub returned " + r.status);
      return r.json();
    }).then(function (c) {
      return { sha: c.sha, short: c.sha.slice(0, 7), message: String((c.commit && c.commit.message) || "").split("\n")[0],
        date: c.commit && c.commit.committer ? c.commit.committer.date : "", url: c.html_url };
    });
  }

  function schedule() {
    clearTimeout(state.timer);
    var wait = MIN_MS + Math.random() * (MAX_MS - MIN_MS);
    state.nextAt = Date.now() + wait;
    state.timer = setTimeout(check, wait);
  }

  function check() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) { schedule(); return Promise.resolve(); }
    return fetchLatest().then(function (c) {
      state.lastCheck = Date.now(); state.latest = c; state.error = null;
      // the first answer is the version this page was loaded with (remembered across reloads of the same build)
      if (!state.base) state.base = store(KEY) || c.sha;
      if (!store(KEY)) store(KEY, state.base);
      if (c.sha !== state.base && c.sha !== state.dismissed) show(c);
      render();
    }).catch(function (e) { state.error = e.message; state.lastCheck = Date.now(); render(); })
      .then(schedule);
  }

  function el(id) { return document.getElementById(id); }

  function show(c) {
    var bar = el("updateBar");
    if (!bar) return;
    el("updateText").textContent = "Update available on GitHub: " + c.short + " " + c.message + (c.date ? " (" + c.date.slice(0, 16).replace("T", " ") + " UTC)" : "");
    bar.hidden = false;
  }

  function render() {
    var s = el("updateStatus");
    if (!s) return;
    var t = state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
    s.textContent = state.error ? "Update check failed: " + state.error : "Checked GitHub " + t + (state.latest ? " · " + state.latest.short : "");
  }

  function applyUpdate() {
    store(KEY, state.latest ? state.latest.sha : "");
    var jobs = [];
    if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
    if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.update(); })); }));
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }

  function init() {
    var reload = el("btnUpdate"), later = el("btnUpdateLater");
    if (reload) reload.addEventListener("click", function () {
      if (T.app && T.app.running && !confirm("Reloading ends the current run. Download its data first from the Data button. Reload now?")) return;
      applyUpdate();
    });
    if (later) later.addEventListener("click", function () { state.dismissed = state.latest && state.latest.sha; el("updateBar").hidden = true; });
    // catch up right away when a hidden tab comes back after its check was due
    document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() > state.nextAt) { clearTimeout(state.timer); check(); } });
    window.addEventListener("online", function () { clearTimeout(state.timer); check(); });
    check();
  }

  T.updates = { state: state, check: check, init: init, repo: REPO, branch: BRANCH };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(window.T = window.T || {});
