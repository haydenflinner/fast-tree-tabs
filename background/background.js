'use strict';

// Wiring: native tab events -> model mutations -> push. The sidebar never sees
// events; it sees snapshots.

import {
  windows, getWin, push, registerPort,
  trackTab, untrackTab, moveInOrder, updateTab, setActive, setHighlighted,
  log, logErr,
} from './model.js';
import { assignUids, restoreWindowTree, restoreTabParent, saveWindowTree, uidFor, rememberClosed } from './persistence.js';
import { initConfig } from './config.js';
import * as I from './intents.js';

// ---------------------------------------------------------------------------
// startup: build the model from scratch, then restore the tree

async function init() {
  try {
    await initConfig();
    const wins = await browser.tabs.query({ windowType: 'normal' }).then(tabs => {
      const byWin = new Map();
      for (const t of tabs) {
        if (!byWin.has(t.windowId)) byWin.set(t.windowId, []);
        byWin.get(t.windowId).push(t);
      }
      return byWin;
    });

    for (const [winId, tabs] of wins) {
      for (const tab of tabs) trackTab(tab);
      const win = getWin(winId);
      await assignUids(win);
      if (!(await restoreWindowTree(win))) {
        // no stored tree: fall back to opener links, which survive restarts
        for (const rec of win.tabs.values()) {
          const native = tabs.find(t => t.id === rec.id);
          if (native && native.openerTabId != null && win.tabs.has(native.openerTabId))
            rec.parentId = native.openerTabId;
        }
      }
      push(winId, { immediate: true });
      saveWindowTree(winId);
    }
    log('initialized', windows.size, 'windows');
  } catch (e) {
    logErr('init failed', e);
  }

  // bring the sidebar up on (re)load; open_at_install covers first install
  try { await browser.sidebarAction.open(); }
  catch (e) { log('sidebarAction.open failed (needs user gesture?)', e); }

  // bench sentinel: present only in ad-hoc test builds, never committed
  try {
    const r = await fetch(browser.runtime.getURL('bench/autorun'));
    if (r.ok)
      browser.tabs.create({ url: browser.runtime.getURL('bench/bench.html?auto=1'), active: true });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// native events -> model

browser.tabs.onCreated.addListener(tab => {
  I.placeNewTab(tab).then(async rec => {
    // Undo-close restores the uid session value; if this "new" tab already
    // has one, pull its parent from the stored tree.
    rec.uid = await uidFor(tab.id);
    await restoreTabParent(rec);
    push(rec.windowId);
  });
});

browser.tabs.onRemoved.addListener((tabId, info) => {
  const win = getWin(info.windowId);
  rememberClosed(win && win.tabs.get(tabId), win);
  untrackTab(info.windowId, tabId);
  saveWindowTree(info.windowId);
});

browser.tabs.onMoved.addListener((tabId, info) => {
  moveInOrder(info.windowId, tabId, info.fromIndex, info.toIndex);
});

browser.tabs.onAttached.addListener((tabId, info) => {
  browser.tabs.get(tabId).then(tab => {
    trackTab(tab); // insert at new index; parent is dropped by the record
    push(info.newWindowId);
  }).catch(() => {});
});

browser.tabs.onDetached.addListener((tabId, info) => {
  untrackTab(info.oldWindowId, tabId);
  saveWindowTree(info.oldWindowId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateTab(tab);
}, { properties: ['title', 'url', 'status', 'favIconUrl', 'pinned', 'discarded', 'audible', 'mutedInfo'] });

browser.tabs.onActivated.addListener(info => {
  setActive(info.windowId, info.tabId, info.previousTabId);
});

browser.tabs.onHighlighted.addListener(info => {
  setHighlighted(info.windowId, info.tabIds);
});

browser.windows.onRemoved.addListener(winId => {
  windows.delete(winId);
});

browser.windows.onCreated.addListener(async win => {
  if (win.type && win.type !== 'normal') return;
  const tabs = await browser.tabs.query({ windowId: win.id }).catch(() => []);
  for (const tab of tabs) trackTab(tab);
  const w = getWin(win.id);
  if (w) {
    await assignUids(w);
    await restoreWindowTree(w);
    push(win.id);
  }
});

// ---------------------------------------------------------------------------
// bench channel: forwards sidebar 'painted' signals to any bench page ports

const benchPorts = new Set();

function benchForward(msg) {
  for (const p of benchPorts) {
    try { p.postMessage(msg); } catch (e) { benchPorts.delete(p); }
  }
}

// ---------------------------------------------------------------------------
// sidebar connection

browser.runtime.onConnect.addListener(port => {
  if (port.name === 'bench') {
    benchPorts.add(port);
    port.onDisconnect.addListener(() => benchPorts.delete(port));
    return;
  }
  if (port.name !== 'sidebar') return;

  let winId = null;
  port.onMessage.addListener(async msg => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      winId = msg.windowId;
      log('sidebar hello for window', winId, '— known:', [...windows.keys()]);
      if (!windows.has(winId)) logErr('hello for unknown window', winId);
      registerPort(port, winId);
      return;
    }
    if (winId == null) return;

    switch (msg.type) {
      case 'painted':        return benchForward(msg);
      case 'activate':       return I.activate(winId, msg.tabId);
      case 'close':          return I.close(winId, msg.tabId);
      case 'closeTree':      return I.closeTree(winId, msg.tabId);
      case 'closeTabs':      return I.closeTabs(winId, msg.tabIds);
      case 'discard':        return I.discard(winId, msg.tabIds);
      case 'toggleCollapse': return I.toggleCollapse(winId, msg.tabId);
      case 'newTab':         return I.newTab(winId);
      case 'highlight':      return I.highlight(winId, msg.indices);
      case 'move':           return I.move(winId, msg);
      case 'detachToRoot':   return I.detachToRoot(winId, msg.tabId);
    }
  });
});

init();
