/* TechyDeck editor. The deck HTML is the source of truth; the iframe is a sandboxed view. */
(function () {
  var STORAGE_KEY = "techydeck.autosave.v1";
  var SHARE_LIMIT = 48000;
  var MAX_HISTORY = 60;
  var SAMPLES = {
    quarterly: { url: "samples/quarterly-review.html", name: "Q3 board review" },
    launch: { url: "samples/fieldnote-launch.html", name: "Fieldnote launch" }
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
    rebaseOnReady: false,
    loadToken: 0
  };
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
    $("hint").textContent = state.editing
      ? "Click any text to edit it. Click an image to replace it. Shift+Enter inserts a line break."
      : "Preview is on. Links work and editing is paused.";
  }

  function updateUndoButtons() {
    var dirty = !!(state.html && history[historyIndex] !== undefined && state.html !== history[historyIndex]);
    $("btn-undo").disabled = historyIndex <= 0 && !dirty;
    $("btn-redo").disabled = historyIndex >= history.length - 1 || dirty;
  }

  function commitHistory(html) {
    if (history[historyIndex] === html) {
      updateUndoButtons();
      return false;
    }
    history = history.slice(0, historyIndex + 1);
    history.push(html);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
    updateUndoButtons();
    return true;
  }

  function flushPending() {
    clearTimeout(historyTimer);
    if (state.html && state.html !== history[historyIndex]) commitHistory(state.html);
  }

  function scheduleHistory(html) {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(function () { commitHistory(html); }, 500);
  }

  function snapshotPayload() {
    var start = Math.max(0, history.length - 20);
    var sliced = history.slice(start);
    return {
      v: 1,
      html: state.html,
      history: sliced,
      index: historyIndex - start,
      savedAt: Date.now(),
      active: state.active,
      editing: state.editing
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
          v: 1,
          html: state.html,
          savedAt: Date.now(),
          active: state.active,
          editing: state.editing
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
    if (editing) doc.documentElement.classList.add("td-editing");
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
    state.rebaseOnReady = !state.pendingUserEdit;
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
      actions.append(
        actionButton("Up", function () { moveSlide(index, index - 1); }, index === 0, "Move up"),
        actionButton("Down", function () { moveSlide(index, index + 1); }, index === found.slides.length - 1, "Move down"),
        actionButton("Duplicate", function () { duplicateSlide(index); }, false, "Duplicate slide"),
        actionButton("Delete", function (btn) { requestDelete(index, btn); }, found.slides.length < 2, found.slides.length < 2 ? "Keep at least one slide" : "Delete slide")
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
    $("btn-preview").setAttribute("aria-pressed", String(!state.editing));
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

  function setEditing(on) {
    state.editing = !!on;
    renderChrome();
    postToFrame({ type: "td:mode", editing: state.editing });
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
    var after = detectSlides(parse(state.html));
    if (state.active >= after.slides.length) state.active = Math.max(0, after.slides.length - 1);
    if (state.active < 0) state.active = 0;
    commitHistory(state.html);
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
    var clean = normalize(String(html || "").replace(/^\uFEFF/, ""));
    if (!clean.trim()) {
      toast("That file is empty.");
      return;
    }
    state.html = clean;
    state.title = deckTitle(clean);
    state.active = opts.active || 0;
    state.editing = opts.editing !== false;
    state.view = "editor";
    state.pendingUserEdit = false;
    if (opts.history && opts.history.length) {
      history = opts.history.filter(function (item) { return typeof item === "string" && item; });
      historyIndex = Number.isInteger(opts.index) ? opts.index : history.length - 1;
      if (historyIndex < 0 || historyIndex >= history.length) historyIndex = history.length - 1;
      history[historyIndex] = state.html;
    } else {
      history = [state.html];
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
    var html = normalize(state.html);
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
    var html = normalize(state.html);
    var compressed = LZString.compressToEncodedURIComponent(html);
    var ok = $("share-ok");
    var big = $("share-big");
    if (!compressed) {
      toast("Could not compress this deck.");
      return;
    }
    var href = appPath().origin + appPath().pathname + "#d=" + compressed;
    if (compressed.length > SHARE_LIMIT) {
      ok.hidden = true;
      big.hidden = false;
      $("share-big-msg").textContent = "This deck is too large for a link (" + formatChars(compressed.length) + " compressed; the limit is " + formatChars(SHARE_LIMIT) + "). Download the HTML file and send that. The recipient can upload it here.";
    } else {
      big.hidden = true;
      ok.hidden = false;
      $("share-url").value = href;
      $("share-size").textContent = "Compressed to " + formatChars(compressed.length) + " from " + formatChars(html.length) + ". The link contains the whole deck.";
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
    if (frag.indexOf("d=") !== 0) return null;
    var payload = frag.slice(2);
    try { payload = decodeURIComponent(payload); } catch (err) { /* already raw */ }
    var html = LZString.decompressFromEncodedURIComponent(payload);
    if (!html) return { error: true };
    return { html: html };
  }

  function onReady(msg) {
    state.frameReady = true;
    clearTimeout(loadTimer);
    hideOverlay();
    if (state.rebaseOnReady && msg.html) {
      state.html = msg.html;
      if (historyIndex >= 0) history[historyIndex] = msg.html;
      state.title = deckTitle(msg.html);
      state.rebaseOnReady = false;
      persistSoon();
      refreshSidebarLabels();
      renderChrome();
    }
    postToFrame({ type: "td:mode", editing: state.editing });
    postToFrame({ type: "td:slide", index: state.active });
  }

  function onChange(msg) {
    if (typeof msg.html !== "string" || !msg.html) return;
    state.pendingUserEdit = true;
    state.rebaseOnReady = false;
    state.html = msg.html;
    state.title = deckTitle(msg.html);
    if (msg.immediate) {
      clearTimeout(historyTimer);
      commitHistory(msg.html);
      persistNow();
    } else {
      scheduleHistory(msg.html);
      persistSoon();
      updateUndoButtons();
    }
    renderChrome();
    refreshSidebarLabels();
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
    state.html = history[historyIndex];
    state.title = deckTitle(state.html);
    state.pendingUserEdit = false;
    var found = detectSlides(parse(state.html));
    if (state.active >= found.slides.length) state.active = Math.max(0, found.slides.length - 1);
    persistSoon();
    render();
    setStatus(historyIndex === 0 ? "At the earliest edit." : "Restored an earlier version.");
  }

  function bind() {
    $("btn-edit").addEventListener("click", function () { setEditing(true); });
    $("btn-preview").addEventListener("click", function () { setEditing(false); });
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
      loadHtml(saved.html, {
        history: saved.history,
        index: saved.index,
        active: saved.active || 0,
        editing: saved.editing !== false,
        status: "Restored the deck saved in this browser."
      });
    });
    $("btn-discard").addEventListener("click", function () {
      localStorage.removeItem(STORAGE_KEY);
      state.html = "";
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
    $("share-close").addEventListener("click", function () { $("share-dialog").close(); });
    $("share-close-big").addEventListener("click", function () { $("share-dialog").close(); });
    window.addEventListener("message", function (event) {
      var frame = $("deck-frame");
      if (!frame || event.source !== frame.contentWindow) return;
      var msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.token !== state.loadToken) return;
      if (msg.type === "td:ready") onReady(msg);
      else if (msg.type === "td:change") onChange(msg);
      else if (msg.type === "td:slide") {
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
    var shared = readShared();
    var sample = new URLSearchParams(location.search).get("sample");
    window.history.replaceState(null, "", appPath().pathname);
    if (shared && shared.html) {
      loadHtml(shared.html, { status: "Opened a shared deck. Edits save in this browser." });
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
