// The tool: files in, a page pile you can rearrange, files out.
//
// There is exactly one piece of state that matters, `pile`: an ordered list of
// { docId, pageIndex, rotate }. Every button rewrites that list, and saving
// hands it to PDF.ops.assemble. Merging is loading two files into one pile,
// splitting is slicing it, deleting is filtering it, and reordering is moving
// entries about — so none of those are separate code paths.
//
// Undo falls out of the same idea: because the whole document is that one list,
// a history entry is a copy of it, and stepping back is putting a copy back.

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
  const undoBtn = el('undo');
  const viewBtn = el('view');

  const docs = [];            // { id, name, doc }
  let pile = [];              // { docId, pageIndex, rotate }
  const selected = new Set(); // indices into `pile`
  const history = [];         // past { pile, selected }, oldest first
  const HISTORY_MAX = 60;
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

  // --- history ---------------------------------------------------------------

  // Entries are copied one level down rather than sliced, because turning a page
  // edits `rotate` in place: a shallow copy of the list would hand the history
  // the very objects the next action is about to change.
  function stateNow() {
    return { pile: pile.map((item) => ({ ...item })), selected: Array.from(selected) };
  }

  // Selection alone is not remembered. It rides along with a change so undo puts
  // back the pages you had in hand, but clicking a card is not a step to undo.
  function remember(state) {
    history.push(state || stateNow());
    if (history.length > HISTORY_MAX) history.shift();
    undoBtn.disabled = false;
  }

  function undo() {
    const prev = history.pop();
    if (!prev) {
      announce('There is nothing to undo.');
      return;
    }
    pile = prev.pile;
    render();
    setSelection(prev.selected);
    undoBtn.disabled = !history.length;
    announce('Stepped back. ' + pile.length + (pile.length === 1 ? ' page' : ' pages') +
             ', ' + history.length + ' more to undo.');
  }

  undoBtn.addEventListener('click', undo);

  // ⌘Z on a Mac, Ctrl+Z elsewhere. Shift is redo, which this tool does not do,
  // so it is left alone rather than quietly undoing instead.
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // The viewer is for reading, not editing: the pile it is showing should not
    // change out from under it.
    if (workspace.hidden || viewAt >= 0) return;
    e.preventDefault();
    undo();
  });

  // --- loading ---------------------------------------------------------------

  async function addFiles(files) {
    const list = Array.from(files).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!list.length) {
      note('That did not look like a PDF.');
      return;
    }
    note('Reading ' + list.length + (list.length === 1 ? ' file…' : ' files…'));

    let added = 0;
    const before = stateNow();
    const problems = [];
    for (const file of list) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = PDF.PDFDocument.load(bytes);
        // Refused before the page count is even consulted. Standard security
        // leaves the xref and the page tree readable, so an encrypted file
        // looks perfectly loadable while every stream is still ciphertext:
        // it would preview blank and save as an unreadable file.
        if (doc.encrypted) {
          problems.push(file.name + ' is password protected, which this tool cannot open yet');
          continue;
        }
        if (!doc.pageCount) {
          problems.push(file.name + ' has no pages this tool could find');
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
    // Merging a file onto a pile is a step back to. The first load is not:
    // undoing it would leave an empty grid with nothing behind it.
    if (added && before.pile.length) remember(before);
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
    viewBtn.disabled = !pile.length;
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

  // --- the viewer ---------------------------------------------------------------

  // The thumbnails say what order the pages are in. They are too small to say
  // whether the right page is there, which is what you want to know before you
  // save. So the viewer draws one page of the pile, at whatever size the window
  // allows, in the order and the turn it will be saved with.

  const viewer = el('viewer');
  const stage = el('viewerStage');
  const viewCount = el('viewerCount');
  const viewSrc = el('viewerSrc');
  const viewPrev = el('viewerPrev');
  const viewNext = el('viewerNext');
  let viewAt = -1;     // index into `pile`, or -1 when the viewer is shut
  let viewToken = 0;   // a page drawn slowly must not land after you paged on
  let viewReturn = null;

  function openViewer(index) {
    if (!pile.length) return;
    viewReturn = document.activeElement;
    viewAt = Math.min(Math.max(index, 0), pile.length - 1);
    viewer.hidden = false;
    // The page underneath is covered, so it should not be tabbable either.
    document.querySelector('.wrap').inert = true;
    el('viewerClose').focus();
    drawViewer();
  }

  function closeViewer() {
    viewAt = -1;
    viewToken++;
    viewer.hidden = true;
    stage.textContent = '';
    document.querySelector('.wrap').inert = false;
    if (viewReturn && viewReturn.isConnected) viewReturn.focus();
    viewReturn = null;
  }

  function stepViewer(delta) {
    const to = viewAt + delta;
    if (viewAt < 0 || to < 0 || to >= pile.length) return;
    viewAt = to;
    drawViewer();
  }

  async function drawViewer() {
    const token = ++viewToken;
    const item = pile[viewAt];
    const entry = docs[item.docId];
    const page = entry.doc.pages[item.pageIndex];

    const size = page.size;
    const turned = ((item.rotate - page.rotate) % 360 + 360) % 360;
    const swap = turned === 90 || turned === 270;

    viewCount.textContent = 'Page ' + (viewAt + 1) + ' of ' + pile.length;
    viewSrc.textContent = entry.name + ', page ' + (item.pageIndex + 1) +
                          (turned ? ', turned ' + turned + '°' : '');
    viewPrev.disabled = viewAt <= 0;
    viewNext.disabled = viewAt >= pile.length - 1;

    // Sized off the window rather than off the panel, because the panel is
    // sized by the sheet: asking it how much room there is would be circular.
    const availW = Math.max(200, window.innerWidth - 96);
    const availH = Math.max(200, window.innerHeight - 140);
    const scale = Math.min(availW / Math.max(swap ? size.height : size.width, 1),
                           availH / Math.max(swap ? size.width : size.height, 1));
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);

    const sheet = document.createElement('div');
    sheet.className = 'viewer-sheet';
    sheet.textContent = '…';
    sheet.style.width = (swap ? h : w) + 'px';
    sheet.style.height = (swap ? w : h) + 'px';
    stage.textContent = '';
    stage.appendChild(sheet);

    const canvas = document.createElement('canvas');
    try {
      await PDF.renderPageToCanvas(entry.doc, page, canvas, {
        scale: Math.max(scale, 0.05) * (window.devicePixelRatio || 1),
        fontCache,
      });
    } catch {
      if (token === viewToken) sheet.textContent = 'This page could not be drawn.';
      return;
    }
    if (token !== viewToken) return;

    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.transform = 'translate(-50%, -50%) rotate(' + turned + 'deg)';
    sheet.textContent = '';
    sheet.appendChild(canvas);
  }

  viewBtn.addEventListener('click', () => {
    // Whatever you have in hand is what you most likely want to look at.
    const first = selected.size ? selectedSorted()[0] : 0;
    openViewer(first);
  });
  viewPrev.addEventListener('click', () => stepViewer(-1));
  viewNext.addEventListener('click', () => stepViewer(1));
  viewer.addEventListener('click', (e) => {
    if (e.target.closest('[data-viewer-close]')) closeViewer();
  });

  // A single click already means select, so opening a page is the second one.
  grid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.page-card');
    if (card) openViewer(+card.dataset.index);
  });

  window.addEventListener('keydown', (e) => {
    if (viewAt < 0) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') stepViewer(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') stepViewer(-1);
    else return;
    e.preventDefault();
  });

  // A window that changed size while the viewer was open leaves the page drawn
  // for the old one, so it is drawn again for the new one.
  window.addEventListener('resize', () => {
    if (viewAt >= 0) drawViewer();
  });

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
      if (dragFrom < to) to--;
      // Dropping a page back where it already was is not a step to undo, for
      // the same reason a nudge against the end is not.
      if (to !== dragFrom) {
        remember();
        const moved = pile[dragFrom];
        pile.splice(dragFrom, 1);
        pile.splice(to, 0, moved);
        selected.clear();
        render();
      }
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
    remember();
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
    remember();
    pile = pile.filter((_, i) => !selected.has(i));
    selected.clear();
    render();
    announce('Removed ' + gone + (gone === 1 ? ' page.' : ' pages.') +
             ' The file on your disk is untouched.');
  });

  el('keepOnly').addEventListener('click', () => {
    if (!requireSelection()) return;
    remember();
    pile = selectedSorted().map((i) => pile[i]);
    selected.clear();
    render();
    announce('Kept ' + pile.length + (pile.length === 1 ? ' page.' : ' pages.'));
  });

  el('reverse').addEventListener('click', () => {
    if (pile.length > 1) remember();
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
    const before = stateNow();
    let swapped = false;
    for (const i of list) {
      const to = i + dir;
      if (to < 0 || to >= pile.length || moved.has(to)) { moved.add(i); continue; }
      const t = pile[i]; pile[i] = pile[to]; pile[to] = t;
      moved.add(to);
      swapped = true;
    }
    // A selection already against the end moves nothing, and an undo that does
    // nothing visible is worse than no undo at all.
    if (swapped) remember(before);
    const next = Array.from(moved).filter((i) => i >= 0 && i < pile.length);
    render();
    setSelection(next);
  }
  el('moveUp').addEventListener('click', () => nudge(-1));
  el('moveDown').addEventListener('click', () => nudge(1));

  el('reset').addEventListener('click', () => {
    remember();
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
