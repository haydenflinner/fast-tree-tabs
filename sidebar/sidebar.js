'use strict';

// Pure projection: the background owns all state and pushes versioned
// snapshots { version, rows, meta }. We keep rows[] + a Map<tabId, rowElement>
// and nothing else. No tab objects, no ordering logic, no waiting on anything.
// Outbound messages are intents; inbound are snapshots. That's the protocol.
//
// Rows are absolutely positioned at translateY(index*ROW_H), so any reorder
// animates for free via a CSS transition. Removed rows linger 160ms fading
// out ("dying") before being pooled — revive them if the id reappears.

const ROW_ACTIVE       = 1 << 0;
const ROW_HIGHLIGHTED  = 1 << 1;
const ROW_PINNED       = 1 << 2;
const ROW_COLLAPSED    = 1 << 3;
const ROW_HAS_CHILDREN = 1 << 4;
const ROW_LOADING      = 1 << 5;
const ROW_DISCARDED    = 1 << 6;
const ROW_UNREAD       = 1 << 7;

const scroller = document.getElementById('scroller');
const spacer   = document.getElementById('spacer');
const viewport = document.getElementById('viewport');
const menu     = document.getElementById('menu');
const dropline = document.getElementById('dropline');

let ROW_H  = 26;
let INDENT = 16;
let animations = true;

let rows = [];
let rowVersion = -1;
let rendered = new Map(); // tabId -> element (current rows)
const dying = new Map();  // tabId -> element fading out
const pool = [];

// ---------------------------------------------------------------------------
// connection

let port = null;
let myWindowId = null;

async function connect() {
  try {
    // windowTypes filter keeps getCurrent from resolving to the sidebar's
    // own context window on some Firefox versions
    const win = await browser.windows.getCurrent({ windowTypes: ['normal'] });
    myWindowId = win.id;
    console.log('[ftt sidebar] connected for window', myWindowId);
    port = browser.runtime.connect({ name: 'sidebar' });
    port.onMessage.addListener(onSnapshot);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
    port.postMessage({ type: 'hello', windowId: myWindowId });
  } catch (e) {
    console.error('[ftt sidebar] connect failed', e);
    setTimeout(connect, 1000);
  }
}

function send(msg) {
  if (port) port.postMessage(msg);
}

let lastActiveId = null;
let lastActiveIndex = -1;

function onSnapshot(msg) {
  if (msg.type !== 'snapshot' || msg.version <= rowVersion) return;
  rowVersion = msg.version;
  rows = msg.rows;
  console.log('[ftt sidebar] snapshot v' + msg.version, rows.length, 'rows');
  if (msg.meta) {
    animations = !!msg.meta.animations;
    if (msg.meta.indent) INDENT = msg.meta.indent;
    document.body.classList.toggle('anim', animations);
  }
  render();
  maybeScrollToActive();
}

function maybeScrollToActive() {
  const i = rows.findIndex(r => r.flags & ROW_ACTIVE);
  if (i < 0) {
    lastActiveId = null;
    lastActiveIndex = -1;
    return;
  }
  // Follow the row's position, not just its identity: a snapshot can move the
  // active tab (tree placement after create, drag-move, a subtree dropped
  // above it) and the view must chase it or the row slides out of view.
  if (rows[i].id === lastActiveId && i === lastActiveIndex) return;
  lastActiveId = rows[i].id;
  lastActiveIndex = i;
  const top = i * ROW_H, bottom = top + ROW_H;
  if (top < scroller.scrollTop)
    scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight)
    scroller.scrollTop = bottom - scroller.clientHeight;
}

// ---------------------------------------------------------------------------
// render — one absolutely-positioned element per row

