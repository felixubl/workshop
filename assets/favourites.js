/* Pinned tools. A pin moves a tool to the front of the index and keeps it
   there. The list is held in localStorage in this browser only, keyed by a
   slug on the card rather than by name or position, so renaming or reordering
   does not unpin anything. Loaded by the index and by every tool page, which
   read and write the same list. */
(function () {
  "use strict";

  var KEY = "workshop-pinned";

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(raw) ? raw.filter(function (id) { return typeof id === "string"; }) : [];
    } catch (err) {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (err) {
      /* Private browsing, a full quota, or a blocked origin. The pin still
         works for this page view but will not survive a reload. */
    }
  }

  function paint() {
    var pinned = read();

    document.querySelectorAll("[data-pin]").forEach(function (button) {
      var on = pinned.indexOf(button.getAttribute("data-pin")) >= 0;
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.classList.toggle("is-on", on);

      var card = button.closest("[data-tool]");
      if (card) card.classList.toggle("is-pinned", on);

      var word = button.querySelector("[data-pin-label]");
      if (word) word.textContent = on ? "pinned" : "pin";
    });

    // The count only appears once there is one, so an untouched page says
    // nothing about a feature the reader has not used.
    var count = document.querySelector("[data-pin-count]");
    if (count) count.textContent = pinned.length ? pinned.length + " pinned · " : "";
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-pin]");
    if (!button) return;
    // On the index the pin sits on top of a link covering the whole card.
    event.preventDefault();
    event.stopPropagation();

    var id = button.getAttribute("data-pin");
    var pinned = read();
    var at = pinned.indexOf(id);
    if (at >= 0) pinned.splice(at, 1);
    else pinned.push(id);
    write(pinned);
    paint();
  });

  // Another tab pinning something is the same reader changing their mind.
  window.addEventListener("storage", function (event) {
    if (event.key === KEY) paint();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", paint);
  } else {
    paint();
  }
})();
