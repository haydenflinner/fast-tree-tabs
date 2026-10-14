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
import { cfg } from './config.js';

// ---------------------------------------------------------------------------
// placement policy (see config.js DEFAULTS for the knobs)
//
//   has opener in this window -> child of opener
//   no opener                 -> cfg.newTabNoOpener
//   child position            -> cfg.insertChildAt ('first' | 'last')

function activeRec(win) {
  for (const rec of win.tabs.values())
    if (rec.active) return rec;
  return null;
}

// A fresh, unused new tab — nesting further new tabs under it produces a
// staircase, so siblings are used instead.
function isBlankTab(rec) {
  const u = rec.url || '';
  return !u || u === 'about:newtab' || u === 'about:home' || u === 'about:blank';
}

export async function placeNewTab(nativeTab) {
  const rec = trackTab(nativeTab); // creates the Win if unseen
  const win = getWin(nativeTab.windowId);
  const opener = nativeTab.openerTabId != null ? win.tabs.get(nativeTab.openerTabId) : null;

  let parentId = null;
  let target = null; // index into order-minus-this-tab

  if (opener && !opener.pinned && !nativeTab.pinned) {
    parentId = opener.id;
  }
  else if (!nativeTab.pinned) {
    const active = activeRec(win);
    switch (cfg.newTabNoOpener) {
      case 'child-of-active':
        if (active && !active.pinned) {
          if (isBlankTab(active)) {
            // active is a throwaway new tab — attach beside it (same parent,
            // right after its subtree) rather than nesting the staircase
            parentId = active.parentId;
            const filtered = win.order.filter(id => id !== rec.id);
            target = subtreeEnd(win, filtered, active.id);
          } else {
            parentId = active.id;
          }
        }
        break;
      case 'after-active': {
        const filtered = win.order.filter(id => id !== rec.id);
        target = active ? subtreeEnd(win, filtered, active.id) : filtered.length;
        break;
      }
      case 'end':
        target = win.order.length - 1;
        break;
      // 'native': leave Firefox's placement alone
    }
  }

  if (parentId != null)
    rec.parentId = parentId;
  if (parentId != null && target == null) {
    const parent = win.tabs.get(parentId);
    if (parent.collapsed) parent.collapsed = false; // the new tab should be visible
    target = insertionIndex(win, {
      parentId,
      firstChild: cfg.insertChildAt === 'first',
      movingIds:  [rec.id],
    });
  }
  if (target != null)
    await moveNative(win, [rec.id], target);

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
  if (toIndex == null) return;
  try {
    await browser.tabs.move(ids, { index: toIndex });
  } catch (e) {
    log('move failed', ids, toIndex, e);
  }
}

// Index (in `filtered`, already free of moving ids) just past the contiguous
// subtree of `id`.
function subtreeEnd(win, filtered, id) {
  const at = filtered.indexOf(id);
  if (at < 0) return filtered.length;
  const subtree = new Set([id]);
  let end = at + 1;
  for (let i = at + 1; i < filtered.length; i++) {
    const rec = win.tabs.get(filtered[i]);
    if (rec && subtree.has(rec.parentId)) { subtree.add(rec.id); end = i + 1; }
    else break;
  }
  return end;
}

// Where in the order (with `movingIds` removed) an insertion should go:
//   beforeId  -> right before that tab
//   parentId  -> inside its subtree: firstChild ? right after the parent
//                                           : after the whole subtree
//   neither   -> end of the window
function insertionIndex(win, { parentId = null, beforeId = null, firstChild = false, movingIds = [] }) {
  const moving = new Set(movingIds);
  const filtered = win.order.filter(id => !moving.has(id));

  if (beforeId != null) {
    const at = filtered.indexOf(beforeId);
    if (at >= 0) return at;
  }
  if (parentId != null) {
    const at = filtered.indexOf(parentId);
    if (at >= 0)
      return firstChild ? at + 1 : subtreeEnd(win, filtered, parentId);
  }
  return filtered.length;
}

function subtreeIds(win, tabId) {
  const keep = new Set([tabId, ...descendantsOf(win, tabId).map(r => r.id)]);
  return win.order.filter(id => keep.has(id));
}

// ---------------------------------------------------------------------------
// intents

export async function activate(winId, tabId) {
  try { await browser.tabs.update(tabId, { active: true }); }
  catch (e) { log('activate failed', e); }
}

// Closebox/menu "close": a collapsed tab takes its subtree with it; an
// expanded tab closes alone and its children get promoted (model.untrackTab).
export async function close(winId, tabId) {
  const win = getWin(winId);
  const rec = win && win.tabs.get(tabId);
  if (!rec) return;
  const ids = (rec.collapsed && cfg.closeCollapsedClosesSubtree)
    ? subtreeIds(win, tabId)
    : [tabId];
  try { await browser.tabs.remove(ids); }
  catch (e) { log('close failed', e); }
}

// Explicit "close tree": always the whole subtree, collapsed or not.
export async function closeTree(winId, tabId) {
  const win = getWin(winId);
  if (!win || !win.tabs.get(tabId)) return;
  try { await browser.tabs.remove(subtreeIds(win, tabId)); }
  catch (e) { log('closeTree failed', e); }
}

export async function closeTabs(winId, tabIds) {
  try { await browser.tabs.remove(tabIds); }
  catch (e) { log('closeTabs failed', e); }
}

export async function discard(winId, tabIds) {
  const win = getWin(winId);
  if (!win) return;
  const ok = tabIds.filter(id => {
    const rec = win.tabs.get(id);
    return rec && !rec.active && !rec.pinned && !rec.discarded;
  });
  if (ok.length === 0) return;
  try { await browser.tabs.discard(ok); }
  catch (e) { log('discard failed', e); }
}

export function toggleCollapse(winId, tabId) {
  const win = getWin(winId);
  const rec = win && win.tabs.get(tabId);
  if (!rec) return;
  rec.collapsed = !rec.collapsed;
  saveWindowTree(winId);
  push(winId);
}

export async function newTab(winId) {
  try {
    await browser.tabs.create({ windowId: winId, active: true });
  } catch (e) { log('newTab failed', e); }
}

// Multi-select. `indices` are native tab indexes; the active tab is always
// included because Firefox requires it.
export async function highlight(winId, indices) {
  const win = getWin(winId);
  if (!win) return;
  const set = new Set(indices.filter(i => i >= 0 && i < win.order.length));
  const activeIndex = win.order.findIndex(id => win.tabs.get(id)?.active);
  if (activeIndex >= 0) set.add(activeIndex);
  try {
    await browser.tabs.highlight({ windowId: winId, tabs: [...set] });
  } catch (e) { log('highlight failed', e); }
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
