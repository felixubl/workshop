// Neuron Bench: the record book.
//
// One number per problem: the lowest loss this browser has ever driven it to,
// and the network that did it. There is no server behind this page and there
// is not going to be one, so a record is yours and stays in this browser —
// a personal best rather than a leaderboard.
//
// The whole difficulty is deciding when two losses are comparable, because a
// number that is not comparable is worse than no number at all. A loss belongs
// to a question, and four things here decide what the question was:
//
//   the set            obviously
//   normalisation      a regression target is scaled with it, so the same fit
//                      scores differently with it on and off
//   the hold-back      0% means the score is the training loss, which is a
//                      different claim from a held-out one
//   the seed           which decides which rows were held out, and a held-out
//                      loss is a loss on those rows and no others
//
// So the key is all four, and a record is only ever shown against a run under
// the same four. Changing the seed to look for a better start does lose sight
// of the old record — but it also genuinely changes the question, and the book
// below still holds it, listed with the conditions it was set under.
//
// Everything the network was is stored alongside the number, because "0.0042"
// on its own teaches nothing and "0.0042, from two layers of six ReLU at a
// learning rate of 0.1" is the whole point of keeping it.

var Records = (function () {
  'use strict';

  const KEY = 'neuron-bench-best';
  const LIMIT = 80;
  const FLUSH_MS = 1200;

  /* The book is held in memory and written back on a trailing timer. A run
     posts a snapshot ten times a second and improves on itself nearly every
     time, and localStorage is synchronous: writing on each improvement would
     put a disk touch inside the training loop's message handler. */
  let book = null;
  let dirty = false;
  let timer = null;

  function load() {
    if (book) return book;
    book = {};
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
          const r = raw[k];
          if (r && typeof r === 'object' && Number.isFinite(r.loss)) book[k] = r;
        }
      }
    } catch (err) {
      /* Unreadable, or storage refused: an empty book is the honest fallback. */
    }
    return book;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(book || {}));
    } catch (err) {
      /* Private browsing, a full quota, or a blocked origin. The record still
         stands for this page view but will not survive a reload. */
    }
  }

  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, FLUSH_MS);
  }

  /* Oldest out first, and only when the book is over the limit. A reader who
     works through every set here needs a couple of dozen entries; the limit is
     there so a few hundred pasted CSVs cannot fill the origin's storage. */
  function prune() {
    const keys = Object.keys(book);
    if (keys.length <= LIMIT) return;
    keys.sort((a, b) => (book[a].t || 0) - (book[b].t || 0));
    for (let i = 0; i < keys.length - LIMIT; i++) delete book[keys[i]];
  }

  function key(c) {
    return [
      c.set,
      c.normalise ? 'norm' : 'raw',
      'hold' + c.split,
      'seed' + c.seed
    ].join('|');
  }

  function get(c) {
    return load()[key(c)] || null;
  }

  /* Offer a run. Ties do not count: the first network to reach a number keeps
     it, so repeating a run cannot quietly rewrite whose it was. */
  function offer(c, run) {
    if (!Number.isFinite(run.loss)) return { record: get(c), beaten: false };
    load();
    const k = key(c);
    const held = book[k];
    if (held && held.loss <= run.loss) return { record: held, beaten: false };

    const now = new Date();
    const record = Object.assign({}, c, run, {
      at: now.toISOString().slice(0, 10),
      t: now.getTime()
    });
    book[k] = record;
    prune();
    touch();
    return { record, beaten: true };
  }

  /* Every record held, newest first, each with the key needed to forget it. */
  function all() {
    const b = load();
    return Object.keys(b)
      .map((k) => ({ key: k, record: b[k] }))
      .sort((x, y) => (y.record.t || 0) - (x.record.t || 0));
  }

  function forget(k) {
    load();
    if (!(k in book)) return;
    delete book[k];
    touch();
    flush();
  }

  function clear() {
    book = {};
    touch();
    flush();
  }

  /* A tab being closed is the commonest way a record is lost, so the pending
     write is made good on the way out. pagehide rather than unload, because
     unload does not fire on a phone. */
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    /* Another tab setting a record is the same reader in another window, and
       what it wrote is newer than what is held here. The cache is dropped
       rather than written out: flushing would push this tab's whole book back
       over the other tab's, and losing one unwritten record of our own is a
       far smaller wrong than undoing every record of theirs. */
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
      book = null;
    });
  }

  return { key, get, offer, all, forget, clear, flush, KEY };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Records;
