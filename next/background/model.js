'use strict';

// Canonical tab/tree model. Single source of truth, lives only here.
//
// Per window:
//   order : number[]         — tab ids in native order (mirrors browser.tabs index)
//   tabs  : Map<id, Rec>     — one record per tab
//   Rec.parentId             — tree structure is just this one field
//   Rec.collapsed            — subtree-collapsed flag (descendants hidden)
//
// The tree is never stored as a separate structure. Rows for the sidebar are
// derived by a linear flatten pass over `order`.

export const DEBUG = false;
export function log(...args) {
  if (DEBUG) console.log('[tst-next]', ...args);
}

export const ROW_ACTIVE       = 1 << 0;
export const ROW_HIGHLIGHTED  = 1 << 1;
export const ROW_PINNED       = 1 << 2;
export const ROW_COLLAPSED    = 1 << 3;
export const ROW_HAS_CHILDREN = 1 << 4;
export const ROW_LOADING      = 1 << 5;
export const ROW_DISCARDED    = 1 << 6;
export const ROW_UNREAD       = 1 << 7; // loaded but never activated

// ---------------------------------------------------------------------------
// state

class Win {
  constructor(id) {
    this.id = id;
    this.order = [];
    this.tabs = new Map();
    this.version = 0;
  }
}

export const windows = new Map(); // winId -> Win

export function getWin(id) {
  return windows.get(id);
}

export function getTab(id) {
  for (const win of windows.values()) {
    const rec = win.tabs.get(id);
    if (rec) return rec;
  }
  return null;
}

function recordFromNative(tab) {
  return {
    id:          tab.id,
    windowId:    tab.windowId,
    parentId:    null,
    collapsed:   false,
    uid:         null, // set by persistence.js
    title:       tab.title || '',
    url:         tab.url || '',
    favIconUrl:  tab.favIconUrl || '',
    status:      tab.status || 'complete',
    active:      !!tab.active,
    highlighted: !!tab.highlighted,
    pinned:      !!tab.pinned,
    discarded:   !!tab.discarded,
    audible:     !!tab.audible,
    muted:       !!(tab.mutedInfo && tab.mutedInfo.muted),
    everActive:  !!tab.active,
  };
}

// ---------------------------------------------------------------------------
// order maintenance — mirror of native index order

function insertIntoOrder(win, tabId, index) {
  const at = Math.max(0, Math.min(index, win.order.length));
  win.order.splice(at, 0, tabId);
}

function removeFromOrder(win, tabId) {
  const i = win.order.indexOf(tabId);
  if (i >= 0) win.order.splice(i, 1);
}

// ---------------------------------------------------------------------------
// tree queries — all O(n) or O(depth); trivially cheap at hundreds of tabs

export function childrenOf(win, id) {
  const out = [];
  for (const tid of win.order) {
    const rec = win.tabs.get(tid);
    if (rec && rec.parentId === id)
      out.push(rec);
  }
  return out;
}

export function descendantsOf(win, id, out = []) {
  for (const child of childrenOf(win, id)) {
    out.push(child);
    descendantsOf(win, child.id, out);
  }
  return out;
}

export function isDescendantOf(win, id, ancestorId) {
  let rec = win.tabs.get(id);
  while (rec && rec.parentId != null) {
    if (rec.parentId === ancestorId)
      return true;
    rec = win.tabs.get(rec.parentId);
  }
  return false;
}

export function hasCollapsedAncestor(win, rec) {
  let p = rec.parentId;
  while (p != null) {
    const parent = win.tabs.get(p);
    if (!parent) return false;
    if (parent.collapsed) return true;
    p = parent.parentId;
  }
  return false;
}

function depthOf(win, rec, memo) {
  if (memo.has(rec.id)) return memo.get(rec.id);
  let depth = 0, p = rec.parentId;
  const seen = new Set([rec.id]);
  while (p != null) {
    const parent = win.tabs.get(p);
    if (!parent || seen.has(parent.id)) break; // cycle guard
    seen.add(parent.id);
    depth++;
    p = parent.parentId;
  }
  memo.set(rec.id, depth);
  return depth;
}

// ---------------------------------------------------------------------------
// flatten: model -> row[] for the sidebar

