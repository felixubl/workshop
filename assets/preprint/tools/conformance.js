/* PREPRINT — the conformance check.
 *
 * Wire this into a new site's harness before you write any other check. It is
 * the one that defends the thing the system exists for: that everything you
 * make looks related, while none of it looks the same.
 *
 * It is vendored along with the system, so a site links it rather than keeping
 * a copy. A conformance check that each site owns a copy of is a check that
 * drifts away from the rules it is meant to be enforcing.
 *
 * It reads a site's OWN stylesheets (the variant layer, not the vendored tree)
 * and asserts three things:
 *
 *   1. the invariants are not restated   — ground, ink, plates, markers
 *   2. the namespace is not squatted     — a --pp-* the system does not define
 *   3. nothing dead survives             — --accent, --shadow-N, --glass
 *
 * Everything else is yours. Layout, density, texture, extra variables under
 * your own prefix, and one licensed breach per law per view. See
 * guidelines/invariants.md for the long version, and guidelines/laws.md for
 * what a breach costs.
 *
 * Use it from a harness:
 *
 *   preprintConformance({ layers: ['/assets/site.css'] })
 *     .then(function (results) {
 *       results.forEach(function (r) { ok(r.name, r.pass, r.detail); });
 *     });
 *
 * Or let it run itself and write into the page:
 *
 *   <script src="/assets/preprint/tools/conformance.js"
 *           data-layers="/assets/site.css"></script>
 */
(function (global) {
  'use strict';

  /* The invariants. These are not "important tokens", they are the identity:
     restate one and the family stops being a family. Kept as one expression so
     there is exactly one place to read the list. */
  var INVARIANT = /--pp-(paper|ink|surface|sunk|edge|line|hair|plate-[123](-text)?|marker-[a-z]+)\s*:/g;

  /* Variables from systems that came before this one. A site still carrying
     them is a site running two systems at once. */
  var DEAD = /--(accent|shadow-[0-9]|glass)\s*:/g;

  var DECLARED = /--pp-[a-z0-9-]+(?=\s*:)/g;

  function text(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' → ' + r.status);
      return r.text();
    });
  }

  /* Every --pp-* the system itself defines, read from the vendored tokens by
     following styles.css's own @import list. Asking the system rather than
     holding a copy of the list is what keeps this check honest when the system
     gains a token. */
  function systemTokens(base) {
    return text(base + 'styles.css').then(function (css) {
      var imports = (css.match(/@import\s+(?:url\()?['"]([^'"]+)['"]/g) || [])
        .map(function (line) { return line.replace(/.*['"]([^'"]+)['"].*/, '$1'); });
      return Promise.all(imports.map(function (href) {
        return text(new URL(href, new URL(base, location.href)).href).catch(function () { return ''; });
      })).then(function (parts) {
        var names = {};
        parts.concat(css).forEach(function (part) {
          (part.match(DECLARED) || []).forEach(function (n) { names[n] = true; });
        });
        return names;
      });
    });
  }

  function check(opts) {
    var layers = (opts && opts.layers) || [];
    var base = (opts && opts.system) || '/assets/preprint/';
    if (!layers.length) return Promise.resolve([]);

    return Promise.all([
      Promise.all(layers.map(text)).then(function (parts) { return parts.join('\n'); }),
      systemTokens(base).catch(function () { return null; }),
    ]).then(function (both) {
      var css = both[0];
      var known = both[1];
      var results = [];

      var forked = css.match(INVARIANT) || [];
      results.push({
        name: 'the variant layer does not restate ground, ink, plates or markers',
        pass: forked.length === 0,
        detail: forked.length ? forked.join(' ') : 'none',
      });

      if (known) {
        var squatted = (css.match(DECLARED) || []).filter(function (n) {
          return !known[n];
        });
        results.push({
          name: 'every --pp-* it sets is one the system defines',
          pass: squatted.length === 0,
          detail: squatted.length
            ? squatted.join(' ') + ' — name your own under your own prefix'
            : 'none invented',
        });
      } else {
        results.push({
          name: 'the system tokens are readable at ' + base,
          pass: false,
          detail: 'could not read ' + base + 'styles.css, so the namespace was not checked',
        });
      }

      var dead = css.match(DEAD) || [];
      results.push({
        name: 'no --accent, --shadow-N or --glass survive',
        pass: dead.length === 0,
        detail: dead.length ? dead.join(' ') : 'none',
      });

      return results;
    }).catch(function (e) {
      return [{ name: 'the variant layer is readable', pass: false, detail: e.message }];
    });
  }

  global.preprintConformance = check;

  /* Standalone: <script src="…/conformance.js" data-layers="/assets/site.css"> */
  var self = document.currentScript;
  if (self && self.dataset.layers) {
    check({
      layers: self.dataset.layers.split(',').map(function (s) { return s.trim(); }),
      system: self.dataset.system || undefined,
    }).then(function (results) {
      var box = document.createElement('pre');
      box.style.font = '12px ui-monospace, monospace';
      box.textContent = results.map(function (r) {
        return (r.pass ? 'PASS  ' : 'FAIL  ') + r.name + '\n      ' + r.detail;
      }).join('\n');
      (document.body || document.documentElement).appendChild(box);
    });
  }
})(window);
