// The tool: files in, a page pile you can rearrange, files out.
//
// There is exactly one piece of state that matters, `pile`: an ordered list of
// { docId, pageIndex, rotate }. Every button rewrites that list, and saving
// hands it to PDF.ops.assemble. Merging is loading two files into one pile,
// splitting is slicing it, deleting is filtering it, and reordering is moving
// entries about — so none of those are separate code paths.

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  const drop = el('drop');
  const fileInput = el('file');
  const workspace = el('workspace');
  const grid = el('grid');
  const tally = el('tally');
  const loadNote = el('loadNote');
  const saveNote = el('saveNote');
  const say = el('say');

  const docs = [];            // { id, name, doc }
  let pile = [];              // { docId, pageIndex, rotate }
  const selected = new Set(); // indices into `pile`
  let thumbQueue = [];
  let thumbRunning = false;
  const fontCache = new Map();

  function announce(msg) {
    say.textContent = msg;
    saveNote.textContent = msg;
  }

  function note(msg) {
    loadNote.textContent = msg;
    loadNote.hidden = !msg;
  }

  // --- loading ---------------------------------------------------------------

  async function addFiles(files) {
    const list = Array.from(files).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!list.length) {
      note('That did not look like a PDF.');
      return;
    }
    note('Reading ' + list.length + (list.length === 1 ? ' file…' : ' files…'));

    let added = 0;
    const problems = [];
    for (const file of list) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = PDF.PDFDocument.load(bytes);
        if (!doc.pageCount) {
          problems.push(file.name + (doc.encrypted
            ? ' is password protected, which this tool cannot open yet'
            : ' has no pages this tool could find'));
          continue;
        }
        const entry = { id: docs.length, name: file.name, doc };
        docs.push(entry);
        for (let i = 0; i < doc.pageCount; i++) {
          pile.push({ docId: entry.id, pageIndex: i, rotate: doc.pages[i].rotate });
        }
        added++;
        if (doc.warnings.length) problems.push(file.name + ': ' + doc.warnings[0]);
      } catch (e) {
        problems.push(file.name + ' could not be read');
      }
    }

    if (!added && !docs.length) {
      note(problems.join('. ') || 'Nothing could be read.');
      return;
    }
    note(problems.length ? problems.join('. ') : '');
    workspace.hidden = false;
    if (docs.length === 1) el('outName').value = suggestName(docs[0].name);
    render();
  }

  function suggestName(name) {
    return name.replace(/\.pdf$/i, '') + '-edited.pdf';
  }

  // --- the grid ---------------------------------------------------------------

  function render() {
    grid.textContent = '';
    thumbQueue = [];

    pile.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'page-card' + (selected.has(index) ? ' is-selected' : '');
      card.dataset.index = String(index);
      card.dataset.src = String(item.docId % 3);
      card.draggable = true;

      const thumb = document.createElement('div');
      thumb.className = 'page-thumb is-pending';
      thumb.textContent = '…';
      card.appendChild(thumb);

      const cap = document.createElement('div');
      cap.className = 'page-cap';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(index + 1);
      cap.appendChild(n);

      const src = document.createElement('span');
      src.className = 'src';
      const doc = docs[item.docId];
      src.textContent = docs.length > 1
        ? doc.name.replace(/\.pdf$/i, '')
        : 'p' + (item.pageIndex + 1);
      src.title = doc.name + ', page ' + (item.pageIndex + 1);
      cap.appendChild(src);

      const base = doc.doc.pages[item.pageIndex].rotate;
      const turned = ((item.rotate - base) % 360 + 360) % 360;
      if (turned) {
        const t = document.createElement('span');
        t.className = 'turn';
        t.textContent = turned + '°';
        cap.appendChild(t);
      }

      card.appendChild(cap);
      grid.appendChild(card);
      thumbQueue.push({ card, thumb, item });
    });

    updateTally();
    runThumbs();
  }

  function updateTally() {
    const parts = [pile.length + (pile.length === 1 ? ' page' : ' pages')];
    if (docs.length > 1) parts.push('from ' + docs.length + ' files');
    if (selected.size) parts.push(selected.size + ' selected');
    tally.textContent = parts.join(' · ');
  }

  // Thumbnails are rendered one at a time. Rendering a page is real work, and
  // firing forty of them at once would lock the tab up on a long document.
  async function runThumbs() {
    if (thumbRunning) return;
    thumbRunning = true;
    while (thumbQueue.length) {
      const job = thumbQueue.shift();
      if (!job.card.isConnected) continue;
      try {
        await drawThumb(job);
      } catch {
        job.thumb.textContent = 'no preview';
      }
      // Let the browser paint and handle clicks between pages.
      await new Promise((r) => setTimeout(r, 0));
    }
    thumbRunning = false;
  }

  async function drawThumb(job) {
    const entry = docs[job.item.docId];
    const page = entry.doc.pages[job.item.pageIndex];
    if (!page) throw new Error('no page');

    const size = page.size;
    const BOX = 140;
    const scale = Math.min(BOX / Math.max(size.width, 1), BOX / Math.max(size.height, 1));

    const canvas = document.createElement('canvas');
    await PDF.renderPageToCanvas(entry.doc, page, canvas, {
      scale: Math.max(scale, 0.05) * (window.devicePixelRatio || 1),
      fontCache,
      maxOps: 220000,
    });
    canvas.style.width = Math.round(size.width * scale) + 'px';
    canvas.style.height = Math.round(size.height * scale) + 'px';

    // The card shows the page as it will be saved, so a turn applied here has
    // to show up here rather than only in the output file.
    const base = page.rotate;
    const turned = ((job.item.rotate - base) % 360 + 360) % 360;
    job.thumb.textContent = '';
    job.thumb.classList.remove('is-pending');
    if (turned) {
      const wrap = document.createElement('div');
      wrap.style.transform = 'rotate(' + turned + 'deg)';
      wrap.style.display = 'flex';
      wrap.appendChild(canvas);
      // A quarter turn swaps which dimension has to fit the box.
      if (turned === 90 || turned === 270) {
        const fit = Math.min(1, BOX / Math.max(size.width * scale, 1));
        wrap.style.transform += ' scale(' + fit + ')';
      }
      job.thumb.appendChild(wrap);
    } else {
      job.thumb.appendChild(canvas);
    }
  }

  // --- selection ---------------------------------------------------------------

  function setSelection(indices) {
    selected.clear();
    indices.forEach((i) => { if (i >= 0 && i < pile.length) selected.add(i); });
    refreshSelection();
  }

  function refreshSelection() {
    grid.querySelectorAll('.page-card').forEach((card) => {
      card.classList.toggle('is-selected', selected.has(+card.dataset.index));
    });
    updateTally();
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    const i = +card.dataset.index;
    if (selected.has(i)) selected.delete(i);
    else selected.add(i);
    refreshSelection();
  });

  // --- drag to reorder ----------------------------------------------------------

  let dragFrom = -1;

  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    dragFrom = +card.dataset.index;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without data set on it.
    try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch { /* ignore */ }
  });

  grid.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const card = e.target.closest('.page-card');
    grid.querySelectorAll('.is-drop-before, .is-drop-after').forEach((c) => {
      c.classList.remove('is-drop-before', 'is-drop-after');
    });
    if (!card) return;
    const box = card.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    card.classList.add(after ? 'is-drop-after' : 'is-drop-before');
  });

  grid.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const card = e.target.closest('.page-card');
    if (card) {
      const box = card.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      let to = +card.dataset.index + (after ? 1 : 0);
      const moved = pile[dragFrom];
      pile.splice(dragFrom, 1);
      if (dragFrom < to) to--;
      pile.splice(to, 0, moved);
      selected.clear();
      render();
    }
    dragFrom = -1;
  });

  grid.addEventListener('dragend', () => {
    dragFrom = -1;
    grid.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after').forEach((c) => {
      c.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    });
  });

  // --- actions -------------------------------------------------------------------

  function selectedSorted() {
    return Array.from(selected).sort((a, b) => a - b);
  }

  function requireSelection() {
    if (selected.size) return true;
    announce('Select some pages first, by clicking them or typing a range.');
    return false;
  }

  el('selApply').addEventListener('click', () => {
    setSelection(PDF.ops.parseRanges(el('range').value, pile.length));
    announce(selected.size ? selected.size + ' pages selected.' : 'That range matched no pages.');
  });
  el('range').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('selApply').click();
  });
  el('selAll').addEventListener('click', () => setSelection(pile.map((_, i) => i)));
  el('selNone').addEventListener('click', () => setSelection([]));
  el('selInvert').addEventListener('click', () => {
    setSelection(pile.map((_, i) => i).filter((i) => !selected.has(i)));
  });

  function turn(delta) {
    if (!requireSelection()) return;
    for (const i of selected) {
      pile[i].rotate = PDF.ops.normaliseAngle(pile[i].rotate + delta);
    }
    const keep = selectedSorted();
    render();
    setSelection(keep);
    announce('Turned ' + keep.length + (keep.length === 1 ? ' page.' : ' pages.'));
  }
  el('rotL').addEventListener('click', () => turn(-90));
  el('rotR').addEventListener('click', () => turn(90));

  el('del').addEventListener('click', () => {
    if (!requireSelection()) return;
    const gone = selected.size;
    pile = pile.filter((_, i) => !selected.has(i));
    selected.clear();
    render();
    announce('Removed ' + gone + (gone === 1 ? ' page.' : ' pages.') +
             ' The file on your disk is untouched.');
  });

  el('keepOnly').addEventListener('click', () => {
    if (!requireSelection()) return;
    pile = selectedSorted().map((i) => pile[i]);
    selected.clear();
    render();
    announce('Kept ' + pile.length + (pile.length === 1 ? ' page.' : ' pages.'));
  });

  el('reverse').addEventListener('click', () => {
    pile.reverse();
    selected.clear();
    render();
    announce('Order reversed.');
  });

  function nudge(dir) {
    if (!requireSelection()) return;
    const order = selectedSorted();
    const list = dir < 0 ? order : order.slice().reverse();
    const moved = new Set();
    for (const i of list) {
      const to = i + dir;
      if (to < 0 || to >= pile.length || moved.has(to)) { moved.add(i); continue; }
      const t = pile[i]; pile[i] = pile[to]; pile[to] = t;
      moved.add(to);
    }
    const next = Array.from(moved).filter((i) => i >= 0 && i < pile.length);
    render();
    setSelection(next);
  }
  el('moveUp').addEventListener('click', () => nudge(-1));
  el('moveDown').addEventListener('click', () => nudge(1));

  el('reset').addEventListener('click', () => {
    pile = [];
    selected.clear();
    docs.forEach((entry) => {
      for (let i = 0; i < entry.doc.pageCount; i++) {
        pile.push({ docId: entry.id, pageIndex: i, rotate: entry.doc.pages[i].rotate });
      }
    });
    render();
    announce('Back to the pages as they were loaded.');
  });

  // --- saving -----------------------------------------------------------------------

  function entriesFor(items) {
    return items.map((item) => ({
      doc: docs[item.docId].doc,
      pageIndex: item.pageIndex,
      rotate: item.rotate,
    }));
  }

  function download(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // `suffix` keeps a partial save from landing on the same name as the whole
  // document, which would otherwise leave two different files called the same
  // thing in the downloads folder.
  function cleanName(fallback, suffix) {
    let name = (el('outName').value || '').trim() || fallback;
    name = name.replace(/\.pdf$/i, '');
    if (suffix) name += '-' + suffix;
    return (name + '.pdf').replace(/[\\/:*?"<>|]/g, '-');
  }

  function saveList(items, name) {
    if (!items.length) {
      announce('There are no pages to save.');
      return;
    }
    try {
      const bytes = PDF.ops.assemble(entriesFor(items), {});
      download(bytes, name);
      announce('Saved ' + name + ' — ' + items.length +
               (items.length === 1 ? ' page.' : ' pages.'));
    } catch (e) {
      announce('Could not build that file: ' + e.message);
    }
  }

  el('save').addEventListener('click', () => saveList(pile, cleanName('combined.pdf')));

  el('saveSel').addEventListener('click', () => {
    if (!requireSelection()) return;
    saveList(selectedSorted().map((i) => pile[i]), cleanName('pages.pdf', 'selection'));
  });

  el('split').addEventListener('click', () => {
    const every = Math.max(1, parseInt(el('splitEvery').value, 10) || 1);
    if (!pile.length) { announce('There are no pages to split.'); return; }
    const base = cleanName('part.pdf').replace(/\.pdf$/i, '');
    saveNote.textContent = '';
    let count = 0;
    for (let start = 0; start < pile.length; start += every) {
      const chunk = pile.slice(start, start + every);
      const from = start + 1;
      const to = Math.min(start + every, pile.length);
      const label = every === 1 ? String(from) : from + '-' + to;
      try {
        download(PDF.ops.assemble(entriesFor(chunk), {}), base + '-' + label + '.pdf');
        count++;
      } catch { /* skip a chunk that will not build */ }
    }
    announce('Saved ' + count + (count === 1 ? ' file.' : ' files.') +
             (count > 5 ? ' Your browser may ask to allow multiple downloads.' : ''));
  });

  // --- file input and drop target ------------------------------------------------------

  el('pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('drag-over');
    });
  });
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // Dropping a file anywhere else should not navigate away from the tool.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (drop.contains(e.target)) return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
})();
