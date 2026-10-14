'use strict';

// All mutations of the model happen here, in response to native tab events
// (background.js) or sidebar intents (via port messages). Every path funnels
// into the same small set of primitives, then pushes a fresh snapshot.

import {
  getWin, push,
  descendantsOf, isDescendantOf,
  trackTab, log,
} from './model.js';
import { saveWindowTree } from './persistence.js';

// ---------------------------------------------------------------------------
// placement rules — the entire "where does a new tab go" policy
//
//   has an opener in this window  -> child of opener, after opener's subtree
//   no opener                     -> wherever Firefox put it (root)
//
// One knob: NEW_ROOT_AT_END forces opener-less tabs to the window's end.

const NEW_ROOT_AT_END = false;

export async function placeNewTab(nativeTab) {
  const rec = trackTab(nativeTab); // creates the Win if unseen
  const win = getWin(nativeTab.windowId);

  const opener = nativeTab.openerTabId != null && win.tabs.get(nativeTab.openerTabId);
  if (opener && !opener.pinned) {
    rec.parentId = opener.id;
    await moveNative(win, [rec.id], insertionIndex(win, { parentId: opener.id, movingIds: [rec.id] }));
  }
  else if (NEW_ROOT_AT_END && !nativeTab.pinned) {
    await moveNative(win, [rec.id], insertionIndex(win, { movingIds: [rec.id] }));
  }
  saveWindowTree(win.id);
  push(win.id);
  return rec;
}

// ---------------------------------------------------------------------------
// primitives

// `toIndex` is expressed against the order with `ids` already removed —
// i.e. "the slot these tabs should occupy" — which is exactly the semantics
// browser.tabs.move() uses for its index argument.
async function moveNative(win, ids, toIndex) {
  try {
    await browser.tabs.move(ids, { index: toIndex });
  } catch (e) {
    log('move failed', ids, toIndex, e);
  }
}

// index within `order` after removing `movingIds`, corresponding to "after the
// subtree of parentId" or "before beforeId" or "at end".
function insertionIndex(win, { parentId = null, beforeId = null, movingIds = [] }) {
  const moving = new Set(movingIds);
  const filtered = win.order.filter(id => !moving.has(id));

  if (beforeId != null) {
    const at = filtered.indexOf(beforeId);
    if (at >= 0) return at;
  }
  if (parentId != null) {
    // position right after parent's last contiguous descendant
    const at = filtered.indexOf(parentId);
    if (at >= 0) {
      const subtree = new Set([parentId]);
      let end = at + 1;
      for (let i = at + 1; i < filtered.length; i++) {
        const rec = win.tabs.get(filtered[i]);
        if (rec && subtree.has(rec.parentId)) { subtree.add(rec.id); end = i + 1; }
        else break;
      }
      return end;
    }
  }
  return filtered.length;
}

// ---------------------------------------------------------------------------
// intents

export async function activate(winId, tabId) {
  try { await browser.tabs.update(tabId, { active: true }); }
  catch (e) { log('activate failed', e); }
}

export async function close(winId, tabId) {
  try { await browser.tabs.remove(tabId); }
  catch (e) { log('close failed', e); }
}

export function toggleCollapse(winId, tabId) {
  const win = getWin(winId);
  const rec = win && win.tabs.get(tabId);
  if (!rec) return;
  rec.collapsed = !rec.collapsed;
  saveWindowTree(winId);
  push(winId);
}

export async function newTab(winId, parentId = null) {
  try {
    await browser.tabs.create({ windowId: winId, active: true });
  } catch (e) { log('newTab failed', e); }
}

// Move tabId (subtree travels with it) under newParentId, before beforeId.
// newParentId=null means root. Rejected silently on cycles/missing tabs.
export async function move(winId, { tabId, newParentId = null, beforeId = null }) {
  const win = getWin(winId);
  const rec = win && win.tabs.get(tabId);
  if (!rec) return;
  if (newParentId != null) {
    if (newParentId === tabId) return;
    if (!win.tabs.get(newParentId)) return;
    if (isDescendantOf(win, newParentId, tabId)) return; // cycle
    if (win.tabs.get(newParentId).pinned && !rec.pinned) return;
  }
  rec.parentId = newParentId;

  // The subtree travels with the tab, preserving current relative order.
  const subtree = new Set(descendantsOf(win, rec.id).map(r => r.id));
  subtree.add(rec.id);
  const block = win.order.filter(id => subtree.has(id));
  const target = insertionIndex(win, { parentId: newParentId, beforeId, movingIds: block });
  await moveNative(win, block, target);
  saveWindowTree(winId);
  push(winId);
}

// Drag onto the blank area = detach to root at end.
export async function detachToRoot(winId, tabId) {
  return move(winId, { tabId, newParentId: null, beforeId: null });
}