function render() {
  // keep the explicit selection honest: anything no longer highlighted
  // (selection collapsed, tab closed) drops out
  for (const id of explicitSel) {
    const r = rows.find(r => r.id === id);
    if (!r || !(r.flags & ROW_HIGHLIGHTED)) explicitSel.delete(id);
  }

  // Always allow scrolling one viewport past the end. ScrollTop only ever
  // clamps when content shrinks below the visible area — with a full
  // viewport of trailing space, closing rows (even whole trees) at the
  // bottom never moves anything on screen.
  spacer.style.height = `${rows.length * ROW_H + scroller.clientHeight}px`;

  // Content is exactly one pane wide, plus indent space for the deepest
  // row — every row keeps its full label width; deep trees scroll sideways.
  let maxDepth = 0;
  for (const row of rows) if (row.depth > maxDepth) maxDepth = row.depth;
  const contentW = scroller.clientWidth + maxDepth * INDENT;
  spacer.style.width   = `${contentW}px`;
  viewport.style.width = `${contentW}px`;

  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    seen.add(row.id);

    let el = rendered.get(row.id);
    let isNew = false;
    if (!el && dying.has(row.id)) { // collapse+expand inside one fade: revive
      el = dying.get(row.id);
      clearTimeout(el._dieTimer);
      dying.delete(row.id);
      el.classList.remove('leaving');
    }
    if (!el) {
      el = pool.pop() || buildRow();
      el._y = null;
      isNew = true;
    }
    rendered.set(row.id, el);

    updateRow(el, row);
    if (isNew && animations) {
      el.classList.add('new');
      requestAnimationFrame(() => el.classList.remove('new'));
    }

    const y = i * ROW_H;
    if (el._y !== y) {
      el.style.transform = `translateY(${y}px)`;
      el._y = y;
    }
    viewport.appendChild(el); // keep DOM order === row order
  }

  // bench hook: report after the next frame
  requestAnimationFrame(() => {
    if (port) port.postMessage({ type: 'painted', version: rowVersion, count: rows.length });
  });

  for (const [id, el] of rendered) {
    if (seen.has(id)) continue;
    rendered.delete(id);
    if (animations) {
      el.classList.add('leaving');
      el._dieTimer = setTimeout(() => { dying.delete(id); release(el); }, 170);
      dying.set(id, el);
    } else {
      release(el);
    }
  }
}

function release(el) {
  el.remove();
  el.className = 'row';
  el.style.transform = '';
  el._y = null;
  pool.push(el);
}

function buildRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.draggable = true;
  el.innerHTML =
    '<span class="twisty"></span>' +
    '<span class="favicon"><img alt=""></span>' +
    '<span class="label"></span>' +
    '<span class="tail"><span class="counter" title="Collapse/expand"></span>' +
    '<button class="close" title="Close">×</button></span>';
  el._twisty  = el.children[0];
  el._favicon = el.children[1].firstChild;
  el._label   = el.children[2];
  el._counter = el.children[3].children[0];
  el._close   = el.children[3].children[1];
  return el;
}

const FLAG_CLASSES = [
  [ROW_ACTIVE, 'active'], [ROW_HIGHLIGHTED, 'highlighted'],
  [ROW_PINNED, 'pinned'], [ROW_COLLAPSED, 'collapsed'],
  [ROW_HAS_CHILDREN, 'has-children'], [ROW_LOADING, 'loading'],
  [ROW_DISCARDED, 'discarded'], [ROW_UNREAD, 'unread'],
];

function updateRow(el, row) {
  let cls = 'row';
  for (const [bit, name] of FLAG_CLASSES)
    if (row.flags & bit) cls += ' ' + name;
  if (el.className !== cls) el.className = cls;

  el.dataset.tabId = row.id;
  const pad = `${row.depth * INDENT + 4}px`;
  if (el.style.paddingLeft !== pad) el.style.paddingLeft = pad;
  el.title = `${row.title}\n${row.url}`;

  if (el._label.textContent !== row.title)
    el._label.textContent = row.title;
  const count = (row.flags & ROW_HAS_CHILDREN) && row.count > 0 ? String(row.count) : '';
  if (el._counter.textContent !== count)
    el._counter.textContent = count;
  if (!row.fav)
    el._favicon.removeAttribute('src');
  else if (el._favicon.getAttribute('src') !== row.fav)
    el._favicon.src = row.fav;
}

// ---------------------------------------------------------------------------
// selection helpers — multi-select rides on native tabs.highlight
//
// explicitSel: rows the user toggled (Cmd+click) or ranged (Shift+click)
// themselves. Firefox always folds the active tab into tabs.highlight, so
// rec.highlighted alone can't tell "selected" from "just active" — the
// explicit set is what multi-tab ops act on. Pruned to still-highlighted
// rows on every snapshot.
const explicitSel = new Set(); // tab ids
let lastClickedRowIndex = null; // index into rows[]

function rowById(id) { return rows.find(r => r.id === id); }

function highlightedIndices() {
  return rows.filter(r => r.flags & ROW_HIGHLIGHTED).map(r => r.index);
}

function sendHighlight(indices) {
  send({ type: 'highlight', indices });
}

function handleSelectClick(e, id) {
  const rowIndex = rows.findIndex(r => r.id === id);
  if (rowIndex < 0) return false;

  if (e.ctrlKey || e.metaKey) { // toggle this tab in the selection
    const set = new Set(highlightedIndices());
    const idx = rows[rowIndex].index;
    if (set.has(idx)) set.delete(idx); else set.add(idx);
    sendHighlight([...set]);
    if (explicitSel.has(id)) explicitSel.delete(id); else explicitSel.add(id);
    lastClickedRowIndex = rowIndex;
    return true;
  }
  if (e.shiftKey && lastClickedRowIndex != null) { // range select
    const [a, b] = lastClickedRowIndex < rowIndex
      ? [lastClickedRowIndex, rowIndex] : [rowIndex, lastClickedRowIndex];
    sendHighlight(rows.slice(a, b + 1).map(r => r.index));
    explicitSel.clear();
    for (const r of rows.slice(a, b + 1)) explicitSel.add(r.id);
    return true;
  }
  lastClickedRowIndex = rowIndex;
  return false;
}

