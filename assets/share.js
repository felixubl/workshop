/* Copies the current tool's address. Every tool page carries one [data-share]
   button beside its name. The query string and fragment are dropped, so what
   is copied is the tool rather than one reader's state. The button reports in
   its own label rather than in a toast. */
(function () {
  "use strict";

  var RESET_MS = 1600;

  function toolUrl() {
    return location.origin + location.pathname;
  }

  /* The async clipboard API needs a secure context, which file:// is not. The
     textarea fallback still works there. */
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "-1000px";
    document.body.appendChild(field);
    field.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(field);
    return ok;
  }

  function report(button, message, done) {
    var slot = button.querySelector("[data-share-label]");
    if (!slot) return;
    if (!button.dataset.restLabel) button.dataset.restLabel = slot.textContent;
    slot.textContent = message;
    button.classList.toggle("is-done", !!done);
    clearTimeout(Number(button.dataset.shareTimer));
    button.dataset.shareTimer = String(
      setTimeout(function () {
        slot.textContent = button.dataset.restLabel;
        button.classList.remove("is-done");
      }, RESET_MS)
    );
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-share]");
    if (!button) return;
    var url = button.getAttribute("data-share") || toolUrl();
    copy(url).then(function (ok) {
      // A failure has to say so. Silently reporting "copied" over an empty
      // clipboard is the one outcome worse than not having the button.
      report(button, ok ? "copied" : "press ⌘C", ok);
      if (!ok) window.prompt("Copy the link to this tool:", url);
    });
  });
})();
