/* node server/test-api.js */
"use strict";

var http = require("http");
var fs = require("fs");
var os = require("os");
var path = require("path");

var dir = fs.mkdtempSync(path.join(os.tmpdir(), "techydeck-"));
process.env.TECHYDECK_DATA = dir;
process.env.PORT = "0";
var server = require("./server.js").server;

function req(port, method, urlPath, token, body, extra) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    if (extra) Object.keys(extra).forEach(function (key) { headers[key] = extra[key]; });
    var r = http.request({
      host: "127.0.0.1",
      port: port,
      method: method,
      path: urlPath,
      headers: headers
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (err) { json = { raw: text }; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function check(name, cond, extra) {
  if (!cond) {
    console.error("FAIL", name, extra || "");
    process.exitCode = 1;
  } else {
    console.log("PASS", name);
  }
}

server.listen(0, "127.0.0.1", function () {
  var port = server.address().port;
  var html = "<!DOCTYPE html><html><head><title>T</title></head><body><h1 data-td-anchor=\"td-a1\" data-td-kind=\"text\">Hello</h1><script>function keep(){return 1;}</script></body></html>";
  var owner, docId, rev, editorToken, commenterToken, viewerToken;
  req(port, "GET", "/api/health").then(function (res) {
    check("health", res.status === 200 && res.json.ok === true);
    return req(port, "POST", "/api/documents", null, { title: "T", sourceHtml: html, comments: [] });
  }).then(function (res) {
    check("owner create", res.status === 201 && res.json.token && res.json.document.role === "owner");
    owner = res.json.token;
    docId = res.json.document.id;
    rev = res.json.document.revision;
    check("script preserved on create", res.json.document.sourceHtml.indexOf("function keep") !== -1);
    return req(port, "GET", "/api/documents/" + docId);
  }).then(function (res) {
    check("anonymous read denied", res.status === 401);
    return req(port, "POST", "/api/documents/" + docId + "/invites", owner, { role: "editor" });
  }).then(function (res) {
    check("owner invites editor", res.status === 201 && res.json.role === "editor");
    editorToken = res.json.token;
    return req(port, "POST", "/api/documents/" + docId + "/invites", owner, { role: "commenter" });
  }).then(function (res) {
    commenterToken = res.json.token;
    return req(port, "POST", "/api/documents/" + docId + "/invites", owner, { role: "viewer" });
  }).then(function (res) {
    viewerToken = res.json.token;
    return req(port, "POST", "/api/documents/" + docId + "/invites", editorToken, { role: "viewer" });
  }).then(function (res) {
    check("editor cannot invite", res.status === 403);
    return req(port, "PUT", "/api/documents/" + docId, viewerToken, { title: "T", sourceHtml: html.replace("Hello", "Nope"), comments: [] }, { "if-match": rev });
  }).then(function (res) {
    check("viewer write denied", res.status === 403);
    return req(port, "POST", "/api/documents/" + docId + "/comments", viewerToken, { anchorId: "td-a1", body: "no", author: "V" }, { "if-match": rev });
  }).then(function (res) {
    check("viewer comment denied", res.status === 403);
    return req(port, "PUT", "/api/documents/" + docId, commenterToken, { title: "T", sourceHtml: html.replace("Hello", "Nope"), comments: [] }, { "if-match": rev });
  }).then(function (res) {
    check("commenter write denied", res.status === 403);
    return req(port, "POST", "/api/documents/" + docId + "/comments", commenterToken, { anchorId: "td-a1", body: "Check this figure", author: "Casey" }, { "if-match": rev });
  }).then(function (res) {
    check("commenter can comment", res.status === 201 && res.json.comments.length === 1 && res.json.comments[0].anchorId === "td-a1");
    rev = res.json.revision;
    check("comment keeps html", res.json.sourceHtml.indexOf("Hello") !== -1 && res.json.sourceHtml.indexOf("function keep") !== -1);
    return req(port, "PUT", "/api/documents/" + docId, editorToken, { title: "T", sourceHtml: html.replace("Hello", "Hello team"), comments: res.json.comments }, { "if-match": "stale-revision" });
  }).then(function (res) {
    check("stale write conflicts", res.status === 409 && res.json.current && res.json.current.revision === rev);
    return req(port, "PUT", "/api/documents/" + docId, editorToken, { title: "T", sourceHtml: html.replace("Hello", "Hello team"), comments: res.json.current.comments }, { "if-match": rev });
  }).then(function (res) {
    check("editor save", res.status === 200 && res.json.sourceHtml.indexOf("Hello team") !== -1);
    rev = res.json.revision;
    return req(port, "GET", "/api/documents/" + docId + "/revisions", viewerToken);
  }).then(function (res) {
    check("viewer can list revisions", res.status === 200 && res.json.revisions.length >= 3);
    var first = res.json.revisions[0].id;
    return req(port, "POST", "/api/documents/" + docId + "/revisions/" + first + "/restore", commenterToken);
  }).then(function (res) {
    check("commenter cannot restore", res.status === 403);
    return req(port, "GET", "/api/documents/" + docId + "/revisions", owner);
  }).then(function (res) {
    var first = res.json.revisions[0].id;
    var before = res.json.revisions.length;
    return req(port, "POST", "/api/documents/" + docId + "/revisions/" + first + "/restore", editorToken).then(function (restored) {
      check("editor restore keeps old and adds head", restored.status === 200 && restored.json.revisionCount === before + 1);
      check("restored text is original", restored.json.sourceHtml.indexOf(">Hello<") !== -1);
      check("script still present after restore", restored.json.sourceHtml.indexOf("function keep") !== -1);
      return req(port, "GET", "/api/documents/" + docId + "/revisions", owner);
    });
  }).then(function (res) {
    var ids = res.json.revisions.map(function (item) { return item.id; });
    check("restore does not delete prior revisions", ids.length >= 4 && new Set(ids).size === ids.length);
    server.close();
    if (process.exitCode) console.error("api tests failed");
    else console.log("ALL API TESTS PASSED");
  }).catch(function (err) {
    console.error(err);
    process.exitCode = 1;
    server.close();
  });
});
