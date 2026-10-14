# Fast Tree Tabs

A tree-style tab sidebar for Firefox.

This project started as a fork of [Tree Style Tab](https://github.com/piroor/treestyletab) by piroor. Credit for the original idea, the interaction design, and years of maintenance goes to piroor and the TST contributors. Fast Tree Tabs contains no code from Tree Style Tab. The code is new.

## Why a rewrite

The original extension kept two complete copies of tab state. The background process held one copy. The sidebar held a second copy. More than one hundred message types kept the two copies synchronized. This design caused three classes of problems:

- The copies went out of synchronization. Tabs landed in unexpected places.
- A full-screen blocking overlay hid intermediate states during slow operations. When the overlay counter went wrong, the sidebar stopped accepting clicks. This failure happened in practice.
- Each tab event cost work in three places: background handling, message transfer, and sidebar re-application.

## The architecture

- The background process owns all state. Each window has one order array and one map of tab records.
- The tree is one field on each tab record: `parentId`. There is no separate tree structure.
- The background flattens the tree into a row list and pushes a versioned snapshot to each connected sidebar.
- The sidebar renders the snapshot. It sends intents back: activate, close, collapse, move.
- No second copy of tab state exists. No reconciliation code exists. No blocking overlay exists.

## The numbers

| Measure | Tree Style Tab | Fast Tree Tabs |
|---|---|---|
| Runtime JavaScript (background + common + sidebar) | ~49,300 lines | ~1,400 lines |
| Protocol message types | 116 | 12 |
| Copies of tab state | 2 | 1 |
| Blocking-overlay code | yes | none |

This is a code-size reduction of about 97%. It is also a desync reduction by construction: one copy of state cannot disagree with itself.

We did not benchmark performance. The claim is structural, not measured: rendering a frame costs one linear flatten pass plus one message. The sidebar does no state bookkeeping.

## Features

- Tree view with collapse and expand
- Click to activate, middle-click or X to close
- Descendant count doubles as the collapse toggle
- Closing a collapsed tab closes its descendants (optional)
- Multi-select with Ctrl/Cmd+click and Shift+click
- Right-click menu: close, close tree, unload, copy links
- Drag and drop to reorder and reparent, subtree included
- Configurable new-tab placement (Preferences page)
- Session restore and undo-close with tree intact
- Animated reorder, collapse, and expand (optional)

## Not implemented

Pinned tab section, native tab groups, container colors, sound buttons, full context menus, the external addon API, bookmarks integration, localization. Each omission is deliberate. Add a feature only if the projection architecture can express it.

## Install

Load `manifest.json` as a temporary add-on from `about:debugging`. The sidebar opens on install.
