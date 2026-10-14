/* Runs inside the sandboxed deck iframe. Talks to the parent only via postMessage. */
(function () {
  var parentOrigin = window.__TD_PARENT_ORIGIN__ || "*";
  var editing = document.documentElement.classList.contains("td-editing");
  var hoverEl = null;
  var sendTimer = 0;

  function post(msg) {
    msg.token = window.__TD_TOKEN__ || 0;
    try {
      parent.postMessage(msg, parentOrigin);
    } catch (err) {
      parent.postMessage(msg, "*");
    }
  }

  function stripOurClasses(el) {
    el.classList.remove("td-slide", "td-active", "td-hover", "td-print-slide");
    if (!el.getAttribute("class")) el.removeAttribute("class");
  }

  function cleanClone() {
    var root = document.documentElement.cloneNode(true);
    root.querySelectorAll("[data-techydeck]").forEach(function (node) {
      node.remove();
    });
    root.querySelectorAll("[data-td-forced-display]").forEach(function (node) {
      node.style.removeProperty("display");
      node.style.removeProperty("visibility");
      node.style.removeProperty("opacity");
      if (!node.getAttribute("style")) node.removeAttribute("style");
      node.removeAttribute("data-td-forced-display");
    });
    root.querySelectorAll("[data-td-slide], [data-td-img], [contenteditable]").forEach(function (node) {
      node.removeAttribute("data-td-slide");
      node.removeAttribute("data-td-img");
      node.removeAttribute("contenteditable");
      stripOurClasses(node);
    });
    root.querySelectorAll(".td-hover, .td-slide, .td-active, .td-print-slide").forEach(stripOurClasses);
    root.classList.remove("td-slide-host", "td-editing", "td-printing");
    if (!root.getAttribute("class")) root.removeAttribute("class");
    return "<!DOCTYPE html>\n" + root.outerHTML;
  }

  function send(immediate) {
    clearTimeout(sendTimer);
    post({ type: "td:change", html: cleanClone(), immediate: !!immediate });
  }

  function scheduleSend() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(function () {
      send(false);
    }, 350);
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

  function hasBlockChild(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var display = window.getComputedStyle(kids[i]).display;
      if (
        display === "block" ||
        display === "flex" ||
        display === "grid" ||
        display === "list-item" ||
        display === "table" ||
        display === "flow-root"
      ) {
        return true;
      }
    }
    return false;
  }

  var SKIP = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    IFRAME: 1,
    OBJECT: 1,
    SVG: 1,
    PATH: 1,
    TEXTAREA: 1,
    INPUT: 1,
    SELECT: 1,
    OPTION: 1,
    CANVAS: 1,
    VIDEO: 1,
    AUDIO: 1,
    HEAD: 1,
    HTML: 1,
    BODY: 1,
    META: 1,
    LINK: 1
  };

  function findEditable(target) {
    var el = asElement(target);
    if (!el || (el.closest && el.closest("[data-techydeck]"))) return null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (SKIP[el.tagName]) return null;
      if (el.tagName === "IMG") return null;
      if (hasDirectText(el) && !hasBlockChild(el)) return el;
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

  function replaceImage(img) {
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
      var reader = new FileReader();
      reader.onload = function () {
        img.setAttribute("src", String(reader.result));
        img.removeAttribute("srcset");
        if (file.size > 1500000) {
          post({
            type: "td:toast",
            message: "Image added. It is large, so a share link may not fit. Download the HTML if sharing fails."
          });
        }
        send(true);
      };
      reader.readAsDataURL(file);
    });
    picker.click();
  }

  document.addEventListener("pointerdown", function (event) {
    if (!editing) return;
    var el = asElement(event.target);
    if (!el || (el.closest && el.closest("[data-techydeck]"))) return;
    if (el.closest && el.closest("img")) return;
    var editable = findEditable(event.target);
    if (!editable) return;
    editable.setAttribute("contenteditable", "true");
  }, true);

  document.addEventListener("click", function (event) {
    if (!editing) return;
    var el = asElement(event.target);
    if (!el) return;
    var img = el.closest && el.closest("img");
    if (img) {
      event.preventDefault();
      event.stopPropagation();
      replaceImage(img);
      return;
    }
    if (el.closest && el.closest("a, button")) event.preventDefault();
  }, true);

  document.addEventListener("keydown", function (event) {
    var meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      send(true);
      post({ type: event.shiftKey ? "td:redo" : "td:undo" });
      return;
    }
    if (meta && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      send(true);
      post({ type: "td:redo" });
      return;
    }
    if (meta && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      post({ type: "td:print" });
      return;
    }
    if (!editing) return;
    var inField = event.target && event.target.getAttribute && event.target.getAttribute("contenteditable") === "true";
    if (!inField) {
      if (event.key === "ArrowRight" || event.key === "PageDown") showSlide(currentSlide() + 1);
      if (event.key === "ArrowLeft" || event.key === "PageUp") showSlide(currentSlide() - 1);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      scheduleSend();
    } else if (event.key === "Escape") {
      event.target.blur();
    }
  }, true);

  document.addEventListener("input", function () {
    if (editing) scheduleSend();
  });

  document.addEventListener("focusout", function (event) {
    var el = event.target;
    if (!el || !el.getAttribute || el.getAttribute("contenteditable") !== "true") return;
    el.removeAttribute("contenteditable");
    send(false);
  });

  document.addEventListener("mouseover", function (event) {
    if (!editing) {
      setHover(null);
      return;
    }
    var el = asElement(event.target);
    var img = el && el.closest && el.closest("img");
    setHover(img || findEditable(event.target));
  });

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var msg = event.data || {};
    if (msg.type === "td:slide") showSlide(msg.index | 0);
    if (msg.type === "td:mode") {
      editing = !!msg.editing;
      document.documentElement.classList.toggle("td-editing", editing);
      if (!editing) {
        setHover(null);
        document.querySelectorAll("[contenteditable='true']").forEach(function (el) {
          el.removeAttribute("contenteditable");
        });
        send(true);
      }
    }
    if (msg.type === "td:flush") send(true);
  });

  window.addEventListener("beforeprint", function () {
    document.documentElement.classList.add("td-printing");
  });
  window.addEventListener("afterprint", function () {
    document.documentElement.classList.remove("td-printing");
  });

  var readyHtml = "";
  try {
    readyHtml = cleanClone();
  } catch (err) {
    readyHtml = "";
  }
  post({ type: "td:ready", html: readyHtml });
})();