// ---------------------------------------------------------------------------
// intents out

function rowTabId(el) {
  const row = el.closest && el.closest('.row');
  return row ? parseInt(row.dataset.tabId) : null;
}

viewport.addEventListener('click', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  if (e.target.classList.contains('close')) {
    send({ type: 'close', tabId: id });
  } else if (e.target.classList.contains('counter')) {
    send({ type: 'toggleCollapse', tabId: id });
  } else if (e.target.classList.contains('twisty')) {
    send({ type: 'toggleCollapse', tabId: id });
  } else if (!handleSelectClick(e, id)) {
    send({ type: 'activate', tabId: id });
  }
});

viewport.addEventListener('auxclick', e => {
  const id = rowTabId(e.target);
  if (e.button === 1 && id != null) {
    e.preventDefault();
    send({ type: 'close', tabId: id });
  }
});

viewport.addEventListener('dblclick', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  if (e.target.closest('.tail') || e.target.classList.contains('twisty'))
    return;
  const row = rowById(id);
  if (row && (row.flags & ROW_HAS_CHILDREN)) {
    e.preventDefault();
    send({ type: 'toggleCollapse', tabId: id });
  }
});

// dblclick on empty space = new tab (as before)
scroller.addEventListener('dblclick', e => {
  if (e.target === scroller || e.target === spacer)
    send({ type: 'newTab' });
});
document.getElementById('newtab').addEventListener('click', () => send({ type: 'newTab' }));

// ---------------------------------------------------------------------------
// context menu

function escMd(s) { return String(s).replace(/\[/g, '\\[').replace(/\]/g, '\\]'); }

function copyLinks(ids) {
  // tree-aware: ids must be contiguous descendants-of-root following rows,
  // so instead operate on row positions
  const lines = [];
  if (ids.length === 1) {
    const i = rows.findIndex(r => r.id === ids[0]);
    if (i < 0) return;
    const base = rows[i].depth;
    for (let j = i; j < rows.length; j++) {
      const r = rows[j];
      if (j > i && r.depth <= base) break;
      lines.push('  '.repeat(r.depth - base) + `- [${escMd(r.title)}](${r.url})`);
    }
  } else {
    for (const r of rows)
      if (ids.includes(r.id))
        lines.push(`- [${escMd(r.title)}](${r.url})`);
  }
  navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
}

function placeMenu(x, y, items) {
  menu.textContent = '';
  for (const item of items) {
    const el = document.createElement('button');
    el.textContent = item.label;
    el.addEventListener('click', () => { closeMenu(); item.act(); });
    menu.appendChild(el);
  }
  menu.style.left = `${Math.min(x, innerWidth - 180)}px`;
  menu.style.top  = `${Math.min(y, innerHeight - items.length * 26 - 8)}px`;
  menu.hidden = false;
}

function openRowMenu(x, y, rowId) {
  const row = rowById(rowId);
  if (!row) return;
  const inSelection = explicitSel.has(rowId);
  const selIds = inSelection
    ? rows.filter(r => explicitSel.has(r.id) && (r.flags & ROW_HIGHLIGHTED)).map(r => r.id)
    : [rowId];
  const multi = selIds.length > 1;
  const hasKids = !!(row.flags & ROW_HAS_CHILDREN);

  const items = [];
  if (!multi) {
    items.push(
      { label: 'Activate', act: () => send({ type: 'activate', tabId: rowId }) },
      { label: (row.flags & ROW_COLLAPSED) && hasKids
          ? `Close tab and ${row.count} descendants`
          : 'Close tab',
        act: () => send({ type: 'close', tabId: rowId }) },
    );
    if (hasKids)
      items.push({ label: `Close tree (${row.count + 1} tabs)`, act: () => send({ type: 'closeTree', tabId: rowId }) });
  } else {
    items.push({ label: `Close ${selIds.length} tabs`, act: () => send({ type: 'closeTabs', tabIds: selIds }) });
  }
  items.push(
    { label: multi ? `Unload ${selIds.length} tabs` : 'Unload tab',
      act: () => send({ type: 'discard', tabIds: selIds }) },
    { label: multi ? `Copy ${selIds.length} links`
                   : hasKids ? `Copy tree as links (${row.count + 1})` : 'Copy link',
      act: () => copyLinks(selIds) },
  );

  placeMenu(x, y, items);
}

