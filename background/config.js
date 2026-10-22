'use strict';

// Runtime config. storage.local backed; changes apply live.

import { pushAll, setSnapshotMetaProvider } from './model.js';

export const DEFAULTS = {
  // Where a tab opened with no opener lands:
  //   'child-of-active'      — first child of the active tab (its subtree)
  //   'sibling-after-active' — next sibling of the active tab, whatever its level
  //   'after-active'         — root tab immediately after the active tab
  //   'end'                  — root tab at the end of the window
  //   'native'               — leave Firefox's own placement alone
  newTabNoOpener: 'sibling-after-active',

  // Where a child tab lands relative to its parent's existing children:
  //   'first' — right after the parent (first thing in the subtree)
  //   'last'  — after the parent's whole subtree
  insertChildAt: 'first',

  // Closing a collapsed tab also closes its descendants; an expanded tab
  // closes alone and its children are promoted. Set false to always close
  // only the single tab.
  closeCollapsedClosesSubtree: true,

  animations: true,
  indentSize: 16,
};

export const cfg = { ...DEFAULTS };

// Shipped with every snapshot so the sidebar can adjust rendering live.
setSnapshotMetaProvider(() => ({
  animations: cfg.animations,
  indent:     cfg.indentSize,
}));

export async function initConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS)).catch(() => ({}));
  for (const key of Object.keys(DEFAULTS))
    if (stored[key] !== undefined) cfg[key] = stored[key];
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let touched = false;
  for (const key of Object.keys(DEFAULTS)) {
    if (key in changes) {
      cfg[key] = changes[key].newValue ?? DEFAULTS[key];
      touched = true;
    }
  }
  if (touched) pushAll();
});
