/* Showpiece. Local only. Does not pretend anyone else is here. */
(function () {
  var KEY = "techydeck.demo.v1";
  var SAMPLE = "samples/northline.html";
  var FRAME_CSS = [
    "html.td-slide-host:not(.td-printing) .td-slide:not(.td-active){display:none!important}",
    "html.td-slide-host,html.td-slide-host body{margin:0!important;height:100%!important;overflow:hidden!important}",
    "html.td-slide-host .td-slide.td-active{height:100%!important;max-height:100%!important;min-height:0!important;overflow:auto!important}",
    "html.td-editing .td-hover,html.td-commenting .td-hover{outline:1.5px solid #9a4e2c;outline-offset:4px}",
    "html.td-editing [contenteditable='true']{outline:1.5px solid #9a4e2c;outline-offset:4px}"
  ].join("");

  var state = {
    html: "",
    comments: [],
    title: "Northline Q4",
    active: 1,
    editing: true,
    commenting: false,
    token: 0,
    ready: false,
    anchor: "",
    sample: true,
    history: [],
    index: -1,
    timer: 0
  };

  function $(id) { return document.getElementById(id); }
  function parse(html) { return new DOMParser().parseFromString(html, "text/html"); }
  function serialize(doc) { return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML; }

  function detectSlides(doc) {
    var reveal = Array.prototype.slice.call(doc.querySelectorAll(".reveal .slides > section"));
    if (reveal.length) return reveal;
    var slides = Array.prototype.slice.call(doc.querySelectorAll(".slide"));
    if (slides.length >= 2) return slides;
    var sections = Array.prototype.slice.call(doc.querySelectorAll("section"));
    if (sections.length >= 2) return sections;
    return [];
  }

  function stamp(doc) {
    var n = 0;
    doc.querySelectorAll("[data-td-anchor]").forEach(function (el) {
      var m = /^td-a(\d+)$/.exec(el.getAttribute("data-td-anchor") || "");
      if (m) n = Math.max(n, Number(m[1]));
    });
    function mark(el, kind) {
      if (!/^td-a\d+$/.test(el.getAttribute("data-td-anchor") || "")) {
        n += 1;
        el.setAttribute("data-td-anchor", "td-a" + n);
      }
      el.setAttribute("data-td-kind", kind);
    }
    doc.querySelectorAll("img").forEach(function (img) {
      if (!img.closest("svg")) mark(img, "image");
    });
    doc.body.querySelectorAll("*").forEach(function (el) {
      if (/^(SCRIPT|STYLE|BUTTON|INPUT|TEXTAREA|SELECT|SVG|PATH)$/.test(el.tagName)) return;
      if (el.closest("svg, script, style")) return;
      if (el.children.length) return;
      var text = false;
      for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3 && el.childNodes[i].textContent.trim()) text = true;
      }
      if (text) mark(el, "text");
    });
  }

  function titles() {
    var doc = parse(state.html);
    var slides = detectSlides(doc);
    if (!slides.length) return ["Document"];
    return slides.map(function (el, i) {
      var h = el.querySelector("h1, h2, p");
      var t = (h ? h.textContent : el.textContent).replace(/\s+/g, " ").trim();
      return (t || "Slide " + (i + 1)).slice(0, 42);
    });
  }

  function pack() {
    return JSON.stringify({ html: state.html, comments: state.comments });
  }

  function commit() {
    var snap = pack();
    if (state.history[state.index] === snap) return;
    state.history = state.history.slice(0, state.index + 1);
    state.history.push(snap);
    if (state.history.length > 40) state.history.shift();
    state.index = state.history.length - 1;
    paintTools();
    save();
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        html: state.html,
        comments: state.comments,
        active: state.active,
        sample: state.sample,
        history: state.history,
        index: state.index
      }));
      $("status").textContent = state.sample ? "Demo · saved in this browser" : "Your file · saved in this browser";
    } catch (err) {
      $("status").textContent = "Could not save in this browser";
    }
  }

  function paintTools() {
    $("btn-undo").disabled = state.index <= 0;
    $("btn-redo").disabled = state.index >= state.history.length - 1;
    $("btn-edit").setAttribute("aria-pressed", String(state.editing));
    $("btn-comment").setAttribute("aria-pressed", String(state.commenting));
    $("deck-title").textContent = state.title;
  }

  function paintNotes() {
    var list = $("notes");
    list.replaceChildren();
    if (!state.comments.length) {
      var empty = document.createElement("li");
      empty.className = "fine";
      empty.textContent = "No notes yet.";
      list.appendChild(empty);
      return;
    }
    state.comments.forEach(function (note) {
      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "note";
      var who = document.createElement("strong");
      who.textContent = note.sample ? "Sample note" : "You";
      var body = document.createElement("span");
      body.textContent = note.body;
      button.append(who, body);
      button.addEventListener("click", function () { reveal(note.anchorId); });
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  function paintThumbs() {
    var nav = $("thumbs");
    nav.replaceChildren();
    titles().forEach(function (title, index) {
      var button = document.createElement("button");
      button.type = "button";
      if (index === state.active) button.setAttribute("aria-current", "true");
      var sw = document.createElement("span");
      sw.className = "swatch" + (index === 0 ? "" : " light");
      var num = document.createElement("span");
      num.textContent = String(index + 1).padStart(2, "0");
      var name = document.createElement("strong");
      name.textContent = title;
      button.append(sw, num, name);
      button.addEventListener("click", function () { go(index); });
      nav.appendChild(button);
    });
  }

  function srcdoc() {
    var doc = parse(state.html);
    var slides = detectSlides(doc);
    if (slides.length) {
      doc.documentElement.classList.add("td-slide-host");
      slides.forEach(function (el, i) {
        el.classList.add("td-slide");
        el.setAttribute("data-td-slide", String(i));
        el.classList.toggle("td-active", i === state.active);
      });
    }
    if (state.editing) doc.documentElement.classList.add("td-editing");
    var style = doc.createElement("style");
    style.setAttribute("data-techydeck", "1");
    style.textContent = FRAME_CSS;
    doc.head.appendChild(style);
    var boot = doc.createElement("script");
    boot.setAttribute("data-techydeck", "1");
    boot.textContent = "window.__TD_PARENT_ORIGIN__=" + JSON.stringify(location.origin) + ";window.__TD_TOKEN__=" + state.token + ";";
    doc.body.appendChild(boot);
    var script = doc.createElement("script");
    script.src = new URL("js/editor-runtime.js", document.baseURI).href;
    script.setAttribute("data-techydeck", "1");
    doc.body.appendChild(script);
    return serialize(doc);
  }

  function mount() {
    state.token += 1;
    state.ready = false;
    $("overlay").hidden = false;
    $("frame").srcdoc = srcdoc();
  }

  function post(msg) {
    var frame = $("frame");
    if (state.ready && frame.contentWindow) frame.contentWindow.postMessage(msg, "*");
  }

  function go(index) {
    var count = titles().length;
    if (index < 0) index = 0;
    if (index > count - 1) index = count - 1;
    state.active = index;
    paintThumbs();
    post({ type: "td:slide", index: index });
    save();
  }

  function reveal(anchor) {
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    var slides = detectSlides(doc);
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] === el || slides[i].contains(el)) go(i);
    }
    post({ type: "td:show-anchor", anchor: anchor });
  }

  function setMode(edit, comment) {
    state.editing = edit;
    state.commenting = comment;
    paintTools();
    post({ type: "td:mode", editing: edit, commenting: comment });
  }

  function bakeText(anchor, text) {
    if (!/^td-a\d+$/.test(anchor) || typeof text !== "string" || text.length > 5000) return;
    var doc = parse(state.html);
    var el = doc.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el || el.getAttribute("data-td-kind") !== "text" || el.children.length) return;
    el.textContent = text;
    state.html = serialize(doc);
    if (text.indexOf("$") === 0) coach("Nice. Choose Comment, then click that figure to leave a note.");
  }

  function addNote(body) {
    var text = String(body || "").trim();
    if (!text || !/^td-a\d+$/.test(state.anchor)) return;
    state.comments.push({
      id: "n" + Date.now().toString(36),
      anchorId: state.anchor,
      body: text.slice(0, 500),
      sample: false
    });
    $("note-form").hidden = true;
    $("note-body").value = "";
    paintNotes();
    commit();
    coach("Open Seats and press +. The total should move. Then export or share a copy.");
  }

  function coach(text) {
    $("coach").innerHTML = "";
    $("coach").append(document.createTextNode(text + " "));
    var button = document.createElement("button");
    button.type = "button";
    button.id = "coach-dismiss";
    button.textContent = "Dismiss";
    button.addEventListener("click", function () { $("coach").hidden = true; });
    $("coach").appendChild(button);
    $("coach").hidden = false;
  }

  function undo() {
    if (state.index <= 0) return;
    state.index -= 1;
    restore();
  }
  function redo() {
    if (state.index >= state.history.length - 1) return;
    state.index += 1;
    restore();
  }
  function restore() {
    var data = JSON.parse(state.history[state.index]);
    state.html = data.html;
    state.comments = data.comments || [];
    paintNotes();
    paintThumbs();
    paintTools();
    mount();
    save();
  }

  function exportFile() {
    var blob = new Blob([state.html], { type: "text/html;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "northline-demo.html";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  function shareCopy() {
    var payload = JSON.stringify({ html: state.html, comments: state.comments, title: state.title });
    var packed = LZString.compressToEncodedURIComponent(payload);
    var dialog = $("share-dialog");
    if (!packed || packed.length > 48000) {
      $("share-url").value = "";
      $("share-note").textContent = "This deck is too large for a link. Use Export instead.";
      dialog.showModal();
      return;
    }
    var url = new URL("demo.html", document.baseURI);
    $("share-url").value = url.origin + url.pathname + "#copy=" + packed;
    $("share-url").scrollLeft = 0;
    $("share-note").textContent = "Anyone with the link gets their own copy. Nothing is uploaded.";
    dialog.showModal();
  }

  function loadHtml(html, opts) {
    opts = opts || {};
    var doc = parse(html);
    stamp(doc);
    state.html = serialize(doc);
    state.title = (doc.querySelector("title") && doc.querySelector("title").textContent.trim()) || "Untitled deck";
    state.sample = opts.sample !== false;
    state.active = typeof opts.active === "number" ? opts.active : (state.sample ? 1 : 0);
    state.comments = opts.comments || (state.sample ? seed(doc) : []);
    state.history = [pack()];
    state.index = 0;
    state.editing = true;
    state.commenting = false;
    paintNotes();
    paintThumbs();
    paintTools();
    mount();
    save();
    if (state.sample) coach("Click $4.8M and type the figure you would actually say.");
    else $("coach").hidden = true;
  }

  function seed(doc) {
    var el = Array.prototype.find.call(doc.querySelectorAll("[data-td-kind='text']"), function (node) {
      return node.textContent.trim() === "$4.8M";
    });
    if (!el) return [];
    return [{
      id: "sample-note",
      anchorId: el.getAttribute("data-td-anchor"),
      body: "Sample note. The draft still said $5.1M.",
      sample: true
    }];
  }

  function bootSaved(saved) {
    state.html = saved.html;
    state.comments = saved.comments || [];
    state.active = saved.active || 0;
    state.sample = saved.sample !== false;
    state.history = saved.history && saved.history.length ? saved.history : [pack()];
    state.index = Number.isInteger(saved.index) ? saved.index : state.history.length - 1;
    var doc = parse(state.html);
    state.title = (doc.querySelector("title") && doc.querySelector("title").textContent.trim()) || "Northline Q4";
    paintNotes();
    paintThumbs();
    paintTools();
    mount();
    $("coach").hidden = true;
  }

  function onMessage(event) {
    if (event.source !== $("frame").contentWindow) return;
    var msg = event.data;
    if (!msg || msg.token !== state.token) return;
    if (msg.type === "td:ready") {
      state.ready = true;
      $("overlay").hidden = true;
      post({ type: "td:mode", editing: state.editing, commenting: state.commenting });
      post({ type: "td:slide", index: state.active });
    } else if (msg.type === "td:text") {
      bakeText(msg.anchor, msg.text);
      clearTimeout(state.timer);
      state.timer = setTimeout(commit, 400);
      paintThumbs();
    } else if (msg.type === "td:comment-target") {
      state.anchor = msg.anchor;
      $("note-target").textContent = msg.preview || "this element";
      $("note-form").hidden = false;
      $("note-body").focus();
    } else if (msg.type === "td:slide") {
      state.active = msg.index | 0;
      paintThumbs();
    } else if (msg.type === "td:undo") undo();
    else if (msg.type === "td:redo") redo();
  }

  function bind() {
    $("btn-edit").addEventListener("click", function () { setMode(true, false); });
    $("btn-comment").addEventListener("click", function () { setMode(false, true); coach("Click the figure, or any sentence, to anchor a note."); });
    $("btn-present").addEventListener("click", function () {
      document.body.classList.toggle("present");
      $("btn-present").textContent = document.body.classList.contains("present") ? "Exit" : "Present";
    });
    $("btn-undo").addEventListener("click", undo);
    $("btn-redo").addEventListener("click", redo);
    $("btn-export").addEventListener("click", exportFile);
    $("btn-share").addEventListener("click", shareCopy);
    $("share-close").addEventListener("click", function () { $("share-dialog").close(); });
    $("share-copy").addEventListener("click", function () {
      var field = $("share-url");
      if (navigator.clipboard) navigator.clipboard.writeText(field.value).catch(function () { field.select(); });
      else field.select();
    });
    $("btn-reset").addEventListener("click", function () {
      if ($("btn-reset").dataset.armed !== "1") {
        $("btn-reset").dataset.armed = "1";
        $("btn-reset").textContent = "Reset demo?";
        setTimeout(function () {
          $("btn-reset").dataset.armed = "";
          $("btn-reset").textContent = "Reset";
        }, 2500);
        return;
      }
      localStorage.removeItem(KEY);
      location.hash = "";
      location.reload();
    });
    $("file").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        loadHtml(String(reader.result || ""), { sample: false, comments: [] });
        $("status").textContent = "Your file · saved in this browser";
      };
      reader.readAsText(file);
    });
    $("note-form").addEventListener("submit", function (event) {
      event.preventDefault();
      addNote($("note-body").value);
    });
    $("coach-dismiss").addEventListener("click", function () { $("coach").hidden = true; });
    window.addEventListener("message", onMessage);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && document.body.classList.contains("present")) {
        document.body.classList.remove("present");
        $("btn-present").textContent = "Present";
      }
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if ((event.metaKey || event.ctrlKey) && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (event.key === "ArrowRight") go(state.active + 1);
      else if (event.key === "ArrowLeft") go(state.active - 1);
    });
  }

  function readCopy() {
    var frag = location.hash.replace(/^#/, "");
    if (frag.indexOf("copy=") !== 0) return null;
    var decoded = LZString.decompressFromEncodedURIComponent(frag.slice(5));
    if (!decoded) return null;
    try { return JSON.parse(decoded); } catch (err) { return null; }
  }

  function init() {
    bind();
    var copy = readCopy();
    if (copy && copy.html) {
      history.replaceState(null, "", new URL("demo.html", document.baseURI).pathname);
      loadHtml(copy.html, { sample: false, comments: copy.comments || [], active: 0 });
      $("status").textContent = "A copy · saved in this browser";
      $("coach").hidden = true;
      return;
    }
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (err) { saved = null; }
    if (saved && saved.html) {
      bootSaved(saved);
      return;
    }
    fetch(new URL(SAMPLE, document.baseURI).href).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }).then(function (html) {
      loadHtml(html, { sample: true });
    }).catch(function () {
      $("overlay").textContent = "The demo deck did not load. Serve this folder over HTTP.";
    });
  }

  init();
})();
