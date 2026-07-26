/* The workshop's drawn controls.

   Four of the browser's own widgets are the only things on these pages the
   design system never drew: the spinner arrows on a number field, the checkbox,
   the colour swatch and its OS dialog, and the menu a <select> opens. Plus the
   grey box a `title` attribute produces. Each one arrives styled by the
   operating system rather than by PREPRINT, which is why a tool page could look
   right in a screenshot and wrong in use.

   This file replaces all of them, and it does it by ENHANCEMENT rather than by
   replacement: the native <input> and <select> stay in the DOM as the source of
   truth, hidden, and the drawn control writes to them and fires the events they
   would have fired. So a tool's own script keeps reading `colorInput.value` and
   listening for `change`, and knows nothing about any of this. Neither tool
   script needed a single line changed.

   A MutationObserver picks up controls added after load, which is how the
   random number generator's parameter fields get their steppers when the
   distribution changes.

   Load it AFTER the tool's own script, so anything the tool builds at startup
   is already in the DOM. */

(function () {
  "use strict";

  const MARK = "data-drawn";
  const svg = (path, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="square" aria-hidden="true"><path d="${path}"></path></svg>`;
  const CHEVRON_DOWN = "M4.5 6.5 8 10l3.5-3.5";
  const CHEVRON_UP = "M4.5 9.5 8 6l3.5 3.5";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // The tools read their controls with plain DOM properties, so every drawn
  // control has to leave the native element looking exactly as if a person had
  // used it: value set, then input and change, both bubbling.
  function commit(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ── Popovers ────────────────────────────────────────────────────────────
     One open at a time, positioned in viewport coordinates so no scroll
     container can clip them, and re-placed rather than closed when the page
     moves under them. Law 04 allows a single hard cast per view for something
     temporarily on top of the work: that is this, and the single-open rule is
     what keeps it to one. */

  let openPopover = null;

  function place(pop, anchor) {
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - a.bottom;
    const flip = below < p.height + gap && a.top > below;
    pop.style.top = `${Math.round(flip ? a.top - p.height - gap : a.bottom + gap)}px`;
    pop.style.left = `${Math.round(
      clamp(a.left, 8, Math.max(8, window.innerWidth - p.width - 8))
    )}px`;
  }

  function closePopover() {
    if (!openPopover) return;
    const { pop, trigger } = openPopover;
    pop.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    openPopover = null;
  }

  function showPopover(pop, trigger, onClose) {
    closePopover();
    pop.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openPopover = { pop, trigger, onClose };
    place(pop, trigger);
  }

  addEventListener(
    "scroll",
    () => openPopover && place(openPopover.pop, openPopover.trigger),
    true
  );
  addEventListener("resize", () => openPopover && place(openPopover.pop, openPopover.trigger));
  addEventListener("pointerdown", (event) => {
    if (!openPopover) return;
    if (openPopover.pop.contains(event.target) || openPopover.trigger.contains(event.target)) return;
    closePopover();
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openPopover) {
      const trigger = openPopover.trigger;
      closePopover();
      trigger.focus();
    }
  });

  /* ── Number steppers ─────────────────────────────────────────────────────
     The native arrows are two 8px targets in a corner of the field with the
     platform's own chrome. These are the same two steps, drawn, and they hold
     to repeat the way the native ones do. On touch there are no arrows at all:
     a drawn spinner is a pointer affordance, and the numeric keyboard is the
     better control there. */

  function decimalsOf(step) {
    const text = String(step);
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
  }

  function stepBy(input, direction) {
    const raw = input.step && input.step !== "any" ? Number(input.step) : 1;
    const size = Number.isFinite(raw) && raw > 0 ? raw : 1;
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    let value = Number(input.value);
    if (!Number.isFinite(value)) value = Number.isFinite(min) ? min : 0;
    // Stepping 0.1 six times in binary floating point is 0.6000000000000001,
    // so the result is rounded back to the precision the step implies.
    const next = clamp(
      Number((value + direction * size).toFixed(decimalsOf(size))),
      min,
      max
    );
    if (next === value) return;
    input.value = String(next);
    commit(input);
  }

  function limitState(input, up, down) {
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    const value = Number(input.value);
    up.classList.toggle("is-limit", Number.isFinite(value) && value >= max);
    down.classList.toggle("is-limit", Number.isFinite(value) && value <= min);
  }

  function enhanceNumber(input) {
    input.setAttribute(MARK, "");

    const shell = document.createElement("span");
    shell.className = "stepper";
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);

    const arrows = document.createElement("span");
    arrows.className = "stepper-arrows";
    // The input is the control and it is already labelled and keyboard
    // steppable. The arrows are a second way to reach it, not a second thing
    // to announce, so they stay out of the tab order and the tree.
    arrows.setAttribute("aria-hidden", "true");

    const make = (direction, path) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stepper-arrow";
      button.tabIndex = -1;
      button.innerHTML = svg(path, 13);
      let timer;
      let repeat;
      const stop = () => {
        clearTimeout(timer);
        clearInterval(repeat);
      };
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        // A tool may set the value straight onto the field without firing
        // anything (draw-svg's size presets do exactly that), so the limit
        // state is recomputed on arrival rather than trusted from the last
        // event seen.
        sync();
        stepBy(input, direction);
        timer = setTimeout(() => {
          repeat = setInterval(() => stepBy(input, direction), 55);
        }, 420);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((type) =>
        button.addEventListener(type, stop)
      );
      addEventListener("blur", stop);
      return button;
    };

    const up = make(1, CHEVRON_UP);
    const down = make(-1, CHEVRON_DOWN);
    arrows.append(up, down);
    shell.appendChild(arrows);

    const sync = () => limitState(input, up, down);
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    arrows.addEventListener("pointerenter", sync);
    sync();
  }

  /* ── Colour ──────────────────────────────────────────────────────────────
     The native swatch opens the operating system's colour dialog, which is a
     different design system arriving on top of this one. This is the same
     control drawn here: a saturation/value field, a hue bar, the hex, a
     palette, and the system eyedropper where the browser exposes one. */

  const PALETTE = [
    "#000000", "#7f7f7f", "#880015", "#ed1c24", "#ff7f27", "#fff200",
    "#22b14c", "#00a2e8", "#3f48cc", "#a349a4", "#b97a57", "#ffaec9",
    "#ffffff", "#c3c3c3", "#efe4b0", "#99d9ea",
  ];

  const hex2rgb = (hex) => {
    let h = hex.replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  const rgb2hex = ({ r, g, b }) =>
    "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

  function rgb2hsv({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsv2rgb({ h, s, v }) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const t = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][Math.floor((h % 360) / 60)];
    return { r: (t[0] + m) * 255, g: (t[1] + m) * 255, b: (t[2] + m) * 255 };
  }

  function enhanceColor(input) {
    input.setAttribute(MARK, "");
    input.hidden = true;

    const wrap = document.createElement("span");
    wrap.className = "picker";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "swatch-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    const chip = document.createElement("span");
    chip.className = "swatch-chip";
    trigger.appendChild(chip);
    wrap.appendChild(trigger);

    const pop = document.createElement("div");
    pop.className = "pop pop-color";
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Choose a colour");
    pop.innerHTML =
      '<div class="sv" tabindex="0" role="application" aria-label="Saturation and brightness"><span class="sv-mark"></span></div>' +
      '<div class="hue" tabindex="0" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="359"><span class="hue-mark"></span></div>' +
      '<div class="pop-row"><input class="field hex" type="text" spellcheck="false" autocomplete="off" aria-label="Hex value" maxlength="7"></div>' +
      '<div class="swatches"></div>';
    wrap.appendChild(pop);

    const sv = pop.querySelector(".sv");
    const svMark = pop.querySelector(".sv-mark");
    const hue = pop.querySelector(".hue");
    const hueMark = pop.querySelector(".hue-mark");
    const hexField = pop.querySelector(".hex");
    const swatches = pop.querySelector(".swatches");

    for (const colour of PALETTE) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch-dot";
      button.style.background = colour;
      button.setAttribute("data-tip", colour);
      button.addEventListener("click", () => setHex(colour));
      swatches.appendChild(button);
    }

    if (window.EyeDropper) {
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "btn-ghost eyedrop";
      drop.innerHTML = svg("M10.5 2.5 13.5 5.5M12 4 5.5 10.5 4 12.5l2-1.5L12.5 4.5M3 13h2", 15);
      drop.setAttribute("data-tip", "Pick a colour from the screen");
      drop.addEventListener("click", async () => {
        try {
          const result = await new window.EyeDropper().open();
          setHex(result.sRGBHex);
        } catch {
          /* the reader cancelled, which is not an error */
        }
      });
      pop.querySelector(".pop-row").appendChild(drop);
    }

    let hsv = rgb2hsv(hex2rgb(input.value || "#000000"));

    function paint() {
      const hex = rgb2hex(hsv2rgb(hsv));
      chip.style.background = hex;
      trigger.setAttribute("aria-label", `Colour ${hex}`);
      trigger.setAttribute("data-tip", hex);
      sv.style.setProperty("--hue", `hsl(${hsv.h} 100% 50%)`);
      svMark.style.left = `${hsv.s * 100}%`;
      svMark.style.top = `${(1 - hsv.v) * 100}%`;
      // The mark has to stay visible on both a white corner and a black one.
      svMark.classList.toggle("on-light", hsv.v > 0.6 && hsv.s < 0.5);
      hueMark.style.left = `${(hsv.h / 360) * 100}%`;
      hue.setAttribute("aria-valuenow", Math.round(hsv.h));
      if (document.activeElement !== hexField) hexField.value = hex;
      return hex;
    }

    function apply() {
      const hex = paint();
      if (input.value.toLowerCase() === hex.toLowerCase()) return;
      input.value = hex;
      commit(input);
    }

    function setHex(hex) {
      hsv = rgb2hsv(hex2rgb(hex));
      apply();
    }

    // Dragging inside the field, and continuing to drag outside it: pointer
    // capture keeps the colour tracking the hand past the edge instead of
    // stopping dead at it.
    function dragging(element, onMove) {
      const move = (event) => {
        const rect = element.getBoundingClientRect();
        onMove(
          clamp((event.clientX - rect.left) / rect.width, 0, 1),
          clamp((event.clientY - rect.top) / rect.height, 0, 1)
        );
      };
      element.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        element.focus();
        move(event);
      });
      element.addEventListener("pointermove", (event) => {
        if (element.hasPointerCapture(event.pointerId)) move(event);
      });
    }

    dragging(sv, (x, y) => {
      hsv.s = x;
      hsv.v = 1 - y;
      apply();
    });
    dragging(hue, (x) => {
      hsv.h = x * 359.999;
      apply();
    });

    sv.addEventListener("keydown", (event) => {
      const big = event.shiftKey ? 0.1 : 0.01;
      const moves = {
        ArrowLeft: () => (hsv.s = clamp(hsv.s - big, 0, 1)),
        ArrowRight: () => (hsv.s = clamp(hsv.s + big, 0, 1)),
        ArrowUp: () => (hsv.v = clamp(hsv.v + big, 0, 1)),
        ArrowDown: () => (hsv.v = clamp(hsv.v - big, 0, 1)),
      };
      if (!moves[event.key]) return;
      event.preventDefault();
      moves[event.key]();
      apply();
    });

    hue.addEventListener("keydown", (event) => {
      const by = event.shiftKey ? 15 : 2;
      if (event.key === "ArrowLeft") hsv.h = (hsv.h - by + 360) % 360;
      else if (event.key === "ArrowRight") hsv.h = (hsv.h + by) % 360;
      else return;
      event.preventDefault();
      apply();
    });

    hexField.addEventListener("input", () => {
      const value = hexField.value.trim();
      if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) setHex(value.startsWith("#") ? value : "#" + value);
    });

    trigger.addEventListener("click", () => {
      if (openPopover && openPopover.pop === pop) return closePopover();
      showPopover(pop, trigger);
      sv.focus();
    });

    // The tool may set the colour itself; the drawn control follows it.
    input.addEventListener("change", () => {
      const current = rgb2hex(hsv2rgb(hsv));
      if (input.value.toLowerCase() !== current.toLowerCase()) {
        hsv = rgb2hsv(hex2rgb(input.value));
        paint();
      }
    });

    paint();
  }

  /* ── Select ──────────────────────────────────────────────────────────────
     A drawn listbox over the real <select>, which stays as the value and keeps
     firing change. Full keyboard behaviour, including type-ahead, because that
     is most of what a native select is actually for. */

  function enhanceSelect(select) {
    select.setAttribute(MARK, "");
    select.hidden = true;

    const wrap = document.createElement("span");
    wrap.className = "picker picker-select";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "field select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (select.id) trigger.id = select.id + "-trigger";
    // A <select> is usually labelled by a <label for>, which cannot point at a
    // button, so the label is carried across by hand.
    const label = select.id && document.querySelector(`label[for="${select.id}"]`);
    if (label) trigger.setAttribute("aria-label", label.textContent.trim());
    trigger.innerHTML = `<span class="select-value"></span>${svg(CHEVRON_DOWN, 12)}`;
    wrap.appendChild(trigger);

    const list = document.createElement("div");
    list.className = "pop pop-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    if (select.id) list.id = select.id + "-list";
    wrap.appendChild(list);

    const valueText = trigger.querySelector(".select-value");
    let active = 0;

    function options() {
      return Array.from(list.querySelectorAll(".pop-item"));
    }

    function build() {
      list.innerHTML = "";
      Array.from(select.options).forEach((option, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pop-item";
        item.setAttribute("role", "option");
        item.textContent = option.textContent;
        item.dataset.value = option.value;
        if (select.id) item.id = `${select.id}-option-${index}`;
        item.addEventListener("click", () => choose(index));
        item.addEventListener("pointermove", () => setActive(index));
        list.appendChild(item);
      });
      sync();
    }

    function sync() {
      valueText.textContent = select.options[select.selectedIndex]?.textContent ?? "";
      options().forEach((item, index) =>
        item.setAttribute("aria-selected", index === select.selectedIndex ? "true" : "false")
      );
    }

    function setActive(index) {
      const items = options();
      if (!items.length) return;
      active = clamp(index, 0, items.length - 1);
      items.forEach((item, i) => item.classList.toggle("is-active", i === active));
      items[active].scrollIntoView({ block: "nearest" });
      trigger.setAttribute("aria-activedescendant", items[active].id || "");
    }

    function choose(index) {
      select.selectedIndex = index;
      sync();
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closePopover();
      trigger.focus();
    }

    function open() {
      showPopover(list, trigger);
      setActive(select.selectedIndex < 0 ? 0 : select.selectedIndex);
    }

    trigger.addEventListener("click", () => {
      if (openPopover && openPopover.pop === list) return closePopover();
      open();
    });

    let typed = "";
    let typedTimer;
    trigger.addEventListener("keydown", (event) => {
      const isOpen = openPopover && openPopover.pop === list;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen) return open();
        setActive(active + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        if (!isOpen) return;
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : options().length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (isOpen) choose(active);
        else open();
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        // Type-ahead, the behaviour a native select has that a hand-built
        // listbox usually loses.
        typed += event.key.toLowerCase();
        clearTimeout(typedTimer);
        typedTimer = setTimeout(() => (typed = ""), 700);
        const index = Array.from(select.options).findIndex((o) =>
          o.textContent.toLowerCase().startsWith(typed)
        );
        if (index < 0) return;
        if (isOpen) setActive(index);
        else choose(index);
      }
    });

    // The tool owns the options: the generator writes its distributions in
    // after load, and rebuilds nothing afterwards, but a tool that did would
    // still be followed here.
    new MutationObserver(build).observe(select, { childList: true });
    select.addEventListener("change", sync);
    build();
  }

  /* ── Tooltips ────────────────────────────────────────────────────────────
     `title` produces a grey box on the operating system's own delay, in the
     operating system's own type. This is one drawn tip, moved around and
     delegated, so controls built later need no wiring. */

  let tip;
  let tipTimer;
  let tipFor = null;

  function hideTip() {
    clearTimeout(tipTimer);
    if (!tipFor) return;
    tipFor.removeAttribute("aria-describedby");
    tipFor = null;
    tip.hidden = true;
  }

  function showTip(target) {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip";
      tip.id = "workshop-tip";
      tip.setAttribute("role", "tooltip");
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    tip.textContent = target.getAttribute("data-tip");
    tip.hidden = false;
    tipFor = target;
    target.setAttribute("aria-describedby", tip.id);

    const a = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const above = a.top > t.height + 10;
    tip.classList.toggle("tip-below", !above);
    tip.style.top = `${Math.round(above ? a.top - t.height - 7 : a.bottom + 7)}px`;
    tip.style.left = `${Math.round(
      clamp(a.left + a.width / 2 - t.width / 2, 8, Math.max(8, window.innerWidth - t.width - 8))
    )}px`;
  }

  function armTip(target, delay) {
    if (tipFor === target) return;
    hideTip();
    tipTimer = setTimeout(() => showTip(target), delay);
  }

  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (target) armTip(target, 320);
    else if (tipFor && !tipFor.contains(event.target)) hideTip();
  });
  document.addEventListener("pointerdown", hideTip);
  // Keyboard arrival gets the tip immediately: there is no hovering hand to
  // suggest the reader is still deciding.
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (target) armTip(target, 0);
  });
  document.addEventListener("focusout", hideTip);
  addEventListener("scroll", hideTip, true);
  addEventListener("keydown", (event) => event.key === "Escape" && hideTip());

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  function enhance(root = document) {
    root.querySelectorAll(`input[type='number']:not([${MARK}])`).forEach(enhanceNumber);
    root.querySelectorAll(`input[type='color']:not([${MARK}])`).forEach(enhanceColor);
    root.querySelectorAll(`select:not([${MARK}])`).forEach(enhanceSelect);
  }

  function start() {
    enhance();
    // Controls a tool builds later (the generator rewrites its parameter fields
    // whenever the distribution changes) are picked up here, so no tool has to
    // know this file exists.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        enhance();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
