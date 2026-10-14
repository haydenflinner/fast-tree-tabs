'use strict';

// Pure projection: the background owns all state and pushes versioned
// snapshots { version, rows }. We keep rows[] + a Map<tabId, rowElement> and
// nothing else. No tab objects, no ordering logic, no waiting on anything.
// Outbound messages are intents; inbound are snapshots. That's the protocol.

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
const INDENT   = 16;
let ROW_H = 26;
const OVERSCAN = 8;

let rows = [];
let rowVersion = -1;
let rendered = new Map(); // tabId -> element
const pool = [];

// ---------------------------------------------------------------------------
// connection

let port = null;
let myWindowId = null;

async function connect() {
  try {
    const win = await browser.windows.getCurrent();
    myWindowId = win.id;
    port = browser.runtime.connect({ name: 'sidebar' });
    port.onMessage.addListener(onSnapshot);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
    port.postMessage({ type: 'hello', windowId: myWindowId });
  } catch (e) {
    setTimeout(connect, 1000);
  }
}

function send(msg) {
  if (port) port.postMessage(msg);
}

let lastActiveId = null;

function onSnapshot(msg) {
  if (msg.type !== 'snapshot' || msg.version <= rowVersion) return;
  rowVersion = msg.version;
  rows = msg.rows;
  maybeScrollToActive();
  scheduleRender();
}

function maybeScrollToActive() {
  const i = rows.findIndex(r => r.flags & ROW_ACTIVE);
  if (i < 0 || rows[i].id === lastActiveId) return;
  lastActiveId = rows[i].id;
  const top = i * ROW_H, bottom = top + ROW_H;
  if (top < scroller.scrollTop)
    scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight)
    scroller.scrollTop = bottom - scroller.clientHeight;
}

// ---------------------------------------------------------------------------
// render — keyed element reuse over a virtual window

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const count = rows.length;
  spacer.style.height = `${count * ROW_H}px`;

  const viewH = scroller.clientHeight;
  let first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
  let last = Math.min(count, Math.ceil((scroller.scrollTop + viewH) / ROW_H) + OVERSCAN);

  const needed = new Set();
  for (let i = first; i < last; i++) needed.add(rows[i].id);

  for (const [id, el] of rendered) {
    if (!needed.has(id)) {
      pool.push(el);
      rendered.delete(id);
    }
  }

  const ordered = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    let el = rendered.get(row.id);
    if (!el) {
      el = pool.pop() || buildRow();
      rendered.set(row.id, el);
    }
    updateRow(el, row);
    ordered.push(el);
  }
  // replaceChildren reorders/moves existing nodes without recreating them.
  viewport.replaceChildren(...ordered);

  viewport.style.transform = `translateY(${first * ROW_H}px)`;
}

function buildRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.draggable = true;
  el.innerHTML =
    '<span class="twisty"></span>' +
    '<span class="favicon"><img alt=""></span>' +
    '<span class="label"></span>' +
    '<button class="close" title="Close">×</button>';
  el._twisty  = el.children[0];
  el._favicon = el.children[1].firstChild;
  el._label   = el.children[2];
  el._close   = el.children[3];
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
  el.style.paddingLeft = `${row.depth * INDENT + 4}px`;
  el.title = `${row.title}\n${row.url}`;

  if (el._label.textContent !== row.title)
    el._label.textContent = row.title;
  if (!row.fav)
    el._favicon.removeAttribute('src');
  else if (el._favicon.getAttribute('src') !== row.fav)
    el._favicon.src = row.fav;
}

// ---------------------------------------------------------------------------
// intents out

function rowTabId(el) {
  const row = el.closest('.row');
  return row ? parseInt(row.dataset.tabId) : null;
}

viewport.addEventListener('click', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  if (e.target.classList.contains('close')) {
    send({ type: 'close', tabId: id });
  } else if (e.target.classList.contains('twisty')) {
    send({ type: 'toggleCollapse', tabId: id });
  } else {
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

scroller.addEventListener('dblclick', e => {
  if (e.target === scroller || e.target === spacer)
    send({ type: 'newTab' });
});
document.getElementById('newtab').addEventListener('click', () => send({ type: 'newTab' }));

// ---------------------------------------------------------------------------
// drag and drop — local preview only; the move itself is a background intent

let dragId = null;

viewport.addEventListener('dragstart', e => {
  const id = rowTabId(e.target);
  if (id == null) return;
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
});

function clearDropHints() {
  for (const el of viewport.querySelectorAll('.drop-before,.drop-after,.drop-into'))
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  scroller.classList.remove('drop-root');
}

// Given a target row + pointer position, compute {newParentId, beforeId, hint}.
function dropTarget(rowEl, clientY) {
  const id = parseInt(rowEl.dataset.tabId);
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return null;
  const row = rows[i];
  const rect = rowEl.getBoundingClientRect();
  const frac = (clientY - rect.top) / rect.height;

  if (frac < 0.3) {
    return { newParentId: row.pid, beforeId: row.id, hint: 'drop-before', el: rowEl };
  }
  if (frac > 0.7) {
    // "after" = before the next row that isn't inside this row's subtree
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].depth <= row.depth)
        return { newParentId: row.pid, beforeId: rows[j].id, hint: 'drop-after', el: rowEl };
    }
    return { newParentId: row.pid, beforeId: null, hint: 'drop-after', el: rowEl };
  }
  return { newParentId: row.id, beforeId: null, hint: 'drop-into', el: rowEl };
}

let lastHint = null;

scroller.addEventListener('dragover', e => {
  if (dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropHints();
  const rowEl = e.target.closest('.row');
  if (rowEl && parseInt(rowEl.dataset.tabId) !== dragId) {
    lastHint = dropTarget(rowEl, e.clientY);
    if (lastHint) lastHint.el.classList.add(lastHint.hint);
  } else {
    lastHint = { root: true };
    scroller.classList.add('drop-root');
  }
});

scroller.addEventListener('drop', e => {
  if (dragId == null) return;
  e.preventDefault();
  clearDropHints();
  if (lastHint && lastHint.root) {
    send({ type: 'detachToRoot', tabId: dragId });
  } else if (lastHint) {
    send({ type: 'move', tabId: dragId, newParentId: lastHint.newParentId, beforeId: lastHint.beforeId });
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

scroller.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender, { passive: true });

ROW_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 26;
connect();
