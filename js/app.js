/* TechyDeck editor. The deck HTML is the source of truth; the iframe is a sandboxed view. */
(function () {
  var STORAGE_KEY = "techydeck.autosave.v2";
  var LEGACY_KEY = "techydeck.autosave.v1";
  var REV_KEY = "techydeck.revisions.v1";
  var API_KEY = "techydeck.api";
  var SHARE_LIMIT = 48000;
  var MAX_HISTORY = 60;
  var SAMPLES = {
    quarterly: { url: "samples/quarterly-review.html", name: "Q3 board review" },
    launch: { url: "samples/fieldnote-launch.html", name: "Fieldnote launch" },
    calculator: { url: "samples/calculator.html", name: "Pricing calculator" },
    chart: { url: "samples/svg-chart.html", name: "SVG chart" }
  };
  var NOTE_HTML = [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"utf-8\"><title>Client note</title>",
    "<style>body{margin:0;font-family:Georgia,serif;background:#f7f4ee;color:#1c1915}",
    "article{max-width:680px;margin:0 auto;padding:64px 28px}",
    "h1{font-weight:500;font-size:44px;letter-spacing:-.03em}",
    "img{width:120px;height:120px;border-radius:12px}</style></head>",
    "<body><article>",
    "<img alt=\"Mark\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' rx='12' fill='%231e4d38'/%3E%3C/svg%3E\">",
    "<h1>Monday note for Northwind</h1>",
    "<p>The pilot starts 3 November with 40 seats. The success number to edit is 18 active teams by day 30.</p>",
    "<p>This page has no slide markup, so TechyDeck treats it as one document.</p>",
    "</article></body></html>"
  ].join("");

  var FRAME_CSS = [
    "html.td-slide-host:not(.td-printing) .td-slide:not(.td-active){display:none!important}",
    "html.td-slide-host,html.td-slide-host body{margin:0!important;overflow:hidden!important}",
    "html.td-slide-host .td-slide.td-active{box-sizing:border-box!important;height:100vh!important;max-height:100vh!important;min-height:0!important;overflow:auto!important}",
    "html.td-editing .td-hover{outline:2px solid rgba(30,77,56,.9);outline-offset:3px;cursor:text}",
    "html.td-editing img.td-hover{outline:2px dashed #9a3f1d;outline-offset:4px;cursor:pointer}",
    "html.td-editing [contenteditable='true']{outline:2px solid #1e4d38;outline-offset:3px;caret-color:#1e4d38}",
    "html.td-commenting [data-td-anchor]{cursor:cell}",
    "@media print{",
    "html.td-slide-host,html.td-slide-host body{overflow:visible!important;height:auto!important}",
    "html.td-slide-host .td-slide,html.td-slide-host .td-slide.td-active{display:flex!important;flex-direction:column;height:auto!important;max-height:none!important;min-height:160mm!important;overflow:visible!important;break-after:page;page-break-after:always}",
    "}"
  ].join("");

  var state = {
    html: "",
    title: "",
    view: "start",
    editing: true,
    active: 0,
    kind: "document",
    frameReady: false,
    pendingUserEdit: false,
    loadToken: 0,
    comments: [],
    role: "owner",
    mode: "local",
    docId: "",
    token: "",
    revision: "",
    commenting: false,
    typing: false,
    apiBase: "",
    commentAnchor: ""
  };
  var serverTimer = 0;
  var history = [];
  var historyIndex = -1;
  var historyTimer = 0;
  var persistTimer = 0;
  var loadTimer = 0;
  var toastTimer = 0;
  var confirmTimer = 0;
  var confirmBtn = null;

  function $(id) { return document.getElementById(id); }

  function parse(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function serialize(doc) {
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  function canWrite() {
    return state.role === "owner" || state.role === "editor";
  }

  function canComment() {
    return canWrite() || state.role === "commenter";
  }

  function cleanComments(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (item) {
      return item && /^td-a\d+$/.test(item.anchorId || "") && typeof item.body === "string" && item.body.trim();
    }).slice(0, 200).map(function (item) {
      return {
        id: String(item.id || ("c" + Math.random().toString(16).slice(2, 10))).slice(0, 40),
        anchorId: item.anchorId,
        body: String(item.body).slice(0, 4000),
        author: String(item.author || "Colleague").slice(0, 80),
        createdAt: Number(item.createdAt) || Date.now()
      };
    });
  }

  function directText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3 && el.childNodes[i].textContent.trim()) return true;
    }
    return false;
  }

  var TEXT_SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, SVG: 1, PATH: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1,
    BUTTON: 1, LABEL: 1, HEAD: 1, META: 1, LINK: 1
  };

  function maxAnchor(doc) {
    var max = 0;
    doc.querySelectorAll("[data-td-anchor]").forEach(function (el) {
      var match = /^td-a(\d+)$/.exec(el.getAttribute("data-td-anchor") || "");
      if (match) max = Math.max(max, Number(match[1]));
    });
    return max;
  }

  function stampAnchors(doc) {
    var n = maxAnchor(doc);
    function mark(el, kind) {
      if (!/^td-a\d+$/.test(el.getAttribute("data-td-anchor") || "")) {
        n += 1;
        el.setAttribute("data-td-anchor", "td-a" + n);
      }
      el.setAttribute("data-td-kind", kind);
    }
    doc.querySelectorAll("img").forEach(function (img) {
      if (img.closest("svg")) return;
      mark(img, "image");
    });
    if (!doc.body) return;
    doc.body.querySelectorAll("*").forEach(function (el) {
      if (TEXT_SKIP[el.tagName]) return;
      if (el.closest("svg, script, style")) return;
      if (el.children.length) return;
      if (!directText(el)) return;
      mark(el, "text");
    });
  }

  function takeSidecar(doc) {
    var node = doc.querySelector("script[data-techydeck-sidecar]");
    var comments = [];
    if (!node) return comments;
    try {
      var data = JSON.parse(node.textContent || "{}");
      if (data && Array.isArray(data.comments)) comments = cleanComments(data.comments);
    } catch (err) {
      comments = [];
    }
    node.remove();
    return comments;
  }

  function prepareImported(html) {
    var doc = parse(String(html || "").replace(/^\uFEFF/, ""));
    var comments = takeSidecar(doc);
    stripInDoc(doc);
    if (!doc.querySelector("meta[charset]")) {
      var meta = doc.createElement("meta");
      meta.setAttribute("charset", "utf-8");
      doc.head.prepend(meta);
    }
    if (!doc.querySelector("title")) {
      var title = doc.createElement("title");
      var h1 = doc.querySelector("h1");
      title.textContent = (h1 && h1.textContent.trim()) || "Untitled deck";
      doc.head.appendChild(title);
    }
    stampAnchors(doc);
    return { html: serialize(doc), comments: comments };
  }

  function packState(html, comments) {
    return JSON.stringify({ html: html, comments: comments || [] });
  }

  function unpackState(entry) {
    if (entry && typeof entry === "object" && typeof entry.html === "string") {
      return { html: entry.html, comments: cleanComments(entry.comments) };
    }
    if (typeof entry !== "string") return { html: "", comments: [] };
    if (entry.charAt(0) === "{") {
      try {
        var obj = JSON.parse(entry);
        if (obj && typeof obj.html === "string") return { html: obj.html, comments: cleanComments(obj.comments) };
      } catch (err) { /* raw html */ }
    }
    return { html: entry, comments: [] };
  }

  function currentPack() {
    return packState(state.html, state.comments);
  }

  function stripOurClasses(el) {
    el.classList.remove("td-slide", "td-active", "td-hover", "td-print-slide");
    if (!el.getAttribute("class")) el.removeAttribute("class");
  }

  function stripInDoc(doc) {
    doc.querySelectorAll("[data-techydeck]").forEach(function (node) { node.remove(); });
    doc.querySelectorAll("[data-td-forced-display]").forEach(function (node) {
      node.style.removeProperty("display");
      node.style.removeProperty("visibility");
      node.style.removeProperty("opacity");
      if (!node.getAttribute("style")) node.removeAttribute("style");
      node.removeAttribute("data-td-forced-display");
    });
    doc.querySelectorAll("[data-td-slide], [data-td-img], [contenteditable]").forEach(function (node) {
      node.removeAttribute("data-td-slide");
      node.removeAttribute("data-td-img");
      node.removeAttribute("contenteditable");
      stripOurClasses(node);
    });
    doc.querySelectorAll(".td-hover, .td-slide, .td-active, .td-print-slide").forEach(stripOurClasses);
    doc.documentElement.classList.remove("td-slide-host", "td-editing", "td-printing");
    if (!doc.documentElement.getAttribute("class")) doc.documentElement.removeAttribute("class");
  }

  function normalize(html) {
    var doc = parse(html);
    stripInDoc(doc);
    if (!doc.querySelector("meta[charset]")) {
      var meta = doc.createElement("meta");
      meta.setAttribute("charset", "utf-8");
      doc.head.prepend(meta);
    }
    if (!doc.querySelector("title")) {
      var title = doc.createElement("title");
      var h1 = doc.querySelector("h1");
      title.textContent = (h1 && h1.textContent.trim()) || "Untitled deck";
      doc.head.appendChild(title);
    }
    return serialize(doc);
  }

  function largestGroup(nodes) {
    var map = new Map();
    nodes.forEach(function (el) {
      var parent = el.parentElement;
      if (!parent) return;
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(el);
    });
    var best = [];
    map.forEach(function (group) {
      if (group.length > best.length) best = group;
    });
    return best;
  }

  function detectSlides(doc) {
    var reveal = Array.prototype.slice.call(doc.querySelectorAll(".reveal .slides > section"));
    if (reveal.length >= 1) return { kind: "reveal", slides: reveal };
    var byClass = largestGroup(Array.prototype.slice.call(doc.querySelectorAll(".slide")));
    if (byClass.length >= 2) return { kind: "slide", slides: byClass };
    var sections = largestGroup(Array.prototype.slice.call(doc.querySelectorAll("section")));
    if (sections.length >= 2) return { kind: "section", slides: sections };
    return { kind: "document", slides: [] };
  }

  function deckTitle(html) {
    var doc = typeof html === "string" ? parse(html) : html;
    var title = doc.querySelector("title");
    if (title && title.textContent.trim()) return title.textContent.trim();
    var h1 = doc.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim().replace(/\s+/g, " ").slice(0, 80);
    return "Untitled deck";
  }

  function slideTitle(el, index) {
    var heading = el.querySelector("h1, h2, h3");
    var text = (heading ? heading.textContent : el.textContent) || "";
    var clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return "Slide " + (index + 1);
    return clean.length > 72 ? clean.slice(0, 69) + "…" : clean;
  }

  function kindLabel(found) {
    if (found.kind === "reveal") return found.slides.length + " slides · reveal.js sections";
    if (found.kind === "slide") return found.slides.length + " slides · .slide elements";
    if (found.kind === "section") return found.slides.length + " slides · section elements";
    return "Single document";
  }

  function setStatus(message) {
    $("status").textContent = message || "";
  }

  function setSaveStatus(message) {
    $("save-state").textContent = message || "";
  }

  function toast(message) {
    var el = $("toast");
    el.hidden = false;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 5200);
  }

  function setStartError(message) {
    var el = $("start-error");
    el.hidden = !message;
    el.textContent = message || "";
  }

  function updateHint() {
    if (state.commenting) {
      $("hint").textContent = "Comment mode. Click text or an image to anchor a note. The deck’s buttons still run.";
      return;
    }
    $("hint").textContent = state.editing
      ? "Click text to edit that element only. Click an image to replace it. Scripts keep running."
      : "Preview is on. Links and widgets run. Editing is paused.";
  }

  function updateUndoButtons() {
    var dirty = !!(state.html && history[historyIndex] !== undefined && currentPack() !== history[historyIndex]);
    var write = canWrite();
    $("btn-undo").disabled = !write || (historyIndex <= 0 && !dirty);
    $("btn-redo").disabled = !write || historyIndex >= history.length - 1 || dirty;
    if ($("btn-edit")) $("btn-edit").disabled = !write;
    if ($("btn-comment")) $("btn-comment").disabled = !canComment();
    if ($("mode-pill")) {
      $("mode-pill").textContent = state.mode === "shared" ? ("Shared · " + state.role) : "Local mode";
    }
  }

  function commitHistory() {
    var snap = currentPack();
    if (history[historyIndex] === snap) {
      updateUndoButtons();
      return false;
    }
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
    rememberRevision("Edit");
    updateUndoButtons();
    scheduleServerSave();
    return true;
  }

  function flushPending() {
    clearTimeout(historyTimer);
    if (state.html && currentPack() !== history[historyIndex]) commitHistory();
  }

  function scheduleHistory() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(function () { commitHistory(); }, 500);
  }

  function snapshotPayload() {
    var start = Math.max(0, history.length - 20);
    var sliced = history.slice(start);
    return {
      v: 2,
      html: state.html,
      comments: state.comments,
      history: sliced,
      index: historyIndex - start,
      savedAt: Date.now(),
      active: state.active,
      editing: state.editing,
      mode: state.mode,
      docId: state.docId,
      token: state.token,
      revision: state.revision,
      role: state.role
    };
  }

  function persistNow() {
    if (!state.html) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotPayload()));
      setSaveStatus("Saved in this browser");
    } catch (err) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          v: 2,
          html: state.html,
          comments: state.comments,
          savedAt: Date.now(),
          active: state.active,
          editing: state.editing,
          mode: state.mode,
          docId: state.docId,
          token: state.token,
          revision: state.revision,
          role: state.role
        }));
        setSaveStatus("Saved in this browser");
      } catch (err2) {
        setSaveStatus("This browser blocked local save. Download a copy.");
      }
    }
  }

  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 300);
  }

  function readAutosave() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data.html !== "string" || !data.html.trim()) return null;
      if (!Array.isArray(data.comments)) data.comments = [];
      return data;
    } catch (err) {
      return null;
    }
  }

  function describeSaved(saved) {
    var title = deckTitle(saved.html);
    var when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "";
    return title + (when ? " · saved " + when : "");
  }

  function slug(title) {
    var s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    return (s || "deck") + ".html";
  }

  function downloadHtml(html, filename) {
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1500);
  }

  function appPath() {
    var url = new URL("app.html", document.baseURI);
    url.search = "";
    url.hash = "";
    return url;
  }

  function showOverlay(message) {
    $("frame-overlay-msg").textContent = message;
    $("frame-overlay").hidden = false;
    $("frame-dismiss").hidden = true;
  }

  function showFrameError(message) {
    $("frame-overlay-msg").textContent = message;
    $("frame-overlay").hidden = false;
    $("frame-dismiss").hidden = false;
  }

  function hideOverlay() {
    $("frame-overlay").hidden = true;
  }

  function toSrcdoc(html, active, editing, token) {
    var doc = parse(html);
    var found = detectSlides(doc);
    if (found.slides.length) {
      doc.documentElement.classList.add("td-slide-host");
      found.slides.forEach(function (el, i) {
        el.setAttribute("data-td-slide", String(i));
        el.classList.add("td-slide");
        el.classList.toggle("td-active", i === active);
      });
    }
    if (state.commenting) doc.documentElement.classList.add("td-commenting");
    else if (editing) doc.documentElement.classList.add("td-editing");
    var n = 0;
    doc.querySelectorAll("img").forEach(function (img) {
      img.setAttribute("data-td-img", String(n++));
    });
    var style = doc.createElement("style");
    style.setAttribute("data-techydeck", "1");
    style.textContent = FRAME_CSS;
    doc.head.appendChild(style);
    var link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("css/editor-frame.css", document.baseURI).href;
    link.setAttribute("data-techydeck", "1");
    doc.head.appendChild(link);
    var boot = doc.createElement("script");
    boot.setAttribute("data-techydeck", "1");
    boot.textContent = "window.__TD_PARENT_ORIGIN__=" + JSON.stringify(location.origin) + ";window.__TD_TOKEN__=" + Number(token) + ";";
    doc.body.appendChild(boot);
    var script = doc.createElement("script");
    script.setAttribute("data-techydeck", "1");
    script.src = new URL("js/editor-runtime.js", document.baseURI).href;
    doc.body.appendChild(script);
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  function renderFrame() {
    var token = ++state.loadToken;
    state.frameReady = false;
    showOverlay("Opening deck…");
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (state.loadToken === token && !state.frameReady) {
        showFrameError("The editor script did not start. A content security policy in the file can block it. You can still export the HTML.");
      }
    }, 8000);
    $("deck-frame").srcdoc = toSrcdoc(state.html, state.active, state.editing, token);
  }

  function resetConfirm() {
    clearTimeout(confirmTimer);
    if (!confirmBtn) return;
    confirmBtn.textContent = "Delete";
    confirmBtn.classList.remove("confirming");
    delete confirmBtn.dataset.confirm;
    confirmBtn = null;
  }

  function requestDelete(index, btn) {
    if (btn.disabled) return;
    if (btn.dataset.confirm === "1") {
      resetConfirm();
      deleteSlide(index);
      return;
    }
    resetConfirm();
    confirmBtn = btn;
    btn.dataset.confirm = "1";
    btn.textContent = "Confirm";
    btn.classList.add("confirming");
    confirmTimer = setTimeout(resetConfirm, 2800);
  }

  function actionButton(text, onClick, disabled, title) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini";
    btn.textContent = text;
    btn.disabled = !!disabled;
    if (title) btn.title = title;
    btn.addEventListener("click", function () { onClick(btn); });
    return btn;
  }

  function focusActiveSlide() {
    var button = document.querySelector("#slide-list li.active .slide-select");
    if (button) button.focus();
  }

  function renderSidebar(found) {
    state.kind = found.kind;
    var list = $("slide-list");
    list.replaceChildren();
    $("doc-note").hidden = found.kind !== "document";
    $("slide-heading").textContent = found.kind === "document" ? "Document" : "Slides";
    $("slide-meta").textContent = kindLabel(found) + (found.slides.length > 1 ? " · Drag the grip to reorder." : "");

    found.slides.forEach(function (el, index) {
      var li = document.createElement("li");
      li.dataset.index = String(index);
      if (index === state.active) li.classList.add("active");

      var grip = document.createElement("button");
      grip.type = "button";
      grip.className = "grip";
      grip.draggable = true;
      grip.setAttribute("aria-label", "Drag to reorder");
      grip.title = "Drag to reorder";
      grip.textContent = "⋮⋮";
      grip.addEventListener("dragstart", function (event) {
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
      });
      grip.addEventListener("dragend", function () { li.classList.remove("dragging"); });

      var select = document.createElement("button");
      select.type = "button";
      select.className = "slide-select";
      if (index === state.active) select.setAttribute("aria-current", "true");
      var num = document.createElement("span");
      num.className = "num";
      num.textContent = String(index + 1).padStart(2, "0");
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = slideTitle(el, index);
      select.append(num, label);
      select.addEventListener("click", function () { selectSlide(index); });
      select.addEventListener("keydown", function (event) {
        if (!event.altKey) return;
        if (event.key === "ArrowUp") { event.preventDefault(); moveSlide(index, index - 1); }
        if (event.key === "ArrowDown") { event.preventDefault(); moveSlide(index, index + 1); }
      });

      var row = document.createElement("div");
      row.className = "slide-row";
      row.append(grip, select);

      var actions = document.createElement("div");
      actions.className = "slide-actions";
      var locked = !canWrite();
      actions.append(
        actionButton("Up", function () { moveSlide(index, index - 1); }, locked || index === 0, "Move up"),
        actionButton("Down", function () { moveSlide(index, index + 1); }, locked || index === found.slides.length - 1, "Move down"),
        actionButton("Duplicate", function () { duplicateSlide(index); }, locked, "Duplicate slide"),
        actionButton("Delete", function (btn) { requestDelete(index, btn); }, locked || found.slides.length < 2, found.slides.length < 2 ? "Keep at least one slide" : "Delete slide")
      );

      li.addEventListener("dragover", function (event) {
        event.preventDefault();
        li.classList.add("drag-over");
      });
      li.addEventListener("dragleave", function () { li.classList.remove("drag-over"); });
      li.addEventListener("drop", function (event) {
        event.preventDefault();
        li.classList.remove("drag-over");
        var from = Number(event.dataTransfer.getData("text/plain"));
        if (!Number.isNaN(from)) moveSlide(from, index);
      });

      li.append(row, actions);
      list.append(li);
    });
  }

  function refreshSidebarLabels() {
    var found = detectSlides(parse(state.html));
    var labels = document.querySelectorAll("#slide-list .label");
    if (labels.length !== found.slides.length) {
      renderSidebar(found);
      return;
    }
    found.slides.forEach(function (el, i) { labels[i].textContent = slideTitle(el, i); });
    $("slide-meta").textContent = kindLabel(found) + (found.slides.length > 1 ? " · Drag the grip to reorder." : "");
  }

  function highlightActive() {
    document.querySelectorAll("#slide-list li").forEach(function (li) {
      var on = Number(li.dataset.index) === state.active;
      li.classList.toggle("active", on);
      var sel = li.querySelector(".slide-select");
      if (!sel) return;
      if (on) sel.setAttribute("aria-current", "true");
      else sel.removeAttribute("aria-current");
    });
  }

  function renderChrome() {
    document.body.dataset.view = state.view;
    $("btn-edit").setAttribute("aria-pressed", String(state.editing));
    $("btn-comment").setAttribute("aria-pressed", String(state.commenting));
    $("btn-preview").setAttribute("aria-pressed", String(!state.editing && !state.commenting));
    updateHint();
    updateUndoButtons();
    if (state.view === "editor") {
      $("deck-name").textContent = state.title || "Untitled deck";
      document.title = (state.title || "Deck") + " — TechyDeck";
    } else {
      document.title = "Editor — TechyDeck";
    }
  }

  function render() {
    renderChrome();
    if (state.view !== "editor") return;
    renderSidebar(detectSlides(parse(state.html)));
    renderComments();
    renderRevisions();
    renderFrame();
  }

  function postToFrame(msg) {
    var frame = $("deck-frame");
    if (!state.frameReady || !frame.contentWindow) return;
    frame.contentWindow.postMessage(msg, "*");
  }

  function selectSlide(index) {
    state.active = index;
    highlightActive();
    postToFrame({ type: "td:slide", index: index });
    persistSoon();
  }

  function setSurface(kind) {
    if (kind === "edit" && !canWrite()) kind = "preview";
    if (kind === "comment" && !canComment()) kind = "preview";
    state.editing = kind === "edit";
    state.commenting = kind === "comment";
    renderChrome();
    postToFrame({ type: "td:mode", editing: state.editing, commenting: state.commenting });
    persistSoon();
  }

  function mutateSlides(fn) {
    flushPending();
    resetConfirm();
    var doc = parse(state.html);
    var found = detectSlides(doc);
    if (!found.slides.length) return;
    if (!fn(found.slides)) return;
    state.html = serialize(doc);
    state.title = deckTitle(state.html);
    state.pendingUserEdit = false;
    var removed = pruneComments();
    if (removed) toast(removed + " comment" + (removed === 1 ? "" : "s") + " on the removed slide were dropped.");
    var after = detectSlides(parse(state.html));
    if (state.active >= after.slides.length) state.active = Math.max(0, after.slides.length - 1);
    if (state.active < 0) state.active = 0;
    commitHistory();
    persistNow();
    render();
    setTimeout(focusActiveSlide, 0);
  }

  function moveSlide(from, to) {
    mutateSlides(function (slides) {
      if (to < 0 || to >= slides.length || from === to) return false;
      var parent = slides[0].parentElement;
      var ordered = slides.slice();
      var moved = ordered.splice(from, 1)[0];
      ordered.splice(to, 0, moved);
      var placeholders = slides.map(function (node) {
        var ph = node.ownerDocument.createComment("s");
        parent.insertBefore(ph, node);
        return ph;
      });
      ordered.forEach(function (node, i) { parent.insertBefore(node, placeholders[i]); });
      placeholders.forEach(function (ph) { ph.remove(); });
      state.active = to;
      return true;
    });
  }

  function duplicateSlide(index) {
    mutateSlides(function (slides) {
      var copy = slides[index].cloneNode(true);
      var max = maxAnchor(slides[index].ownerDocument);
      function reanchor(el) {
        if (el.getAttribute && el.hasAttribute("data-td-anchor")) {
          max += 1;
          el.setAttribute("data-td-anchor", "td-a" + max);
        }
      }
      reanchor(copy);
      copy.querySelectorAll("[data-td-anchor]").forEach(reanchor);
      slides[index].after(copy);
      state.active = index + 1;
      return true;
    });
  }

  function deleteSlide(index) {
    mutateSlides(function (slides) {
      if (slides.length < 2) return false;
      slides[index].remove();
      state.active = Math.min(index, slides.length - 2);
      return true;
    });
  }

  function loadHtml(html, opts) {
    opts = opts || {};
    var prepared = prepareImported(html);
    if (!prepared.html.trim()) {
      toast("That file is empty.");
      return;
    }
    state.html = prepared.html;
    state.comments = opts.comments ? cleanComments(opts.comments) : prepared.comments;
    state.title = deckTitle(prepared.html);
    state.active = opts.active || 0;
    state.editing = canWrite() && opts.editing !== false;
    state.commenting = false;
    state.view = "editor";
    state.pendingUserEdit = false;
    state.typing = false;
    if (opts.history && opts.history.length) {
      history = opts.history.map(function (item) { return typeof item === "string" ? item : packState(item.html, item.comments); });
      historyIndex = Number.isInteger(opts.index) ? opts.index : history.length - 1;
      if (historyIndex < 0 || historyIndex >= history.length) historyIndex = history.length - 1;
      history[historyIndex] = currentPack();
    } else {
      history = [currentPack()];
      historyIndex = 0;
    }
    var found = detectSlides(parse(state.html));
    if (!found.slides.length) state.active = 0;
    else if (state.active >= found.slides.length) state.active = 0;
    setStartError("");
    persistNow();
    render();
    if (opts.status) setStatus(opts.status);
  }

  function showStart() {
    state.view = "start";
    renderChrome();
    var saved = readAutosave();
    $("resume-card").hidden = !saved;
    if (saved) $("resume-meta").textContent = describeSaved(saved);
    hideOverlay();
  }

  function hasDeck() {
    return !!(state.html || readAutosave());
  }

  function confirmReplace(label) {
    if (!hasDeck()) return true;
    return window.confirm("Replace the current deck with " + label + "?");
  }

  function onFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf("image/") === 0) {
      toast("Upload the HTML file, not an image. Images are replaced after the deck is open.");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || "").replace(/^\uFEFF/, "");
      if (!text.trim()) return toast("That file is empty.");
      if (text.indexOf("\0") !== -1) return toast("That file does not look like HTML.");
      if (!confirmReplace(file.name)) return;
      loadHtml(text, { status: "Loaded " + file.name + "." });
    };
    reader.readAsText(file);
  }

  function loadSample(id, opts) {
    opts = opts || {};
    var sample = SAMPLES[id];
    if (!sample) return;
    if (opts.confirm !== false && !confirmReplace(sample.name)) return;
    setStartError("");
    state.view = "editor";
    state.title = sample.name;
    renderChrome();
    showOverlay("Loading " + sample.name + "…");
    fetch(new URL(sample.url, document.baseURI).href)
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then(function (html) {
        loadHtml(html, { status: "Loaded " + sample.name + "." });
      })
      .catch(function () {
        showStart();
        setStartError("Could not load the sample. Serve this folder over HTTP — GitHub Pages does. Opening the file directly from disk blocks sample loading.");
      });
  }

  function exportHtmlFile() {
    if (!state.html) return;
    flushPending();
    var html = exportDocument();
    downloadHtml(html, slug(state.title));
    setStatus("Downloaded " + slug(state.title) + ".");
  }

  function toPrintHtml(html) {
    var doc = parse(html);
    stripInDoc(doc);
    doc.querySelectorAll("script").forEach(function (node) { node.remove(); });
    var found = detectSlides(doc);
    found.slides.forEach(function (el) { el.classList.add("td-print-slide"); });
    var style = doc.createElement("style");
    style.textContent = [
      found.slides.length ? "@page{size:landscape;margin:10mm}" : "@page{margin:14mm}",
      "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}",
      ".td-print-slide{display:flex!important;flex-direction:column;justify-content:center;position:relative!important;transform:none!important;opacity:1!important;visibility:visible!important;overflow:visible!important;height:auto!important;min-height:170mm!important;break-after:page;page-break-after:always}",
      ".td-print-slide:last-of-type{break-after:auto;page-break-after:auto}"
    ].join("");
    doc.head.appendChild(style);
    return serialize(doc);
  }

  function exportPdf() {
    if (!state.html) return;
    flushPending();
    var html = toPrintHtml(state.html);
    var frame = $("print-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "print-frame";
      frame.title = "Print preview";
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;";
      document.body.appendChild(frame);
    }
    frame.onload = function () {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setStatus("Print dialog opened. Turn on background graphics, then choose Save as PDF.");
      } catch (err) {
        setStatus("Could not open the print dialog. Download the HTML file and print that instead.");
      }
    };
    frame.srcdoc = html.replace("</head>", "<!--print:" + Date.now() + "--></head>");
  }

  function formatChars(n) {
    if (n < 1024) return n + " characters";
    return (n / 1024).toFixed(1) + " KB";
  }

  function share() {
    if (!state.html) return;
    flushPending();
    var payload = JSON.stringify({ v: 2, html: exportDocument(), comments: state.comments });
    var compressed = LZString.compressToEncodedURIComponent(payload);
    var html = payload;
    var ok = $("share-ok");
    var big = $("share-big");
    if (!compressed) {
      toast("Could not compress this deck.");
      return;
    }
    var href = appPath().origin + appPath().pathname + "#s=" + compressed;
    if (compressed.length > SHARE_LIMIT) {
      ok.hidden = true;
      big.hidden = false;
      $("share-big-msg").textContent = "This deck is too large for a link (" + formatChars(compressed.length) + " compressed; the limit is " + formatChars(SHARE_LIMIT) + "). Download the HTML file and send that. The recipient can upload it here.";
    } else {
      big.hidden = true;
      ok.hidden = false;
      $("share-url").value = href;
      $("share-url").scrollLeft = 0;
      $("share-size").textContent = "Snapshot copy, " + formatChars(compressed.length) + " compressed. It is not a shared document — each person who opens it gets their own copy.";
    }
    $("share-dialog").showModal();
  }

  async function copyShare() {
    var url = $("share-url").value;
    try {
      await navigator.clipboard.writeText(url);
      $("share-copy").textContent = "Copied";
      setTimeout(function () { $("share-copy").textContent = "Copy link"; }, 1600);
    } catch (err) {
      $("share-url").focus();
      $("share-url").select();
      toast("Copy was blocked. Select the link and copy it manually.");
    }
  }

  function readShared() {
    var frag = location.hash.replace(/^#/, "");
    var legacy = frag.indexOf("d=") === 0;
    var snap = frag.indexOf("s=") === 0;
    if (!legacy && !snap) return null;
    var payload = frag.slice(2);
    try { payload = decodeURIComponent(payload); } catch (err) { /* already raw */ }
    var decoded = LZString.decompressFromEncodedURIComponent(payload);
    if (!decoded) return { error: true };
    if (legacy) return { html: decoded, note: "Opened a snapshot copy in this browser. It is not a shared document." };
    try {
      var data = JSON.parse(decoded);
      if (data && typeof data.html === "string") {
        return { html: data.html, comments: data.comments || [], note: "Opened a snapshot copy in this browser. It is not a shared document." };
      }
    } catch (err) { /* fall through */ }
    return { html: decoded, note: "Opened a snapshot copy in this browser. It is not a shared document." };
  }

  function onReady() {
    state.frameReady = true;
    clearTimeout(loadTimer);
    hideOverlay();
    postToFrame({ type: "td:mode", editing: state.editing, commenting: state.commenting });
    postToFrame({ type: "td:slide", index: state.active });
    renderComments();
  }

  function anchorOk(anchor) {
    return typeof anchor === "string" && /^td-a\d+$/.test(anchor);
  }

  function bakeText(anchor, text) {
    if (!canWrite() || !anchorOk(anchor) || typeof text !== "string" || text.length > 20000) return false;
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el || el.getAttribute("data-td-kind") !== "text" || el.children.length) return false;
    el.textContent = text;
    state.html = serialize(doc);
    state.title = deckTitle(state.html);
    return true;
  }

  function bakeImage(anchor, src, alt) {
    if (!canWrite() || !anchorOk(anchor) || typeof src !== "string") return false;
    if (src.length > 2000000) return false;
    if (src.indexOf("data:image/") !== 0) return false;
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el || el.tagName !== "IMG") return false;
    el.setAttribute("src", src);
    el.removeAttribute("srcset");
    if (typeof alt === "string") el.setAttribute("alt", alt.slice(0, 200));
    state.html = serialize(doc);
    state.commentAnchor = anchor;
    return true;
  }

  function bakeAlt(anchor, alt) {
    if (!canWrite() || !anchorOk(anchor)) return false;
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el || el.tagName !== "IMG") return false;
    el.setAttribute("alt", String(alt || "").slice(0, 200));
    state.html = serialize(doc);
    return true;
  }

  function pruneComments() {
    var doc = parse(state.html);
    var live = {};
    doc.querySelectorAll("[data-td-anchor]").forEach(function (el) { live[el.getAttribute("data-td-anchor")] = 1; });
    var before = state.comments.length;
    state.comments = state.comments.filter(function (item) { return live[item.anchorId]; });
    return before - state.comments.length;
  }

  function onText(msg) {
    if (!bakeText(msg.anchor, msg.text)) return;
    state.pendingUserEdit = true;
    state.typing = true;
    if (msg.immediate) {
      clearTimeout(historyTimer);
      commitHistory();
      persistNow();
    } else {
      scheduleHistory();
      persistSoon();
      updateUndoButtons();
    }
    renderChrome();
    refreshSidebarLabels();
  }

  function onImage(msg) {
    if (!bakeImage(msg.anchor, msg.src, msg.alt)) {
      toast("That image could not be saved into the file.");
      return;
    }
    clearTimeout(historyTimer);
    commitHistory();
    persistNow();
    renderChrome();
    var row = $("alt-row");
    if (row) {
      row.hidden = false;
      $("image-alt").value = msg.alt || "";
      $("image-alt").dataset.anchor = msg.anchor;
    }
    setStatus("Image replaced. Add alt text if the picture carries meaning.");
  }

  function undo() {
    flushPending();
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applyHistory();
  }

  function redo() {
    flushPending();
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applyHistory();
  }

  function applyHistory() {
    var unpacked = unpackState(history[historyIndex]);
    state.html = unpacked.html;
    state.comments = unpacked.comments;
    state.title = deckTitle(state.html);
    state.pendingUserEdit = false;
    state.typing = false;
    var found = detectSlides(parse(state.html));
    if (state.active >= found.slides.length) state.active = Math.max(0, found.slides.length - 1);
    persistSoon();
    render();
    setStatus(historyIndex === 0 ? "At the earliest edit." : "Restored an earlier version.");
  }

  function exportDocument() {
    var doc = parse(state.html);
    stripInDoc(doc);
    doc.querySelectorAll("script[data-techydeck-sidecar]").forEach(function (node) { node.remove(); });
    if (state.comments.length) {
      var sidecar = doc.createElement("script");
      sidecar.type = "application/json";
      sidecar.setAttribute("data-techydeck-sidecar", "1");
      sidecar.textContent = JSON.stringify({ v: 2, comments: state.comments });
      doc.body.appendChild(sidecar);
    }
    return serialize(doc);
  }

  function readRevisions() {
    try {
      var data = JSON.parse(localStorage.getItem(REV_KEY) || "[]");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  function rememberRevision(label) {
    var list = readRevisions().filter(function (item) { return item && item.html !== state.html; });
    list.push({
      id: "r" + Date.now().toString(36),
      at: Date.now(),
      label: label || "Edit",
      html: state.html,
      comments: state.comments
    });
    if (list.length > 20) list = list.slice(-20);
    try { localStorage.setItem(REV_KEY, JSON.stringify(list)); } catch (err) { /* keep the deck even if revisions do not fit */ }
    renderRevisions();
  }

  function renderRevisions() {
    var list = $("rev-list");
    if (!list) return;
    list.replaceChildren();
    readRevisions().slice().reverse().forEach(function (rev) {
      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mini";
      button.textContent = (rev.label || "Revision") + " · " + new Date(rev.at).toLocaleTimeString();
      button.addEventListener("click", function () { restoreLocal(rev.id); });
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  function restoreLocal(id) {
    var rev = readRevisions().find(function (item) { return item.id === id; });
    if (!rev || !canWrite()) return;
    flushPending();
    state.html = rev.html;
    state.comments = cleanComments(rev.comments);
    state.title = deckTitle(state.html);
    commitHistory();
    persistNow();
    render();
    setStatus("Restored a saved revision. Older revisions are still in the list.");
  }

  function renderComments() {
    var list = $("comment-list");
    if (!list) return;
    list.replaceChildren();
    if (!state.comments.length) {
      var empty = document.createElement("li");
      empty.textContent = "No comments yet.";
      list.appendChild(empty);
      return;
    }
    state.comments.forEach(function (item) {
      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "comment-jump";
      button.textContent = item.body;
      button.addEventListener("click", function () { showCommentAnchor(item.anchorId); });
      var meta = document.createElement("p");
      meta.className = "fine";
      meta.textContent = item.author + " · " + item.anchorId;
      li.append(button, meta);
      list.appendChild(li);
    });
  }

  function showCommentAnchor(anchor) {
    var index = slideIndexForAnchor(anchor);
    if (index >= 0) selectSlide(index);
    postToFrame({ type: "td:show-anchor", anchor: anchor });
  }

  function slideIndexForAnchor(anchor) {
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el) return -1;
    var found = detectSlides(doc);
    for (var i = 0; i < found.slides.length; i++) {
      if (found.slides[i] === el || found.slides[i].contains(el)) return i;
    }
    return -1;
  }

  function addComment(body) {
    if (!canComment()) return;
    var text = String(body || "").trim();
    if (!text || !anchorOk(state.commentAnchor)) return;
    state.comments.push({
      id: "c" + Date.now().toString(36),
      anchorId: state.commentAnchor,
      body: text.slice(0, 4000),
      author: state.role === "owner" ? "Owner" : state.role,
      createdAt: Date.now()
    });
    if (state.mode === "shared" && state.role === "commenter") {
      postCommentOnly(state.comments[state.comments.length - 1]);
    } else {
      commitHistory();
      persistNow();
    }
    renderComments();
    $("comment-body").value = "";
    $("comment-form").hidden = true;
  }

  function apiUrl(path) {
    return state.apiBase.replace(/\/$/, "") + path;
  }

  function scheduleServerSave() {
    if (state.mode !== "shared" || !canWrite()) return;
    clearTimeout(serverTimer);
    serverTimer = setTimeout(saveToServer, 700);
  }

  function saveToServer() {
    if (state.mode !== "shared" || !canWrite() || !state.revision) return;
    fetch(apiUrl("/api/documents/" + state.docId), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + state.token,
        "if-match": state.revision
      },
      body: JSON.stringify({ title: state.title, sourceHtml: state.html, comments: state.comments })
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status === 200) {
          state.revision = result.body.revision;
          setSaveStatus("Saved to the shared document");
          hideConflict();
          return;
        }
        if (result.status === 409) {
          showConflict("Someone saved a newer version. Your typing stays put until you choose.");
          state.serverCopy = result.body.current;
          return;
        }
        setSaveStatus("Shared save failed (" + result.status + "). Your copy is still in this browser.");
      }).catch(function () {
        setSaveStatus("Shared server is unreachable. Your copy is still in this browser.");
      });
  }

  function postCommentOnly(comment) {
    fetch(apiUrl("/api/documents/" + state.docId + "/comments"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + state.token,
        "if-match": state.revision
      },
      body: JSON.stringify(comment)
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status === 201) {
          state.revision = result.body.revision;
          state.comments = cleanComments(result.body.comments);
          state.html = result.body.sourceHtml;
          history[historyIndex] = currentPack();
          renderComments();
          setSaveStatus("Comment saved to the shared document");
          return;
        }
        if (result.status === 409) {
          showConflict("The document changed before the comment was saved.");
          state.serverCopy = result.body.current;
          return;
        }
        toast("The server rejected the comment.");
      }).catch(function () { toast("Shared server is unreachable."); });
  }

  function showConflict(message) {
    var banner = $("conflict");
    if (!banner) return;
    $("conflict-msg").textContent = message;
    banner.hidden = false;
  }

  function hideConflict() {
    if ($("conflict")) $("conflict").hidden = true;
  }

  function applyRemote(doc) {
    state.html = doc.sourceHtml;
    state.comments = cleanComments(doc.comments);
    state.revision = doc.revision;
    state.title = doc.title || deckTitle(state.html);
    state.role = doc.role || state.role;
    history = [currentPack()];
    historyIndex = 0;
    state.editing = canWrite();
    state.commenting = false;
    state.typing = false;
    hideConflict();
    persistNow();
    render();
    setStatus("Loaded the shared version.");
  }

  function connectApi(base) {
    var trimmed = String(base || "").trim().replace(/\/$/, "");
    if (!trimmed) {
      state.apiBase = "";
      localStorage.removeItem(API_KEY);
      if ($("api-status")) $("api-status").textContent = "No server connected. This browser stays in local mode.";
      return Promise.resolve(false);
    }
    return fetch(trimmed + "/api/health").then(function (res) { return res.json(); }).then(function (body) {
      if (!body || body.ok !== true) throw new Error("unhealthy");
      state.apiBase = trimmed;
      localStorage.setItem(API_KEY, trimmed);
      if ($("api-status")) $("api-status").textContent = "Connected to " + trimmed + ". Publishing a deck uploads it to that server.";
      return true;
    }).catch(function () {
      if ($("api-status")) $("api-status").textContent = "Could not reach that server. Staying in local mode.";
      return false;
    });
  }

  function publishShared() {
    if (!state.apiBase) {
      toast("Connect a TechyDeck server first. GitHub Pages cannot store a shared deck.");
      return;
    }
    flushPending();
    fetch(apiUrl("/api/documents"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: state.title, sourceHtml: state.html, comments: state.comments })
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status !== 201) throw new Error("create failed");
        state.mode = "shared";
        state.docId = result.body.document.id;
        state.token = result.body.token;
        state.revision = result.body.document.revision;
        state.role = "owner";
        persistNow();
        updateUndoButtons();
        setStatus("This browser is the owner of one shared document.");
        toast("Shared document created. Use Snapshot link to invite an editor, commenter, or viewer.");
        pollShared();
      }).catch(function () { toast("Could not create the shared document."); });
  }

  function invite(role) {
    if (state.mode !== "shared" || state.role !== "owner") {
      toast("Only the owner of a connected document can invite.");
      return;
    }
    fetch(apiUrl("/api/documents/" + state.docId + "/invites"), {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + state.token },
      body: JSON.stringify({ role: role })
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status !== 201) throw new Error("invite failed");
        var link = appPath().origin + appPath().pathname + "#join=" + result.body.documentId + "." + result.body.token;
        $("share-url").value = link;
        $("share-url").scrollLeft = 0;
        $("share-ok").hidden = false;
        $("share-big").hidden = true;
        $("share-size").textContent = "Invite for a " + role + ". The token is the permission. Anyone with the link has that role.";
        $("share-dialog").showModal();
      }).catch(function () { toast("Could not create an invite."); });
  }

  function openJoined(id, token) {
    state.apiBase = state.apiBase || localStorage.getItem(API_KEY) || window.TECHYDECK_API || "";
    if (!state.apiBase) {
      showStart();
      setStartError("That invite needs the shared server URL saved in this browser first.");
      return;
    }
    state.token = token;
    fetch(state.apiBase.replace(/\/$/, "") + "/api/documents/" + id, {
      headers: { authorization: "Bearer " + token }
    }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status !== 200) throw new Error("join failed");
        state.mode = "shared";
        state.docId = id;
        state.view = "editor";
        applyRemote(result.body);
        setStatus("Opened the shared document as " + result.body.role + ".");
        pollShared();
      }).catch(function () {
        showStart();
        setStartError("Could not open that shared document. Check the server URL and the invite.");
      });
  }

  function pollShared() {
    clearTimeout(state.pollTimer);
    if (state.mode !== "shared" || !state.docId) return;
    state.pollTimer = setTimeout(function () {
      fetch(apiUrl("/api/documents/" + state.docId), { headers: { authorization: "Bearer " + state.token } })
        .then(function (res) { return res.json(); })
        .then(function (body) {
          if (body && body.revision && body.revision !== state.revision && !state.typing) {
            state.serverCopy = body;
            showConflict("A newer shared version is available. Load it when you are ready.");
          }
          pollShared();
        }).catch(function () { pollShared(); });
    }, 8000);
  }

  function bind() {
    $("btn-edit").addEventListener("click", function () { setSurface("edit"); });
    $("btn-comment").addEventListener("click", function () { setSurface("comment"); });
    $("btn-preview").addEventListener("click", function () { setSurface("preview"); });
    $("btn-undo").addEventListener("click", undo);
    $("btn-redo").addEventListener("click", redo);
    $("btn-export").addEventListener("click", exportHtmlFile);
    $("btn-pdf").addEventListener("click", exportPdf);
    $("btn-share").addEventListener("click", share);
    $("share-copy").addEventListener("click", copyShare);
    $("share-download").addEventListener("click", function () {
      exportHtmlFile();
      $("share-dialog").close();
    });
    $("btn-open").addEventListener("click", function () {
      if (state.html) { flushPending(); persistNow(); }
      showStart();
    });
    $("btn-resume").addEventListener("click", function () {
      var saved = readAutosave();
      if (!saved) return showStart();
      state.mode = saved.mode === "shared" ? "shared" : "local";
      state.docId = saved.docId || "";
      state.token = saved.token || "";
      state.revision = saved.revision || "";
      state.role = saved.role || "owner";
      loadHtml(saved.html, {
        comments: saved.comments,
        history: saved.history,
        index: saved.index,
        active: saved.active || 0,
        editing: saved.editing !== false,
        status: state.mode === "shared" ? "Restored the shared document saved in this browser." : "Restored the deck saved in this browser."
      });
      if (state.mode === "shared") pollShared();
    });
    $("btn-discard").addEventListener("click", function () {
      localStorage.removeItem(STORAGE_KEY);
      state.html = "";
      state.comments = [];
      state.mode = "local";
      state.docId = "";
      state.token = "";
      state.revision = "";
      state.role = "owner";
      history = [];
      historyIndex = -1;
      showStart();
      toast("Removed the saved deck from this browser.");
    });
    $("file-input").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      onFile(file);
      event.target.value = "";
    });
    var drop = $("dropzone");
    ["dragenter", "dragover"].forEach(function (type) {
      drop.addEventListener(type, function (event) {
        event.preventDefault();
        drop.classList.add("dragover");
      });
    });
    drop.addEventListener("dragleave", function () { drop.classList.remove("dragover"); });
    drop.addEventListener("drop", function (event) {
      event.preventDefault();
      drop.classList.remove("dragover");
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) return onFile(file);
      var text = event.dataTransfer.getData("text/html") || event.dataTransfer.getData("text/plain");
      if (text && confirmReplace("the dropped HTML")) loadHtml(text, { status: "Loaded dropped HTML." });
    });
    document.querySelectorAll("[data-sample]").forEach(function (button) {
      button.addEventListener("click", function () { loadSample(button.dataset.sample); });
    });
    $("load-paste").addEventListener("click", function () {
      var text = $("paste-html").value;
      if (!text.trim()) return toast("Paste HTML first.");
      if (!confirmReplace("the pasted HTML")) return;
      loadHtml(text, { status: "Loaded pasted HTML." });
    });
    $("load-note").addEventListener("click", function () {
      if (!confirmReplace("the one-page note")) return;
      loadHtml(NOTE_HTML, { status: "Loaded a one-page note. No slide sections were found." });
    });
    $("frame-dismiss").addEventListener("click", hideOverlay);
    $("comment-form").addEventListener("submit", function (event) {
      event.preventDefault();
      addComment($("comment-body").value);
    });
    $("image-alt").addEventListener("change", function (event) {
      var anchor = event.target.dataset.anchor;
      if (!anchor) return;
      if (!bakeAlt(anchor, event.target.value)) return;
      postToFrame({ type: "td:alt", anchor: anchor, alt: event.target.value });
      commitHistory();
      persistNow();
    });
    $("api-save").addEventListener("click", function () { connectApi($("api-base").value); });
    $("btn-publish").addEventListener("click", publishShared);
    $("btn-invite-editor").addEventListener("click", function () { invite("editor"); });
    $("btn-invite-commenter").addEventListener("click", function () { invite("commenter"); });
    $("btn-invite-viewer").addEventListener("click", function () { invite("viewer"); });
    $("conflict-load").addEventListener("click", function () {
      if (state.serverCopy) applyRemote(state.serverCopy);
    });
    $("conflict-keep").addEventListener("click", function () {
      if (!state.serverCopy || !canWrite()) {
        hideConflict();
        return;
      }
      state.revision = state.serverCopy.revision;
      hideConflict();
      saveToServer();
    });
    $("share-close").addEventListener("click", function () { $("share-dialog").close(); });
    $("share-close-big").addEventListener("click", function () { $("share-dialog").close(); });
    window.addEventListener("message", function (event) {
      var frame = $("deck-frame");
      if (!frame || event.source !== frame.contentWindow) return;
      var msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.token !== state.loadToken) return;
      if (msg.type === "td:ready") onReady(msg);
      else if (msg.type === "td:text") onText(msg);
      else if (msg.type === "td:image") onImage(msg);
      else if (msg.type === "td:focus") state.typing = true;
      else if (msg.type === "td:blur") state.typing = false;
      else if (msg.type === "td:comment-target" && anchorOk(msg.anchor)) {
        state.commentAnchor = msg.anchor;
        $("comment-target").textContent = msg.preview || msg.anchor;
        $("comment-form").hidden = false;
      } else if (msg.type === "td:slide") {
        state.active = msg.index | 0;
        highlightActive();
      } else if (msg.type === "td:undo") undo();
      else if (msg.type === "td:redo") redo();
      else if (msg.type === "td:print") exportPdf();
      else if (msg.type === "td:toast" && msg.message) toast(msg.message);
    });
    document.addEventListener("keydown", function (event) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      var meta = event.metaKey || event.ctrlKey;
      if (!meta || state.view !== "editor") return;
      if (event.key === "z" || event.key === "Z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (event.key === "y" || event.key === "Y") {
        event.preventDefault();
        redo();
      } else if (event.key === "p" || event.key === "P") {
        event.preventDefault();
        exportPdf();
      }
    });
  }

  function init() {
    bind();
    $("toast").hidden = true;
    if (typeof LZString === "undefined") {
      showStart();
      setStartError("The compression library failed to load, so share links are unavailable.");
      return;
    }
    state.apiBase = localStorage.getItem(API_KEY) || window.TECHYDECK_API || "";
    var params = new URLSearchParams(location.search);
    if (params.get("api")) state.apiBase = params.get("api");
    if ($("api-base") && state.apiBase) $("api-base").value = state.apiBase;
    var join = /^join=([a-f0-9]+)\.([a-f0-9]+)$/.exec(location.hash.replace(/^#/, ""));
    var shared = readShared();
    var sample = params.get("sample");
    window.history.replaceState(null, "", appPath().pathname);
    if (join) {
      openJoined(join[1], join[2]);
      return;
    }
    if (shared && shared.html) {
      loadHtml(shared.html, { comments: shared.comments, status: shared.note || "Opened a snapshot copy in this browser." });
      return;
    }
    if (shared && shared.error) {
      showStart();
      setStartError("That share link could not be read. Ask the sender for the HTML file.");
      return;
    }
    if (sample && SAMPLES[sample]) {
      loadSample(sample, { confirm: false });
      return;
    }
    showStart();
  }

  init();
})();
