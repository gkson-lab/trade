#!/usr/bin/env node
/* Pack the app into one self-contained HTML file (CSS, code, symbol data and the spreadsheet library inlined).
 *   node tools/build_single.js              -> dist/trade-box.html   (open from phone storage, no server needed)
 *   node tools/build_single.js --artifact   -> page body for a claude.ai artifact (the hosted phone link) */
"use strict";
var fs = require("fs"), path = require("path");
var root = path.join(__dirname, ".."), artifact = process.argv.indexOf("--artifact") >= 0;
var outArg = process.argv.indexOf("--out");
var out = outArg >= 0 ? process.argv[outArg + 1] : path.join(root, "dist", artifact ? "trade-box-artifact.html" : "trade-box.html");

var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }
function js(rel) { return "<script>/* " + rel + " */\n" + read(rel).replace(/<\/script/gi, "<\\/script").replace(/\uFFFD/g, "\\uFFFD") + "\n</script>"; }

html = html.replace('<link rel="stylesheet" href="css/app.css">', function () { return "<style>\n" + read("css/app.css") + "\n</style>"; });
html = html.replace(/<script src="([^"]+)"( defer)?><\/script>/g, function (m, src) {
  if (artifact && src === "js/updates.js") return "";        // the viewer blocks calls to GitHub; the link itself gets republished
  return js(src);
});
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "");
var icon = "data:image/svg+xml;base64," + Buffer.from(read("icon.svg")).toString("base64");
html = html.replace('<link rel="icon" href="icon.svg" type="image/svg+xml">', artifact ? "" : '<link rel="icon" href="' + icon + '" type="image/svg+xml">');

if (artifact) {
  // The artifact host supplies doctype/html/head/body; hand it the head tags and body content only.
  var head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>\n?/, "").replace(/<meta name="viewport"[^>]*>\n?/, "");
  var body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  html = head.trim() + "\n" + body.trim() + "\n";
  html = html.replace(/<meta name="update-(repo|branch)"[^>]*>\n?/g, "").replace(/<span id="updateStatus">[^<]*<\/span> · /, "");
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log("Wrote " + out + " (" + (Buffer.byteLength(html) / 1048576).toFixed(2) + " MB)");
