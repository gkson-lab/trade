/* Trading data bot button and dialog: opens (or updates) a pull request with the bots' data in the internal
 * documents repository, by hand or automatically when a run or a training finishes. */
(function (T) {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var D = T.DocsPush, U = T.ui;
  var K = { token: "tb-docs-token", repo: "tb-docs-repo", base: "tb-docs-base", auto: "tb-docs-auto", every: "tb-docs-every" };
  var S = { sending: false, queued: null, lastFinal: null, finalPractice: false, watched: null };

  function get(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { if (v === null) window[store].removeItem(k); else window[store].setItem(k, v); } catch (e) { /* storage blocked */ } }
  function token() { return $("docsToken").value.trim() || get("sessionStorage", K.token) || get("localStorage", K.token) || ""; }
  function saveSettings() {
    var t = $("docsToken").value.trim();
    if (t) { set("sessionStorage", K.token, t); set("localStorage", K.token, $("docsRemember").checked ? t : null); }
    else if (!$("docsRemember").checked) set("localStorage", K.token, null);
    set("localStorage", K.repo, $("docsRepo").value.trim());
    set("localStorage", K.base, $("docsBase").value.trim());
    set("localStorage", K.auto, $("docsAuto").checked ? "1" : "0");
    set("localStorage", K.every, $("docsEvery").value);
    $("dataBotDot").hidden = !$("docsAuto").checked;
  }
  function repo() { return $("docsRepo").value.trim() || D.DEFAULT_REPO; }
  function base() { return $("docsBase").value.trim() || "main"; }

  function status(msg, url) {
    var s = $("docsStatus"); while (s.firstChild) s.removeChild(s.firstChild);
    s.appendChild(document.createTextNode(msg));
    if (url) { var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = url.replace(/^https:\/\/github\.com\//, ""); s.appendChild(document.createTextNode(" ")); s.appendChild(a); }
  }
  function err(m) { var e = $("docsErr"); e.textContent = m || ""; e.hidden = !m; }

  function bundleFor(what) {
    if (what === "final") { if (!S.lastFinal) throw new Error("No final training yet. Train the bot in final training mode first."); return D.finalBundle(S.lastFinal, S.finalPractice); }
    var sim = T.app && T.app.sim;
    if (!sim || !sim.log.generations.length) throw new Error("No finished generation yet. Run the simulation for at least one generation first.");
    return D.simBundle(sim);
  }

  /* Send one bundle. Sim runs keep their branch and pull request so later sends update them. */
  async function send(what, auto) {
    if (S.sending) { S.queued = what; return; }
    var tok = token();
    if (!tok) { if (!auto) err("Paste a GitHub token first (see How to make a token), or use the bundle download."); else U.setStatus("Trading data bot: no GitHub token set, so nothing was sent. Open Trading data bot to add one."); return; }
    var sim = T.app && T.app.sim, b;
    try { b = bundleFor(what); } catch (e) { if (!auto) err(e.message); return; }
    S.sending = true; err(""); $("btnDataBot").classList.add("sending"); $("btnDocsSend").disabled = true;
    try {
      var r = await D.push(b, { repo: repo(), base: base(), request: D.fetchTransport(tok), state: what === "sim" ? sim.docsState : null,
        progress: function (m) { status(m); U.setStatus("Trading data bot: " + m); } });
      if (what === "sim") sim.docsState = { branch: r.branch, pr: r.pr };
      status((r.updated ? "Updated pull request #" : "Opened pull request #") + r.pr + " with " + r.files + " files (" + (r.bytes / 1048576).toFixed(1) + " MB)." +
        (r.omitted.length ? " " + r.omitted.length + " big table(s) left out for size, listed in the README." : ""), r.url);
      U.setStatus("Trading data bot: " + (r.updated ? "updated" : "opened") + " pull request #" + r.pr + " in " + repo() + ".");
    } catch (e) {
      var msg = D.explain(e, repo());
      err(msg); status(""); U.setStatus("Trading data bot: not sent. " + msg);
    } finally {
      S.sending = false; $("btnDataBot").classList.remove("sending"); $("btnDocsSend").disabled = false;
      if (S.queued) { var q = S.queued; S.queued = null; send(q, true); }
    }
  }

  function refreshLabels() {
    var sim = T.app && T.app.sim, g = sim ? sim.log.generations.length : 0;
    $("docsSimLabel").textContent = "This simulation run (" + g + " finished generation" + (g === 1 ? "" : "s") + (sim && sim.docsState ? ", pull request #" + sim.docsState.pr + " will be updated" : "") + ")";
    $("docsFinalLabel").textContent = S.lastFinal ? "Latest final training (" + S.lastFinal.data.list.length + " symbols" + (S.finalPractice ? ", practice data" : "") + ")" : "Latest final training results (none yet)";
    $("docsWhatFinal").disabled = !S.lastFinal;
    if (document.body.classList.contains("final-mode") && S.lastFinal) $("docsWhatFinal").checked = true;
    else if (!S.lastFinal || !document.body.classList.contains("final-mode")) $("docsWhatSim").checked = true;
    // the upload page opens on the folder this kind of data goes to (building the full bundle here would be slow)
    var dir = D.SHELF + ($("docsWhatFinal").checked ? "/final-training/" : "/simulation-runs/" + (sim && sim.docsKey ? sim.docsKey + "/" : ""));
    $("docsUpload").href = D.uploadPage(repo(), base(), dir);
  }

  /* Automatic sending: watch each new simulation, and every finished final training. */
  function watch(sim) {
    if (!sim || S.watched === sim) return;
    S.watched = sim;
    sim.on(function (type, d) {
      if ($("docsAuto").checked === false) return;
      var every = Math.max(1, +$("docsEvery").value || 25);
      if (type === "done") send("sim", true);
      else if (type === "generation" && sim.forever && d.summary.gen % every === 0 && !d.final) send("sim", true);
    });
  }
  T.onSimBuilt = watch;
  T.onFinalTrained = function (res, practice) { S.lastFinal = res; S.finalPractice = practice; if ($("docsAuto").checked) send("final", true); };

  function wire() {
    $("docsRepo").value = get("localStorage", K.repo) || D.DEFAULT_REPO;
    $("docsBase").value = get("localStorage", K.base) || "main";
    $("docsAuto").checked = get("localStorage", K.auto) !== "0";   // on unless you turned it off
    $("docsEvery").value = get("localStorage", K.every) || "25";
    $("docsRemember").checked = !!get("localStorage", K.token);
    $("dataBotDot").hidden = !$("docsAuto").checked;
    $("btnDataBot").addEventListener("click", function () {
      $("docsToken").value = token(); err(""); refreshLabels(); $("dlgDocs").showModal();
    });
    $("btnCloseDocs").addEventListener("click", function () { saveSettings(); $("dlgDocs").close(); });
    $("dlgDocs").addEventListener("close", saveSettings);
    ["docsWhatSim", "docsWhatFinal", "docsRepo", "docsBase"].forEach(function (id) { $(id).addEventListener("change", refreshLabels); });
    $("docsAuto").addEventListener("change", saveSettings);
    $("formDocs").addEventListener("submit", function (e) { e.preventDefault(); saveSettings(); send($("docsWhatFinal").checked ? "final" : "sim", false); });
    $("btnDocsZip").addEventListener("click", function () {
      if (!window.XLSX) { err("The zip writer is still loading. Try again in a moment."); return; }
      var what = $("docsWhatFinal").checked ? "final" : "sim", b;
      try { b = bundleFor(what); } catch (x) { err(x.message); return; }
      err(""); status("Building the bundle…");
      D.bundleZip(b, window.XLSX, {}).then(function (bytes) {
        U.download(b.dir.split("/").slice(-2, -1)[0] + ".zip", new Blob([bytes], { type: "application/zip" }));
        status("Bundle ready. On GitHub's upload page, drop in the unzipped files; they go into " + b.dir + ".");
        $("docsUpload").href = D.uploadPage(repo(), base(), b.dir);
      }).catch(function (x) { err(x.message); status(""); });
    });
    watch(T.app && T.app.sim);
  }
  wire();
  T.docsUI = S;
})(window.T = window.T || {});