export function flatten(win) {
  const rows = [];
  const childCount = new Map(); // id -> direct child count, for HAS_CHILDREN
  for (const id of win.order) {
    const rec = win.tabs.get(id);
    if (rec && rec.parentId != null)
      childCount.set(rec.parentId, (childCount.get(rec.parentId) || 0) + 1);
  }
  const depthMemo = new Map();
  for (const id of win.order) {
    const rec = win.tabs.get(id);
    if (!rec) continue;
    if (hasCollapsedAncestor(win, rec)) continue; // hidden by collapse

    let flags = 0;
    if (rec.active)      flags |= ROW_ACTIVE;
    if (rec.highlighted) flags |= ROW_HIGHLIGHTED;
    if (rec.pinned)      flags |= ROW_PINNED;
    if (rec.collapsed)   flags |= ROW_COLLAPSED;
    if (childCount.has(id)) flags |= ROW_HAS_CHILDREN;
    if (rec.status === 'loading') flags |= ROW_LOADING;
    if (rec.discarded)   flags |= ROW_DISCARDED;
    if (!rec.everActive && rec.status !== 'loading') flags |= ROW_UNREAD;

    rows.push({
      id,
      depth: depthOf(win, rec, depthMemo),
      flags,
      title:       rec.title || rec.url,
      url:         rec.url,
      fav:         rec.favIconUrl,
      pid:         rec.parentId,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// push channel — sidebar ports per window

const ports = new Map(); // winId -> Set<port>
const pushScheduled = new Set();

export function registerPort(port, winId) {
  let set = ports.get(winId);
  if (!set) ports.set(winId, set = new Set());
  set.add(port);
  port.onDisconnect.addListener(() => {
    set.delete(port);
    if (set.size === 0) ports.delete(winId);
  });
  push(winId, { immediate: true });
}

export function push(winId, { immediate = false } = {}) {
  const win = windows.get(winId);
  if (!win) return;
  win.version++;
  if (!immediate) {
    if (pushScheduled.has(winId)) return;
    pushScheduled.add(winId);
    setTimeout(() => {
      pushScheduled.delete(winId);
      flushPush(winId);
    }, 0);
    return;
  }
  flushPush(winId);
}

function flushPush(winId) {
  const win = windows.get(winId);
  const set = ports.get(winId);
  if (!win || !set || set.size === 0) return;
  const snapshot = { type: 'snapshot', version: win.version, rows: flatten(win) };
  for (const port of set) {
    try { port.postMessage(snapshot); }
    catch (e) { set.delete(port); }
  }
}

// ---------------------------------------------------------------------------
// mutations — every one ends by marking the window dirty (push is coalesced)

export function trackTab(nativeTab) {
  let win = windows.get(nativeTab.windowId);
  if (!win) windows.set(nativeTab.windowId, win = new Win(nativeTab.windowId));

  const existing = win.tabs.get(nativeTab.id);
  const rec = existing || recordFromNative(nativeTab);
  if (existing) Object.assign(rec, recordFromNative(nativeTab), {
    parentId:   rec.parentId,
    collapsed:  rec.collapsed,
    uid:        rec.uid,
    everActive: rec.everActive || nativeTab.active,
  });
  win.tabs.set(nativeTab.id, rec);

  if (!win.order.includes(nativeTab.id))
    insertIntoOrder(win, nativeTab.id, nativeTab.index);

  push(win.id);
  return rec;
}

export function untrackTab(winId, tabId) {
  const win = windows.get(winId);
  if (!win) return;
  const rec = win.tabs.get(tabId);
  win.tabs.delete(tabId);
  removeFromOrder(win, tabId);
  // children of a closed tab are promoted to its parent — never orphaned
  if (rec) {
    for (const child of win.tabs.values()) {
      if (child.parentId === tabId) child.parentId = rec.parentId;
    }
  }
  push(winId);
}

export function moveInOrder(winId, tabId, _fromIndex, toIndex) {
  const win = windows.get(winId);
  if (!win) return;
  removeFromOrder(win, tabId);
  insertIntoOrder(win, tabId, toIndex);
  push(winId);
}

export function updateTab(nativeTab) {
  const win = windows.get(nativeTab.windowId);
  const rec = win && win.tabs.get(nativeTab.id);
  if (!rec) return;
  Object.assign(rec, {
    title:       nativeTab.title ?? rec.title,
    url:         nativeTab.url ?? rec.url,
    favIconUrl:  nativeTab.favIconUrl ?? rec.favIconUrl,
    status:      nativeTab.status ?? rec.status,
    pinned:      nativeTab.pinned ?? rec.pinned,
    discarded:   nativeTab.discarded ?? rec.discarded,
    audible:     nativeTab.audible ?? rec.audible,
    muted:       nativeTab.mutedInfo ? nativeTab.mutedInfo.muted : rec.muted,
  });
  push(rec.windowId);
}

export function setActive(winId, tabId, previousTabId) {
  const win = windows.get(winId);
  if (!win) return;
  for (const rec of win.tabs.values()) {
    if (rec.id === tabId) { rec.active = true; rec.everActive = true; }
    else if (rec.active) rec.active = false;
  }
  push(winId);
}

export function setHighlighted(winId, tabIds) {
  const win = windows.get(winId);
  if (!win) return;
  const set = new Set(tabIds);
  for (const rec of win.tabs.values())
    rec.highlighted = set.has(rec.id);
  push(winId);
}
