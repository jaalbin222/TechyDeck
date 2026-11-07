/* TechyDeck companion server. One document, role tokens, immutable revisions.
   Run: node server/server.js
   Binds to 127.0.0.1 only. GitHub Pages does not host this process. */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = Number(process.env.PORT || 8787);
var HOST = process.env.HOST || "127.0.0.1";
var DATA = process.env.TECHYDECK_DATA || path.join(__dirname, "data");
var ROLES = { owner: 4, editor: 3, commenter: 2, viewer: 1 };

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newId(bytes) {
  return crypto.randomBytes(bytes || 16).toString("hex");
}

function docPath(id) {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  return path.join(DATA, id + ".json");
}

function readDoc(id) {
  var file = docPath(id);
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeDoc(doc) {
  fs.mkdirSync(DATA, { recursive: true });
  var file = docPath(doc.id);
  var tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

function publicView(doc, role) {
  var head = doc.revisions[doc.revisions.length - 1];
  return {
    id: doc.id,
    role: role,
    revision: head.id,
    title: head.title,
    sourceHtml: head.sourceHtml,
    comments: head.comments,
    updatedAt: head.at,
    revisionCount: doc.revisions.length
  };
}

function auth(req, doc) {
  var header = req.headers.authorization || "";
  var match = /^Bearer\s+([a-f0-9]+)$/i.exec(header);
  if (!match) return null;
  var hashed = hashToken(match[1]);
  for (var i = 0; i < doc.tokens.length; i++) {
    if (doc.tokens[i].hash === hashed) return doc.tokens[i].role;
  }
  return null;
}

function allow(role, minimum) {
  return !!role && ROLES[role] >= ROLES[minimum];
}

function send(res, code, body, extra) {
  var headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, if-match",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-expose-headers": "etag",
    "cache-control": "no-store"
  };
  if (extra) Object.keys(extra).forEach(function (key) { headers[key] = extra[key]; });
  res.writeHead(code, headers);
  res.end(body == null ? "" : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > (limit || 2000000)) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (err) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function cleanComments(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (item) {
    return item && typeof item.id === "string" && /^td-a\d+$/.test(item.anchorId) && typeof item.body === "string";
  }).slice(0, 200).map(function (item) {
    return {
      id: String(item.id).slice(0, 40),
      anchorId: item.anchorId,
      body: String(item.body).slice(0, 4000),
      author: String(item.author || "Colleague").slice(0, 80),
      createdAt: Number(item.createdAt) || Date.now()
    };
  });
}

function pushRevision(doc, title, sourceHtml, comments) {
  var rev = {
    id: newId(8),
    at: Date.now(),
    title: String(title || "Untitled deck").slice(0, 160),
    sourceHtml: String(sourceHtml || ""),
    comments: cleanComments(comments)
  };
  doc.revisions.push(rev);
  if (doc.revisions.length > 30) doc.revisions = doc.revisions.slice(-30);
  return rev;
}

function ifMatchOk(req, doc) {
  var head = doc.revisions[doc.revisions.length - 1];
  var match = req.headers["if-match"];
  if (!match) return false;
  return match.replace(/"/g, "") === head.id;
}

var server = http.createServer(function (req, res) {
  if (req.method === "OPTIONS") return send(res, 204, null);
  var url = new URL(req.url, "http://127.0.0.1");
  var parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "techydeck" });
  }

  if (req.method === "POST" && url.pathname === "/api/documents") {
    readBody(req).then(function (body) {
      if (typeof body.sourceHtml !== "string" || !body.sourceHtml.trim()) {
        return send(res, 400, { error: "sourceHtml required" });
      }
      var id = newId(12);
      var token = newId(24);
      var doc = { id: id, tokens: [{ hash: hashToken(token), role: "owner" }], revisions: [] };
      pushRevision(doc, body.title, body.sourceHtml, body.comments);
      writeDoc(doc);
      send(res, 201, { token: token, document: publicView(doc, "owner") });
    }).catch(function () { send(res, 400, { error: "bad request" }); });
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "documents" || !parts[2]) {
    return send(res, 404, { error: "not found" });
  }
  var doc = readDoc(parts[2]);
  if (!doc) return send(res, 404, { error: "not found" });
  var role = auth(req, doc);
  if (!role) return send(res, 401, { error: "unauthorized" });
  var head = doc.revisions[doc.revisions.length - 1];

  if (req.method === "GET" && parts.length === 3) {
    res.setHeader("etag", '"' + head.id + '"');
    return send(res, 200, publicView(doc, role), { etag: '"' + head.id + '"' });
  }

  if (req.method === "GET" && parts[3] === "revisions" && parts.length === 4) {
    return send(res, 200, {
      revision: head.id,
      revisions: doc.revisions.map(function (rev) {
        return { id: rev.id, at: rev.at, title: rev.title, commentCount: rev.comments.length };
      })
    });
  }

  if (req.method === "PUT" && parts.length === 3) {
    if (!allow(role, "editor")) return send(res, 403, { error: "viewers and commenters cannot edit the deck" });
    readBody(req).then(function (body) {
      if (!ifMatchOk(req, doc)) {
        return send(res, 409, { error: "conflict", current: publicView(doc, role) });
      }
      if (typeof body.sourceHtml !== "string") return send(res, 400, { error: "sourceHtml required" });
      pushRevision(doc, body.title || head.title, body.sourceHtml, body.comments || head.comments);
      writeDoc(doc);
      send(res, 200, publicView(doc, role));
    }).catch(function () { send(res, 400, { error: "bad request" }); });
    return;
  }

  if (req.method === "POST" && parts[3] === "comments" && parts.length === 4) {
    if (!allow(role, "commenter")) return send(res, 403, { error: "viewers cannot comment" });
    readBody(req).then(function (body) {
      if (!ifMatchOk(req, doc)) {
        return send(res, 409, { error: "conflict", current: publicView(doc, role) });
      }
      if (!body || typeof body.body !== "string" || !/^td-a\d+$/.test(body.anchorId || "")) {
        return send(res, 400, { error: "anchorId and body required" });
      }
      var comments = head.comments.slice();
      comments.push({
        id: "c" + newId(6),
        anchorId: body.anchorId,
        body: String(body.body).slice(0, 4000),
        author: String(body.author || role).slice(0, 80),
        createdAt: Date.now()
      });
      pushRevision(doc, head.title, head.sourceHtml, comments);
      writeDoc(doc);
      send(res, 201, publicView(doc, role));
    }).catch(function () { send(res, 400, { error: "bad request" }); });
    return;
  }

  if (req.method === "POST" && parts[3] === "revisions" && parts[5] === "restore" && parts.length === 6) {
    if (!allow(role, "editor")) return send(res, 403, { error: "only an editor can restore" });
    var prior = null;
    for (var i = 0; i < doc.revisions.length; i++) {
      if (doc.revisions[i].id === parts[4]) prior = doc.revisions[i];
    }
    if (!prior) return send(res, 404, { error: "revision not found" });
    pushRevision(doc, prior.title, prior.sourceHtml, prior.comments);
    writeDoc(doc);
    return send(res, 200, publicView(doc, role));
  }

  if (req.method === "POST" && parts[3] === "invites" && parts.length === 4) {
    if (role !== "owner") return send(res, 403, { error: "only the owner can invite" });
    readBody(req).then(function (body) {
      var inviteRole = body && body.role;
      if (!ROLES[inviteRole] || inviteRole === "owner") {
        return send(res, 400, { error: "role must be editor, commenter, or viewer" });
      }
      var token = newId(24);
      doc.tokens.push({ hash: hashToken(token), role: inviteRole });
      writeDoc(doc);
      send(res, 201, { token: token, role: inviteRole, documentId: doc.id });
    }).catch(function () { send(res, 400, { error: "bad request" }); });
    return;
  }

  send(res, 404, { error: "not found" });
});

if (require.main === module) {
  server.listen(PORT, HOST, function () {
    console.log("TechyDeck server on http://" + HOST + ":" + PORT);
  });
}

module.exports = { server: server, newId: newId, hashToken: hashToken };
