'use strict';

// Session persistence: per-tab unique ids + per-window flattened tree.
// Undo-close and session restore carry these values back, which makes tree
// restoration almost free.

import { getWin, log } from './model.js';

const KEY_UID  = 'ftt-uid';
const KEY_TREE = 'ftt-tree';

const saveScheduled = new Set();

export async function uidFor(tabId) {
  try {
    const existing = await browser.sessions.getTabValue(tabId, KEY_UID);
    if (existing) return existing;
  } catch (_e) {}
  const uid = crypto.randomUUID();
  browser.sessions.setTabValue(tabId, KEY_UID, uid).catch(() => {});
  return uid;
}

export async function assignUids(win) {
  await Promise.all([...win.tabs.values()].map(async rec => {
    rec.uid = await uidFor(rec.id);
  }));
}

// Save debounced per window. Layout: [[uid, parentUidOrNull, collapsed?1:0], ...]
// in `order` sequence.
export function saveWindowTree(winId) {
  if (saveScheduled.has(winId)) return;
  saveScheduled.add(winId);
  setTimeout(async () => {
    saveScheduled.delete(winId);
    const win = getWin(winId);
    if (!win) return;
    const entries = win.order.map(id => {
      const rec = win.tabs.get(id);
      if (!rec) return null;
      const parent = rec.parentId != null ? win.tabs.get(rec.parentId) : null;
      return [rec.uid, parent ? parent.uid : null, rec.collapsed ? 1 : 0];
    }).filter(Boolean);
    try {
      await browser.sessions.setWindowValue(winId, KEY_TREE, entries);
    } catch (_e) {}
  }, 400);
}

// Restore parent links/collapse flags on a freshly tracked window.
// `win` is already populated with tabs + uids.
export async function restoreWindowTree(win) {
  let entries;
  try {
    entries = await browser.sessions.getWindowValue(win.id, KEY_TREE);
  } catch (_e) {}
  if (!Array.isArray(entries)) return false;

  const byUid = new Map();
  for (const rec of win.tabs.values())
    if (rec.uid) byUid.set(rec.uid, rec);

  let restored = 0;
  for (const [uid, parentUid, collapsed] of entries) {
    const rec = byUid.get(uid);
    if (!rec) continue;
    if (collapsed) rec.collapsed = true;
    if (parentUid != null) {
      const parent = byUid.get(parentUid);
      if (parent && parent.id !== rec.id) {
        rec.parentId = parent.id;
        restored++;
      }
    }
  }
  log(`restored ${restored} parent links for window ${win.id}`);
  return restored > 0;
}

// In-memory uid -> parentUid for recently closed tabs. onRemoved saves the
// window tree *without* the closed tab, so undo-close can't find itself in the
// stored tree — this map is what restores its parent.
const closedParentByUid = new Map();
const MAX_CLOSED = 200;

export function rememberClosed(rec, win) {
  if (!rec || !rec.uid) return;
  const parent = rec.parentId != null ? win.tabs.get(rec.parentId) : null;
  closedParentByUid.set(rec.uid, parent ? parent.uid : null);
  if (closedParentByUid.size > MAX_CLOSED)
    closedParentByUid.delete(closedParentByUid.keys().next().value);
}

// For a single newly-seen tab that already carries a uid (undo-close,
// session-restored tab): look up its stored parent by uid.
export async function restoreTabParent(rec) {
  const win = getWin(rec.windowId);
  if (!win || !rec.uid) return;

  let parentUid, collapsed = false;
  if (closedParentByUid.has(rec.uid)) {
    parentUid = closedParentByUid.get(rec.uid);
    closedParentByUid.delete(rec.uid);
  } else {
    let entries;
    try {
      entries = await browser.sessions.getWindowValue(rec.windowId, KEY_TREE);
    } catch (_e) { return; }
    if (!Array.isArray(entries)) return;
    const entry = entries.find(e => e[0] === rec.uid);
    if (!entry) return;
    [, parentUid, collapsed] = entry;
    if (collapsed) rec.collapsed = true;
  }

  if (parentUid != null) {
    for (const other of win.tabs.values()) {
      if (other.uid === parentUid && other.id !== rec.id) {
        rec.parentId = other.id;
        break;
      }
    }
  }
}
