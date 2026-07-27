/* Hand this tool to somebody else.

   Every tool page carries one [data-share] button beside its name. It copies
   the tool's own address — origin and path, with any query string or fragment
   dropped, because what a reader wants to pass on is the tool and not the
   state they happen to have it in.

   The button reports back in its own label rather than in a toast. A toast is
   a second surface appearing to describe something that already has a place on
   the page, and the place is the control you just pressed. */
(function () {
  "use strict";

  var RESET_MS = 1600;

  function toolUrl() {
    return location.origin + location.pathname;
  }

  /* The async clipboard needs a secure context, which localhost is and a
     file:// page is not. The textarea route is the one that still works there,
     so it stays as a fallback rather than being assumed dead. */
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
