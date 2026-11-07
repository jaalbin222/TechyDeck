/* Runs inside the sandboxed deck iframe. Edits are anchor deltas, never a dump of the live DOM. */
(function () {
  var parentOrigin = window.__TD_PARENT_ORIGIN__ || "*";
  var editing = document.documentElement.classList.contains("td-editing");
  var commenting = false;
  var hoverEl = null;
  var sendTimer = 0;
  var pendingEl = null;

  function post(msg) {
    msg.token = window.__TD_TOKEN__ || 0;
    try {
      parent.postMessage(msg, parentOrigin);
    } catch (err) {
      parent.postMessage(msg, "*");
    }
  }

  function asElement(target) {
    if (!target) return null;
    return target.nodeType === 1 ? target : target.parentElement;
  }

  function hasDirectText(el) {
    var nodes = el.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 3 && nodes[i].textContent.trim()) return true;
    }
    return false;
  }

  var SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, SVG: 1, PATH: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1,
    HEAD: 1, HTML: 1, BODY: 1, META: 1, LINK: 1, BUTTON: 1, LABEL: 1
  };

  function findLeaf(target) {
    var el = asElement(target);
    if (!el || (el.closest && el.closest("[data-techydeck], svg, script, style"))) return null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (SKIP[el.tagName]) return null;
      if (el.tagName === "IMG") return null;
      if (el.getAttribute("data-td-kind") === "text" && el.getAttribute("data-td-anchor") && !el.children.length && hasDirectText(el)) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function setHover(el) {
    if (hoverEl === el) return;
    if (hoverEl) hoverEl.classList.remove("td-hover");
    hoverEl = el;
    if (hoverEl) hoverEl.classList.add("td-hover");
  }

  function clearForced(el) {
    if (!el.hasAttribute("data-td-forced-display")) return;
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
    el.style.removeProperty("opacity");
    el.removeAttribute("data-td-forced-display");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }

  function showSlide(index) {
    var slides = document.querySelectorAll("[data-td-slide]");
    if (!slides.length) return;
    if (index < 0) index = 0;
    if (index > slides.length - 1) index = slides.length - 1;
    for (var i = 0; i < slides.length; i++) {
      clearForced(slides[i]);
      slides[i].classList.toggle("td-active", i === index);
    }
    var active = slides[index];
    var cs = window.getComputedStyle(active);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
      active.style.setProperty("display", "block", "important");
      active.style.setProperty("visibility", "visible", "important");
      active.style.setProperty("opacity", "1", "important");
      active.setAttribute("data-td-forced-display", "1");
    }
    post({ type: "td:slide", index: index });
  }

  function currentSlide() {
    var slides = document.querySelectorAll("[data-td-slide]");
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].classList.contains("td-active")) return i;
    }
    return 0;
  }

  function anchorOf(el) {
    return el ? el.getAttribute("data-td-anchor") || "" : "";
  }

  function sendText(el, immediate) {
    var anchor = anchorOf(el);
    if (!anchor) return;
    post({
      type: "td:text",
      anchor: anchor,
      text: el.textContent,
      immediate: !!immediate
    });
  }

  function flushPending(immediate) {
    clearTimeout(sendTimer);
    if (pendingEl && pendingEl.isConnected) sendText(pendingEl, immediate);
    pendingEl = null;
  }

  function scheduleText(el) {
    pendingEl = el;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(function () { flushPending(false); }, 350);
  }

  function replaceImage(img) {
    var anchor = anchorOf(img);
    if (!anchor) {
      post({ type: "td:toast", message: "This image is not in an editable part of the file." });
      return;
    }
    var picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.setAttribute("data-techydeck", "1");
    picker.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(picker);
    picker.addEventListener("change", function () {
      var file = picker.files && picker.files[0];
      picker.remove();
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        post({ type: "td:toast", message: "Choose an image file." });
        return;
      }
      if (file.size > 1500000) {
        post({ type: "td:toast", message: "That image is over 1.5 MB. Choose a smaller one so the deck stays easy to save." });
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var src = String(reader.result || "");
        img.setAttribute("src", src);
        img.removeAttribute("srcset");
        post({ type: "td:image", anchor: anchor, src: src, alt: img.getAttribute("alt") || "" });
      };
      reader.readAsDataURL(file);
    });
    picker.click();
  }

  function highlightAnchor(anchor) {
    var el = document.querySelector('[data-td-anchor="' + anchor + '"]');
    if (!el) return;
    var slides = document.querySelectorAll("[data-td-slide]");
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] === el || slides[i].contains(el)) showSlide(i);
    }
    setHover(el);
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (err) { el.scrollIntoView(); }
  }

  document.addEventListener("pointerdown", function (event) {
    if (!editing || commenting) return;
    var el = asElement(event.target);
    if (!el || (el.closest && el.closest("[data-techydeck]"))) return;
    if (el.closest && el.closest("img")) return;
    var editable = findLeaf(event.target);
    if (!editable) return;
    if (pendingEl && pendingEl !== editable) flushPending(false);
    editable.setAttribute("contenteditable", "true");
    post({ type: "td:focus", anchor: anchorOf(editable) });
  }, true);

  document.addEventListener("click", function (event) {
    var el = asElement(event.target);
    if (!el || (el.closest && el.closest("[data-techydeck]"))) return;
    if (commenting) {
      var target = (el.closest && el.closest("[data-td-anchor]")) || findLeaf(el);
      var imgTarget = el.closest && el.closest("img");
      if (imgTarget) target = imgTarget;
      if (!target || !anchorOf(target)) return;
      event.preventDefault();
      event.stopPropagation();
      post({
        type: "td:comment-target",
        anchor: anchorOf(target),
        preview: (target.getAttribute("alt") || target.textContent || "Image").replace(/\s+/g, " ").trim().slice(0, 80)
      });
      return;
    }
    if (!editing) return;
    var img = el.closest && el.closest("img");
    if (img && img.getAttribute("data-td-kind") === "image") {
      event.preventDefault();
      event.stopPropagation();
      replaceImage(img);
      return;
    }
    if (el.closest && el.closest("a")) event.preventDefault();
  }, true);

  document.addEventListener("paste", function (event) {
    var el = event.target;
    if (!el || !el.getAttribute || el.getAttribute("contenteditable") !== "true") return;
    event.preventDefault();
    var text = "";
    if (event.clipboardData) text = event.clipboardData.getData("text/plain") || "";
    text = text.replace(/\r\n/g, "\n").replace(/\n/g, " ");
    try { document.execCommand("insertText", false, text); } catch (err) { el.textContent += text; }
    scheduleText(el);
  }, true);

  document.addEventListener("keydown", function (event) {
    var meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === "z" || event.key === "Z")) {
      if (event.target && event.target.getAttribute && event.target.getAttribute("contenteditable") === "true") {
        event.preventDefault();
        flushPending(true);
        post({ type: event.shiftKey ? "td:redo" : "td:undo" });
      }
      return;
    }
    if (meta && (event.key === "y" || event.key === "Y")) {
      if (event.target && event.target.getAttribute && event.target.getAttribute("contenteditable") === "true") {
        event.preventDefault();
        flushPending(true);
        post({ type: "td:redo" });
      }
      return;
    }
    if (meta && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      post({ type: "td:print" });
      return;
    }
    if (!editing || commenting) return;
    var inField = event.target && event.target.getAttribute && event.target.getAttribute("contenteditable") === "true";
    if (!inField) {
      if (event.key === "ArrowRight" || event.key === "PageDown") showSlide(currentSlide() + 1);
      if (event.key === "ArrowLeft" || event.key === "PageUp") showSlide(currentSlide() - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === "Escape") {
      event.target.blur();
    }
  }, true);

  document.addEventListener("input", function (event) {
    if (!editing || commenting) return;
    var el = event.target;
    if (!el || el.getAttribute("contenteditable") !== "true") return;
    scheduleText(el);
  });

  document.addEventListener("focusout", function (event) {
    var el = event.target;
    if (!el || !el.getAttribute || el.getAttribute("contenteditable") !== "true") return;
    el.removeAttribute("contenteditable");
    if (pendingEl === el) pendingEl = el;
    flushPending(false);
    post({ type: "td:blur" });
  });

  document.addEventListener("mouseover", function (event) {
    if (!editing && !commenting) {
      setHover(null);
      return;
    }
    var el = asElement(event.target);
    var img = el && el.closest && el.closest("img[data-td-kind='image']");
    var leaf = findLeaf(event.target);
    var marked = el && el.closest && el.closest("[data-td-anchor]");
    setHover(img || leaf || (commenting ? marked : null));
  });

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var msg = event.data || {};
    if (msg.type === "td:slide") showSlide(msg.index | 0);
    if (msg.type === "td:mode") {
      editing = !!msg.editing && !msg.commenting;
      commenting = !!msg.commenting;
      document.documentElement.classList.toggle("td-editing", editing);
      document.documentElement.classList.toggle("td-commenting", commenting);
      if (!editing) {
        setHover(null);
        flushPending(true);
        document.querySelectorAll("[contenteditable='true']").forEach(function (el) {
          el.removeAttribute("contenteditable");
        });
      }
    }
    if (msg.type === "td:show-anchor" && typeof msg.anchor === "string") highlightAnchor(msg.anchor);
    if (msg.type === "td:alt" && typeof msg.anchor === "string") {
      var img = document.querySelector('img[data-td-anchor="' + msg.anchor + '"]');
      if (img && typeof msg.alt === "string") img.setAttribute("alt", msg.alt);
    }
  });

  window.addEventListener("beforeprint", function () {
    document.documentElement.classList.add("td-printing");
  });
  window.addEventListener("afterprint", function () {
    document.documentElement.classList.remove("td-printing");
  });

  post({ type: "td:ready" });
})();
