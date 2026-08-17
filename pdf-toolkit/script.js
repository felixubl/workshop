// The tool: files in, a reorderable pile of pages, files out. One piece of
// state matters, `pile`: an ordered list of { docId, pageIndex, rotate, marks }.
// Every button rewrites that list, and saving passes it to PDF.ops.assemble.
// Merging is loading two files into one pile, splitting is slicing it,
// deleting is filtering it, reordering is moving entries, so none of those is
// a separate code path. Undo follows from the same design: a history entry is
// a copy of the list, and stepping back restores a copy.
//
// Marks — a blackout or a highlight — are part of a page's entry rather than a
// layer of their own, which is what makes them survive turning, moving and
// undo without a line of code each. The second panel is the metadata: what the
// loaded files say about whoever made them, and which of it the saved file is
// allowed to keep.

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
  let pile = [];              // { docId, pageIndex, rotate, marks }
  const selected = new Set(); // indices into `pile`
  const history = [];         // past { pile, selected }, oldest first
  const HISTORY_MAX = 60;
  let thumbQueue = [];
  let thumbRunning = false;
  let gridStale = false;      // the pile moved on while the viewer covered the grid
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

  // Entries are copied one level down rather than sliced, because rotating a
  // page edits `rotate` in place: a shallow copy would hand the history the
  // objects the next action is about to change. A page's marks are a list
  // inside that entry, so they are copied too, for the same reason.
  function stateNow() {
    return {
      pile: pile.map((item) => ({ ...item, marks: item.marks ? item.marks.slice() : undefined })),
      selected: Array.from(selected),
    };
  }

  // Selection is not remembered on its own. It is stored with a change so undo
  // restores the pages that were selected, but selecting a card is not itself
  // an undo step.
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
    if (workspace.hidden) return;
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
        // Refused before the page count is read. Standard security leaves the
        // xref and page tree readable, so an encrypted file appears loadable
        // while every stream is still ciphertext: it would preview blank and
        // save unreadable.
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

  // "The pile changed, show it." Both surfaces come through here, so an edit
  // made anywhere — including an undo — reaches whichever one is on screen.
  function render() {
    // The grid is covered while the viewer is open, and rebuilding it there
    // would requeue every thumbnail on every keystroke. It is rebuilt once on
    // close, from whatever the pile has become.
    if (viewAt >= 0) {
      gridStale = true;
      if (viewAt > pile.length - 1) viewAt = pile.length - 1;
      updateTally();
      drawViewer();
      return;
    }
    gridStale = false;

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

      // The marks are drawn on the thumbnail as well, but a highlight at this
      // size is easy to miss and a blackout is easy to mistake for the page.
      const tally = PDF.marks.count(item.marks);
      if (tally.total) {
        const m = document.createElement('span');
        m.className = 'marks';
        m.textContent = tally.total + (tally.total === 1 ? ' mark' : ' marks');
        m.title = describeMarks(tally);
        cap.appendChild(m);
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
    const marked = allMarks();
    if (marked.total) parts.push(describeMarks(marked));
    tally.textContent = parts.join(' · ');
    viewBtn.disabled = !pile.length;
    // Which file supplies the saved file's metadata is a fact about the pile,
    // so the sheet is refreshed by whatever refreshed the pile.
    updateMeta();
  }

  function allMarks() {
    const total = { censor: 0, highlight: 0, total: 0 };
    for (const item of pile) {
      const c = PDF.marks.count(item.marks);
      total.censor += c.censor;
      total.highlight += c.highlight;
      total.total += c.total;
    }
    return total;
  }

  function describeMarks(c) {
    const parts = [];
    if (c.censor) parts.push(c.censor + (c.censor === 1 ? ' blackout' : ' blackouts'));
    if (c.highlight) parts.push(c.highlight + (c.highlight === 1 ? ' highlight' : ' highlights'));
    return parts.join(' · ');
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
    const device = Math.max(scale, 0.05) * (window.devicePixelRatio || 1);
    await PDF.renderPageToCanvas(entry.doc, page, canvas, {
      scale: device,
      fontCache,
      maxOps: 220000,
    });
    // Painted onto the thumbnail rather than laid over it, because the card is
    // a picture of the page as it will be saved and a mark is part of that.
    PDF.marks.paintMarks(canvas.getContext('2d'), page, device, job.item.marks);
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

  // Thumbnails show the page order but are too small to confirm the right page
  // is present, which is what matters before saving. The viewer draws one page
  // at the size the window allows, in the order and rotation it will be saved
  // with, and allows edits in place. It edits only the page it is showing; the
  // grid is where several pages are acted on at once. Marking a page connects
  // the two: tick pages while reading, close, and the grid has them selected.

  const viewer = el('viewer');
  const stage = el('viewerStage');
  const viewCount = el('viewerCount');
  const viewSrc = el('viewerSrc');
  const viewMarked = el('viewerMarked');
  const viewPrev = el('viewerPrev');
  const viewNext = el('viewerNext');
  const viewSel = el('viewerSel');
  const viewEarlier = el('viewerEarlier');
  const viewLater = el('viewerLater');
  let viewAt = -1;     // index into `pile`, or -1 when the viewer is shut
  let viewToken = 0;   // a page drawn slowly must not land after you paged on
  let viewReturn = null;
  let shownItem = null;    // the pile entry the canvas on screen was drawn from
  let shownCanvas = null;
  let paper = null;
  let markLayer = null;    // the marks over the page, and where they are drawn
  let viewScale = 1;       // CSS pixels per point, as the page is being shown

  function openViewer(index) {
    if (!pile.length) return;
    viewReturn = document.activeElement;
    viewAt = Math.min(Math.max(index, 0), pile.length - 1);
    viewer.hidden = false;
    // The page underneath is covered, so it should not be tabbable either.
    document.querySelector('.wrap').inert = true;
    // A button takes focus, not the panel. Chrome draws its own ring around a
    // focused container that outline: none does not remove. Space is handled
    // below rather than left to the focused button, so it means the same thing
    // either way.
    el('viewerClose').focus();
    drawViewer();
  }

  function closeViewer() {
    viewAt = -1;
    viewToken++;
    shownItem = null;
    shownCanvas = null;
    paper = null;
    markLayer = null;
    viewer.hidden = true;
    stage.textContent = '';
    document.querySelector('.wrap').inert = false;
    // Whatever the viewer did to the pile is drawn now, in one go.
    if (gridStale) render();
    if (viewReturn && viewReturn.isConnected) viewReturn.focus();
    viewReturn = null;
  }

  function stepViewer(delta) {
    const to = viewAt + delta;
    if (viewAt < 0 || to < 0 || to >= pile.length) return;
    viewAt = to;
    drawViewer();
  }

  // Everything the bar says about the page, without touching the canvas. A mark
  // or a move changes all of this and none of the ink.
  function refreshViewerBar() {
    const item = pile[viewAt];
    if (!item) return;
    const entry = docs[item.docId];
    const page = entry.doc.pages[item.pageIndex];
    const turned = ((item.rotate - page.rotate) % 360 + 360) % 360;
    const picked = selected.has(viewAt);
    const marks = PDF.marks.count(item.marks);

    viewCount.textContent = 'Page ' + (viewAt + 1) + ' of ' + pile.length;
    viewSrc.textContent = entry.name + ', page ' + (item.pageIndex + 1) +
                          (turned ? ', turned ' + turned + '°' : '') +
                          (marks.total ? ', ' + describeMarks(marks) : '');
    viewMarked.textContent = selected.size ? selected.size + ' selected' : '';
    viewPrev.disabled = viewAt <= 0;
    viewNext.disabled = viewAt >= pile.length - 1;
    viewEarlier.disabled = viewAt <= 0;
    viewLater.disabled = viewAt >= pile.length - 1;
    viewSel.setAttribute('aria-pressed', String(picked));
    viewSel.classList.toggle('is-on', picked);
    viewSel.textContent = picked ? 'Selected' : 'Select';
    el('markClear').disabled = !marks.total;
    if (paper) paper.parentNode.classList.toggle('is-selected', picked);
  }

  // The panel fills the window, because the available size is a property of
  // the stage: a panel sized by the sheet could not report how much room the
  // sheet has.
  function layoutSheet(canvas, sheetPaper) {
    const c = canvas || shownCanvas;
    const p = sheetPaper || paper;
    const item = pile[viewAt];
    if (!c || !p || !item) return 1;
    const page = docs[item.docId].doc.pages[item.pageIndex];
    const size = page.size;
    const turned = ((item.rotate - page.rotate) % 360 + 360) % 360;
    const swap = turned === 90 || turned === 270;

    // What the stage loses to the frame's padding and the two borders in it.
    const FRAME = 32;
    const availW = Math.max(120, stage.clientWidth - FRAME);
    const availH = Math.max(120, stage.clientHeight - FRAME);
    const scale = Math.min(availW / Math.max(swap ? size.height : size.width, 1),
                           availH / Math.max(swap ? size.width : size.height, 1));
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);

    p.style.width = (swap ? h : w) + 'px';
    p.style.height = (swap ? w : h) + 'px';
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.style.transform = 'translate(-50%, -50%) rotate(' + turned + 'deg)';

    // The marks are laid over the canvas and given the same size and turn, so
    // that a mark drawn on a word stays on that word when the page is turned.
    viewScale = scale;
    if (markLayer) {
      markLayer.style.width = w + 'px';
      markLayer.style.height = h + 'px';
      markLayer.style.transform = c.style.transform;
      refreshMarks();
    }
    return scale;
  }

  async function drawViewer() {
    if (viewAt < 0) return;
    const item = pile[viewAt];
    if (!item) return;
    refreshViewerBar();

    // Rotating and moving both leave the rendered image unchanged: one is a
    // transform on the drawn canvas, the other a change of position in the
    // pile. Only a different page needs re-rendering.
    if (item === shownItem && shownCanvas) {
      layoutSheet();
      return;
    }

    const token = ++viewToken;
    const entry = docs[item.docId];
    const page = entry.doc.pages[item.pageIndex];

    const sheet = document.createElement('div');
    sheet.className = 'viewer-sheet' + (selected.has(viewAt) ? ' is-selected' : '');
    const fresh = document.createElement('div');
    fresh.className = 'viewer-paper';
    fresh.textContent = '…';
    sheet.appendChild(fresh);
    stage.textContent = '';
    stage.appendChild(sheet);

    // Measured before rendering, so the page is requested at the size it will
    // be shown and the sheet holds its place while the image is produced.
    paper = fresh;
    shownCanvas = null;
    shownItem = null;
    markLayer = makeMarkLayer();
    const canvas = document.createElement('canvas');
    const scale = layoutSheet(canvas, fresh);

    try {
      await PDF.renderPageToCanvas(entry.doc, page, canvas, {
        scale: Math.max(scale, 0.05) * (window.devicePixelRatio || 1),
        fontCache,
      });
    } catch {
      if (token === viewToken) fresh.textContent = 'This page could not be drawn.';
      return;
    }
    if (token !== viewToken) return;

    fresh.textContent = '';
    fresh.appendChild(canvas);
    fresh.appendChild(markLayer);
    shownItem = item;
    shownCanvas = canvas;
    layoutSheet();
  }

  // --- marking a page ---------------------------------------------------------

  // Two pens and a way to put them down. The pen in hand is what a drag lays
  // over the page; with none in hand the page is only being read. A click on a
  // mark lifts it either way, because that is the same gesture as reaching for
  // something you can see.

  const TONES = PDF.marks.TONES;
  let pen = null;                  // null, { kind: 'censor' } or { kind: 'highlight', tone }
  let lastTone = TONES[0].id;

  function markedPage() {
    const item = pile[viewAt];
    if (!item) return null;
    const page = docs[item.docId].doc.pages[item.pageIndex];
    return { item, page, frame: PDF.marks.frameOf(page, viewScale) };
  }

  // The layer carries the page's own turn, so a point on the screen has to be
  // turned back before it means anything in the page's coordinates.
  function localPoint(e) {
    const box = markLayer.getBoundingClientRect();
    const w = parseFloat(markLayer.style.width) || box.width;
    const h = parseFloat(markLayer.style.height) || box.height;
    const item = pile[viewAt];
    const page = docs[item.docId].doc.pages[item.pageIndex];
    const turn = ((item.rotate - page.rotate) % 360 + 360) % 360;
    const rad = turn * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const sx = e.clientX - (box.left + box.width / 2);
    const sy = e.clientY - (box.top + box.height / 2);
    return [sx * cos + sy * sin + w / 2, -sx * sin + sy * cos + h / 2];
  }

  function makeMarkLayer() {
    const layer = document.createElement('div');
    layer.className = 'mark-layer';
    let drag = null;

    const place = (elem, x1, y1, x2, y2) => {
      elem.style.left = Math.min(x1, x2) + 'px';
      elem.style.top = Math.min(y1, y2) + 'px';
      elem.style.width = Math.abs(x2 - x1) + 'px';
      elem.style.height = Math.abs(y2 - y1) + 'px';
    };

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || viewAt < 0) return;
      const p = localPoint(e);
      if (!pen) { liftMarkAt(p); return; }
      drag = { x: p[0], y: p[1], moved: false, box: null };
      try { layer.setPointerCapture(e.pointerId); } catch { /* no capture, no matter */ }
      e.preventDefault();
    });

    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = localPoint(e);
      if (Math.abs(p[0] - drag.x) > 3 || Math.abs(p[1] - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (!drag.box) {
        drag.box = document.createElement('div');
        drag.box.className = 'mark-draft';
        layer.appendChild(drag.box);
      }
      place(drag.box, drag.x, drag.y, p[0], p[1]);
    });

    const finish = (e) => {
      if (!drag) return;
      const started = drag;
      drag = null;
      if (started.box) started.box.remove();
      const p = localPoint(e);
      if (started.moved) addMark(started.x, started.y, p[0], p[1]);
      else liftMarkAt(p);
    };
    layer.addEventListener('pointerup', finish);
    layer.addEventListener('pointercancel', () => { if (drag && drag.box) drag.box.remove(); drag = null; });

    return layer;
  }

  function refreshMarks() {
    const at = markedPage();
    if (!markLayer || !at) return;
    markLayer.textContent = '';
    markLayer.classList.toggle('is-drawing', !!pen);
    (at.item.marks || []).forEach((mark, i) => {
      const box = PDF.marks.boxOf(at.frame, mark);
      const elem = document.createElement('div');
      elem.className = 'mark mark--' + (mark.kind === 'censor' ? 'censor' : 'highlight');
      if (mark.kind !== 'censor') elem.style.background = PDF.marks.toneCSS(mark.tone);
      elem.style.left = box.left + 'px';
      elem.style.top = box.top + 'px';
      elem.style.width = box.width + 'px';
      elem.style.height = box.height + 'px';
      elem.title = (mark.kind === 'censor' ? 'Blackout' : 'Highlight in ' + PDF.marks.tone(mark.tone).label) +
                   ' — click to lift it';
      elem.dataset.mark = String(i);
      markLayer.appendChild(elem);
    });
  }

  function setMarks(item, marks) {
    remember();
    item.marks = marks;
    render();
  }

  function addMark(x1, y1, x2, y2) {
    const at = markedPage();
    if (!at || !pen) return;
    const mark = PDF.marks.markFromDrag(at.frame, pen.kind, pen.tone, x1, y1, x2, y2);
    if (!mark) return;
    setMarks(at.item, (at.item.marks || []).concat([mark]));
    announce(mark.kind === 'censor'
      ? 'Blacked out. The text under it will be deleted from the file, not covered.'
      : 'Highlighted in ' + PDF.marks.tone(mark.tone).label + '.');
  }

  function liftMarkAt(p) {
    const at = markedPage();
    if (!at) return;
    const marks = at.item.marks || [];
    const i = PDF.marks.markAt(at.frame, marks, p[0], p[1]);
    if (i < 0) return;
    setMarks(at.item, marks.slice(0, i).concat(marks.slice(i + 1)));
    announce('Mark lifted.');
  }

  function setPen(next) {
    pen = next;
    const kind = next ? next.kind : 'off';
    el('penOff').classList.toggle('is-on', kind === 'off');
    el('penOff').setAttribute('aria-pressed', String(kind === 'off'));
    el('penBlack').classList.toggle('is-on', kind === 'censor');
    el('penBlack').setAttribute('aria-pressed', String(kind === 'censor'));
    el('penTones').querySelectorAll('.swatch').forEach((b) => {
      const on = kind === 'highlight' && b.dataset.tone === next.tone;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (next && next.tone) lastTone = next.tone;

    el('penNote').textContent =
      kind === 'censor' ? 'Drag over what has to go. What it covers is deleted, not hidden.'
      : kind === 'highlight' ? 'Drag across the words. Click a mark to lift it.'
      : 'Reading. Click a mark to lift it.';
    if (markLayer) markLayer.classList.toggle('is-drawing', !!pen);
  }

  TONES.forEach((t) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.tone = t.id;
    button.dataset.tip = 'Highlight in ' + t.label;
    button.setAttribute('aria-label', 'Highlight in ' + t.label);
    button.setAttribute('aria-pressed', 'false');
    const chip = document.createElement('i');
    chip.style.background = PDF.marks.toneCSS(t.id);
    button.appendChild(chip);
    button.addEventListener('click', () => setPen({ kind: 'highlight', tone: t.id }));
    el('penTones').appendChild(button);
  });

  el('penOff').addEventListener('click', () => setPen(null));
  el('penBlack').addEventListener('click', () => setPen({ kind: 'censor' }));
  el('markClear').addEventListener('click', () => {
    const at = markedPage();
    if (!at || !(at.item.marks || []).length) return;
    const gone = at.item.marks.length;
    setMarks(at.item, []);
    announce('Lifted ' + gone + (gone === 1 ? ' mark' : ' marks') + ' off this page.');
  });
  setPen(null);

  // --- editing from the viewer -----------------------------------------------

  // Each of these acts on the page being shown and then follows it: rotating
  // stays on the same page, moving follows it, and deleting leaves the index
  // in place, showing whatever comes next.

  function viewerTurn(delta) {
    if (viewAt < 0) return;
    turnPages([viewAt], delta);
    const t = pile[viewAt];
    const base = docs[t.docId].doc.pages[t.pageIndex].rotate;
    announce('Turned this page to ' + (((t.rotate - base) % 360 + 360) % 360) + '°.');
  }

  function viewerMove(dir) {
    if (viewAt < 0) return;
    const { swapped } = movePages([viewAt], dir);
    if (!swapped) {
      announce(dir < 0 ? 'This page is already first.' : 'This page is already last.');
      return;
    }
    // Set before the redraw, so what comes back is the page you were reading in
    // its new place rather than whichever page took the old one.
    viewAt += dir;
    render();
    announce('Moved to place ' + (viewAt + 1) + ' of ' + pile.length + '.');
  }

  // Staying at the same index brings the next page into view, which suits
  // clearing several in a row. Past the end, render() pulls the index back to
  // the last page.
  function viewerDelete() {
    if (viewAt < 0) return;
    const was = viewAt + 1;
    deletePages([viewAt]);
    if (!pile.length) {
      announce('Removed page ' + was + '. Nothing left to show.');
      closeViewer();
      return;
    }
    announce('Removed page ' + was + '. ' + pile.length +
             (pile.length === 1 ? ' page left.' : ' pages left.'));
  }

  function viewerMark() {
    if (viewAt < 0) return;
    if (selected.has(viewAt)) selected.delete(viewAt);
    else selected.add(viewAt);
    // The grid is covered, so it is retinted on the way out with everything else.
    gridStale = true;
    refreshSelection();
    announce(selected.has(viewAt)
      ? 'Marked. ' + selected.size + ' in hand.'
      : 'Unmarked. ' + selected.size + ' in hand.');
  }

  viewBtn.addEventListener('click', () => {
    // Whatever you have in hand is what you most likely want to look at.
    const first = selected.size ? selectedSorted()[0] : 0;
    openViewer(first);
  });
  viewPrev.addEventListener('click', () => stepViewer(-1));
  viewNext.addEventListener('click', () => stepViewer(1));
  el('viewerRotL').addEventListener('click', () => viewerTurn(-90));
  el('viewerRotR').addEventListener('click', () => viewerTurn(90));
  viewEarlier.addEventListener('click', () => viewerMove(-1));
  viewLater.addEventListener('click', () => viewerMove(1));
  el('viewerDel').addEventListener('click', viewerDelete);
  viewSel.addEventListener('click', viewerMark);
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
    // ⌘Z is the history's, and a modified key otherwise belongs to the browser.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const shift = e.shiftKey;

    switch (e.key) {
      case 'Escape': closeViewer(); break;
      case 'ArrowRight': case 'ArrowDown': shift ? viewerMove(1) : stepViewer(1); break;
      case 'ArrowLeft': case 'ArrowUp': shift ? viewerMove(-1) : stepViewer(-1); break;
      case '[': viewerTurn(-90); break;
      case ']': viewerTurn(90); break;
      case 'b': case 'B': setPen({ kind: 'censor' }); break;
      case 'h': case 'H': setPen({ kind: 'highlight', tone: lastTone }); break;
      case 'v': case 'V': setPen(null); break;
      case 'Delete': case 'Backspace': viewerDelete(); break;
      // Space means the same thing wherever focus is, which costs it the usual
      // "press the focused button". Enter still does that.
      case ' ': viewerMark(); break;
      default: return;
    }
    e.preventDefault();
  });

  // A window that changed size while the viewer was open leaves the page drawn
  // for the old one. The ink is still good, so only the fit is redone.
  let resizeAt = 0;
  window.addEventListener('resize', () => {
    if (viewAt < 0) return;
    layoutSheet();
    clearTimeout(resizeAt);
    // Once it settles, drawn again at the new size so it is crisp and not scaled.
    resizeAt = setTimeout(() => {
      if (viewAt < 0) return;
      shownItem = null;
      drawViewer();
    }, 200);
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
    if (viewAt >= 0) refreshViewerBar();
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

  // The three actions below are given the pages to act on rather than reading
  // the selection themselves, because the two surfaces target different pages:
  // the grid the selection, the viewer the page shown. Same list, same
  // history, one code path.

  // Selection is carried across an edit by identity rather than by index,
  // because indices move when the pile does and entries do not. A page ticked
  // while reading survives deleting or moving a different one.
  function markedItems() {
    const items = new Set();
    for (const i of selected) if (pile[i]) items.add(pile[i]);
    return items;
  }

  function reselect(items) {
    setSelection(pile.reduce((acc, item, i) => {
      if (items.has(item)) acc.push(i);
      return acc;
    }, []));
  }

  function turnPages(indices, delta) {
    if (!indices.length) return;
    remember();
    for (const i of indices) {
      pile[i].rotate = PDF.ops.normaliseAngle(pile[i].rotate + delta);
    }
    const keep = markedItems();
    render();
    reselect(keep);
  }

  function deletePages(indices) {
    const gone = new Set(indices);
    if (!gone.size) return 0;
    remember();
    const keep = markedItems();
    pile = pile.filter((_, i) => !gone.has(i));
    render();
    reselect(keep);
    return gone.size;
  }

  function turn(delta) {
    if (!requireSelection()) return;
    const n = selected.size;
    turnPages(selectedSorted(), delta);
    announce('Turned ' + n + (n === 1 ? ' page.' : ' pages.'));
  }
  el('rotL').addEventListener('click', () => turn(-90));
  el('rotR').addEventListener('click', () => turn(90));

  el('del').addEventListener('click', () => {
    if (!requireSelection()) return;
    const gone = deletePages(selectedSorted());
    announce('Removed ' + gone + (gone === 1 ? ' page.' : ' pages.') +
             ' The file on your disk is untouched.');
  });

  el('clearMarks').addEventListener('click', () => {
    if (!requireSelection()) return;
    const items = selectedSorted().map((i) => pile[i]).filter((item) => (item.marks || []).length);
    if (!items.length) {
      announce('None of the selected pages carries a mark.');
      return;
    }
    const gone = items.reduce((n, item) => n + item.marks.length, 0);
    remember();
    items.forEach((item) => { item.marks = []; });
    const keep = markedItems();
    render();
    reselect(keep);
    announce('Lifted ' + gone + (gone === 1 ? ' mark' : ' marks') + ' off ' +
             items.length + (items.length === 1 ? ' page.' : ' pages.'));
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

  function movePages(indices, dir) {
    const order = indices.slice().sort((a, b) => a - b);
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
    return { swapped, landed: Array.from(moved).filter((i) => i >= 0 && i < pile.length) };
  }

  function nudge(dir) {
    if (!requireSelection()) return;
    const { landed } = movePages(selectedSorted(), dir);
    render();
    setSelection(landed);
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

  // --- metadata -----------------------------------------------------------------
  //
  // The sheet lists what each loaded file says about whoever made it, and puts
  // a switch on everything this tool can drop. Three groups, because the three
  // places a PDF keeps it behave differently: the information dictionary is
  // rebuilt from what is left ticked, the XMP packet and the file identifier
  // are never copied at all, and the page-level entries travel with the pages
  // and so are dropped for the whole pile or not at all.
  //
  // Only one file's information dictionary can go into one saved file, and it
  // is the first page's. The others are shown all the same: what they carry is
  // worth knowing even when this save is not the one that would carry it.

  const metaPanel = el('metaPanel');
  const metaTable = el('metaTable');
  const metaCache = new Map();     // docId -> rows, read once per file
  const metaCut = new Map();       // docId -> the ids of the fields to drop
  let metaShown = -1;              // the file on the sheet, or -1 to follow the pile
  let dropPageMeta = false;
  let dropAnnotAuthors = false;

  const META_GROUPS = [
    ['info', 'Document information', 'The named fields a reader lists under File, Properties.'],
    ['attached', 'Attached to the file', 'Written beside the document rather than into it.'],
    ['pages', 'On the pages', 'Travels with a page wherever that page ends up.'],
  ];

  function metaRowsFor(docId) {
    if (metaCache.has(docId)) return metaCache.get(docId);
    let rows = [];
    try { rows = PDF.metadata.read(docs[docId].doc); } catch { rows = []; }
    metaCache.set(docId, rows);
    return rows;
  }

  // The file whose information dictionary the saved file would carry.
  function metaSourceId() {
    if (pile.length) return pile[0].docId;
    return docs.length ? docs[0].id : -1;
  }

  function metaShownId() {
    if (metaShown >= 0 && docs[metaShown]) return metaShown;
    return metaSourceId();
  }

  // Whether this row is this reader's to decide. An information field belongs
  // to whichever file is supplying the saved file's; the rest are the pile's.
  function switchable(docId, row) {
    if (!row.removable) return false;
    return row.group !== 'info' || docId === metaSourceId();
  }

  function cutState(docId, row) {
    if (row.group === 'pages') return row.id === 'page:extras' ? dropPageMeta : dropAnnotAuthors;
    if (!switchable(docId, row)) return true;
    const set = metaCut.get(docId);
    return !!set && set.has(row.id);
  }

  function setCut(docId, row, cut) {
    if (row.group === 'pages') {
      if (row.id === 'page:extras') dropPageMeta = cut;
      else dropAnnotAuthors = cut;
      return;
    }
    let set = metaCut.get(docId);
    if (!set) { set = new Set(); metaCut.set(docId, set); }
    if (cut) set.add(row.id);
    else set.delete(row.id);
  }

  function metaCutCount() {
    const id = metaSourceId();
    if (id < 0) return 0;
    let n = 0;
    for (const row of metaRowsFor(id)) {
      if (row.group === 'info' && switchable(id, row) && cutState(id, row)) n++;
    }
    if (dropPageMeta) n++;
    if (dropAnnotAuthors) n++;
    return n;
  }

  // The instructions the assembler needs: a value for every field left ticked,
  // a null for every one struck out, and the two page-level switches.
  function saveOptions(report) {
    const id = metaSourceId();
    const info = {};
    if (id >= 0) {
      for (const row of metaRowsFor(id)) {
        if (row.group !== 'info' || !switchable(id, row)) continue;
        const key = row.key.slice(1);
        if (cutState(id, row)) info[key] = null;
        else if (row.raw !== null) info[key] = row.raw;
      }
    }
    return { info, dropPageMeta, dropAnnotAuthors, report };
  }

  function metaSummary() {
    const id = metaSourceId();
    if (id < 0) return '';
    const rows = metaRowsFor(id);
    const high = rows.filter((r) => r.risk === 'high').length;
    const cut = metaCutCount();
    const parts = [rows.length + (rows.length === 1 ? ' field' : ' fields')];
    if (high) parts.push(high + ' identifying');
    if (cut) parts.push(cut + ' to go');
    return parts.join(' · ');
  }

  function updateMeta() {
    el('metaTally').textContent = docs.length ? metaSummary() : '';
    if (!metaPanel.hidden) renderMeta();
  }

  function renderMeta() {
    const docId = metaShownId();
    if (docId < 0 || !docs[docId]) return;
    const rows = metaRowsFor(docId);
    const source = metaSourceId();

    const files = el('metaFiles');
    files.hidden = docs.length < 2;
    if (!files.hidden) {
      const row = el('metaFileRow');
      row.textContent = '';
      docs.forEach((entry) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-ghost meta-file' + (entry.id === docId ? ' is-on' : '');
        b.textContent = entry.name.replace(/\.pdf$/i, '');
        b.setAttribute('aria-pressed', String(entry.id === docId));
        b.addEventListener('click', () => { metaShown = entry.id; renderMeta(); });
        row.appendChild(b);
      });
    }

    el('metaCapName').textContent = docs[docId].name;
    el('metaCapNote').textContent = rows.length
      ? metaSummary()
      : 'nothing found';

    // Everything below the head row is rebuilt; the head is markup.
    Array.from(metaTable.querySelectorAll('tbody')).forEach((b) => b.remove());

    if (!rows.length) {
      const body = metaTable.createTBody();
      const cell = body.insertRow().insertCell();
      cell.colSpan = 4;
      cell.textContent = 'This file carries no metadata this tool can find.';
    }

    let id = 0;
    for (const [key, title, blurb] of META_GROUPS) {
      const group = rows.filter((r) => r.group === key);
      if (!group.length) continue;

      const body = metaTable.createTBody();
      const head = body.insertRow();
      head.className = 'grp-row';
      const headCell = head.insertCell();
      headCell.colSpan = 4;
      const name = document.createElement('span');
      name.className = 'grp-title';
      name.textContent = title;
      const say = document.createElement('span');
      say.className = 'grp-blurb';
      say.textContent = blurb;
      headCell.append(name, say);

      for (const row of group) {
        const cut = cutState(docId, row);
        const live = switchable(docId, row);
        const tr = body.insertRow();
        tr.className = 'fld' + (cut ? ' is-cut' : '') + (live ? '' : ' is-fixed');

        const keep = tr.insertCell();
        keep.className = 'col-keep';
        const nameId = 'meta-fld-' + (++id);
        if (live) {
          const label = document.createElement('label');
          label.className = 'checkbox';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = !cut;
          box.setAttribute('aria-labelledby', nameId);
          box.addEventListener('change', () => {
            setCut(docId, row, !box.checked);
            updateTally();
          });
          label.appendChild(box);
          keep.appendChild(label);
        }

        const label = document.createElement('th');
        label.className = 'fld-name';
        label.scope = 'row';
        label.id = nameId;
        label.append(row.label);
        const code = document.createElement('span');
        code.className = 'fld-key';
        code.textContent = row.key;
        label.appendChild(code);
        tr.appendChild(label);

        const value = tr.insertCell();
        value.className = 'col-value';
        const said = document.createElement('span');
        said.className = 'val' + (row.blank ? ' val-blank' : '');
        said.textContent = row.value || '(blank)';
        value.appendChild(said);

        const note = tr.insertCell();
        note.className = 'col-note';
        if (!live) {
          const why = document.createElement('span');
          why.className = 'risk';
          why.textContent = row.fixedNote || 'not carried';
          why.dataset.tip = row.group === 'info' && row.removable
            ? 'Only the first page\'s file supplies the information dictionary of the saved file.'
            : row.note;
          note.appendChild(why);
        } else if (row.risk === 'high' || row.risk === 'med') {
          const risk = document.createElement('span');
          risk.className = 'risk' + (row.risk === 'high' ? ' is-high mk--citron' : '');
          risk.textContent = row.risk === 'high' ? 'identifying' : 'telling';
          risk.dataset.tip = row.note;
          note.appendChild(risk);
        }
      }
    }

    const others = docs.length > 1 && docId !== source;
    el('metaNote').textContent = others
      ? 'Read out of ' + docs[docId].name + ' as it stands. Its information dictionary is not the ' +
        'one the saved file carries — that comes from ' + docs[source].name + ', the file the first ' +
        'page came from — so the fields above are shown rather than offered.'
      : 'Read out of the file as it stands. What is left ticked is what the saved file carries: the ' +
        'information dictionary is written fresh from these fields, the XMP packet and the file ' +
        'identifier are never copied, and the page-level rows cover every page in the pile.';
  }

  el('metaToggle').addEventListener('click', () => {
    const open = metaPanel.hidden;
    metaPanel.hidden = !open;
    el('metaToggle').setAttribute('aria-expanded', String(open));
    el('metaToggle').textContent = open ? 'Hide' : 'Show';
    if (open) renderMeta();
  });

  el('metaCutAll').addEventListener('click', () => {
    const docId = metaShownId();
    if (docId < 0) return;
    for (const row of metaRowsFor(docId)) if (switchable(docId, row)) setCut(docId, row, true);
    updateTally();
    announce('Every field this tool can drop is struck out. Nothing changes on your disk until you save.');
  });

  el('metaKeepAll').addEventListener('click', () => {
    const docId = metaShownId();
    if (docId < 0) return;
    for (const row of metaRowsFor(docId)) if (switchable(docId, row)) setCut(docId, row, false);
    updateTally();
    announce('Every field is back.');
  });

  // --- saving -----------------------------------------------------------------------

  function entriesFor(items) {
    return items.map((item) => ({
      doc: docs[item.docId].doc,
      pageIndex: item.pageIndex,
      rotate: item.rotate,
      marks: item.marks,
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
      const report = {};
      const bytes = PDF.ops.assemble(entriesFor(items), saveOptions(report));
      download(bytes, name);
      announce('Saved ' + name + ' — ' + items.length +
               (items.length === 1 ? ' page' : ' pages') + describeSave(report) + '.');
    } catch (e) {
      announce('Could not build that file: ' + e.message);
    }
  }

  // What the save did beyond copying pages, said in the same breath as the
  // filename. A blackout that could not be read all the way through is worth
  // more words than the rest put together, so it gets them.
  function describeSave(report) {
    const parts = [];
    if (report.censored) {
      parts.push(report.censored + (report.censored === 1 ? ' blackout' : ' blackouts') +
                 ', with the text under ' + (report.censored === 1 ? 'it' : 'them') + ' deleted');
    }
    if (report.highlighted) {
      parts.push(report.highlighted + (report.highlighted === 1 ? ' highlight' : ' highlights'));
    }
    const cut = metaCutCount();
    if (cut) parts.push(cut + (cut === 1 ? ' metadata field' : ' metadata fields') + ' dropped');
    let out = parts.length ? ', ' + parts.join(', ') : '';
    if (report.unsure) {
      out += '. Warning: ' + report.unsure + (report.unsure === 1 ? ' run of text' : ' runs of text') +
             ' could not be read well enough to be sure it went. Check the saved file';
    }
    return out;
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
        download(PDF.ops.assemble(entriesFor(chunk), saveOptions({})), base + '-' + label + '.pdf');
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