function closeMenu() { menu.hidden = true; }

viewport.addEventListener('contextmenu', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  e.preventDefault();
  openRowMenu(e.clientX, e.clientY, id);
});
scroller.addEventListener('contextmenu', e => {
  if (e.target === scroller || e.target === spacer) {
    e.preventDefault();
    placeMenu(e.clientX, e.clientY, [
      { label: 'New tab', act: () => send({ type: 'newTab' }) },
      { label: 'Run bench', act: () => browser.tabs.create({ url: browser.runtime.getURL('bench/bench.html') }) },
    ]);
  }
});
document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
scroller.addEventListener('scroll', closeMenu, { passive: true });

// ---------------------------------------------------------------------------
// drag and drop — local preview only; the move itself is a background intent
//
// The pointer picks the exact slot: y chooses the gap between rows, x chooses
// the depth (snapped to the indent grid). The drop line is drawn at that slot,
// so the tab lands where the line is. The middle band of a row is the one
// exception: it means drop-into-the-row (child slot follows insertChildAt).

let dragId = null;

viewport.addEventListener('dragstart', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
});

function clearDropHints() {
  for (const el of viewport.querySelectorAll('.drop-into'))
    el.classList.remove('drop-into');
  dropline.style.display = 'none';
}

// The slot between rows[g-1] and rows[g]. Legal depths run 0..a.depth+1 (first
// child of the row above), capped at a.depth when a is collapsed so a drop can
// never vanish into a hidden subtree. The parent for depth d is the nearest
// row above the gap at depth d-1; beforeId is simply the row below the gap.
function gapTarget(g, clientX) {
  const a = g > 0 ? rows[g - 1] : null;
  const b = g < rows.length ? rows[g] : null;
  let maxDepth = a ? a.depth : 0;
  if (a && !(a.flags & ROW_COLLAPSED)) maxDepth = a.depth + 1;
  const x = clientX + scroller.scrollLeft - 4; // content space, indent origin
  let depth = Math.max(0, Math.min(maxDepth, Math.floor(x / INDENT)));
  let newParentId = null;
  if (depth > 0) {
    for (let j = g - 1; j >= 0; j--) {
      if (rows[j].depth < depth - 1) break; // malformed order — bail to root
      if (rows[j].depth === depth - 1) { newParentId = rows[j].id; break; }
    }
    if (newParentId == null) depth = 0;
  }
  return { hint: 'line', gap: g, depth, newParentId, beforeId: b ? b.id : null, into: false };
}

function dropTarget(rowEl, clientX, clientY) {
  const id = parseInt(rowEl.dataset.tabId);
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return null;
  const row = rows[i];
  const rect = rowEl.getBoundingClientRect();
  const frac = (clientY - rect.top) / rect.height;

  if (frac >= 0.3 && frac <= 0.7)
    return { hint: 'into', el: rowEl, newParentId: row.id, beforeId: null, into: true };
  return gapTarget(frac < 0.3 ? i : i + 1, clientX);
}

let lastHint = null;

scroller.addEventListener('dragover', e => {
  if (dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropHints();
  const rowEl = e.target.closest('.row');
  lastHint = rowEl
    ? (parseInt(rowEl.dataset.tabId) === dragId ? null : dropTarget(rowEl, e.clientX, e.clientY))
    : gapTarget(rows.length, e.clientX); // empty space = gap past the last row
  if (!lastHint) return;
  if (lastHint.hint === 'into') {
    lastHint.el.classList.add('drop-into');
  } else {
    dropline.style.display = 'block';
    dropline.style.left = `${lastHint.depth * INDENT + 4}px`;
    dropline.style.transform = `translateY(${lastHint.gap * ROW_H}px)`;
  }
});

scroller.addEventListener('drop', e => {
  if (dragId == null) return;
  e.preventDefault();
  clearDropHints();
  if (lastHint) {
    const tabIds = explicitSel.has(dragId)
      ? rows.filter(r => explicitSel.has(r.id) && (r.flags & ROW_HIGHLIGHTED)).map(r => r.id)
      : [dragId];
    send({ type: 'move', tabIds, newParentId: lastHint.newParentId, beforeId: lastHint.beforeId, into: !!lastHint.into });
  }
  lastHint = null;
  dragId = null;
});

viewport.addEventListener('dragend', () => {
  dragId = null;
  lastHint = null;
  clearDropHints();
});

// ---------------------------------------------------------------------------

// spacer size depends on clientHeight
window.addEventListener('resize', () => render(), { passive: true });

ROW_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 26;
connect();
