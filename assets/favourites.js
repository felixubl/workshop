/* Pinned tools. A pin lifts a tool out of its category and onto the Pinned
   shelf at the top of the index; unpinning puts it back exactly where it was.
   The card itself moves, rather than being sorted to the front of the page,
   because sorting can only reorder within one container and promoting a card
   that way dragged the whole category up with it.

   The list is held in localStorage in this browser only, keyed by a slug on the
   card rather than by name or position, so renaming or reordering does not
   unpin anything. Loaded by the index and by every tool page, which read and
   write the same list. A tool page has the pin but none of the cards, so every
   move here is guarded on the shelf existing. */
(function () {
  "use strict";

  var KEY = "workshop-pinned";
  var REGISTER = /^reg-\d+$/;

  /* Where each card came from, remembered once at load: its category and its
     place in it, written onto the card as data-home. A place is a number rather
     than a neighbour because the neighbour may itself be away on the shelf when
     the card comes back, and a card that went out third comes back third
     whichever of the others are still gone. */
  var home = null;

  function learnHomes() {
    if (home) return home;
    home = [];
    document.querySelectorAll("[data-tool]").forEach(function (card, i) {
      var area = card.closest("section");
      /* The register is declared on the category and --w-card-ink is inherited,
         so a card that leaves its category leaves its colour behind unless it
         takes the class with it. In its own category this changes nothing: the
         value is the one it was already inheriting. */
      if (area) {
        area.classList.forEach(function (name) {
          if (REGISTER.test(name)) card.classList.add(name);
        });
      }
      card.setAttribute("data-home", String(i));
      home.push({ card: card, parent: card.parentNode, at: i });
    });
    return home;
  }

  function putBack(spot) {
    var before = null;
    var kids = spot.parent.children;
    for (var i = 0; i < kids.length; i++) {
      var at = kids[i].getAttribute("data-home");
      if (at !== null && +at > spot.at) { before = kids[i]; break; }
    }
    spot.parent.insertBefore(spot.card, before);
  }

  function shelve(pinned) {
    var shelf = document.getElementById("pinnedPlates");
    var section = document.getElementById("pinned");
    if (!shelf || !section) return;
    var homes = learnHomes();

    // Onto the shelf, in the order they were pinned.
    pinned.forEach(function (id) {
      var card = document.querySelector('[data-tool="' + id + '"]');
      if (card) shelf.appendChild(card);
    });

    // And back into the category, for anything no longer pinned.
    homes.forEach(function (spot) {
      if (pinned.indexOf(spot.card.getAttribute("data-tool")) >= 0) return;
      if (spot.card.parentNode === spot.parent) return;
      putBack(spot);
    });

    var on = shelf.children.length;
    section.hidden = !on;
    var count = section.querySelector("[data-pinned-count]");
    if (count) count.textContent = on === 1 ? "1 pinned" : on + " pinned";
  }

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
    shelve(pinned);

    document.querySelectorAll("[data-pin]").forEach(function (button) {
      var on = pinned.indexOf(button.getAttribute("data-pin")) >= 0;
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.classList.toggle("is-on", on);

      var card = button.closest("[data-tool]");
      if (card) card.classList.toggle("is-pinned", on);

      var word = button.querySelector("[data-pin-label]");
      if (word) word.textContent = on ? "pinned" : "pin";
    });
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
